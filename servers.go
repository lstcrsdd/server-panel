package main

// Управление списком серверов: добавление (в том числе по паролю — панель один
// раз входит с ним и ставит свой ключ), правка, удаление, порядок, группы и
// выбор хостов из ~/.ssh/config.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
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

var (
	hostRe    = regexp.MustCompile(`^[A-Za-z0-9._:\[\]-]{1,253}$`)
	userRe    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	keyTypeRe = regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-[a-z0-9@.-]+)$`)
	b64Re     = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)
)

// ---------- ключ и known_hosts панели ----------

func (a *App) keysDir() string        { return filepath.Join(a.dataDir, "keys") }
func (a *App) panelKeyPath() string   { return filepath.Join(a.keysDir(), "id_ed25519") }
func (a *App) knownHostsPath() string { return filepath.Join(a.dataDir, "known_hosts") }

var keyMu, knownMu sync.Mutex

// panelPub возвращает открытый ключ панели, создавая пару при первом вызове.
// Ключ ed25519 без пароля лежит в каталоге данных панели и на серверы
// попадает только туда, куда пользователь добавил сервер по паролю.
func (a *App) panelPub(create bool) (string, error) {
	keyMu.Lock()
	defer keyMu.Unlock()
	p := a.panelKeyPath()
	if _, err := os.Stat(p); err != nil {
		if !create {
			return "", nil
		}
		if err := os.MkdirAll(a.keysDir(), 0o700); err != nil {
			return "", err
		}
		host, _ := os.Hostname()
		comment := "method-panel@" + safeComment(host)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", p).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("не удалось создать ключ (ssh-keygen): %v %s", err, strings.TrimSpace(string(out)))
		}
	}
	b, err := os.ReadFile(p + ".pub")
	if err != nil {
		return "", err
	}
	pub := strings.TrimSpace(string(b))
	f := strings.Fields(pub)
	if len(f) < 2 || !keyTypeRe.MatchString(f[0]) || !b64Re.MatchString(f[1]) {
		return "", errors.New("неожиданный формат открытого ключа панели")
	}
	return pub, nil
}

var commentRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func safeComment(s string) string {
	s = strings.Trim(commentRe.ReplaceAllString(s, "-"), "-")
	if s == "" {
		s = "local"
	}
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

type hostKey struct {
	Type string `json:"type"`
	Data string `json:"-"`
	FP   string `json:"fp"`
}

func fingerprint(b64 string) string {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// pinHostKeys записывает ключи хоста в known_hosts панели под именем alias
// (HostKeyAlias = id сервера), заменяя прежние записи этого сервера.
func (a *App) pinHostKeys(alias string, keys []hostKey) error {
	knownMu.Lock()
	defer knownMu.Unlock()
	var lines []string
	if b, err := os.ReadFile(a.knownHostsPath()); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if f := strings.Fields(l); len(f) > 0 && f[0] != alias {
				lines = append(lines, l)
			}
		}
	}
	for _, k := range keys {
		lines = append(lines, alias+" "+k.Type+" "+k.Data)
	}
	return writeFileAtomic(a.knownHostsPath(), []byte(strings.Join(lines, "\n")+"\n"))
}

func (a *App) unpinHostKeys(alias string) { _ = a.pinHostKeys(alias, nil) }

// ---------- проверка адреса: отпечаток ключа сервера ----------

type probeResult struct {
	Host string
	Port int
	Keys []hostKey
	At   time.Time
}

var (
	probeMu sync.Mutex
	probes  = map[string]*probeResult{}
)

func scanHostKeys(ctx context.Context, host string, port int) ([]hostKey, error) {
	cmd := exec.CommandContext(ctx, "ssh-keyscan", "-T", "8", "-p", strconv.Itoa(port), "-t", "ed25519,ecdsa,rsa", sshHost(host))
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	var keys []hostKey
	seen := map[string]bool{}
	for _, l := range strings.Split(out.String(), "\n") {
		f := strings.Fields(l)
		if len(f) < 3 || strings.HasPrefix(f[0], "#") || !keyTypeRe.MatchString(f[1]) || !b64Re.MatchString(f[2]) || seen[f[1]] {
			continue
		}
		seen[f[1]] = true
		keys = append(keys, hostKey{Type: f[1], Data: f[2], FP: fingerprint(f[2])})
	}
	if len(keys) == 0 {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, errors.New("не найден ssh-keyscan — установите клиент OpenSSH")
		}
		if msg := sshError(errb.String()); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("не удалось подключиться к %s:%d — проверьте адрес и порт SSH", host, port)
	}
	rank := map[string]int{"ssh-ed25519": 0, "ecdsa-sha2-nistp256": 1, "ecdsa-sha2-nistp384": 1, "ecdsa-sha2-nistp521": 1, "ssh-rsa": 2}
	sort.SliceStable(keys, func(i, j int) bool { return rank[keys[i].Type] < rank[keys[j].Type] })
	return keys, nil
}

type connReq struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}

func (c *connReq) normalize() error {
	c.Host = strings.TrimSpace(c.Host)
	c.User = strings.TrimSpace(c.User)
	// «root@1.2.3.4» и «1.2.3.4:2222» — частые варианты ввода
	if u, h, ok := strings.Cut(c.Host, "@"); ok {
		if u != "" && (c.User == "" || c.User == "root") {
			c.User = u
		}
		c.Host = h
	}
	if h, p, ok := strings.Cut(c.Host, ":"); ok && !strings.Contains(p, ":") && !strings.HasPrefix(c.Host, "[") {
		if n, err := strconv.Atoi(p); err == nil {
			c.Host = h
			if c.Port == 0 || c.Port == 22 {
				c.Port = n
			}
		}
	}
	if !hostRe.MatchString(c.Host) || strings.HasPrefix(c.Host, "-") {
		return errors.New("укажите адрес сервера: IP или домен")
	}
	if c.User == "" {
		c.User = "root"
	}
	if !userRe.MatchString(c.User) || strings.HasPrefix(c.User, "-") {
		return errors.New("недопустимое имя пользователя")
	}
	if c.Port == 0 {
		c.Port = 22
	}
	if c.Port < 1 || c.Port > 65535 {
		return errors.New("недопустимый порт")
	}
	return nil
}

func (a *App) handleProbe(w http.ResponseWriter, r *http.Request) {
	var req connReq
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if err := req.normalize(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	keys, err := scanHostKeys(ctx, req.Host, req.Port)
	if err != nil {
		writeErr(w, 422, err.Error())
		return
	}
	id := randomHex(8)
	probeMu.Lock()
	for k, p := range probes {
		if time.Since(p.At) > 15*time.Minute {
			delete(probes, k)
		}
	}
	probes[id] = &probeResult{Host: req.Host, Port: req.Port, Keys: keys, At: time.Now()}
	probeMu.Unlock()

	// тот же адрес уже есть в панели?
	var dup string
	for _, v := range a.views(false) {
		if strings.EqualFold(v.Host, req.Host) && (v.Port == req.Port || v.Port == 0 && req.Port == 22) && v.User == req.User {
			dup = v.Name
			break
		}
	}
	writeJSON(w, 200, map[string]any{"probe": id, "host": req.Host, "port": req.Port, "user": req.User, "keys": keys, "duplicate": dup})
}

func takeProbe(id, host string, port int) (*probeResult, error) {
	probeMu.Lock()
	defer probeMu.Unlock()
	p := probes[id]
	if p == nil || time.Since(p.At) > 15*time.Minute {
		return nil, errors.New("проверка адреса устарела — нажмите «Далее» ещё раз")
	}
	if !strings.EqualFold(p.Host, host) || p.Port != port {
		return nil, errors.New("адрес изменился после проверки — нажмите «Далее» ещё раз")
	}
	return p, nil
}

// ---------- вход по паролю: установка ключа панели ----------

// passwordArgs — аргументы ssh для единственного входа по паролю. Пароль
// подаёт сама панель в роли SSH_ASKPASS (см. askpassMain), на диск он не
// попадает и нигде не сохраняется.
func (a *App) passwordArgs(s *Server) []string {
	args := []string{"-T",
		"-o", "BatchMode=no",
		"-o", "ControlMaster=no", "-o", "ControlPath=none",
		"-o", "PubkeyAuthentication=no", "-o", "GSSAPIAuthentication=no",
		"-o", "PreferredAuthentications=keyboard-interactive,password",
		"-o", "NumberOfPasswordPrompts=1",
		"-o", "ConnectTimeout=12", "-o", "LogLevel=ERROR",
	}
	args = append(args, a.hostKeyArgs(s)...)
	args = append(args, "-p", strconv.Itoa(s.Port), "-l", s.User, "--", sshHost(s.Host))
	return args
}

const installKeyScript = `set -e
umask 077
mkdir -p "$HOME/.ssh"
f="$HOME/.ssh/authorized_keys"
touch "$f"
if ! grep -qF '%[2]s' "$f"; then
  if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then echo >> "$f"; fi
  printf '%%s\n' '%[1]s' >> "$f"
fi
chmod 700 "$HOME/.ssh"; chmod 600 "$f"
command -v restorecon >/dev/null 2>&1 && restorecon -R "$HOME/.ssh" >/dev/null 2>&1 || true
echo SP-KEY-OK
`

func (a *App) installPanelKey(ctx context.Context, s *Server, password, pub string) error {
	f := strings.Fields(pub)
	script := fmt.Sprintf(installKeyScript, pub, f[1])
	args := append(a.passwordArgs(s), "sh -s")
	cmd := exec.CommandContext(ctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(script)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.WaitDelay = 2 * time.Second
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd.Env = append(os.Environ(),
		"SSH_ASKPASS="+exe, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=:0",
		"SP_ASKPASS=1", "SP_ASKPASS_SECRET="+password)
	err = cmd.Run()
	text := out.String()
	if strings.Contains(text, "SP-KEY-OK") {
		return nil
	}
	if ctx.Err() != nil {
		return errors.New("сервер не ответил вовремя")
	}
	if strings.Contains(text, "Permission denied") || strings.Contains(text, "Authentication failed") {
		if s.User == "root" {
			return errors.New("пароль не подошёл, или сервер не пускает root по паролю (так часто бывает) — попробуйте обычного пользователя с sudo")
		}
		return errors.New("пароль не подошёл, или вход по паролю на сервере выключен")
	}
	if msg := sshError(text); msg != "" {
		return errors.New(msg)
	}
	if t := strings.TrimSpace(text); t != "" {
		return errors.New(lastLines(t, 4))
	}
	if err != nil {
		return err
	}
	return errors.New("не удалось установить ключ")
}

// askpassMain — панель, запущенная ssh в роли SSH_ASKPASS: печатает пароль
// на запрос пароля и отказывает на всё остальное.
func askpassMain() {
	prompt := strings.ToLower(strings.Join(os.Args[1:], " "))
	if strings.Contains(prompt, "yes/no") || strings.Contains(prompt, "fingerprint") {
		fmt.Println("no")
		return
	}
	if !strings.Contains(prompt, "password") && !strings.Contains(prompt, "пароль") {
		os.Exit(1)
	}
	fmt.Println(os.Getenv("SP_ASKPASS_SECRET"))
}

const revokeKeyScript = `f="$HOME/.ssh/authorized_keys"
[ -f "$f" ] || { echo SP-REVOKED; exit 0; }
t="$f.sp-tmp.$$"
grep -vF '%s' "$f" > "$t"; rc=$?
if [ $rc -gt 1 ]; then rm -f "$t"; exit 1; fi
cat "$t" > "$f" && rm -f "$t" && echo SP-REVOKED
`

// ---------- добавление ----------

func (a *App) checkLogin(ctx context.Context, s *Server) error {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	res := a.runSSH(ctx, s, "echo ok", "", false, 4096)
	if res.Err != nil || strings.TrimSpace(res.Stdout) != "ok" {
		msg := res.errText()
		if msg == "" {
			msg = "сервер не ответил"
		}
		return errors.New(msg)
	}
	return nil
}

func cleanName(n string) (string, error) {
	n = strings.TrimSpace(n)
	if len([]rune(n)) > 64 {
		return "", errors.New("слишком длинное название")
	}
	return n, nil
}

func cleanGroup(g string) (string, error) {
	g = strings.Join(strings.Fields(g), " ")
	if len([]rune(g)) > 40 {
		return "", errors.New("слишком длинное название группы")
	}
	return g, nil
}

func (a *App) checkKeyFile(k string) (string, error) {
	k = strings.TrimSpace(k)
	if k == "" {
		return "", nil
	}
	if k == "panel" {
		k = a.panelKeyPath()
	}
	if _, err := os.Stat(expandHome(k)); err != nil {
		return "", errors.New("файл ключа не найден: " + k)
	}
	return k, nil
}

func (a *App) handleAddServer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		connReq
		Name     string `json:"name"`
		Group    string `json:"group"`
		Auth     string `json:"auth"` // password | key
		Password string `json:"password"`
		KeyFile  string `json:"keyFile"`
		Probe    string `json:"probe"`
		Force    bool   `json:"force"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if err := req.normalize(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	name, err := cleanName(req.Name)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	group, err := cleanGroup(req.Group)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if name == "" {
		name = req.Host
	}
	s := &Server{ID: "srv-" + randomHex(4), Name: name, Group: group, Source: "manual", Host: req.Host, User: req.User, Port: req.Port, Monitor: true}

	if req.Probe != "" {
		p, err := takeProbe(req.Probe, req.Host, req.Port)
		if err != nil {
			writeErr(w, 409, err.Error())
			return
		}
		if err := a.pinHostKeys(s.ID, p.Keys); err != nil {
			writeErr(w, 500, "не удалось сохранить ключ сервера: "+err.Error())
			return
		}
		s.Pinned = true
	}
	fail := func(code int, msg string, canForce bool) {
		if s.Pinned {
			a.unpinHostKeys(s.ID)
		}
		writeJSON(w, code, map[string]any{"error": msg, "canForce": canForce})
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	switch req.Auth {
	case "password":
		if req.Password == "" || len(req.Password) > 1024 || strings.ContainsAny(req.Password, "\r\n") {
			fail(400, "введите пароль", false)
			return
		}
		pub, err := a.panelPub(true)
		if err != nil {
			fail(500, err.Error(), false)
			return
		}
		s.KeyFile = a.panelKeyPath()
		if err := a.installPanelKey(ctx, s, req.Password, pub); err != nil {
			fail(422, err.Error(), false)
			return
		}
		if err := a.checkLogin(ctx, s); err != nil {
			fail(422, "ключ установлен, но вход по нему не удался: "+err.Error(), false)
			return
		}
	default:
		k, err := a.checkKeyFile(req.KeyFile)
		if err != nil {
			fail(400, err.Error(), false)
			return
		}
		s.KeyFile = k
		if !req.Force {
			if err := a.checkLogin(ctx, s); err != nil {
				fail(422, err.Error(), true)
				return
			}
		}
	}

	a.mu.Lock()
	a.settings.Manual = append(a.settings.Manual, s)
	err = a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, "не удалось сохранить настройки: "+err.Error())
		return
	}
	a.syncServers()
	writeJSON(w, 200, map[string]any{"ok": true, "id": s.ID})
}

// ---------- правка ----------

func (a *App) handleUpdateServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m := a.monitor(id)
	if m == nil {
		writeErr(w, 404, "сервер не найден")
		return
	}
	var req struct {
		Name    *string `json:"name"`
		Group   *string `json:"group"`
		Monitor *bool   `json:"monitor"`
		Hidden  *bool   `json:"hidden"`
		Mute    *bool   `json:"mute"`
		// подключение — только для серверов, добавленных в панели
		Host    *string `json:"host"`
		Port    *int    `json:"port"`
		User    *string `json:"user"`
		KeyFile *string `json:"keyFile"`
		Probe   string  `json:"probe"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	if req.Name != nil {
		n, err := cleanName(*req.Name)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		req.Name = &n
	}
	if req.Group != nil {
		g, err := cleanGroup(*req.Group)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		req.Group = &g
	}
	srv := m.server()
	connChanged := false
	var newConn Server
	if req.Host != nil || req.Port != nil || req.User != nil || req.KeyFile != nil {
		if srv.Source != "manual" {
			writeErr(w, 400, "параметры подключения этого сервера берутся из ~/.ssh/config — меняйте их там")
			return
		}
		c := connReq{Host: srv.Host, Port: srv.Port, User: srv.User}
		if req.Host != nil {
			c.Host = *req.Host
		}
		if req.Port != nil {
			c.Port = *req.Port
		}
		if req.User != nil {
			c.User = *req.User
		}
		if err := c.normalize(); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		newConn = srv
		newConn.Host, newConn.Port, newConn.User = c.Host, c.Port, c.User
		if req.KeyFile != nil {
			k, err := a.checkKeyFile(*req.KeyFile)
			if err != nil {
				writeErr(w, 400, err.Error())
				return
			}
			newConn.KeyFile = k
		}
		addrChanged := !strings.EqualFold(newConn.Host, srv.Host) || newConn.Port != srv.Port
		if addrChanged && srv.Pinned && req.Probe == "" {
			writeErr(w, 409, "адрес изменился — сначала проверьте отпечаток ключа сервера")
			return
		}
		if req.Probe != "" {
			p, err := takeProbe(req.Probe, newConn.Host, newConn.Port)
			if err != nil {
				writeErr(w, 409, err.Error())
				return
			}
			if err := a.pinHostKeys(srv.ID, p.Keys); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			newConn.Pinned = true
		}
		connChanged = newConn.Host != srv.Host || newConn.Port != srv.Port || newConn.User != srv.User || newConn.KeyFile != srv.KeyFile || newConn.Pinned != srv.Pinned
	}

	a.mu.Lock()
	if srv.Source == "manual" {
		for _, s := range a.settings.Manual {
			if s.ID != id {
				continue
			}
			if req.Name != nil && *req.Name != "" {
				s.Name = *req.Name
			}
			if req.Group != nil {
				s.Group = *req.Group
			}
			if req.Monitor != nil {
				s.Monitor = *req.Monitor
			}
			if req.Hidden != nil {
				s.Hidden = *req.Hidden
			}
			if req.Mute != nil {
				s.Mute = *req.Mute
			}
			if connChanged {
				s.Host, s.Port, s.User, s.KeyFile, s.Pinned = newConn.Host, newConn.Port, newConn.User, newConn.KeyFile, newConn.Pinned
			}
		}
	} else {
		o := a.settings.Overrides[id]
		if o == nil {
			o = &Override{}
			a.settings.Overrides[id] = o
		}
		if req.Name != nil {
			o.Name = *req.Name
			if o.Name == srv.Alias {
				o.Name = ""
			}
		}
		if req.Group != nil {
			o.Group = *req.Group
		}
		if req.Monitor != nil {
			o.Monitor = req.Monitor
		}
		if req.Hidden != nil {
			o.Hidden = req.Hidden
		}
		if req.Mute != nil {
			o.Mute = req.Mute
		}
	}
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if connChanged {
		a.closeMaster(&srv)
	}
	a.syncServers()
	if connChanged {
		go m.restart(a.ctx)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *App) handleTestServer(w http.ResponseWriter, r *http.Request, m *Monitor) {
	s := m.server()
	start := time.Now()
	if err := a.checkLogin(r.Context(), &s); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "ms": time.Since(start).Milliseconds()})
}

// ---------- удаление ----------

func (a *App) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m := a.monitor(id)
	if m == nil {
		writeErr(w, 404, "сервер не найден")
		return
	}
	srv := m.server()
	revoke := r.URL.Query().Get("revoke") == "1"
	var warn string
	if revoke && srv.Source == "manual" && srv.KeyFile == a.panelKeyPath() {
		if err := a.revokePanelKey(r.Context(), &srv); err != nil {
			warn = "ключ панели с сервера убрать не удалось: " + err.Error()
		}
	}

	a.mu.Lock()
	if srv.Source == "manual" {
		list := a.settings.Manual[:0]
		for _, s := range a.settings.Manual {
			if s.ID != id {
				list = append(list, s)
			}
		}
		a.settings.Manual = list
	} else if !contains(a.settings.Removed, id) {
		a.settings.Removed = append(a.settings.Removed, id)
	}
	order := a.settings.Order[:0]
	for _, x := range a.settings.Order {
		if x != id {
			order = append(order, x)
		}
	}
	a.settings.Order = order
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if srv.Pinned {
		a.unpinHostKeys(srv.ID)
	}
	a.closeTermsFor(id)
	a.syncServers()
	a.closeMaster(&srv)
	writeJSON(w, 200, map[string]any{"ok": true, "warning": warn})
}

func (a *App) revokePanelKey(ctx context.Context, s *Server) error {
	pub, err := a.panelPub(false)
	if err != nil || pub == "" {
		return errors.New("ключ панели не найден")
	}
	// тот же сервер и пользователь могут быть добавлены дважды — не отрезаем второй
	for _, v := range a.views(false) {
		if v.ID != s.ID && v.Source == "manual" && strings.EqualFold(v.Host, s.Host) && v.User == s.User && v.KeyFile == s.KeyFile {
			return nil
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	res := a.runScript(ctx, s, fmt.Sprintf(revokeKeyScript, strings.Fields(pub)[1]))
	if !strings.Contains(res.Stdout, "SP-REVOKED") {
		if t := res.errText(); t != "" {
			return errors.New(t)
		}
		return errors.New("сервер не подтвердил")
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---------- порядок ----------

func (a *App) handleOrder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := readJSON(r, &req); err != nil || len(req.IDs) > 1000 {
		writeErr(w, 400, "неверный запрос")
		return
	}
	a.mu.Lock()
	a.settings.Order = req.IDs
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.syncServers()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- хосты ~/.ssh/config ----------

type sshHostView struct {
	Alias   string `json:"alias"`
	Host    string `json:"host"`
	User    string `json:"user,omitempty"`
	Port    int    `json:"port,omitempty"`
	InPanel bool   `json:"inPanel"`
}

func (a *App) sshCandidates() []string {
	var out []string
	seen := map[string]bool{}
	for _, e := range a.sshEntries() {
		if seen[e.Alias] || gitHosts[strings.ToLower(e.Alias)] {
			continue
		}
		seen[e.Alias] = true
		out = append(out, e.Alias)
	}
	return out
}

func (a *App) handleSSHHosts(w http.ResponseWriter, r *http.Request) {
	aliases := a.sshCandidates()
	a.mu.RLock()
	setup := a.settings.SSHSetup != nil && *a.settings.SSHSetup
	removed := map[string]bool{}
	for _, id := range a.settings.Removed {
		removed[id] = true
	}
	a.mu.RUnlock()
	out := make([]sshHostView, len(aliases))
	var wg sync.WaitGroup
	for i, al := range aliases {
		wg.Add(1)
		go func(i int, al string) {
			defer wg.Done()
			h, u, p := resolveSSH(al)
			out[i] = sshHostView{Alias: al, Host: h, User: u, Port: p, InPanel: setup && !removed[al]}
		}(i, al)
	}
	wg.Wait()
	list := out[:0]
	for _, v := range out {
		if !gitHosts[strings.ToLower(v.Host)] {
			list = append(list, v)
		}
	}
	writeJSON(w, 200, map[string]any{"hosts": list, "setup": setup})
}

func (a *App) handleSSHHostsSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Show []string `json:"show"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	show := map[string]bool{}
	for _, s := range req.Show {
		show[s] = true
	}
	a.mu.Lock()
	removed := []string{}
	for _, al := range a.sshCandidates() {
		if !show[al] {
			removed = append(removed, al)
		}
	}
	// убранные раньше хосты, которых уже нет в ~/.ssh/config, тоже помним
	for _, id := range a.settings.Removed {
		if !show[id] && !contains(removed, id) {
			removed = append(removed, id)
		}
	}
	a.settings.Removed = removed
	t := true
	a.settings.SSHSetup = &t
	err := a.saveSettings()
	a.mu.Unlock()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	a.syncServers()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- первый запуск и сведения для интерфейса ----------

type setupInfo struct {
	OS         string `json:"os"`
	SSHSetup   bool   `json:"sshSetup"`
	SSHPending int    `json:"sshPending"` // хостов ~/.ssh/config, которые можно добавить
	PanelKey   string `json:"panelKey,omitempty"`
	DataDir    string `json:"dataDir"`
}

func (a *App) setupInfo() setupInfo {
	a.mu.RLock()
	setup := a.settings.SSHSetup != nil && *a.settings.SSHSetup
	removed := map[string]bool{}
	for _, id := range a.settings.Removed {
		removed[id] = true
	}
	a.mu.RUnlock()
	n := 0
	for _, al := range a.sshCandidates() {
		if !setup || removed[al] {
			n++
		}
	}
	pub, _ := a.panelPub(false)
	return setupInfo{OS: runtime.GOOS, SSHSetup: setup, SSHPending: n, PanelKey: pub, DataDir: a.dataDir}
}

func (a *App) handleSetup(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, a.setupInfo())
}

// handleKeys — ключи, которыми можно входить: ключ панели и ~/.ssh/*.
func (a *App) handleKeys(w http.ResponseWriter, r *http.Request) {
	type key struct {
		Path  string `json:"path"`
		Name  string `json:"name"`
		Pub   string `json:"pub"`
		Panel bool   `json:"panel,omitempty"`
	}
	out := []key{}
	if pub, err := a.panelPub(r.URL.Query().Get("create") == "1"); err == nil && pub != "" {
		out = append(out, key{Path: "panel", Name: "Ключ панели", Pub: pub, Panel: true})
	}
	sshDir := filepath.Join(a.home, ".ssh")
	files, _ := filepath.Glob(filepath.Join(sshDir, "*.pub"))
	sort.Strings(files)
	for _, f := range files {
		priv := strings.TrimSuffix(f, ".pub")
		if _, err := os.Stat(priv); err != nil {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil || len(b) > 16*1024 {
			continue
		}
		pub := strings.TrimSpace(string(b))
		if !strings.HasPrefix(pub, "ssh-") && !strings.HasPrefix(pub, "ecdsa-") && !strings.HasPrefix(pub, "sk-") {
			continue
		}
		out = append(out, key{Path: "~/.ssh/" + filepath.Base(priv), Name: filepath.Base(priv), Pub: pub})
	}
	writeJSON(w, 200, out)
}
