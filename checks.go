package main

// Проверки снаружи: панель с этого компьютера раз в минуту проверяет сайты
// (HTTP/HTTPS), порты (TCP) и TLS-сертификаты. «Не отвечает» и «скоро
// истекает сертификат» — оповещения наравне с остальными (alerts.go).
// Список проверок хранится в settings.json, результаты — только в памяти.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Check struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`   // необязательно; иначе показывается адрес
	Target  string `json:"target"`           // https://…, http://…, host:port, tls://host:port
	Server  string `json:"server,omitempty"` // id сервера, к которому относится (необязательно)
	Off     bool   `json:"off,omitempty"`    // на паузе
	Created int64  `json:"created"`
}

type CheckResult struct {
	At    int64     `json:"at"` // когда проверено, мс
	OK    bool      `json:"ok"`
	Ms    int       `json:"ms"`             // время ответа
	Code  int       `json:"code,omitempty"` // HTTP-статус
	Err   string    `json:"err,omitempty"`
	Since int64     `json:"since"` // с какого момента такое состояние, мс
	Cert  *CertInfo `json:"cert,omitempty"`
}

type CertInfo struct {
	Host     string `json:"host"`
	NotAfter int64  `json:"notAfter"` // мс
	Days     int    `json:"days"`     // полных дней до окончания (меньше 0 — истёк)
	Issuer   string `json:"issuer,omitempty"`
	Err      string `json:"err,omitempty"` // не проходит проверку
}

const (
	maxChecks     = 200
	checkEvery    = time.Minute
	checkTimeout  = 10 * time.Second
	checkParallel = 8
)

// ---------- адрес проверки ----------

type checkTarget struct {
	kind       string // http | tcp | tls
	url        string // для http
	host, port string
}

// tls — проверяется ли сертификат.
func (t checkTarget) tls() bool { return t.kind == "tls" || strings.HasPrefix(t.url, "https://") }

func (t checkTarget) canon() string {
	switch t.kind {
	case "http":
		return t.url
	case "tls":
		return "tls://" + net.JoinHostPort(t.host, t.port)
	}
	return net.JoinHostPort(t.host, t.port)
}

func validHost(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	if net.ParseIP(h) != nil {
		return true
	}
	for _, r := range h {
		if !(r == '.' || r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r > 127) {
			return false
		}
	}
	return true
}

func parseHostPort(s string) (string, string, error) {
	h, p, err := net.SplitHostPort(s)
	if err != nil {
		return "", "", errors.New("укажите адрес и порт через двоеточие, например example.com:443")
	}
	n, err := strconv.Atoi(p)
	if err != nil || n < 1 || n > 65535 {
		return "", "", errors.New("порт — число от 1 до 65535")
	}
	if !validHost(h) {
		return "", "", errors.New("неверное имя или IP-адрес")
	}
	return strings.ToLower(h), strconv.Itoa(n), nil
}

func parseCheckTarget(s string) (checkTarget, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return checkTarget{}, errors.New("укажите адрес")
	}
	if len(s) > 500 || strings.ContainsAny(s, " \t\r\n") {
		return checkTarget{}, errors.New("неверный адрес")
	}
	low := strings.ToLower(s)
	switch {
	case strings.HasPrefix(low, "tcp://"):
		h, p, err := parseHostPort(s[6:])
		return checkTarget{kind: "tcp", host: h, port: p}, err
	case strings.HasPrefix(low, "tls://"):
		h, p, err := parseHostPort(s[6:])
		return checkTarget{kind: "tls", host: h, port: p}, err
	case !strings.Contains(low, "://"):
		// host:port — порт; просто домен или домен с путём — сайт по https
		if _, _, err := net.SplitHostPort(s); err == nil && !strings.Contains(s, "/") {
			h, p, err := parseHostPort(s)
			return checkTarget{kind: "tcp", host: h, port: p}, err
		}
		s, low = "https://"+s, "https://"+low
	}
	if !strings.HasPrefix(low, "http://") && !strings.HasPrefix(low, "https://") {
		return checkTarget{}, errors.New("поддерживаются адреса http://, https://, host:порт и tls://host:порт")
	}
	u, err := url.Parse(s)
	if err != nil || u.Hostname() == "" || !validHost(u.Hostname()) {
		return checkTarget{}, errors.New("неверный адрес сайта")
	}
	if u.User != nil {
		return checkTarget{}, errors.New("уберите из адреса логин и пароль")
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return checkTarget{}, errors.New("порт — число от 1 до 65535")
		}
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Fragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"http": "80", "https": "443"}[u.Scheme]
	}
	return checkTarget{kind: "http", url: u.String(), host: strings.ToLower(u.Hostname()), port: port}, nil
}

// checkLabel — как проверка называется в списке и сообщениях.
func checkLabel(c *Check) string {
	if c.Name != "" {
		return c.Name
	}
	t := strings.TrimPrefix(c.Target, "https://")
	return strings.TrimSuffix(t, "/")
}

// ---------- сама проверка ----------

func runCheck(ctx context.Context, t checkTarget) *CheckResult {
	res := &CheckResult{At: time.Now().UnixMilli()}
	start := time.Now()
	switch t.kind {
	case "http":
		var cert *CertInfo
		tr := &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: checkTimeout}).DialContext,
			TLSHandshakeTimeout:   checkTimeout,
			ResponseHeaderTimeout: 2 * checkTimeout,
			DisableKeepAlives:     true,
			ForceAttemptHTTP2:     true,
			// сертификат проверяем сами (certCheck): сайт с плохим сертификатом
			// всё равно «отвечает», а о сертификате — отдельное оповещение
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true, VerifyConnection: func(cs tls.ConnectionState) error {
				if cert == nil {
					cert = certCheck(cs, t.host)
				}
				return nil
			}},
		}
		defer tr.CloseIdleConnections()
		cl := &http.Client{Transport: tr, Timeout: 3 * checkTimeout, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("слишком много перенаправлений")
			}
			return nil
		}}
		req, err := http.NewRequestWithContext(ctx, "GET", t.url, nil)
		if err != nil {
			res.Err = err.Error()
			break
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; uptime-check)")
		resp, err := cl.Do(req)
		res.Ms = int(time.Since(start).Milliseconds())
		res.Cert = cert
		if err != nil {
			res.Err = netErrRu(err)
			break
		}
		io.CopyN(io.Discard, resp.Body, 64<<10)
		resp.Body.Close()
		res.Code = resp.StatusCode
		// 4xx — сервер жив и отвечает (часто так отвечают панели на «/»)
		res.OK = resp.StatusCode < 500
		if !res.OK {
			res.Err = fmt.Sprintf("сервер ответил %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
		}
	case "tcp", "tls":
		d := &net.Dialer{Timeout: checkTimeout}
		addr := net.JoinHostPort(t.host, t.port)
		if t.kind == "tcp" {
			c, err := d.DialContext(ctx, "tcp", addr)
			res.Ms = int(time.Since(start).Milliseconds())
			if err != nil {
				res.Err = netErrRu(err)
				break
			}
			c.Close()
			res.OK = true
			break
		}
		cfg := &tls.Config{InsecureSkipVerify: true}
		if net.ParseIP(t.host) == nil {
			cfg.ServerName = t.host
		}
		td := &tls.Dialer{NetDialer: d, Config: cfg}
		c, err := td.DialContext(ctx, "tcp", addr)
		res.Ms = int(time.Since(start).Milliseconds())
		if err != nil {
			res.Err = netErrRu(err)
			break
		}
		res.Cert = certCheck(c.(*tls.Conn).ConnectionState(), t.host)
		c.Close()
		res.OK = true
	}
	return res
}

// certCheck — срок и пригодность сертификата для этого имени.
func certCheck(cs tls.ConnectionState, host string) *CertInfo {
	if len(cs.PeerCertificates) == 0 {
		return nil
	}
	leaf := cs.PeerCertificates[0]
	info := &CertInfo{
		Host:     host,
		NotAfter: leaf.NotAfter.UnixMilli(),
		Days:     int(math.Floor(time.Until(leaf.NotAfter).Hours() / 24)),
		Issuer:   leaf.Issuer.CommonName,
	}
	if info.Issuer == "" && len(leaf.Issuer.Organization) > 0 {
		info.Issuer = leaf.Issuer.Organization[0]
	}
	now := time.Now()
	switch {
	case now.After(leaf.NotAfter):
		info.Err = "истёк " + leaf.NotAfter.Local().Format("02.01.2006")
	case now.Before(leaf.NotBefore):
		info.Err = "ещё не действует (с " + leaf.NotBefore.Local().Format("02.01.2006") + ")"
	case leaf.VerifyHostname(host) != nil:
		info.Err = "выдан не для " + host
	default:
		pool := x509.NewCertPool()
		for _, c := range cs.PeerCertificates[1:] {
			pool.AddCert(c)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Intermediates: pool}); err != nil {
			if leaf.Subject.String() == leaf.Issuer.String() {
				info.Err = "самоподписанный"
			} else {
				info.Err = "выдан неизвестным центром сертификации"
			}
		}
	}
	return info
}

// netErrRu — понятная причина сетевой ошибки.
func netErrRu(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var dnsErr *net.DNSError
	var ne net.Error
	switch {
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound:
		return "домен не найден"
	case errors.As(err, &dnsErr):
		return "не удалось узнать IP-адрес (DNS)"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "соединение отклонено — порт закрыт"
	case errors.Is(err, syscall.ECONNRESET):
		return "соединение сброшено"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "сеть или узел недоступны"
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return fmt.Sprintf("нет ответа за %d с", int(checkTimeout.Seconds()))
	case errors.Is(err, io.EOF):
		return "соединение закрыто сервером"
	}
	var re tls.RecordHeaderError
	if errors.As(err, &re) {
		return "по этому адресу не TLS"
	}
	s := err.Error()
	if strings.Contains(s, "tls:") || strings.Contains(s, "handshake") {
		return "ошибка TLS: " + s
	}
	return s
}

// ---------- расписание проверок ----------

type checker struct {
	mu      sync.Mutex
	res     map[string]*CheckResult
	running map[string]bool
	kick    chan string // id проверки, которую выполнить сейчас; "" — все
}

func newChecker() *checker {
	return &checker{res: map[string]*CheckResult{}, running: map[string]bool{}, kick: make(chan string, 16)}
}

func (a *App) checksCopy() []Check {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]Check, 0, len(a.settings.Checks))
	for _, c := range a.settings.Checks {
		out = append(out, *c)
	}
	return out
}

// checksState — проверки с последними результатами (для API и оповещений).
func (a *App) checksState() ([]Check, map[string]*CheckResult) {
	list := a.checksCopy()
	a.chk.mu.Lock()
	res := make(map[string]*CheckResult, len(list))
	for _, c := range list {
		if v := a.chk.res[c.ID]; v != nil {
			cp := *v
			res[c.ID] = &cp
		}
	}
	a.chk.mu.Unlock()
	return list, res
}

func (a *App) runChecks(ctx context.Context) {
	t := time.NewTicker(checkEvery)
	defer t.Stop()
	time.Sleep(3 * time.Second) // пусть панель сначала поднимется
	a.checkAll(ctx, "")
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.checkAll(ctx, "")
		case id := <-a.chk.kick:
			a.checkAll(ctx, id)
		}
	}
}

// checkAll выполняет проверки (only — только одну) параллельно и публикует итог.
func (a *App) checkAll(ctx context.Context, only string) {
	list := a.checksCopy()
	sem := make(chan struct{}, checkParallel)
	var wg sync.WaitGroup
	for i := range list {
		c := list[i]
		if c.Off || (only != "" && c.ID != only) {
			continue
		}
		t, err := parseCheckTarget(c.Target)
		if err != nil {
			continue
		}
		a.chk.mu.Lock()
		if a.chk.running[c.ID] {
			a.chk.mu.Unlock()
			continue
		}
		a.chk.running[c.ID] = true
		a.chk.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			cctx, cancel := context.WithTimeout(ctx, 4*checkTimeout)
			r := runCheck(cctx, t)
			cancel()
			<-sem
			a.chk.mu.Lock()
			delete(a.chk.running, c.ID)
			r.Since = r.At
			if prev := a.chk.res[c.ID]; prev != nil && prev.OK == r.OK && prev.Since > 0 {
				r.Since = prev.Since
			}
			a.chk.res[c.ID] = r
			a.chk.mu.Unlock()
		}()
	}
	wg.Wait()
	// результаты удалённых за это время проверок не нужны
	keep := map[string]bool{}
	for _, c := range a.checksCopy() {
		keep[c.ID] = true
	}
	a.chk.mu.Lock()
	for id := range a.chk.res {
		if !keep[id] {
			delete(a.chk.res, id)
		}
	}
	a.chk.mu.Unlock()
	a.publishChecks()
}

func (a *App) publishChecks() {
	list, res := a.checksState()
	a.hub.send("checks", map[string]any{"checks": list, "results": res})
}

// ---------- API ----------

func (a *App) handleChecks(w http.ResponseWriter, r *http.Request) {
	list, res := a.checksState()
	writeJSON(w, 200, map[string]any{"checks": list, "results": res})
}

type checkReq struct {
	Name   *string `json:"name"`
	Target *string `json:"target"`
	Server *string `json:"server"`
	Off    *bool   `json:"off"`
}

// applyCheck вызывается под a.mu.
func (a *App) applyCheck(c *Check, req checkReq) string {
	if req.Target != nil {
		t, err := parseCheckTarget(*req.Target)
		if err != nil {
			return err.Error()
		}
		if c.Target != t.canon() {
			c.Target = t.canon()
			a.chk.mu.Lock()
			delete(a.chk.res, c.ID)
			a.chk.mu.Unlock()
		}
	}
	if req.Name != nil {
		c.Name = cleanLine(*req.Name, 80)
	}
	if req.Server != nil {
		id := strings.TrimSpace(*req.Server)
		if id != "" && a.mons[id] == nil {
			return "сервер не найден"
		}
		c.Server = id
	}
	if req.Off != nil {
		c.Off = *req.Off
		if c.Off {
			a.chk.mu.Lock()
			delete(a.chk.res, c.ID)
			a.chk.mu.Unlock()
		}
	}
	for _, o := range a.settings.Checks {
		if o.ID != c.ID && o.Target == c.Target {
			return "такая проверка уже есть"
		}
	}
	return ""
}

func (a *App) kickCheck(id string) {
	select {
	case a.chk.kick <- id:
	default:
	}
}

func (a *App) handleAddCheck(w http.ResponseWriter, r *http.Request) {
	var req checkReq
	if err := readJSON(r, &req); err != nil || req.Target == nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	c := &Check{ID: newID(6), Created: time.Now().UnixMilli()}
	a.mu.Lock()
	if len(a.settings.Checks) >= maxChecks {
		a.mu.Unlock()
		writeErr(w, 400, "слишком много проверок")
		return
	}
	if msg := a.applyCheck(c, req); msg != "" {
		a.mu.Unlock()
		writeErr(w, 400, msg)
		return
	}
	a.settings.Checks = append(a.settings.Checks, c)
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.kickCheck(c.ID)
	a.publishChecks()
	writeJSON(w, 200, c)
}

func (a *App) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	var req checkReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	id := r.PathValue("cid")
	a.mu.Lock()
	var c *Check
	for _, x := range a.settings.Checks {
		if x.ID == id {
			c = x
		}
	}
	if c == nil {
		a.mu.Unlock()
		writeErr(w, 404, "проверка не найдена")
		return
	}
	next := *c
	if msg := a.applyCheck(&next, req); msg != "" {
		a.mu.Unlock()
		writeErr(w, 400, msg)
		return
	}
	*c = next
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !c.Off {
		a.kickCheck(c.ID)
	}
	a.publishChecks()
	writeJSON(w, 200, next)
}

func (a *App) handleDeleteCheck(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("cid")
	a.mu.Lock()
	out := a.settings.Checks[:0]
	found := false
	for _, x := range a.settings.Checks {
		if x.ID == id {
			found = true
			continue
		}
		out = append(out, x)
	}
	a.settings.Checks = out
	err := a.saveSettings()
	a.mu.Unlock()
	if !found {
		writeErr(w, 404, "проверка не найдена")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.chk.mu.Lock()
	delete(a.chk.res, id)
	a.chk.mu.Unlock()
	a.publishChecks()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleRunCheck — «Проверить сейчас»: выполняет проверку и возвращает итог.
func (a *App) handleRunCheck(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("cid")
	var c *Check
	for _, x := range a.checksCopy() {
		if x.ID == id {
			x := x
			c = &x
		}
	}
	if c == nil {
		writeErr(w, 404, "проверка не найдена")
		return
	}
	if c.Off {
		writeErr(w, 400, "проверка на паузе")
		return
	}
	a.checkAll(r.Context(), id)
	_, res := a.checksState()
	writeJSON(w, 200, map[string]any{"result": res[id]})
}
