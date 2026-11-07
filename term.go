package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"time"
)

// ptyProc — ssh, запущенный в псевдотерминале. В macOS и Linux это /dev/ptmx
// (term_unix.go), в Windows — ConPTY (term_windows.go).
type ptyProc interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows int) error
	Hangup()            // мягко завершить (SIGHUP / закрыть консоль)
	Kill()              // принудительно
	Wait() (int, error) // код выхода; ошибка — только если его не узнать
	Close() error
}

// ---------- терминал: ssh -tt в локальном псевдотерминале ----------

const (
	termRing    = 128 << 10        // столько последнего вывода помним для переподключения
	termIdle    = 15 * time.Minute // закрываем сессию, если к ней долго никто не подключён
	termMaxOpen = 16
)

type termSession struct {
	ID      string `json:"id"`
	Server  string `json:"server"`
	Created int64  `json:"created"`

	mu      sync.Mutex
	p       ptyProc
	ring    []byte
	subs    map[chan []byte]struct{}
	done    bool
	exitMsg string
	idleAt  time.Time // с какого момента нет подписчиков
	inMu    sync.Mutex
}

type termManager struct {
	mu   sync.Mutex
	sess map[string]*termSession
}

func newTermManager() *termManager { return &termManager{sess: map[string]*termSession{}} }

func (a *App) termArgs(s *Server) []string {
	args := a.sshArgs(s)
	for i, x := range args {
		if x == "-T" {
			args[i] = "-tt"
		}
	}
	return args
}

func (a *App) startTerm(srv Server, cols, rows int) (*termSession, error) {
	a.terms.mu.Lock()
	n := 0
	for _, t := range a.terms.sess {
		if !t.isDone() {
			n++
		}
	}
	a.terms.mu.Unlock()
	if n >= termMaxOpen {
		return nil, errors.New("открыто слишком много терминалов — закройте ненужные")
	}
	env := os.Environ()
	env = append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
	if os.Getenv("LANG") == "" {
		env = append(env, "LANG=en_US.UTF-8")
	}
	p, err := startPTY(append([]string{"ssh"}, a.termArgs(&srv)...), env, cols, rows)
	if err != nil {
		return nil, fmt.Errorf("не удалось запустить терминал: %v", err)
	}
	t := &termSession{ID: randToken() + randToken(), Server: srv.ID, Created: time.Now().UnixMilli(),
		p: p, subs: map[chan []byte]struct{}{}, idleAt: time.Now()}
	a.terms.mu.Lock()
	a.terms.sess[t.ID] = t
	a.terms.mu.Unlock()
	go t.pump()
	return t, nil
}

func (t *termSession) isDone() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.done
}

// pump читает вывод ssh и рассылает его подписчикам.
func (t *termSession) pump() {
	buf := make([]byte, 32<<10)
	for {
		n, err := t.p.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			t.mu.Lock()
			t.ring = append(t.ring, chunk...)
			if len(t.ring) > termRing {
				t.ring = append([]byte(nil), t.ring[len(t.ring)-termRing:]...)
			}
			msg := termMsg("o", chunk)
			for c := range t.subs {
				select {
				case c <- msg:
				default: // клиент не успевает — отключаем, при переподключении он получит буфер
					delete(t.subs, c)
					close(c)
				}
			}
			t.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	code, _ := t.p.Wait()
	msg := "соединение закрыто"
	if code == 255 {
		msg = "ssh: нет связи с сервером или соединение прервано"
	} else if code > 0 {
		msg = fmt.Sprintf("сессия завершена (код %d)", code)
	}
	t.p.Close()
	t.mu.Lock()
	t.done, t.exitMsg = true, msg
	b, _ := json.Marshal(map[string]string{"msg": msg})
	for c := range t.subs {
		select {
		case c <- sseMessage("x", b):
		default:
		}
		close(c)
	}
	t.subs = map[chan []byte]struct{}{}
	t.mu.Unlock()
}

func termMsg(event string, data []byte) []byte {
	return sseMessage(event, []byte(`"`+base64.StdEncoding.EncodeToString(data)+`"`))
}

func (t *termSession) subscribe() (chan []byte, []byte, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := make(chan []byte, 1024)
	replay := append([]byte(nil), t.ring...)
	if t.done {
		close(c)
		return c, replay, true
	}
	t.subs[c] = struct{}{}
	return c, replay, false
}

func (t *termSession) unsubscribe(c chan []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.subs[c]; ok {
		delete(t.subs, c)
		close(c)
	}
	if len(t.subs) == 0 {
		t.idleAt = time.Now()
	}
}

func (t *termSession) kill() {
	t.mu.Lock()
	done := t.done
	t.mu.Unlock()
	if !done {
		t.p.Hangup()
		time.AfterFunc(2*time.Second, func() {
			if !t.isDone() {
				t.p.Kill()
			}
		})
	}
}

// reapTerms закрывает брошенные сессии и забывает завершённые.
func (a *App) reapTerms() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-a.ctx.Done():
			a.terms.mu.Lock()
			for _, s := range a.terms.sess {
				s.kill()
			}
			a.terms.mu.Unlock()
			return
		case <-t.C:
		}
		a.terms.mu.Lock()
		for id, s := range a.terms.sess {
			s.mu.Lock()
			idle := len(s.subs) == 0 && time.Since(s.idleAt) > termIdle
			done := s.done
			s.mu.Unlock()
			if done && idle {
				delete(a.terms.sess, id)
			} else if idle {
				s.kill()
			}
		}
		a.terms.mu.Unlock()
	}
}

func (a *App) term(id string) *termSession {
	a.terms.mu.Lock()
	defer a.terms.mu.Unlock()
	return a.terms.sess[id]
}

// ---------- API ----------

type termInfo struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Done    bool   `json:"done"`
	Msg     string `json:"msg,omitempty"`
	Viewers int    `json:"viewers"`
}

func (a *App) handleTermList(w http.ResponseWriter, r *http.Request, m *Monitor) {
	srv := m.server()
	var out []termInfo
	a.terms.mu.Lock()
	for _, t := range a.terms.sess {
		if t.Server != srv.ID {
			continue
		}
		t.mu.Lock()
		out = append(out, termInfo{ID: t.ID, Created: t.Created, Done: t.done, Msg: t.exitMsg, Viewers: len(t.subs)})
		t.mu.Unlock()
	}
	a.terms.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	if out == nil {
		out = []termInfo{}
	}
	writeJSON(w, 200, map[string]any{"sessions": out})
}

func termSize(cols, rows int) (int, int) {
	if cols < 10 || cols > 500 {
		cols = 80
	}
	if rows < 3 || rows > 300 {
		rows = 24
	}
	return cols, rows
}

func (a *App) handleTermOpen(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	_ = readJSON(r, &req)
	cols, rows := termSize(req.Cols, req.Rows)
	t, err := a.startTerm(m.server(), cols, rows)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": t.ID, "created": t.Created})
}

func (a *App) handleTermStream(w http.ResponseWriter, r *http.Request) {
	t := a.term(r.PathValue("tid"))
	if t == nil {
		writeErr(w, 404, "сессия не найдена")
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	c, replay, done := t.subscribe()
	defer t.unsubscribe(c)
	_, _ = w.Write([]byte("retry: 2000\n"))
	_, _ = w.Write(termMsg("r", replay)) // r — весь сохранённый вывод (экран очищается)
	if done {
		t.mu.Lock()
		b, _ := json.Marshal(map[string]string{"msg": t.exitMsg})
		t.mu.Unlock()
		_, _ = w.Write(sseMessage("x", b))
		fl.Flush()
		return
	}
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-c:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			// склеиваем то, что уже накопилось, в одну отправку
			for more := true; more; {
				select {
				case m2, ok := <-c:
					if !ok {
						fl.Flush()
						return
					}
					_, _ = w.Write(m2)
				default:
					more = false
				}
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

func (a *App) handleTermInput(w http.ResponseWriter, r *http.Request) {
	t := a.term(r.PathValue("tid"))
	if t == nil {
		writeErr(w, 404, "сессия не найдена")
		return
	}
	var req struct {
		D string `json:"d"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if t.isDone() {
		writeErr(w, 410, "сессия завершена")
		return
	}
	t.inMu.Lock()
	_, err := t.p.Write([]byte(req.D))
	t.inMu.Unlock()
	if err != nil {
		writeErr(w, 410, "сессия завершена")
		return
	}
	w.WriteHeader(204)
}

func (a *App) handleTermResize(w http.ResponseWriter, r *http.Request) {
	t := a.term(r.PathValue("tid"))
	if t == nil {
		writeErr(w, 404, "сессия не найдена")
		return
	}
	var req struct {
		Cols int `json:"cols"`
		Rows int `json:"rows"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if !t.isDone() {
		cols, rows := termSize(req.Cols, req.Rows)
		_ = t.p.Resize(cols, rows)
	}
	w.WriteHeader(204)
}

func (a *App) handleTermClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("tid")
	t := a.term(id)
	if t == nil {
		writeErr(w, 404, "сессия не найдена")
		return
	}
	t.kill()
	if t.isDone() {
		a.terms.mu.Lock()
		delete(a.terms.sess, id)
		a.terms.mu.Unlock()
	}
	w.WriteHeader(204)
}

// termIDsFor — для удаления сервера.
func (a *App) closeTermsFor(serverID string) {
	a.terms.mu.Lock()
	defer a.terms.mu.Unlock()
	for _, t := range a.terms.sess {
		if t.Server == serverID {
			t.kill()
		}
	}
}
