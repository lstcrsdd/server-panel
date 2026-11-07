package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// sshArgs — аргументы ssh для сервера. Для хостов из ~/.ssh/config передаётся
// только алиас, поэтому работают все ваши IdentityFile, ProxyJump, Tailscale и
// т. д. Соединения мультиплексируются (ControlMaster), чтобы команды
// управления не открывали новое SSH-подключение каждый раз.
func (a *App) sshArgs(s *Server) []string {
	args := []string{"-T", "-o", "BatchMode=yes"}
	if useControlMaster {
		args = append(args,
			"-o", "ControlMaster=auto",
			"-o", "ControlPath="+sshQuote(a.cmDir+"/%C"),
			"-o", "ControlPersist=120")
	}
	args = append(args,
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=3",
		"-o", "LogLevel=ERROR",
	)
	if s.Source == "manual" {
		args = append(args, "-o", "ConnectTimeout=12")
		args = append(args, a.hostKeyArgs(s)...)
		if s.Port > 0 {
			args = append(args, "-p", strconv.Itoa(s.Port))
		}
		if s.User != "" {
			args = append(args, "-l", s.User)
		}
		if s.KeyFile != "" {
			args = append(args, "-i", expandHome(s.KeyFile), "-o", "IdentitiesOnly=yes")
		}
		return append(args, "--", sshHost(s.Host))
	}
	return append(args, "--", s.Alias)
}

// hostKeyArgs — проверка ключа хоста. Серверы, добавленные мастером, сверяются
// с ключом, который пользователь подтвердил при добавлении (known_hosts панели,
// запись по id сервера). Старые записи — как раньше, «доверять при первом входе».
func (a *App) hostKeyArgs(s *Server) []string {
	if s.Pinned {
		return []string{
			"-o", "StrictHostKeyChecking=yes",
			"-o", "UserKnownHostsFile=" + sshQuote(a.knownHostsPath()),
			"-o", "GlobalKnownHostsFile=none",
			"-o", "HostKeyAlias=" + s.ID,
			"-o", "UpdateHostKeys=no",
		}
	}
	return []string{"-o", "StrictHostKeyChecking=accept-new"}
}

// sshQuote заключает значение опции -o в кавычки: иначе путь с пробелом
// (C:\Users\Имя Фамилия\…) ssh разберёт как несколько значений.
func sshQuote(v string) string {
	if strings.ContainsAny(v, " \t\"") {
		return `"` + strings.ReplaceAll(v, `"`, ``) + `"`
	}
	return v
}

// sshHost убирает квадратные скобки у IPv6-адреса: ssh ждёт его без них.
func sshHost(h string) string { return strings.TrimSuffix(strings.TrimPrefix(h, "["), "]") }

type RunResult struct {
	Stdout    string
	Stderr    string
	Code      int
	Err       error
	Duration  time.Duration
	Truncated bool
}

// errText — понятное описание ошибки выполнения.
func (r RunResult) errText() string {
	if msg := sshError(r.Stderr); msg != "" {
		return msg
	}
	if s := strings.TrimSpace(r.Stderr); s != "" {
		return lastLines(s, 6)
	}
	if r.Err != nil {
		if errors.Is(r.Err, context.DeadlineExceeded) {
			return "превышено время ожидания"
		}
		return r.Err.Error()
	}
	if r.Code != 0 {
		return "команда завершилась с кодом " + strconv.Itoa(r.Code)
	}
	return ""
}

// runSSH выполняет команду на сервере. stdin передаётся удалённой команде.
// combined=true — stderr пишется в тот же буфер, что и stdout.
func (a *App) runSSH(ctx context.Context, s *Server, remoteCmd, stdin string, combined bool, limit int) RunResult {
	args := append(a.sshArgs(s), remoteCmd)
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(stdin)
	out := &limitedBuffer{max: limit}
	errb := &limitedBuffer{max: 64 * 1024}
	cmd.Stdout = out
	if combined {
		cmd.Stderr = out
	} else {
		cmd.Stderr = errb
	}
	cmd.WaitDelay = 2 * time.Second
	start := time.Now()
	err := cmd.Run()
	res := RunResult{Stdout: out.String(), Stderr: errb.String(), Duration: time.Since(start), Truncated: out.truncated}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			res.Code = ee.ExitCode()
		} else {
			res.Code = -1
		}
		if ctx.Err() != nil {
			res.Err = ctx.Err()
		} else if res.Code < 0 || !errors.As(err, &ee) {
			res.Err = err
		}
	}
	// 255 — код ошибки самого ssh (нет связи, ключ не подошёл…)
	if res.Code == 255 && res.Err == nil && sshError(res.Stderr+res.Stdout) != "" {
		res.Err = errors.New(sshError(res.Stderr + res.Stdout))
	}
	return res
}

// runScript выполняет shell-скрипт через `sh -s` (скрипт идёт по stdin, без
// проблем с экранированием командной строки).
func (a *App) runScript(ctx context.Context, s *Server, script string) RunResult {
	return a.runSSH(ctx, s, "sh -s", script, false, 16<<20)
}

func (a *App) closeMaster(s *Server) {
	if !useControlMaster {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	args := a.sshArgs(s)
	// "-O exit" вставляем перед "--"
	for i, v := range args {
		if v == "--" {
			args = append(append(append([]string{}, args[:i]...), "-O", "exit"), args[i:]...)
			break
		}
	}
	_ = exec.CommandContext(ctx, "ssh", args...).Run()
}

var sshErrHints = []struct{ needle, text string }{
	{"Permission denied", "Ключ не подошёл (Permission denied)"},
	{"Host key verification failed", "Ключ хоста не совпадает с known_hosts (Host key verification failed)"},
	{"REMOTE HOST IDENTIFICATION HAS CHANGED", "Ключ хоста изменился — проверьте known_hosts"},
	{"Could not resolve hostname", "Не удалось найти хост (DNS)"},
	{"Connection refused", "Соединение отклонено (порт SSH закрыт)"},
	{"Connection timed out", "Сервер не отвечает (таймаут)"},
	{"Operation timed out", "Сервер не отвечает (таймаут)"},
	{"No route to host", "Нет маршрута до хоста"},
	{"Network is unreachable", "Сеть недоступна"},
	{"Connection closed by", "Сервер закрыл соединение"},
	{"Connection reset", "Соединение сброшено"},
	{"Too many authentication failures", "Слишком много попыток аутентификации"},
	{"no such identity", "Файл ключа не найден"},
	{"Timeout, server", "Сервер перестал отвечать"},
	{"Broken pipe", "Соединение оборвалось"},
}

func sshError(stderr string) string {
	for _, h := range sshErrHints {
		if strings.Contains(stderr, h.needle) {
			return h.text
		}
	}
	return ""
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'" }

// limitedBuffer — буфер с ограничением размера (лишнее отбрасывается).
type limitedBuffer struct {
	mu        sync.Mutex
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.max > 0 && b.buf.Len()+len(p) > b.max {
		room := b.max - b.buf.Len()
		if room > 0 {
			b.buf.Write(p[:room])
		}
		b.truncated = true
		return len(p), nil
	}
	return b.buf.Write(p)
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// tailBuffer хранит только последние max байт.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = append([]byte(nil), b.buf[len(b.buf)-b.max:]...)
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// lineWriter режет поток на строки и отдаёт их обработчику.
type lineWriter struct {
	buf []byte
	fn  func(string)
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		w.fn(string(w.buf[:i]))
		w.buf = w.buf[i+1:]
	}
	if len(w.buf) > 1<<20 {
		w.buf = nil
	}
	return len(p), nil
}

// ---------- SSE-рассылка ----------

type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	closed  bool
}

func newHub() *Hub { return &Hub{clients: map[chan []byte]struct{}{}} }

func (h *Hub) subscribe() chan []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := make(chan []byte, 512)
	if h.closed {
		close(c)
		return c
	}
	h.clients[c] = struct{}{}
	return c
}

func (h *Hub) unsubscribe(c chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c)
	}
}

func (h *Hub) send(event string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	msg := sseMessage(event, data)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c <- msg:
		default: // медленный клиент — пропускаем кадр
		}
	}
}

func (h *Hub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for c := range h.clients {
		close(c)
		delete(h.clients, c)
	}
}

func sseMessage(event string, data []byte) []byte {
	var b bytes.Buffer
	b.WriteString("event: ")
	b.WriteString(event)
	b.WriteString("\ndata: ")
	b.Write(data)
	b.WriteString("\n\n")
	return b.Bytes()
}
