package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- настройки оповещений ----------

// Rule — одно правило: включено, порог в процентах и сколько минут условие
// должно держаться.
type Rule struct {
	On   bool    `json:"on"`
	Pct  float64 `json:"pct,omitempty"`
	Min  float64 `json:"min,omitempty"`
	Days int     `json:"days,omitempty"`
}

type AlertRules struct {
	Offline  Rule  `json:"offline"`         // нет связи N мин
	CPU      Rule  `json:"cpu"`             // процессор в среднем ≥ X% за N мин
	Mem      Rule  `json:"mem"`             // память ≥ X% за N мин
	Disk     Rule  `json:"disk"`            // файловая система заполнена ≥ X%
	Failed   Rule  `json:"failed"`          // служба перешла в состояние ошибки
	VPN      Rule  `json:"vpn"`             // VPN-служба не работает N мин
	Temp     *Rule `json:"temp,omitempty"`  // перегрев дольше N мин; nil — по умолчанию (в старых настройках его нет)
	Check    *Rule `json:"check,omitempty"` // сайт или порт не отвечает дольше N мин (checks.go); nil — по умолчанию
	Cert     *Rule `json:"cert,omitempty"`  // сертификат истекает через N дней или не проходит проверку
	Recovery bool  `json:"recovery"`        // сообщать о восстановлении
}

type AlertChannels struct {
	MacOS    bool   `json:"macos"`
	Telegram bool   `json:"telegram"`
	TGToken  string `json:"tgToken,omitempty"`
	TGChat   string `json:"tgChat,omitempty"`
}

type AlertConfig struct {
	Rules    AlertRules    `json:"rules"`
	Channels AlertChannels `json:"channels"`
	Watch    WatchCfg      `json:"watch"` // сторож на серверах (watchdog.go)
}

func defaultTempRule() *Rule  { return &Rule{On: true, Min: 5} }
func defaultCheckRule() *Rule { return &Rule{On: true, Min: 3} }
func defaultCertRule() *Rule  { return &Rule{On: true, Days: 14} }

// fillRules подставляет значения по умолчанию для правил, которых нет в старых настройках.
func fillRules(r *AlertRules, from AlertRules) {
	if r.Temp == nil {
		r.Temp = from.Temp
	}
	if r.Check == nil {
		r.Check = from.Check
	}
	if r.Cert == nil {
		r.Cert = from.Cert
	}
}

func defaultAlertConfig() AlertConfig {
	return AlertConfig{
		Rules: AlertRules{
			Offline:  Rule{On: true, Min: 2},
			CPU:      Rule{On: true, Pct: 90, Min: 5},
			Mem:      Rule{On: true, Pct: 90, Min: 5},
			Disk:     Rule{On: true, Pct: 90},
			Failed:   Rule{On: true},
			VPN:      Rule{On: true, Min: 1},
			Temp:     defaultTempRule(),
			Check:    defaultCheckRule(),
			Cert:     defaultCertRule(),
			Recovery: true,
		},
		Channels: AlertChannels{MacOS: true},
	}
}

func (a *App) alertConfig() AlertConfig {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.settings.Alerts == nil {
		return defaultAlertConfig()
	}
	c := *a.settings.Alerts
	fillRules(&c.Rules, defaultAlertConfig().Rules)
	return c
}

// ---------- состояние ----------

// Firing — сработавшее оповещение.
type Firing struct {
	Key     string `json:"key"`
	Server  string `json:"server"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Subject string `json:"subject,omitempty"`
	Text    string `json:"text"`
	Since   int64  `json:"since"` // когда условие возникло
	Fired   int64  `json:"fired"` // когда отправлено
}

// AlertEvent — запись в журнале оповещений.
type AlertEvent struct {
	ID     int64  `json:"id"`
	T      int64  `json:"t"`
	Server string `json:"server"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	State  string `json:"state"` // fire | ok | test
	Text   string `json:"text"`
	Sent   string `json:"sent,omitempty"`
	Err    string `json:"err,omitempty"`
}

type alertState struct {
	Firing  map[string]*Firing  `json:"firing"`
	Events  []*AlertEvent       `json:"events"`
	VPNSeen map[string][]string `json:"vpnSeen"` // службы VPN, которые панель видела работающими
}

type Alerts struct {
	a      *App
	notify bool // false — не отправлять наружу (флаг -notify=false)

	mu      sync.Mutex
	st      alertState
	pending map[string]time.Time // условие замечено, ждём, пока продержится
	nextID  int64
	path    string
}

func newAlerts(a *App, notify bool) *Alerts {
	al := &Alerts{a: a, notify: notify, pending: map[string]time.Time{}, path: filepath.Join(a.dataDir, "alerts.json")}
	if b, err := os.ReadFile(al.path); err == nil {
		_ = json.Unmarshal(b, &al.st)
	}
	if al.st.Firing == nil {
		al.st.Firing = map[string]*Firing{}
	}
	if al.st.VPNSeen == nil {
		al.st.VPNSeen = map[string][]string{}
	}
	for _, e := range al.st.Events {
		if e.ID >= al.nextID {
			al.nextID = e.ID
		}
	}
	return al
}

// save вызывается под al.mu.
func (al *Alerts) save() {
	if len(al.st.Events) > 300 {
		al.st.Events = append([]*AlertEvent(nil), al.st.Events[len(al.st.Events)-300:]...)
	}
	if b, err := json.Marshal(al.st); err == nil {
		_ = writeFileAtomic(al.path, b)
	}
}

func (al *Alerts) firingList() []*Firing {
	out := make([]*Firing, 0, len(al.st.Firing))
	for _, f := range al.st.Firing {
		c := *f
		out = append(out, &c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since > out[j].Since })
	return out
}

// snapshot — для API.
func (al *Alerts) snapshot(events int) map[string]any {
	al.mu.Lock()
	defer al.mu.Unlock()
	ev := al.st.Events
	if len(ev) > events {
		ev = ev[len(ev)-events:]
	}
	rev := make([]AlertEvent, 0, len(ev))
	for i := len(ev) - 1; i >= 0; i-- {
		rev = append(rev, *ev[i])
	}
	return map[string]any{"firing": al.firingList(), "events": rev, "notify": al.notify}
}

func (al *Alerts) broadcast(ev *AlertEvent) {
	al.mu.Lock()
	d := map[string]any{"firing": al.firingList()}
	if ev != nil {
		d["event"] = *ev
	}
	al.mu.Unlock()
	al.a.hub.send("alerts", d)
}

func (al *Alerts) clearEvents() {
	al.mu.Lock()
	al.st.Events = nil
	al.save()
	al.mu.Unlock()
	al.broadcast(nil)
}

// ---------- проверка правил ----------

type cond struct {
	key, server, name, kind, subject, text string
	wait                                   time.Duration
	start                                  time.Time // когда условие возникло, если известно
}

func (al *Alerts) run(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			al.evaluate()
		}
	}
}

func fmtMin(m float64) string {
	if m < 1 {
		return fmt.Sprintf("%d с", int(m*60+0.5))
	}
	if m == float64(int(m)) {
		return fmt.Sprintf("%d мин", int(m))
	}
	return strconv.FormatFloat(m, 'f', 1, 64) + " мин"
}

func fmtAgo(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d с", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d мин", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d ч %d мин", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%d дн", int(d.Hours()/24))
	}
}

// windowAvg — среднее значение за последние n минут, если данных достаточно.
func windowAvg(raw []Point, min float64, interval time.Duration, get func(Point) float64) (float64, bool) {
	cut := time.Now().Add(-time.Duration(min * float64(time.Minute))).UnixMilli()
	i := sort.Search(len(raw), func(i int) bool { return raw[i].T >= cut })
	n := len(raw) - i
	need := int(min * float64(time.Minute) / float64(interval) * 0.8)
	if need < 1 {
		need = 1
	}
	if n < need {
		return 0, false
	}
	sum := 0.0
	for _, p := range raw[i:] {
		sum += get(p)
	}
	return sum / float64(n), true
}

func (al *Alerts) evaluate() {
	cfg := al.a.alertConfig()
	r := cfg.Rules
	now := time.Now()

	al.a.mu.RLock()
	mons := make([]*Monitor, 0, len(al.a.order))
	for _, id := range al.a.order {
		mons = append(mons, al.a.mons[id])
	}
	al.a.mu.RUnlock()

	al.mu.Lock()
	firing := func(k string) bool { return al.st.Firing[k] != nil }
	var conds []cond
	evaluated := map[string]bool{} // "<server>|<kind>" — что удалось проверить
	active := map[string]bool{}    // серверы под наблюдением
	seenChanged := false

	type avg struct {
		v  float64
		ok bool
	}
	for _, m := range mons {
		m.mu.RLock()
		srv, status, down := m.srv, m.status, m.downSince
		units, unitsAt, fsList := m.units, m.unitsAt, m.fs
		var temps []TempSensor
		if m.latest != nil {
			temps = m.latest.Temps
		}
		var cpuAvg, memAvg avg
		if r.CPU.On && r.CPU.Min > 0 {
			cpuAvg.v, cpuAvg.ok = windowAvg(m.raw, r.CPU.Min, al.a.interval, func(p Point) float64 { return p.CPU })
		}
		if r.Mem.On && r.Mem.Min > 0 {
			memAvg.v, memAvg.ok = windowAvg(m.raw, r.Mem.Min, al.a.interval, func(p Point) float64 { return p.Mem })
		}
		m.mu.RUnlock()
		if !srv.Monitor || srv.Hidden || srv.Mute {
			continue
		}
		active[srv.ID] = true
		id, name := srv.ID, srv.Name
		key := func(kind, subj string) string { return id + "|" + kind + "|" + subj }
		mark := func(kind string) { evaluated[id+"|"+kind] = true }
		add := func(kind, subj, text string, wait time.Duration) {
			conds = append(conds, cond{key: key(kind, subj), server: id, name: name, kind: kind, subject: subj, text: text, wait: wait})
		}

		// нет связи
		if status != "connecting" {
			mark("offline")
		}
		if r.Offline.On && status == "offline" && !down.IsZero() {
			if now.Sub(down) >= time.Duration(r.Offline.Min*float64(time.Minute)) {
				conds = append(conds, cond{key: key("offline", ""), server: id, name: name, kind: "offline",
					text: "нет связи " + fmtAgo(now.Sub(down)), start: down})
			} else if firing(key("offline", "")) {
				add("offline", "", "нет связи", 0)
			}
		}
		if status != "online" {
			continue
		}

		// процессор и память — среднее за окно; гасим с запасом, чтобы не мигало
		for _, x := range []struct {
			kind string
			rule Rule
			avg  avg
			what string
		}{
			{"cpu", r.CPU, cpuAvg, "процессор"},
			{"mem", r.Mem, memAvg, "память"},
		} {
			if !x.rule.On || x.rule.Min <= 0 {
				mark(x.kind)
				continue
			}
			if !x.avg.ok {
				continue
			}
			mark(x.kind)
			thr := x.rule.Pct
			if firing(key(x.kind, "")) {
				thr -= 5
			}
			if x.avg.v >= thr {
				add(x.kind, "", fmt.Sprintf("%s %.0f%% в среднем за %s", x.what, x.avg.v, fmtMin(x.rule.Min)), 0)
			}
		}

		// диски
		if len(fsList) > 0 || !r.Disk.On {
			mark("disk")
		}
		if r.Disk.On {
			for _, f := range fsList {
				thr := r.Disk.Pct
				if firing(key("disk", f.Mount)) {
					thr -= 1
				}
				if f.Pct >= thr {
					add("disk", f.Mount, fmt.Sprintf("диск %s заполнен на %.0f%%", f.Mount, f.Pct), 0)
				}
			}
		}

		// перегрев: самый горячий датчик каждого процессора, видеокарты и диска
		mark("temp")
		if r.Temp.On {
			for _, t := range tempAlarms(temps) {
				thr := t.crit
				if firing(key("temp", t.subj)) {
					thr -= 3
				}
				if t.c >= thr {
					add("temp", t.subj, fmt.Sprintf("перегрев: %s %.0f °C (порог %.0f °C)", t.who, t.c, t.crit), time.Duration(r.Temp.Min*float64(time.Minute)))
				}
			}
		}

		// службы
		if unitsAt.IsZero() || now.Sub(unitsAt) > 2*time.Minute {
			continue
		}
		mark("failed")
		mark("vpn")
		seen := map[string]bool{}
		for _, u := range al.st.VPNSeen[id] {
			seen[u] = true
		}
		present := map[string]bool{}
		for _, u := range units {
			present[u.Unit] = true
			short := strings.TrimSuffix(u.Unit, ".service")
			if u.VPN {
				if u.Active == "active" && !seen[u.Unit] {
					seen[u.Unit] = true
					seenChanged = true
				}
				if r.VPN.On && seen[u.Unit] && u.Active != "active" && u.Active != "activating" && u.Active != "reloading" {
					add("vpn", u.Unit, fmt.Sprintf("VPN-служба %s не работает (%s)", short, stateRu(u.Active, u.Sub)), time.Duration(r.VPN.Min*float64(time.Minute)))
				}
				continue
			}
			if r.Failed.On && u.Active == "failed" {
				add("failed", u.Unit, fmt.Sprintf("служба %s завершилась с ошибкой", short), 50*time.Second)
			}
		}
		// служба исчезла из списка (удалена или выгружена) — больше не следим
		var keep []string
		for u := range seen {
			if present[u] {
				keep = append(keep, u)
			} else {
				seenChanged = true
			}
		}
		sort.Strings(keep)
		if len(keep) > 0 {
			al.st.VPNSeen[id] = keep
		} else if _, ok := al.st.VPNSeen[id]; ok {
			delete(al.st.VPNSeen, id)
			seenChanged = true
		}
	}

	// проверки снаружи (checks.go). Если ни один сервер не на связи, скорее
	// всего, нет сети у этого компьютера — тогда о сайтах ничего не решаем.
	netOK, anyMon := false, false
	for _, m := range mons {
		m.mu.RLock()
		if m.srv.Monitor && !m.srv.Hidden {
			anyMon = true
			netOK = netOK || m.status == "online"
		}
		m.mu.RUnlock()
	}
	netOK = netOK || !anyMon
	checks, results := al.a.checksState()
	for i := range checks {
		c := &checks[i]
		if c.Off {
			continue
		}
		if c.Server != "" {
			if m := al.a.monitor(c.Server); m != nil {
				if s := m.server(); s.Mute || s.Hidden {
					continue
				}
			}
		}
		id := "check:" + c.ID
		active[id] = true
		res := results[c.ID]
		t, err := parseCheckTarget(c.Target)
		if res == nil || !netOK || err != nil {
			continue
		}
		name := checkLabel(c)
		evaluated[id+"|check"] = true
		if r.Check.On && !res.OK {
			conds = append(conds, cond{key: id + "|check|", server: id, name: name, kind: "check", subject: c.Target,
				text: "не отвечает: " + res.Err, wait: time.Duration(r.Check.Min * float64(time.Minute)), start: time.UnixMilli(res.Since)})
		}
		// о сертификате судим, только когда он получен
		if res.Cert == nil && t.tls() {
			continue
		}
		evaluated[id+"|cert"] = true
		if !r.Cert.On || res.Cert == nil {
			continue
		}
		ce := res.Cert
		exp := time.UnixMilli(ce.NotAfter).Format("02.01.2006")
		who := "сертификат " + ce.Host // имя хоста не повторяем, если оно уже в названии
		if strings.Contains(name, ce.Host) {
			who = "сертификат"
		}
		switch {
		case ce.Err != "":
			conds = append(conds, cond{key: id + "|cert|", server: id, name: name, kind: "cert", subject: ce.Host,
				text: who + ": " + ce.Err})
		case ce.Days < r.Cert.Days:
			conds = append(conds, cond{key: id + "|cert|", server: id, name: name, kind: "cert", subject: ce.Host,
				text: fmt.Sprintf("%s истекает через %d %s (%s)", who, ce.Days, plural(ce.Days, "день", "дня", "дней"), exp)})
		}
	}

	var fired, resolved []*Firing
	var silent bool
	cur := map[string]bool{}
	for _, c := range conds {
		cur[c.key] = true
		if f := al.st.Firing[c.key]; f != nil {
			f.Text = c.text
			continue
		}
		since, ok := al.pending[c.key]
		if !ok {
			since = now
			al.pending[c.key] = since
		}
		if now.Sub(since) < c.wait {
			continue
		}
		start := since
		if !c.start.IsZero() {
			start = c.start
		}
		f := &Firing{Key: c.key, Server: c.server, Name: c.name, Kind: c.kind, Subject: c.subject, Text: c.text, Since: start.UnixMilli(), Fired: now.UnixMilli()}
		al.st.Firing[c.key] = f
		delete(al.pending, c.key)
		fired = append(fired, f)
	}
	for k := range al.pending {
		if !cur[k] {
			delete(al.pending, k)
		}
	}
	for k, f := range al.st.Firing {
		if cur[k] {
			continue
		}
		if !active[f.Server] {
			// сервер убран, выключен или заглушён — снимаем без сообщения
			delete(al.st.Firing, k)
			silent = true
			continue
		}
		if !evaluated[f.Server+"|"+f.Kind] {
			continue // нет данных — оставляем как есть
		}
		delete(al.st.Firing, k)
		resolved = append(resolved, f)
	}

	var batch []*AlertEvent
	for _, f := range fired {
		batch = append(batch, al.addEvent(f.Server, f.Name, f.Kind, "fire", f.Text))
	}
	for _, f := range resolved {
		batch = append(batch, al.addEvent(f.Server, f.Name, f.Kind, "ok", recoveryText(f, now)))
	}
	var send []*AlertEvent
	for _, e := range batch {
		if e.State == "fire" || cfg.Rules.Recovery {
			send = append(send, e)
		} else {
			e.Sent = "о восстановлении не сообщаем"
		}
	}
	if len(batch) > 0 || silent || seenChanged {
		al.save()
	}
	al.mu.Unlock()

	if len(batch) == 0 {
		if silent {
			al.broadcast(nil)
		}
		return
	}
	for _, e := range batch {
		al.broadcast(e)
	}
	if len(send) > 0 {
		go al.deliver(cfg.Channels, send)
	}
}

func stateRu(active, sub string) string {
	switch active {
	case "failed":
		return "ошибка"
	case "inactive":
		return "остановлена"
	case "deactivating":
		return "останавливается"
	}
	return active + "/" + sub
}

func recoveryText(f *Firing, now time.Time) string {
	d := fmtAgo(now.Sub(time.UnixMilli(f.Since)))
	switch f.Kind {
	case "offline":
		return "связь восстановлена (не было " + d + ")"
	case "cpu":
		return "нагрузка на процессор снизилась"
	case "mem":
		return "память освободилась"
	case "disk":
		return "на диске " + f.Subject + " снова есть место"
	case "failed":
		return "служба " + strings.TrimSuffix(f.Subject, ".service") + " больше не в ошибке"
	case "vpn":
		return "VPN-служба " + strings.TrimSuffix(f.Subject, ".service") + " снова работает (не работала " + d + ")"
	case "check":
		return "снова отвечает (не отвечал " + d + ")"
	case "cert":
		return "сертификат " + f.Subject + " в порядке"
	case "temp":
		switch {
		case f.Subject == "cpu":
			return "процессор остыл"
		case strings.HasPrefix(f.Subject, "gpu:"):
			return "видеокарта остыла"
		case strings.HasPrefix(f.Subject, "disk:"):
			return "диск " + strings.TrimPrefix(f.Subject, "disk:") + " остыл"
		}
	}
	return "в норме: " + f.Text
}

// addEvent вызывается под al.mu.
func (al *Alerts) addEvent(server, name, kind, state, text string) *AlertEvent {
	al.nextID++
	e := &AlertEvent{ID: al.nextID, T: time.Now().UnixMilli(), Server: server, Name: name, Kind: kind, State: state, Text: text}
	al.st.Events = append(al.st.Events, e)
	return e
}

// ---------- отправка ----------

// watchKinds — события, о которых сторож на сервере пишет в Telegram сам.
var watchKinds = map[string]bool{"vpn": true, "failed": true, "disk": true, "temp": true}

func (al *Alerts) deliver(ch AlertChannels, evs []*AlertEvent) {
	tgEvs, byWatch := evs, map[*AlertEvent]bool{}
	if ch.Telegram {
		tgEvs = nil
		for _, e := range evs {
			if watchKinds[e.Kind] && al.a.watchdogOn(e.Server) {
				byWatch[e] = true
			} else {
				tgEvs = append(tgEvs, e)
			}
		}
	}
	var localErr, tgErr error
	if al.notify {
		if ch.MacOS {
			title, body := composeMessage(evs)
			localErr = notifyLocal(title, body)
		}
		if ch.Telegram && len(tgEvs) > 0 {
			title, body := composeMessage(tgEvs)
			tgErr = telegramSend(ch.TGToken, ch.TGChat, title+"\n"+body)
		}
	}
	al.mu.Lock()
	for _, e := range evs {
		var sent, errs []string
		if ch.MacOS {
			if localErr != nil {
				errs = append(errs, localNotifyName()+": "+localErr.Error())
			} else {
				sent = append(sent, localNotifyName())
			}
		}
		if ch.Telegram {
			switch {
			case byWatch[e]:
				sent = append(sent, "Telegram — пишет сторож на сервере")
			case tgErr != nil:
				errs = append(errs, "Telegram: "+tgErr.Error())
			default:
				sent = append(sent, "Telegram")
			}
		}
		e.Sent = strings.Join(sent, ", ")
		e.Err = strings.Join(errs, "; ")
		if !al.notify {
			e.Sent, e.Err = "", "отправка отключена флагом -notify=false"
		} else if len(sent) == 0 && len(errs) == 0 {
			e.Err = "не выбран ни один способ доставки"
		}
	}
	al.save()
	al.mu.Unlock()
	for _, e := range evs {
		al.broadcast(e)
	}
}

func composeMessage(evs []*AlertEvent) (title, body string) {
	line := func(e *AlertEvent) string {
		mark := "🔴"
		if e.State == "ok" {
			mark = "🟢"
		}
		return mark + " " + e.Name + ": " + e.Text
	}
	if len(evs) == 1 {
		e := evs[0]
		t := "Method Network · " + e.Name
		if e.State == "ok" {
			return t, "В норме: " + e.Text
		}
		return t, e.Text
	}
	lines := make([]string, 0, len(evs))
	for _, e := range evs {
		lines = append(lines, line(e))
	}
	return fmt.Sprintf("Method Network · %d %s", len(evs), plural(len(evs), "событие", "события", "событий")), strings.Join(lines, "\n")
}

func plural(n int, one, few, many string) string {
	n %= 100
	if n >= 11 && n <= 14 {
		return many
	}
	switch n % 10 {
	case 1:
		return one
	case 2, 3, 4:
		return few
	}
	return many
}

func localNotifyName() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	}
	return "рабочий стол"
}

// winToast показывает всплывающее уведомление Windows 10/11 через WinRT из
// PowerShell. Текст приходит через переменные окружения — без экранирования.
const winToast = `$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:SP_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:SP_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`

// notifyLocal — уведомление на этом компьютере: macOS (osascript),
// Windows (всплывающее уведомление), Linux (notify-send).
func notifyLocal(title, body string) error {
	if len([]rune(body)) > 600 {
		body = string([]rune(body)[:600]) + "…"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		// текст передаём аргументами, а не внутри скрипта — без экранирования
		cmd = exec.CommandContext(ctx, "osascript",
			"-e", "on run argv",
			"-e", `display notification (item 2 of argv) with title (item 1 of argv) sound name "Submarine"`,
			"-e", "end run", title, body)
	case "windows":
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", winToast)
		cmd.Env = append(os.Environ(), "SP_TITLE="+title, "SP_BODY="+body)
	default:
		if _, err := exec.LookPath("notify-send"); err != nil {
			return errors.New("не найден notify-send (пакет libnotify-bin)")
		}
		cmd = exec.CommandContext(ctx, "notify-send", "--", title, body)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v %s", err, lastLines(strings.TrimSpace(string(out)), 3))
	}
	return nil
}

var tgTokenRe = regexp.MustCompile(`^\d{5,15}:[A-Za-z0-9_-]{30,64}$`)

var tgClient = &http.Client{Timeout: 15 * time.Second}

func telegramCall(token, method string, form url.Values) (json.RawMessage, error) {
	if !tgTokenRe.MatchString(token) {
		return nil, errors.New("неверный токен бота")
	}
	resp, err := tgClient.PostForm("https://api.telegram.org/bot"+token+"/"+method, form)
	if err != nil {
		// в тексте ошибки есть адрес с токеном — убираем его
		return nil, errors.New(strings.ReplaceAll(err.Error(), token, "…"))
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var r struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		Description string          `json:"description"`
	}
	if json.Unmarshal(b, &r) != nil {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if !r.OK {
		msg := r.Description
		switch {
		case resp.StatusCode == 401:
			msg = "бот не найден — проверьте токен"
		case strings.Contains(msg, "chat not found"):
			msg = "чат не найден — напишите боту /start и проверьте chat id"
		case strings.Contains(msg, "bot was blocked"):
			msg = "бот заблокирован в этом чате"
		}
		return nil, errors.New(msg)
	}
	return r.Result, nil
}

func telegramSend(token, chat, text string) error {
	if strings.TrimSpace(chat) == "" {
		return errors.New("не указан chat id")
	}
	if len([]rune(text)) > 3900 {
		text = string([]rune(text)[:3900]) + "…"
	}
	_, err := telegramCall(token, "sendMessage", url.Values{"chat_id": {chat}, "text": {text}, "disable_web_page_preview": {"true"}})
	return err
}

type tgChat struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

// telegramChats — чаты, из которых боту недавно писали.
func telegramChats(token string) ([]tgChat, error) {
	res, err := telegramCall(token, "getUpdates", url.Values{"limit": {"100"}, "allowed_updates": {`["message","channel_post","my_chat_member"]`}})
	if err != nil {
		return nil, err
	}
	var ups []map[string]json.RawMessage
	if err := json.Unmarshal(res, &ups); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []tgChat
	for i := len(ups) - 1; i >= 0; i-- {
		for _, k := range []string{"message", "channel_post", "my_chat_member"} {
			raw, ok := ups[i][k]
			if !ok {
				continue
			}
			var m struct {
				Chat struct {
					ID        int64  `json:"id"`
					Type      string `json:"type"`
					Title     string `json:"title"`
					Username  string `json:"username"`
					FirstName string `json:"first_name"`
					LastName  string `json:"last_name"`
				} `json:"chat"`
			}
			if json.Unmarshal(raw, &m) != nil || m.Chat.ID == 0 {
				continue
			}
			id := strconv.FormatInt(m.Chat.ID, 10)
			if seen[id] {
				continue
			}
			seen[id] = true
			t := m.Chat.Title
			if t == "" {
				t = strings.TrimSpace(m.Chat.FirstName + " " + m.Chat.LastName)
			}
			if m.Chat.Username != "" {
				t += " (@" + m.Chat.Username + ")"
			}
			out = append(out, tgChat{ID: id, Title: strings.TrimSpace(t), Type: m.Chat.Type})
		}
	}
	return out, nil
}

// ---------- API ----------

func maskAlertConfig(c AlertConfig) map[string]any {
	hasToken := c.Channels.TGToken != ""
	c.Channels.TGToken = ""
	return map[string]any{"rules": c.Rules, "channels": c.Channels, "watch": c.Watch, "tgTokenSet": hasToken}
}

func (a *App) handleAlerts(w http.ResponseWriter, r *http.Request) {
	d := a.alerts.snapshot(200)
	d["config"] = maskAlertConfig(a.alertConfig())
	writeJSON(w, 200, d)
}

func validRule(r Rule, pct bool) error {
	if r.Min < 0 || r.Min > 1440 {
		return errors.New("время должно быть от 0 до 1440 минут")
	}
	if pct && (r.Pct < 1 || r.Pct > 100) {
		return errors.New("порог должен быть от 1 до 100 %")
	}
	return nil
}

func (a *App) handleAlertConfig(w http.ResponseWriter, r *http.Request) {
	var req AlertConfig
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	fillRules(&req.Rules, a.alertConfig().Rules)
	rr := req.Rules
	if rr.Cert.Days < 1 || rr.Cert.Days > 365 {
		writeErr(w, 400, "срок сертификата — от 1 до 365 дней")
		return
	}
	for _, x := range []struct {
		r   Rule
		pct bool
	}{{rr.Offline, false}, {rr.CPU, true}, {rr.Mem, true}, {rr.Disk, true}, {rr.VPN, false}, {*rr.Temp, false}, {*rr.Check, false}} {
		if err := validRule(x.r, x.pct); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
	}
	if rr.CPU.Min < 0.5 || rr.Mem.Min < 0.5 {
		writeErr(w, 400, "для процессора и памяти время — не меньше 0,5 минуты")
		return
	}
	ch := &req.Channels
	ch.TGToken, ch.TGChat = strings.TrimSpace(ch.TGToken), strings.TrimSpace(ch.TGChat)
	old := a.alertConfig()
	if ch.TGToken == "" {
		ch.TGToken = old.Channels.TGToken
	}
	if ch.TGToken != "" && !tgTokenRe.MatchString(ch.TGToken) {
		writeErr(w, 400, "токен бота выглядит неверно: нужен вид 123456789:AA…")
		return
	}
	if ch.TGChat != "" && !regexp.MustCompile(`^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$`).MatchString(ch.TGChat) {
		writeErr(w, 400, "chat id — это число (например 123456789 или -100…) или @имя_канала")
		return
	}
	if ch.Telegram && (ch.TGToken == "" || ch.TGChat == "") {
		writeErr(w, 400, "для Telegram нужны токен бота и chat id")
		return
	}
	a.mu.Lock()
	a.settings.Alerts = &req
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.syncWatchdogs()
	writeJSON(w, 200, map[string]any{"ok": true, "config": maskAlertConfig(req)})
}

func (a *App) handleAlertTest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Channel string `json:"channel"` // macos | telegram
		Token   string `json:"token"`
		Chat    string `json:"chat"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if !a.alerts.notify {
		writeErr(w, 409, "отправка отключена флагом -notify=false")
		return
	}
	title, body := "Method Network", "Проверка оповещений: если вы это видите, всё настроено."
	var err error
	switch req.Channel {
	case "macos":
		err = notifyLocal(title, body)
	case "telegram":
		cfg := a.alertConfig()
		token, chat := strings.TrimSpace(req.Token), strings.TrimSpace(req.Chat)
		if token == "" {
			token = cfg.Channels.TGToken
		}
		if chat == "" {
			chat = cfg.Channels.TGChat
		}
		err = telegramSend(token, chat, title+"\n"+body)
	default:
		writeErr(w, 400, "неизвестный способ доставки")
		return
	}
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *App) handleTelegramChats(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	token := strings.TrimSpace(req.Token)
	if token == "" {
		token = a.alertConfig().Channels.TGToken
	}
	if token == "" {
		writeErr(w, 400, "сначала укажите токен бота")
		return
	}
	chats, err := telegramChats(token)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"chats": chats})
}

func (a *App) handleAlertEventsClear(w http.ResponseWriter, r *http.Request) {
	a.alerts.clearEvents()
	writeJSON(w, 200, map[string]any{"ok": true})
}
