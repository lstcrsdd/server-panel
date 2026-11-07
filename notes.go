package main

// Заметки и сценарии пользователя. Хранятся только на этом компьютере, в
// settings.json, — на серверы панель их не записывает (кроме копии сценария,
// когда его ставят в расписание, см. schedule.go).

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type Note struct {
	ID         string `json:"id"`
	Server     string `json:"server,omitempty"`     // id сервера; пусто — общая заметка
	ServerName string `json:"serverName,omitempty"` // название на момент сохранения: пригодится, если сервер удалят
	Title      string `json:"title,omitempty"`
	Text       string `json:"text"`
	Pinned     bool   `json:"pinned,omitempty"`
	Created    int64  `json:"created"`
	Updated    int64  `json:"updated"`
}

type Scenario struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Desc    string `json:"desc,omitempty"`
	Script  string `json:"script"`
	Sudo    bool   `json:"sudo,omitempty"`    // выполнять от root (через sudo, если вошли не под root)
	Timeout int    `json:"timeout,omitempty"` // секунд на запуск из панели, 0 — по умолчанию
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
}

const (
	maxNotes      = 2000
	maxNoteText   = 50000
	maxScenarios  = 500
	maxScriptSize = 64 << 10
)

func newID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// cleanLine — одна строка без управляющих символов, не длиннее max символов.
func cleanLine(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

// cleanText — многострочный текст: переводы строк \n, без прочих управляющих символов.
func cleanText(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimRight(s, " \t\n")
}

// ---------- заметки ----------

func (a *App) notesCopy() []Note {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]Note, 0, len(a.settings.Notes))
	for _, n := range a.settings.Notes {
		out = append(out, *n)
	}
	return out
}

func (a *App) publishNotes() { a.hub.send("notes", a.notesCopy()) }

func (a *App) handleNotes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"notes": a.notesCopy()})
}

type noteReq struct {
	Server *string `json:"server"`
	Title  *string `json:"title"`
	Text   *string `json:"text"`
	Pinned *bool   `json:"pinned"`
}

func (a *App) applyNote(n *Note, req noteReq) string {
	if req.Server != nil {
		id := strings.TrimSpace(*req.Server)
		if id != "" {
			m := a.monitor(id)
			if m == nil {
				return "сервер не найден"
			}
			n.ServerName = m.server().Name
		} else {
			n.ServerName = ""
		}
		n.Server = id
	}
	if req.Title != nil {
		n.Title = cleanLine(*req.Title, 200)
	}
	if req.Text != nil {
		t := cleanText(*req.Text)
		if len(t) > maxNoteText {
			return "заметка слишком длинная"
		}
		n.Text = t
	}
	if req.Pinned != nil {
		n.Pinned = *req.Pinned
	}
	if strings.TrimSpace(n.Title) == "" && strings.TrimSpace(n.Text) == "" {
		return "пустая заметка"
	}
	return ""
}

func (a *App) handleAddNote(w http.ResponseWriter, r *http.Request) {
	var req noteReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	now := time.Now().UnixMilli()
	n := &Note{ID: newID(6), Created: now, Updated: now}
	if msg := a.applyNote(n, req); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	a.mu.Lock()
	if len(a.settings.Notes) >= maxNotes {
		a.mu.Unlock()
		writeErr(w, 400, "слишком много заметок")
		return
	}
	a.settings.Notes = append(a.settings.Notes, n)
	err := a.saveSettings()
	cp := *n
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.publishNotes()
	writeJSON(w, 200, cp)
}

func (a *App) handleUpdateNote(w http.ResponseWriter, r *http.Request) {
	var req noteReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	id := r.PathValue("nid")
	a.mu.RLock()
	var cur *Note
	for _, n := range a.settings.Notes {
		if n.ID == id {
			c := *n
			cur = &c
		}
	}
	a.mu.RUnlock()
	if cur == nil {
		writeErr(w, 404, "заметка не найдена")
		return
	}
	if msg := a.applyNote(cur, req); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	cur.Updated = time.Now().UnixMilli()
	a.mu.Lock()
	found := false
	for i, n := range a.settings.Notes {
		if n.ID == id {
			a.settings.Notes[i] = cur
			found = true
		}
	}
	var err error
	if found {
		err = a.saveSettings()
	}
	a.mu.Unlock()
	if !found {
		writeErr(w, 404, "заметка не найдена")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.publishNotes()
	writeJSON(w, 200, *cur)
}

func (a *App) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nid")
	a.mu.Lock()
	out := a.settings.Notes[:0]
	for _, n := range a.settings.Notes {
		if n.ID != id {
			out = append(out, n)
		}
	}
	a.settings.Notes = out
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.publishNotes()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- сценарии ----------

func (a *App) scenariosCopy() []Scenario {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]Scenario, 0, len(a.settings.Scenarios))
	for _, s := range a.settings.Scenarios {
		out = append(out, *s)
	}
	return out
}

func (a *App) scenario(id string) (Scenario, bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, s := range a.settings.Scenarios {
		if s.ID == id {
			return *s, true
		}
	}
	return Scenario{}, false
}

func (a *App) publishScenarios() { a.hub.send("scenarios", a.scenariosCopy()) }

func (a *App) handleScenarios(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"scenarios": a.scenariosCopy()})
}

type scenarioReq struct {
	Name    string `json:"name"`
	Desc    string `json:"desc"`
	Script  string `json:"script"`
	Sudo    bool   `json:"sudo"`
	Timeout int    `json:"timeout"`
}

func (req scenarioReq) apply(s *Scenario) string {
	name := cleanLine(req.Name, 120)
	if name == "" {
		return "укажите название"
	}
	script := cleanText(req.Script)
	if strings.TrimSpace(script) == "" {
		return "пустой скрипт"
	}
	if len(script) > maxScriptSize {
		return "скрипт больше 64 КБ"
	}
	if req.Timeout < 0 || req.Timeout > 3600 {
		return "время выполнения — от 1 секунды до часа"
	}
	s.Name, s.Desc, s.Script, s.Sudo, s.Timeout = name, cleanLine(req.Desc, 300), script, req.Sudo, req.Timeout
	return ""
}

func (a *App) handleAddScenario(w http.ResponseWriter, r *http.Request) {
	var req scenarioReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	now := time.Now().UnixMilli()
	s := &Scenario{ID: newID(6), Created: now, Updated: now}
	if msg := req.apply(s); msg != "" {
		writeErr(w, 400, msg)
		return
	}
	a.mu.Lock()
	if len(a.settings.Scenarios) >= maxScenarios {
		a.mu.Unlock()
		writeErr(w, 400, "слишком много сценариев")
		return
	}
	a.settings.Scenarios = append(a.settings.Scenarios, s)
	err := a.saveSettings()
	cp := *s
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.publishScenarios()
	writeJSON(w, 200, cp)
}

func (a *App) handleUpdateScenario(w http.ResponseWriter, r *http.Request) {
	var req scenarioReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	id := r.PathValue("sid")
	a.mu.Lock()
	var cp Scenario
	found := false
	var msg string
	for _, s := range a.settings.Scenarios {
		if s.ID == id {
			found = true
			c := *s
			if msg = req.apply(&c); msg == "" {
				c.Updated = time.Now().UnixMilli()
				*s = c
				cp = c
			}
		}
	}
	var err error
	if found && msg == "" {
		err = a.saveSettings()
	}
	a.mu.Unlock()
	switch {
	case !found:
		writeErr(w, 404, "сценарий не найден")
	case msg != "":
		writeErr(w, 400, msg)
	case err != nil:
		writeErr(w, 500, err.Error())
	default:
		a.publishScenarios()
		writeJSON(w, 200, cp)
	}
}

func (a *App) handleDeleteScenario(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("sid")
	a.mu.Lock()
	out := a.settings.Scenarios[:0]
	for _, s := range a.settings.Scenarios {
		if s.ID != id {
			out = append(out, s)
		}
	}
	a.settings.Scenarios = out
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.publishScenarios()
	writeJSON(w, 200, map[string]any{"ok": true})
}
