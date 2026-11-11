package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/stream", a.handleStream)
	mux.HandleFunc("GET /api/servers", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, a.views(true))
	})
	mux.HandleFunc("POST /api/servers", a.handleAddServer)
	mux.HandleFunc("POST /api/servers/reload", func(w http.ResponseWriter, r *http.Request) {
		a.syncServers()
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("POST /api/servers/probe", a.handleProbe)
	mux.HandleFunc("PUT /api/servers/order", a.handleOrder)
	mux.HandleFunc("GET /api/setup", a.handleSetup)
	mux.HandleFunc("GET /api/ssh-hosts", a.handleSSHHosts)
	mux.HandleFunc("PUT /api/ssh-hosts", a.handleSSHHostsSave)
	mux.HandleFunc("PATCH /api/servers/{id}", a.handleUpdateServer)
	mux.HandleFunc("DELETE /api/servers/{id}", a.handleDeleteServer)
	mux.HandleFunc("POST /api/servers/{id}/test", a.withMon(a.handleTestServer))
	mux.HandleFunc("POST /api/servers/{id}/reconnect", a.withMon(a.handleReconnect))
	mux.HandleFunc("GET /api/servers/{id}/history", a.withMon(a.handleHistory))
	mux.HandleFunc("GET /api/servers/{id}/procs", a.withMon(a.handleProcs))
	mux.HandleFunc("POST /api/servers/{id}/procs/kill", a.withMon(a.handleKill))
	mux.HandleFunc("GET /api/servers/{id}/services", a.withMon(a.handleServices))
	mux.HandleFunc("POST /api/servers/{id}/services/action", a.withMon(a.handleServiceAction))
	mux.HandleFunc("GET /api/servers/{id}/logs", a.withMon(a.handleLogs))
	mux.HandleFunc("GET /api/servers/{id}/network", a.withMon(a.handleNetwork))
	mux.HandleFunc("GET /api/servers/{id}/docker", a.withMon(a.handleDocker))
	mux.HandleFunc("POST /api/servers/{id}/docker/action", a.withMon(a.handleDockerAction))
	mux.HandleFunc("GET /api/servers/{id}/docker/logs", a.withMon(a.handleDockerLogs))
	mux.HandleFunc("POST /api/servers/{id}/exec", a.withMon(a.handleExec))
	mux.HandleFunc("POST /api/servers/{id}/reboot", a.withMon(a.handleReboot))
	mux.HandleFunc("GET /api/servers/{id}/vpn", a.withMon(a.handleVPN))
	mux.HandleFunc("GET /api/servers/{id}/term", a.withMon(a.handleTermList))
	mux.HandleFunc("POST /api/servers/{id}/term", a.withMon(a.handleTermOpen))
	mux.HandleFunc("GET /api/term/{tid}/stream", a.handleTermStream)
	mux.HandleFunc("POST /api/term/{tid}/input", a.handleTermInput)
	mux.HandleFunc("POST /api/term/{tid}/resize", a.handleTermResize)
	mux.HandleFunc("DELETE /api/term/{tid}", a.handleTermClose)
	mux.HandleFunc("GET /api/servers/{id}/system", a.withMon(a.handleSystem))
	mux.HandleFunc("POST /api/servers/{id}/system/apt", a.withMon(a.handleAptJob))
	mux.HandleFunc("GET /api/servers/{id}/system/job", a.withMon(a.handleAptJobLog))
	mux.HandleFunc("POST /api/servers/{id}/system/unban", a.withMon(a.handleUnban))
	mux.HandleFunc("GET /api/servers/{id}/files/list", a.withMon(a.handleFileList))
	mux.HandleFunc("GET /api/servers/{id}/files/read", a.withMon(a.handleFileRead))
	mux.HandleFunc("POST /api/servers/{id}/files/write", a.withMon(a.handleFileWrite))
	mux.HandleFunc("POST /api/servers/{id}/files/op", a.withMon(a.handleFileOp))
	mux.HandleFunc("GET /api/servers/{id}/files/download", a.withMon(a.handleFileDownload))
	mux.HandleFunc("POST /api/servers/{id}/files/upload", a.withMon(a.handleFileUpload))
	mux.HandleFunc("GET /api/servers/{id}/hardware", a.withMon(a.handleHardware))
	mux.HandleFunc("POST /api/servers/{id}/sensors", a.withMon(a.handleSensors))
	mux.HandleFunc("GET /api/servers/{id}/watchdog", a.withMon(a.handleWatchdog))
	mux.HandleFunc("POST /api/servers/{id}/watchdog", a.withMon(a.handleWatchdogAction))
	mux.HandleFunc("GET /api/servers/{id}/schedule", a.withMon(a.handleSchedule))
	mux.HandleFunc("POST /api/servers/{id}/schedule", a.withMon(a.handleAddSchedule))
	mux.HandleFunc("DELETE /api/servers/{id}/schedule/{tid}", a.withMon(a.handleDeleteSchedule))
	mux.HandleFunc("POST /api/servers/{id}/schedule/{tid}/action", a.withMon(a.handleScheduleAction))
	mux.HandleFunc("GET /api/servers/{id}/schedule/{tid}/log", a.withMon(a.handleScheduleLog))
	mux.HandleFunc("GET /api/notes", a.handleNotes)
	mux.HandleFunc("POST /api/notes", a.handleAddNote)
	mux.HandleFunc("PUT /api/notes/{nid}", a.handleUpdateNote)
	mux.HandleFunc("DELETE /api/notes/{nid}", a.handleDeleteNote)
	mux.HandleFunc("GET /api/checks", a.handleChecks)
	mux.HandleFunc("POST /api/checks", a.handleAddCheck)
	mux.HandleFunc("PUT /api/checks/{cid}", a.handleUpdateCheck)
	mux.HandleFunc("DELETE /api/checks/{cid}", a.handleDeleteCheck)
	mux.HandleFunc("POST /api/checks/{cid}/run", a.handleRunCheck)
	mux.HandleFunc("GET /api/scenarios", a.handleScenarios)
	mux.HandleFunc("POST /api/scenarios", a.handleAddScenario)
	mux.HandleFunc("PUT /api/scenarios/{sid}", a.handleUpdateScenario)
	mux.HandleFunc("DELETE /api/scenarios/{sid}", a.handleDeleteScenario)
	mux.HandleFunc("GET /api/keys", a.handleKeys)
	mux.HandleFunc("GET /api/alerts", a.handleAlerts)
	mux.HandleFunc("PUT /api/alerts/config", a.handleAlertConfig)
	mux.HandleFunc("POST /api/alerts/test", a.handleAlertTest)
	mux.HandleFunc("POST /api/alerts/telegram-chats", a.handleTelegramChats)
	mux.HandleFunc("DELETE /api/alerts/events", a.handleAlertEventsClear)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	return json.NewDecoder(r.Body).Decode(v)
}

type monHandler func(w http.ResponseWriter, r *http.Request, m *Monitor)

func (a *App) withMon(h monHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m := a.monitor(r.PathValue("id"))
		if m == nil {
			writeErr(w, 404, "сервер не найден")
			return
		}
		h(w, r, m)
	}
}

// ---------- поток событий ----------

func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	ch := a.hub.subscribe()
	defer a.hub.unsubscribe(ch)

	a.alerts.mu.Lock()
	firing := a.alerts.firingList()
	a.alerts.mu.Unlock()
	hello, _ := json.Marshal(map[string]any{"servers": a.views(true), "interval": a.interval.Milliseconds(), "firing": firing, "setup": a.setupInfo(),
		"notes": a.notesCopy(), "scenarios": a.scenariosCopy()})
	w.Write([]byte("retry: 3000\n"))
	w.Write(sseMessage("hello", hello))
	fl.Flush()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			fl.Flush()
		case <-ping.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func (a *App) handleReconnect(w http.ResponseWriter, r *http.Request, m *Monitor) {
	m.mu.Lock()
	m.info = nil
	m.mu.Unlock()
	go m.restart(a.ctx)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- история ----------

func (a *App) handleHistory(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ranges := map[string]time.Duration{"5m": 5 * time.Minute, "15m": 15 * time.Minute, "1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}
	d, ok := ranges[r.URL.Query().Get("range")]
	if !ok {
		d = 15 * time.Minute
	}
	pts, step := m.history(d)
	writeJSON(w, 200, map[string]any{"points": pts, "step": step, "now": time.Now().UnixMilli()})
}

// ---------- процессы ----------

func (a *App) handleProcs(w http.ResponseWriter, r *http.Request, m *Monitor) {
	srv := m.server()
	a.procMu.Lock()
	prev := a.procCache[srv.ID]
	a.procMu.Unlock()
	double := prev == nil || time.Since(prev.at) > 20*time.Second

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res := a.runScript(ctx, &srv, procScript(double))
	if res.Err != nil || (res.Code != 0 && !strings.Contains(res.Stdout, "@@E")) {
		writeErr(w, 502, res.errText())
		return
	}
	po := parseProcOutput(res.Stdout)
	var base *procSample
	if !double {
		base = prev
	}
	procs, sample := buildProcs(po, base)
	if sample != nil {
		a.procMu.Lock()
		a.procCache[srv.ID] = sample
		a.procMu.Unlock()
	}
	cores := 0
	if in := m.ensureInfo(ctx); in != nil {
		cores = in.Cores
	}
	writeJSON(w, 200, map[string]any{"procs": procs, "memTotal": po.memTotal, "cores": cores})
}

func (a *App) handleKill(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		PID    int    `json:"pid"`
		Signal string `json:"signal"`
	}
	if err := readJSON(r, &req); err != nil || req.PID <= 1 {
		writeErr(w, 400, "неверный PID")
		return
	}
	sigs := map[string]bool{"TERM": true, "KILL": true, "HUP": true, "INT": true}
	if !sigs[req.Signal] {
		writeErr(w, 400, "недопустимый сигнал")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	srv := m.server()
	script := fmt.Sprintf("%skill -s %s %d 2>&1", m.sudo(ctx), req.Signal, req.PID)
	res := a.runScript(ctx, &srv, script)
	actionResult(w, res)
}

func actionResult(w http.ResponseWriter, res RunResult) {
	if res.Err != nil || res.Code != 0 {
		msg := strings.TrimSpace(res.Stdout)
		if msg == "" {
			msg = res.errText()
		}
		writeJSON(w, 200, map[string]any{"ok": false, "error": lastLines(msg, 8), "code": res.Code})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "output": strings.TrimSpace(res.Stdout)})
}

// ---------- службы ----------

func (a *App) handleServices(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, servicesScript)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	writeJSON(w, 200, map[string]any{"services": parseServices(res.Stdout)})
}

func (a *App) handleServiceAction(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Unit   string `json:"unit"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil || !unitRe.MatchString(req.Unit) {
		writeErr(w, 400, "недопустимое имя службы")
		return
	}
	actions := map[string]bool{"start": true, "stop": true, "restart": true, "reload": true, "enable": true, "disable": true}
	if !actions[req.Action] {
		writeErr(w, 400, "недопустимое действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	srv := m.server()
	script := fmt.Sprintf("%ssystemctl %s %s 2>&1", m.sudo(ctx), req.Action, shq(req.Unit))
	actionResult(w, a.runScript(ctx, &srv, script))
}

// ---------- журнал ----------

func (a *App) handleLogs(w http.ResponseWriter, r *http.Request, m *Monitor) {
	q := r.URL.Query()
	lines, _ := strconv.Atoi(q.Get("lines"))
	if lines <= 0 {
		lines = 300
	}
	if lines > 5000 {
		lines = 5000
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	in := m.ensureInfo(ctx)
	sudo := m.sudo(ctx)

	if in != nil && !in.Journal {
		script := fmt.Sprintf("%stail -n %d /var/log/syslog 2>/dev/null || %stail -n %d /var/log/messages 2>&1", sudo, lines, sudo, lines)
		res := a.runScript(ctx, &srv, script)
		var entries []LogEntry
		for _, l := range strings.Split(strings.TrimRight(res.Stdout, "\n"), "\n") {
			if l != "" {
				entries = append(entries, LogEntry{Prio: 6, Msg: l})
			}
		}
		writeJSON(w, 200, map[string]any{"entries": entries, "plain": true})
		return
	}

	args := []string{"journalctl", "--no-pager", "-o", "json",
		"--output-fields=MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,_PID,_SYSTEMD_UNIT,_COMM", "-n", strconv.Itoa(lines)}
	switch unit := q.Get("unit"); {
	case unit == "":
	case unit == "kernel":
		args = append(args, "-k")
	case unitRe.MatchString(unit) || unitRe.MatchString(unit+".service"):
		args = append(args, "-u", shq(unit))
	default:
		writeErr(w, 400, "недопустимое имя службы")
		return
	}
	if p := q.Get("prio"); p != "" {
		if n, err := strconv.Atoi(p); err == nil && n >= 0 && n <= 7 {
			args = append(args, "-p", strconv.Itoa(n))
		}
	}
	if c := q.Get("after"); c != "" {
		if len(c) > 512 {
			writeErr(w, 400, "неверный курсор")
			return
		}
		args = append(args, "--after-cursor="+shq(c))
	}
	res := a.runScript(ctx, &srv, sudo+strings.Join(args, " ")+" 2>&1")
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	entries, cursor, notes := parseJournal(res.Stdout)
	if entries == nil {
		entries = []LogEntry{}
	}
	writeJSON(w, 200, map[string]any{"entries": entries, "cursor": cursor, "notes": notes})
}

// ---------- сеть ----------

func (a *App) handleNetwork(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, fmt.Sprintf(networkScript, m.sudo(ctx)))
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	writeJSON(w, 200, parseNetwork(res.Stdout))
}

// ---------- docker ----------

func (a *App) handleDocker(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	srv := m.server()
	d := m.sudo(ctx) + "docker"
	script := fmt.Sprintf(`%s ps -a --no-trunc --format '{{json .}}' 2>&1
echo @@S
%s stats --no-stream --no-trunc --format '{{json .}}' 2>/dev/null
`, d, d)
	res := a.runScript(ctx, &srv, script)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	psOut, statsOut, _ := strings.Cut(res.Stdout, "@@S")
	containers := parseJSONLines(psOut)
	if containers == nil {
		if msg := strings.TrimSpace(psOut); msg != "" {
			writeErr(w, 502, lastLines(msg, 4))
			return
		}
		containers = []map[string]any{}
	}
	stats := parseJSONLines(statsOut)
	if stats == nil {
		stats = []map[string]any{}
	}
	writeJSON(w, 200, map[string]any{"containers": containers, "stats": stats})
}

func (a *App) handleDockerAction(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Container string `json:"container"`
		Action    string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil || !containerRe.MatchString(req.Container) {
		writeErr(w, 400, "недопустимое имя контейнера")
		return
	}
	actions := map[string]bool{"start": true, "stop": true, "restart": true, "pause": true, "unpause": true}
	if !actions[req.Action] {
		writeErr(w, 400, "недопустимое действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	srv := m.server()
	actionResult(w, a.runScript(ctx, &srv, fmt.Sprintf("%sdocker %s %s 2>&1", m.sudo(ctx), req.Action, shq(req.Container))))
}

func (a *App) handleDockerLogs(w http.ResponseWriter, r *http.Request, m *Monitor) {
	c := r.URL.Query().Get("container")
	if !containerRe.MatchString(c) {
		writeErr(w, 400, "недопустимое имя контейнера")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runSSH(ctx, &srv, "sh -s", fmt.Sprintf("%sdocker logs --tail 500 --timestamps %s 2>&1", m.sudo(ctx), shq(c)), true, 4<<20)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	writeJSON(w, 200, map[string]any{"output": res.Stdout})
}

// ---------- консоль и питание ----------

func (a *App) handleExec(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Cmd     string `json:"cmd"`
		Sudo    bool   `json:"sudo"`
		Timeout int    `json:"timeout"` // секунд; сценарии могут работать дольше обычной команды
	}
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Cmd) == "" {
		writeErr(w, 400, "пустая команда")
		return
	}
	limit := 120 * time.Second
	if req.Timeout > 0 && req.Timeout <= 3600 {
		limit = time.Duration(req.Timeout) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), limit)
	defer cancel()
	srv := m.server()
	prefix := ""
	if req.Sudo {
		prefix = m.sudo(ctx)
	}
	remote := fmt.Sprintf("if command -v bash >/dev/null 2>&1; then exec %sbash -s; else exec %ssh -s; fi", prefix, prefix)
	res := a.runSSH(ctx, &srv, remote, req.Cmd+"\n", true, 2<<20)
	out := map[string]any{"output": res.Stdout, "code": res.Code, "ms": res.Duration.Milliseconds(), "truncated": res.Truncated}
	if res.Err != nil {
		out["error"] = res.errText()
	}
	writeJSON(w, 200, out)
}

func (a *App) handleReboot(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Confirm string `json:"confirm"`
	}
	srv := m.server()
	if err := readJSON(r, &req); err != nil || (req.Confirm != srv.Name && req.Confirm != srv.ID) {
		writeErr(w, 400, "подтверждение не совпадает с названием сервера")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if in := m.ensureInfo(ctx); in != nil && in.UID != 0 && !in.Sudo {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "нет прав: нужен root или sudo без пароля"})
		return
	}
	s := m.sudo(ctx)
	res := a.runScript(ctx, &srv, fmt.Sprintf("(sleep 1; %ssystemctl reboot || %sreboot) >/dev/null 2>&1 &\necho scheduled", s, s))
	if !strings.Contains(res.Stdout, "scheduled") {
		writeJSON(w, 200, map[string]any{"ok": false, "error": res.errText()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
