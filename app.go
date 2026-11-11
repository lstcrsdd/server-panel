package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Server — один сервер в панели. Источник: хост из ~/.ssh/config ("ssh") или
// добавленный вручную в интерфейсе ("manual").
type Server struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Source  string `json:"source"`
	Alias   string `json:"alias,omitempty"`
	Host    string `json:"host"`
	User    string `json:"user,omitempty"`
	Port    int    `json:"port,omitempty"`
	KeyFile string `json:"keyFile,omitempty"`
	Note    string `json:"-"`                // комментарий из ~/.ssh/config в интерфейс не отдаём
	Group   string `json:"group,omitempty"`  // группа в списке ("VPN", "Сайты"…)
	Pinned  bool   `json:"pinned,omitempty"` // ключ хоста сохранён панелью (known_hosts панели)
	Monitor bool   `json:"monitor"`
	Hidden  bool   `json:"hidden"`
	Mute    bool   `json:"mute,omitempty"` // не присылать оповещения
}

// Override — пользовательские настройки для хоста из ~/.ssh/config (сам файл
// панель никогда не меняет).
type Override struct {
	Name    string `json:"name,omitempty"`
	Group   string `json:"group,omitempty"`
	Monitor *bool  `json:"monitor,omitempty"`
	Hidden  *bool  `json:"hidden,omitempty"`
	Mute    *bool  `json:"mute,omitempty"`
}

type Settings struct {
	Manual    []*Server            `json:"manual"`
	Overrides map[string]*Override `json:"overrides"`
	Alerts    *AlertConfig         `json:"alerts,omitempty"`
	Order     []string             `json:"order,omitempty"`   // порядок серверов в списке
	Removed   []string             `json:"removed,omitempty"` // хосты ~/.ssh/config, убранные из панели
	// SSHSetup — пользователь уже выбрал, какие хосты ~/.ssh/config показывать.
	// До этого (первый запуск) панель их не подключает, а предлагает выбрать.
	SSHSetup *bool `json:"sshSetup,omitempty"`

	Notes     []*Note     `json:"notes,omitempty"`     // заметки пользователя
	Scenarios []*Scenario `json:"scenarios,omitempty"` // сохранённые сценарии
	Checks    []*Check    `json:"checks,omitempty"`    // проверки сайтов и портов снаружи
}

type App struct {
	home, dataDir, cmDir, histDir string
	interval                      time.Duration
	ctx                           context.Context
	cancel                        context.CancelFunc
	hub                           *Hub

	syncMu   sync.Mutex // сериализует syncServers
	mu       sync.RWMutex
	settings Settings
	order    []string
	mons     map[string]*Monitor

	procMu    sync.Mutex
	procCache map[string]*procSample

	alerts *Alerts
	terms  *termManager
	wsync  watchSync
	chk    *checker
}

func NewApp(dataDir, home string, interval time.Duration, notify bool) (*App, error) {
	a := &App{
		home:      home,
		dataDir:   dataDir,
		interval:  interval,
		hub:       newHub(),
		mons:      map[string]*Monitor{},
		procCache: map[string]*procSample{},
	}
	a.histDir = filepath.Join(dataDir, "history")
	dirs := []string{dataDir, a.histDir}
	if useControlMaster {
		a.cmDir = filepath.Join(dataDir, "cm")
		// Путь unix-сокета ограничен ~104 байтами: ControlPath = <cmDir>/<40 hex>
		// плюс временный суффикс ssh. Для длинных путей берём короткий каталог в /tmp.
		if len(a.cmDir)+60 > 100 {
			a.cmDir = fmt.Sprintf("/tmp/spcm-%d-%s", os.Getuid(), shortHash(dataDir))
		}
		dirs = append(dirs, a.cmDir)
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	if useControlMaster {
		if st, err := os.Lstat(a.cmDir); err != nil || !st.IsDir() || st.Mode().Perm()&0o077 != 0 || !ownedByMe(st) {
			return nil, fmt.Errorf("каталог %s должен принадлежать вам и иметь права 700", a.cmDir)
		}
	}
	a.ctx, a.cancel = context.WithCancel(context.Background())
	a.loadSettings()
	a.alerts = newAlerts(a, notify)
	a.chk = newChecker()
	a.terms = newTermManager()
	return a, nil
}

func (a *App) Start() {
	a.syncServers()
	go a.alerts.run(a.ctx)
	go a.runChecks(a.ctx)
	go a.reapTerms()
	go func() {
		t := time.NewTicker(5 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-t.C:
				a.saveAllHistory()
			}
		}
	}()
}

func (a *App) Stop() {
	a.hub.close()
	a.mu.RLock()
	mons := make([]*Monitor, 0, len(a.mons))
	for _, m := range a.mons {
		mons = append(mons, m)
	}
	a.mu.RUnlock()
	var wg sync.WaitGroup
	for _, m := range mons {
		wg.Add(1)
		go func(m *Monitor) {
			defer wg.Done()
			m.stop()
			srv := m.server()
			a.closeMaster(&srv)
		}(m)
	}
	wg.Wait()
	a.cancel()
	a.saveAllHistory()
}

// ---------- настройки ----------

func (a *App) settingsPath() string { return filepath.Join(a.dataDir, "settings.json") }

func (a *App) loadSettings() {
	a.settings = Settings{Overrides: map[string]*Override{}}
	b, err := os.ReadFile(a.settingsPath())
	existed := err == nil
	if existed {
		_ = json.Unmarshal(b, &a.settings)
	}
	if a.settings.Overrides == nil {
		a.settings.Overrides = map[string]*Override{}
	}
	if a.settings.SSHSetup == nil {
		// у тех, кто уже пользовался панелью, хосты ~/.ssh/config подключались
		// сами — так и оставляем; при первом запуске предлагаем выбрать
		a.settings.SSHSetup = &existed
	}
}

// saveSettings вызывается под a.mu.
func (a *App) saveSettings() error {
	b, err := json.MarshalIndent(a.settings, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(a.settingsPath(), b)
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------- список серверов ----------

var gitHosts = map[string]bool{
	"github.com": true, "ssh.github.com": true, "gitlab.com": true,
	"bitbucket.org": true, "ssh.dev.azure.com": true, "vs-ssh.visualstudio.com": true,
}

func (a *App) sshEntries() []sshHostEntry {
	sshDir := filepath.Join(a.home, ".ssh")
	return parseSSHConfig(filepath.Join(sshDir, "config"), sshDir, 0, map[string]bool{})
}

func (a *App) buildServerList() []*Server {
	entries := a.sshEntries()
	a.mu.RLock()
	setup := a.settings.SSHSetup != nil && *a.settings.SSHSetup
	removed := map[string]bool{}
	for _, id := range a.settings.Removed {
		removed[id] = true
	}
	a.mu.RUnlock()

	var list []*Server
	seen := map[string]bool{}
	for _, e := range entries {
		if seen[e.Alias] {
			continue
		}
		seen[e.Alias] = true
		if !setup || removed[e.Alias] || gitHosts[strings.ToLower(e.Alias)] {
			continue
		}
		list = append(list, &Server{ID: e.Alias, Name: e.Alias, Source: "ssh", Alias: e.Alias, Note: e.Note, Monitor: true})
	}

	var wg sync.WaitGroup
	for _, s := range list {
		wg.Add(1)
		go func(s *Server) {
			defer wg.Done()
			s.Host, s.User, s.Port = resolveSSH(s.Alias)
		}(s)
	}
	wg.Wait()

	a.mu.RLock()
	defer a.mu.RUnlock()
	kept := list[:0]
	for _, s := range list {
		if gitHosts[strings.ToLower(s.Host)] {
			continue // github.com и т. п. — не серверы
		}
		kept = append(kept, s)
		if o := a.settings.Overrides[s.ID]; o != nil {
			if o.Name != "" {
				s.Name = o.Name
			}
			s.Group = o.Group
			if o.Monitor != nil {
				s.Monitor = *o.Monitor
			}
			if o.Hidden != nil {
				s.Hidden = *o.Hidden
			}
			if o.Mute != nil {
				s.Mute = *o.Mute
			}
		}
	}
	for _, m := range a.settings.Manual {
		c := *m
		c.Source = "manual"
		if seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		kept = append(kept, &c)
	}
	list = kept
	pos := map[string]int{}
	for i, id := range a.settings.Order {
		pos[id] = i
	}
	sort.SliceStable(list, func(i, j int) bool {
		pi, oki := pos[list[i].ID]
		pj, okj := pos[list[j].ID]
		if oki && okj {
			return pi < pj
		}
		return oki && !okj
	})
	return list
}

// syncServers перечитывает ~/.ssh/config и настройки, запускает и
// останавливает мониторы, рассылает новый список в интерфейс.
func (a *App) syncServers() {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()

	list := a.buildServerList()
	a.mu.Lock()
	keep := map[string]bool{}
	order := make([]string, 0, len(list))
	for _, s := range list {
		keep[s.ID] = true
		order = append(order, s.ID)
		if m, ok := a.mons[s.ID]; ok {
			m.setServer(*s)
		} else {
			a.mons[s.ID] = newMonitor(a, *s)
		}
	}
	var removed []*Monitor
	for id, m := range a.mons {
		if !keep[id] {
			removed = append(removed, m)
			delete(a.mons, id)
		}
	}
	a.order = order
	mons := make([]*Monitor, 0, len(order))
	for _, id := range order {
		mons = append(mons, a.mons[id])
	}
	a.mu.Unlock()

	for _, m := range removed {
		m.stop()
		_ = os.Remove(m.historyPath())
	}
	for _, m := range mons {
		s := m.server()
		if s.Monitor && !s.Hidden {
			m.start(a.ctx)
		} else {
			m.stop()
		}
	}
	a.hub.send("servers", a.views(true))
}

func (a *App) monitor(id string) *Monitor {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.mons[id]
}

type ServerView struct {
	Server
	Status string      `json:"status"`
	Error  string      `json:"error,omitempty"`
	Since  int64       `json:"since,omitempty"`
	Info   *Info       `json:"info,omitempty"`
	Latest *Metrics    `json:"latest,omitempty"`
	Spark  []Point     `json:"spark,omitempty"`
	Units  []UnitState `json:"units,omitempty"`
	// PanelKey — сервер добавлен по паролю, вход по ключу панели
	PanelKey bool `json:"panelKey,omitempty"`
}

func (a *App) views(withSpark bool) []ServerView {
	a.mu.RLock()
	mons := make([]*Monitor, 0, len(a.order))
	for _, id := range a.order {
		mons = append(mons, a.mons[id])
	}
	a.mu.RUnlock()
	out := make([]ServerView, 0, len(mons))
	for _, m := range mons {
		out = append(out, m.view(withSpark))
	}
	return out
}

func (a *App) saveAllHistory() {
	a.mu.RLock()
	mons := make([]*Monitor, 0, len(a.mons))
	for _, m := range a.mons {
		mons = append(mons, m)
	}
	a.mu.RUnlock()
	for _, m := range mons {
		m.saveHistory()
	}
}

// ---------- разбор ~/.ssh/config ----------

type sshHostEntry struct {
	Alias, Note string
}

func parseSSHConfig(path, sshDir string, depth int, seen map[string]bool) []sshHostEntry {
	if depth > 8 || seen[path] {
		return nil
	}
	seen[path] = true
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var out []sshHostEntry
	var comments []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			comments = nil
			continue
		}
		if strings.HasPrefix(line, "#") {
			c := strings.TrimSpace(strings.TrimLeft(line, "#"))
			if c != "" {
				comments = append(comments, c)
			}
			continue
		}
		key, val := splitDirective(line)
		switch strings.ToLower(key) {
		case "include":
			for _, pat := range strings.Fields(val) {
				pat = expandHome(strings.Trim(pat, `"`))
				if !filepath.IsAbs(pat) {
					pat = filepath.Join(sshDir, pat)
				}
				matches, _ := filepath.Glob(pat)
				for _, m := range matches {
					out = append(out, parseSSHConfig(m, sshDir, depth+1, seen)...)
				}
			}
		case "host":
			alias := ""
			for _, p := range strings.Fields(val) {
				p = strings.Trim(p, `"`)
				if p == "" || strings.ContainsAny(p, "*?!") {
					continue
				}
				alias = p
				break
			}
			if alias != "" {
				out = append(out, sshHostEntry{Alias: alias, Note: strings.Join(comments, " ")})
			}
		}
		comments = nil
	}
	return out
}

func splitDirective(line string) (string, string) {
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return line, ""
	}
	key := line[:i]
	val := strings.TrimSpace(line[i:])
	val = strings.TrimSpace(strings.TrimPrefix(val, "="))
	return key, val
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// resolveSSH спрашивает у самого ssh итоговые параметры хоста (ssh -G).
func resolveSSH(alias string) (host, user string, port int) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ssh", "-G", "--", alias).Output()
	host, port = alias, 22
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		k, v, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		switch k {
		case "hostname":
			host = v
		case "user":
			user = v
		case "port":
			if p, err := strconv.Atoi(v); err == nil {
				port = p
			}
		}
	}
	return
}

func shortHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:4])
}

var safeFileRe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeFileName(s string) string { return safeFileRe.ReplaceAllString(s, "_") }
