package main

// Расписание: задания хранятся на самом сервере как таймеры systemd
// (/etc/systemd/system/method-panel-<id>.timer + .service), поэтому
// выполняются, даже если панель выключена или компьютер спит. Панель только
// создаёт, показывает и удаляет их. Сведения о задании для панели лежат в
// секции [X-MethodPanel] таймера — systemd такие секции пропускает.

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const schedPrefix = "method-panel-"

var (
	schedIDRe = regexp.MustCompile(`^[0-9a-f]{8}$`)
	dateRe    = regexp.MustCompile(`^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$`)
	clockRe   = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
	tzRe      = regexp.MustCompile(`^(UTC|[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2})$`)
	weekDays  = map[string]bool{"Mon": true, "Tue": true, "Wed": true, "Thu": true, "Fri": true, "Sat": true, "Sun": true}
	dayOrder  = []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
)

type SchedTask struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`             // reboot | service | scenario
	Target    string `json:"target,omitempty"` // служба или id сценария
	TargetNm  string `json:"targetName,omitempty"`
	Repeat    string `json:"repeat"` // once | daily | weekly | monthly
	Spec      string `json:"spec"`   // OnCalendar
	RunAs     string `json:"runAs,omitempty"`
	Created   int64  `json:"created,omitempty"`
	Next      int64  `json:"next,omitempty"` // unix, 0 — больше не сработает
	Last      int64  `json:"last,omitempty"` // последнее срабатывание таймера
	Ran       int64  `json:"ran,omitempty"`  // последний запуск службы (в том числе вручную)
	Enabled   bool   `json:"enabled"`
	Running   bool   `json:"running"`
	Result    string `json:"result,omitempty"` // success | exit-code | …
	ExitCode  int    `json:"exitCode"`
	Repeating bool   `json:"repeating"`
}

const schedListScript = `export LC_ALL=C TZ=UTC
ts() { case "$1" in ""|n/a) echo ;; *) date -d "$1" +%s 2>/dev/null ;; esac; }
for f in /etc/systemd/system/` + schedPrefix + `*.timer; do
  [ -e "$f" ] || continue
  u=$(basename "$f" .timer)
  echo "@@T $u"
  sed -n '/^\[X-MethodPanel\]/,/^\[/p' "$f" | grep -v '^\['
  grep -m1 '^OnCalendar=' "$f"
  echo "Next=$(ts "$(systemctl show -p NextElapseUSecRealtime --value "$u.timer" 2>/dev/null)")"
  echo "Last=$(ts "$(systemctl show -p LastTriggerUSec --value "$u.timer" 2>/dev/null)")"
  echo "Ran=$(ts "$(systemctl show -p ExecMainStartTimestamp --value "$u.service" 2>/dev/null)")"
  echo "Enabled=$(systemctl is-enabled "$u.timer" 2>/dev/null)"
  echo "SvcState=$(systemctl show -p ActiveState --value "$u.service" 2>/dev/null)"
  echo "Result=$(systemctl show -p Result --value "$u.service" 2>/dev/null)"
  echo "ExitStatus=$(systemctl show -p ExecMainStatus --value "$u.service" 2>/dev/null)"
done
echo "@@TZ $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)"
`

func parseSchedList(out string) ([]SchedTask, string) {
	var tasks []SchedTask
	var cur *SchedTask
	tz := ""
	flush := func() {
		if cur != nil {
			tasks = append(tasks, *cur)
		}
	}
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@T ") {
			flush()
			id := strings.TrimPrefix(strings.TrimSpace(l[4:]), schedPrefix)
			cur = &SchedTask{ID: id}
			continue
		}
		if strings.HasPrefix(l, "@@TZ") {
			tz = strings.TrimSpace(strings.TrimPrefix(l, "@@TZ"))
			continue
		}
		if cur == nil {
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "Name":
			cur.Name = v
		case "Kind":
			cur.Kind = v
		case "Target":
			cur.Target = v
		case "TargetName":
			cur.TargetNm = v
		case "Repeat":
			cur.Repeat = v
		case "RunAs":
			cur.RunAs = v
		case "Created":
			cur.Created, _ = strconv.ParseInt(v, 10, 64)
		case "OnCalendar":
			cur.Spec = v
		case "Next":
			cur.Next, _ = strconv.ParseInt(v, 10, 64)
		case "Last":
			cur.Last, _ = strconv.ParseInt(v, 10, 64)
		case "Ran":
			cur.Ran, _ = strconv.ParseInt(v, 10, 64)
		case "Enabled":
			cur.Enabled = v == "enabled"
		case "SvcState":
			cur.Running = v == "activating" || v == "active" || v == "deactivating"
		case "Result":
			cur.Result = v
		case "ExitStatus":
			cur.ExitCode, _ = strconv.Atoi(v)
		}
	}
	flush()
	for i := range tasks {
		tasks[i].Repeating = tasks[i].Repeat != "once"
		if tasks[i].Name == "" {
			tasks[i].Name = schedPrefix + tasks[i].ID
		}
	}
	sort.SliceStable(tasks, func(i, j int) bool {
		a, b := tasks[i], tasks[j]
		if (a.Next == 0) != (b.Next == 0) {
			return a.Next != 0
		}
		if a.Next != b.Next {
			return a.Next < b.Next
		}
		return a.Created < b.Created
	})
	return tasks, tz
}

func (a *App) handleSchedule(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	in := m.ensureInfo(ctx)
	res := a.runScript(ctx, &srv, schedListScript)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	tasks, tz := parseSchedList(res.Stdout)
	writeJSON(w, 200, map[string]any{
		"tasks":      tasks,
		"tz":         tz,
		"privileged": in != nil && (in.UID == 0 || in.Sudo),
		"systemd":    in == nil || in.Systemd,
		"user":       srv.User,
	})
}

// unitText — значение для строки unit-файла: одна строка, % удвоены
// (systemd подставляет %-спецификаторы в Description).
func unitText(s string) string {
	s = cleanLine(s, 200)
	s = strings.TrimRight(s, "\\")
	return strings.ReplaceAll(s, "%", "%%")
}

// metaText — значение для секции [X-MethodPanel]: её systemd не разбирает,
// но обратный слеш в конце строки всё равно склеил бы её со следующей.
func metaText(s string) string {
	return strings.TrimRight(cleanLine(s, 120), "\\")
}

type schedReq struct {
	Name     string   `json:"name"`
	Kind     string   `json:"kind"`
	Target   string   `json:"target"`
	Repeat   string   `json:"repeat"`
	Date     string   `json:"date"`
	Time     string   `json:"time"`
	Days     []string `json:"days"`
	MonthDay int      `json:"monthDay"`
	TZ       string   `json:"tz"`
}

// calendarSpec собирает OnCalendar из проверенных частей.
func (q schedReq) calendarSpec() (string, string) {
	if !clockRe.MatchString(q.Time) {
		return "", "укажите время в формате ЧЧ:ММ"
	}
	tz := q.TZ
	if tz == "" {
		tz = "UTC"
	}
	if !tzRe.MatchString(tz) {
		return "", "неизвестный часовой пояс"
	}
	at := q.Time + ":00 " + tz
	switch q.Repeat {
	case "once":
		if !dateRe.MatchString(q.Date) {
			return "", "укажите дату"
		}
		return q.Date + " " + at, ""
	case "daily":
		return "*-*-* " + at, ""
	case "weekly":
		set := map[string]bool{}
		for _, d := range q.Days {
			if !weekDays[d] {
				return "", "неизвестный день недели"
			}
			set[d] = true
		}
		if len(set) == 0 {
			return "", "выберите дни недели"
		}
		var ds []string
		for _, d := range dayOrder {
			if set[d] {
				ds = append(ds, d)
			}
		}
		return strings.Join(ds, ",") + " *-*-* " + at, ""
	case "monthly":
		if q.MonthDay < 1 || q.MonthDay > 28 {
			return "", "день месяца — от 1 до 28"
		}
		return fmt.Sprintf("*-*-%02d %s", q.MonthDay, at), ""
	}
	return "", "неизвестный повтор"
}

func (a *App) handleAddSchedule(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var q schedReq
	if err := readJSON(r, &q); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	spec, msg := q.calendarSpec()
	if msg != "" {
		writeErr(w, 400, msg)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	srv := m.server()
	in := m.ensureInfo(ctx)
	if in == nil {
		writeErr(w, 502, "сервер недоступен")
		return
	}
	if in.UID != 0 && !in.Sudo {
		writeErr(w, 403, "нужен root или sudo без пароля")
		return
	}
	if !in.Systemd {
		writeErr(w, 400, "на сервере нет systemd — расписание недоступно")
		return
	}

	id := newID(4)
	unit := schedPrefix + id
	name := cleanLine(q.Name, 120)
	// всё, что попадает в unit-файлы, проверено или очищено (cleanLine,
	// unitRe, userRe), а сами файлы пишутся через закавыченный heredoc —
	// на сервере в них ничего не подставляется
	var exec, runAs, target, targetName, scriptFile, scriptBody string
	timeout := "15min"
	switch q.Kind {
	case "reboot":
		exec = "@@SYSTEMCTL@@ reboot"
		if name == "" {
			name = "Перезагрузка"
		}
	case "service":
		if !unitRe.MatchString(q.Target) {
			writeErr(w, 400, "недопустимое имя службы")
			return
		}
		exec = "@@SYSTEMCTL@@ restart " + q.Target
		target = q.Target
		targetName = q.Target
		if name == "" {
			name = "Перезапуск " + strings.TrimSuffix(q.Target, ".service")
		}
	case "scenario":
		sc, ok := a.scenario(q.Target)
		if !ok {
			writeErr(w, 400, "сценарий не найден")
			return
		}
		target = sc.ID
		targetName = sc.Name
		if name == "" {
			name = sc.Name
		}
		// от root — если сценарий этого требует или мы и так root; иначе от
		// пользователя, под которым панель входит на сервер
		if !sc.Sudo && in.UID != 0 {
			if !userRe.MatchString(in.User) {
				writeErr(w, 400, "не удалось определить пользователя на сервере")
				return
			}
			runAs = in.User
		}
		scriptFile = "/etc/method-panel/" + id + ".sh"
		scriptBody = sc.Script
		exec = "/bin/sh " + scriptFile
		timeout = "1h"
		if sc.Timeout > 0 {
			timeout = strconv.Itoa(sc.Timeout) + "s"
		}
	default:
		writeErr(w, 400, "неизвестный тип задания")
		return
	}
	if name == "" {
		name = "Задание"
	}

	// путь к systemctl на этом сервере подставит sed ниже (@@SYSTEMCTL@@)
	svc := "[Unit]\nDescription=Method Panel: " + unitText(name) + "\n\n[Service]\nType=oneshot\nExecStart=" + exec + "\nTimeoutStartSec=" + timeout + "\n"
	if runAs != "" {
		svc += "User=" + runAs + "\n"
	}
	timer := fmt.Sprintf(`# Создано панелью Method Network. Удалить: systemctl disable --now %[1]s.timer
# и удалить %[1]s.timer, %[1]s.service (и /etc/method-panel/%[2]s.sh, если есть).
[Unit]
Description=Method Panel: %[3]s

[Timer]
OnCalendar=%[4]s
AccuracySec=1s
Persistent=false
Unit=%[1]s.service

[Install]
WantedBy=timers.target

[X-MethodPanel]
Name=%[5]s
Kind=%[6]s
Target=%[7]s
TargetName=%[8]s
Repeat=%[9]s
RunAs=%[10]s
Created=%[11]d
`, unit, id, unitText(name), spec, metaText(name), q.Kind, target, metaText(targetName), q.Repeat, runAs, time.Now().Unix())

	eof := "SP_EOF_" + newID(8)
	var b strings.Builder
	fmt.Fprintf(&b, "set -e\nexport LC_ALL=C\numask 022\nSC=$(command -v systemctl)\n")
	fmt.Fprintf(&b, "chk=$(systemd-analyze calendar %s 2>&1) || { echo \"@@BADSPEC $chk\" | head -3; exit 0; }\n", shq(spec))
	fmt.Fprintf(&b, "case \"$chk\" in *'Next elapse: never'*) echo @@PAST; exit 0 ;; esac\n")
	if scriptFile != "" {
		fmt.Fprintf(&b, "mkdir -p /etc/method-panel\nchmod 755 /etc/method-panel\n")
		fmt.Fprintf(&b, "cat > %s <<'%s'\n%s\n%s\n", scriptFile, eof, scriptBody, eof)
		fmt.Fprintf(&b, "chmod 700 %s\n", scriptFile)
		if runAs != "" {
			fmt.Fprintf(&b, "chown %s %s\n", shq(runAs), scriptFile)
		}
	}
	// подставляем путь к systemctl в ExecStart
	fmt.Fprintf(&b, "cat > /etc/systemd/system/%s.service <<'%s'\n%s%s\n", unit, eof, svc, eof)
	fmt.Fprintf(&b, "sed -i \"s|@@SYSTEMCTL@@|$SC|\" /etc/systemd/system/%s.service\n", unit)
	fmt.Fprintf(&b, "cat > /etc/systemd/system/%s.timer <<'%s'\n%s%s\n", unit, eof, timer, eof)
	fmt.Fprintf(&b, "$SC daemon-reload\nout=$($SC enable --now %s.timer 2>&1) || { echo \"$out\"; exit 1; }\necho @@OK\n", unit)

	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", b.String(), true, 64<<10)
	out := res.Stdout
	switch {
	case strings.Contains(out, "@@OK"):
		writeJSON(w, 200, map[string]any{"ok": true, "id": id})
	case strings.Contains(out, "@@PAST"):
		writeErr(w, 400, "это время уже прошло")
	case strings.Contains(out, "@@BADSPEC"):
		writeErr(w, 400, "сервер не принял расписание: "+lastLines(strings.TrimSpace(strings.SplitN(out, "@@BADSPEC", 2)[1]), 2))
	default:
		// не дописали — убираем то, что успели создать
		cleanup := fmt.Sprintf("SC=$(command -v systemctl); $SC disable --now %[1]s.timer >/dev/null 2>&1; rm -f /etc/systemd/system/%[1]s.timer /etc/systemd/system/%[1]s.service /etc/method-panel/%[2]s.sh; $SC daemon-reload\n", unit, id)
		a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", cleanup, true, 4096)
		msg := strings.TrimSpace(out)
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 500, "не удалось создать задание: "+lastLines(msg, 4))
	}
}

func (a *App) schedID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("tid")
	if !schedIDRe.MatchString(id) {
		writeErr(w, 400, "неверное задание")
		return "", false
	}
	return id, true
}

func (a *App) handleDeleteSchedule(w http.ResponseWriter, r *http.Request, m *Monitor) {
	id, ok := a.schedID(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	srv := m.server()
	script := fmt.Sprintf(`SC=$(command -v systemctl)
$SC disable --now %[1]s.timer >/dev/null 2>&1
rm -f /etc/systemd/system/%[1]s.timer /etc/systemd/system/%[1]s.service /etc/method-panel/%[2]s.sh || exit 1
$SC daemon-reload
$SC reset-failed %[1]s.service %[1]s.timer >/dev/null 2>&1
rmdir /etc/method-panel 2>/dev/null
[ -e /etc/systemd/system/%[1]s.timer ] || echo @@OK
`, schedPrefix+id, id)
	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", script, true, 16<<10)
	if !strings.Contains(res.Stdout, "@@OK") {
		msg := strings.TrimSpace(res.Stdout)
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 500, "не удалось удалить: "+lastLines(msg, 4))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *App) handleScheduleAction(w http.ResponseWriter, r *http.Request, m *Monitor) {
	id, ok := a.schedID(w, r)
	if !ok {
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	unit := schedPrefix + id
	var cmd string
	switch req.Action {
	case "run":
		// перезагрузку вручную не запускаем: для этого есть отдельная кнопка с подтверждением
		cmd = fmt.Sprintf(`grep -q '^Kind=reboot' /etc/systemd/system/%[1]s.timer && { echo "@@REBOOT"; exit 0; }
systemctl start --no-block %[1]s.service 2>&1 && echo @@OK`, unit)
	case "pause":
		cmd = fmt.Sprintf("systemctl disable --now %s.timer 2>&1 && echo @@OK", unit)
	case "resume":
		cmd = fmt.Sprintf("systemctl enable --now %s.timer 2>&1 && echo @@OK", unit)
	default:
		writeErr(w, 400, "неизвестное действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", "[ -e /etc/systemd/system/"+unit+".timer ] || { echo 'задание не найдено'; exit 1; }\n"+cmd+"\n", true, 16<<10)
	switch {
	case strings.Contains(res.Stdout, "@@REBOOT"):
		writeErr(w, 400, "перезагрузку по расписанию нельзя запустить вручную — используйте кнопку «Перезагрузить»")
	case strings.Contains(res.Stdout, "@@OK"):
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		msg := strings.TrimSpace(res.Stdout)
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 500, lastLines(msg, 4))
	}
}

func (a *App) handleScheduleLog(w http.ResponseWriter, r *http.Request, m *Monitor) {
	id, ok := a.schedID(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	script := fmt.Sprintf("export LC_ALL=C\n%sjournalctl -u %s.service -o short-iso --no-pager -n 300 2>&1\n", m.sudo(ctx), schedPrefix+id)
	res := a.runScript(ctx, &srv, script)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	log := strings.TrimSpace(res.Stdout)
	if log == "-- No entries --" {
		log = ""
	}
	writeJSON(w, 200, map[string]any{"log": log})
}
