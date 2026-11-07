package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os/exec"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxEditSize = 2 << 20 // файлы больше 2 МБ не открываем в редакторе

// cleanRemotePath проверяет и нормализует абсолютный путь на сервере.
func cleanRemotePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || !strings.HasPrefix(p, "/") {
		return "", errors.New("нужен абсолютный путь, например /etc")
	}
	if strings.ContainsAny(p, "\x00\n\r") {
		return "", errors.New("недопустимые символы в пути")
	}
	if len(p) > 4096 {
		return "", errors.New("слишком длинный путь")
	}
	return path.Clean(p), nil
}

// asRoot — выполнять ли команду через sudo (если подключены не под root).
func (a *App) wantRoot(r *http.Request, m *Monitor, ctx context.Context) (prefix string, err error) {
	if r.URL.Query().Get("root") != "1" {
		return "", nil
	}
	in := m.ensureInfo(ctx)
	if in == nil {
		return "", errors.New("не удалось узнать права на сервере")
	}
	if in.UID == 0 {
		return "", nil
	}
	if !in.Sudo {
		return "", errors.New("на сервере нет sudo без пароля — работа «как root» недоступна")
	}
	return "sudo -n ", nil
}

// runFileScript выполняет скрипт на сервере, при необходимости через sudo.
func (a *App) runFileScript(ctx context.Context, srv *Server, sudo, script string, limit int) RunResult {
	return a.runSSH(ctx, srv, sudo+"sh -s", script, false, limit)
}

type FileEntry struct {
	Name   string  `json:"name"`
	Type   string  `json:"type"` // f d l s p b c
	Size   int64   `json:"size"`
	MTime  float64 `json:"mtime"`
	Mode   string  `json:"mode"`
	User   string  `json:"user"`
	Group  string  `json:"group"`
	Link   string  `json:"link,omitempty"`
	Target string  `json:"target,omitempty"` // тип объекта, на который указывает ссылка
}

func permError(stderr string) string {
	s := strings.TrimSpace(stderr)
	if strings.Contains(s, "Permission denied") || strings.Contains(s, "Operation not permitted") {
		return "нет доступа — включите «как root»"
	}
	if strings.Contains(s, "a password is required") || strings.Contains(s, "sudo:") {
		return "sudo требует пароль — работа «как root» недоступна"
	}
	if strings.Contains(s, "Read-only file system") {
		return "файловая система только для чтения"
	}
	if strings.Contains(s, "No such file") {
		return "не найдено"
	}
	return lastLines(s, 4)
}

func (a *App) handleFileList(w http.ResponseWriter, r *http.Request, m *Monitor) {
	p, err := cleanRemotePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	script := fmt.Sprintf(`export LC_ALL=C
p=%s
[ -e "$p" ] || { echo "@@ERR папка не найдена"; exit 0; }
[ -d "$p" ] || { echo "@@ERR это не папка"; exit 0; }
cd -- "$p" 2>/dev/null || { echo "@@ERR нет доступа — включите «как root»"; exit 0; }
echo "@@PWD $(pwd -P)"
find . -mindepth 1 -maxdepth 1 -printf '%%f\0%%y\0%%s\0%%T@\0%%m\0%%u\0%%g\0%%l\0%%Y\0' 2>/dev/null | head -c 8000000
`, shq(p))
	srv := m.server()
	res := a.runFileScript(ctx, &srv, sudo, script, 9<<20)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	if strings.HasPrefix(res.Stdout, "@@ERR ") {
		writeErr(w, 404, strings.TrimSpace(strings.TrimPrefix(res.Stdout, "@@ERR ")))
		return
	}
	if !strings.HasPrefix(res.Stdout, "@@PWD ") {
		msg := permError(res.Stderr)
		if strings.Contains(res.Stderr, "Not a directory") {
			msg = "это не папка"
		}
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 404, msg)
		return
	}
	head, body, _ := strings.Cut(res.Stdout, "\n")
	pwd := strings.TrimPrefix(head, "@@PWD ")
	fields := strings.Split(body, "\x00")
	var list []FileEntry
	for i := 0; i+8 < len(fields) && len(list) < 20000; i += 9 {
		f := fields[i : i+9]
		e := FileEntry{Name: f[0], Type: f[1], Mode: f[4], User: f[5], Group: f[6], Link: f[7]}
		e.Size, _ = strconv.ParseInt(f[2], 10, 64)
		e.MTime, _ = strconv.ParseFloat(f[3], 64)
		if e.Type == "l" {
			e.Target = f[8]
		}
		if !utf8.ValidString(e.Name) {
			e.Name = strings.ToValidUTF8(e.Name, "�")
		}
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool {
		di := list[i].Type == "d" || list[i].Type == "l" && list[i].Target == "d"
		dj := list[j].Type == "d" || list[j].Type == "l" && list[j].Target == "d"
		if di != dj {
			return di
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	if list == nil {
		list = []FileEntry{}
	}
	writeJSON(w, 200, map[string]any{"path": pwd, "entries": list, "truncated": res.Truncated})
}

func (a *App) handleFileRead(w http.ResponseWriter, r *http.Request, m *Monitor) {
	p, err := cleanRemotePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	script := fmt.Sprintf(`export LC_ALL=C
f=%s
if [ -d "$f" ]; then echo "@@ERR это папка"; exit 0; fi
if [ ! -e "$f" ]; then echo "@@ERR файл не найден"; exit 0; fi
if [ ! -f "$f" ]; then echo "@@ERR это не обычный файл"; exit 0; fi
sz=$(stat -L -c %%s -- "$f") || exit 4
if [ "$sz" -gt %d ]; then echo "@@BIG $sz"; exit 0; fi
echo "@@META $(stat -L -c '%%s %%Y %%a %%U %%G' -- "$f")"
cat -- "$f" > /dev/null || exit 4
echo "@@SHA $(sha256sum -- "$f" | cut -d' ' -f1)"
echo "@@DATA"
base64 -w0 -- "$f"
echo
`, shq(p), maxEditSize)
	srv := m.server()
	res := a.runFileScript(ctx, &srv, sudo, script, 4<<20)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	out := res.Stdout
	if strings.HasPrefix(out, "@@ERR ") {
		writeErr(w, 400, strings.TrimSpace(strings.TrimPrefix(out, "@@ERR ")))
		return
	}
	if strings.HasPrefix(out, "@@BIG ") {
		n, _ := strconv.ParseInt(strings.TrimSpace(out[6:]), 10, 64)
		writeJSON(w, 200, map[string]any{"path": p, "tooBig": true, "size": n})
		return
	}
	if res.Code != 0 || !strings.HasPrefix(out, "@@META ") {
		msg := permError(res.Stderr)
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 403, msg)
		return
	}
	resp := map[string]any{"path": p}
	head, data, _ := strings.Cut(out, "@@DATA\n")
	data = strings.TrimSpace(data)
	for _, l := range strings.Split(head, "\n") {
		switch {
		case strings.HasPrefix(l, "@@META "):
			f := strings.Fields(l[7:])
			if len(f) >= 5 {
				sz, _ := strconv.ParseInt(f[0], 10, 64)
				mt, _ := strconv.ParseInt(f[1], 10, 64)
				resp["size"], resp["mtime"], resp["mode"], resp["user"], resp["group"] = sz, mt, f[2], f[3], f[4]
			}
		case strings.HasPrefix(l, "@@SHA "):
			resp["sha"] = strings.TrimSpace(l[6:])
		}
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		writeErr(w, 502, "не удалось прочитать файл")
		return
	}
	if utf8.Valid(raw) && !bytes.Contains(raw, []byte{0}) {
		resp["content"] = string(raw)
	} else {
		resp["binary"] = true
	}
	writeJSON(w, 200, resp)
}

func randToken() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *App) handleFileWrite(w http.ResponseWriter, r *http.Request, m *Monitor) {
	r.Body = http.MaxBytesReader(w, r.Body, 4*maxEditSize)
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		SHA     string `json:"sha"` // ожидаемая сумма текущего файла; "" — создать новый
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос или файл слишком большой")
		return
	}
	p, err := cleanRemotePath(req.Path)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if len(req.Content) > maxEditSize {
		writeErr(w, 400, "файл больше 2 МБ")
		return
	}
	if req.SHA != "" && (len(req.SHA) != 64 || strings.Trim(req.SHA, "0123456789abcdef") != "") {
		writeErr(w, 400, "неверная контрольная сумма")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	enc := base64.StdEncoding.EncodeToString([]byte(req.Content))
	var b strings.Builder
	for i := 0; i < len(enc); i += 76 {
		j := min(i+76, len(enc))
		b.WriteString(enc[i:j])
		b.WriteByte('\n')
	}
	eof := "SP_EOF_" + randToken()
	// пишем во временный файл рядом и атомарно подменяем; права и владельца
	// берём у прежнего файла; если файл успел измениться — не трогаем его
	script := fmt.Sprintf(`export LC_ALL=C
f=%s
exp=%s
t=$(readlink -f -- "$f" 2>/dev/null); [ -n "$t" ] || t="$f"
if [ -n "$exp" ]; then
  cur=$(sha256sum -- "$t" 2>/dev/null | cut -d' ' -f1)
  [ "$cur" = "$exp" ] || { echo "@@CONFLICT"; exit 0; }
elif [ -e "$t" ]; then
  echo "@@EXISTS"; exit 0
fi
d=$(dirname -- "$t")
[ -d "$d" ] || { echo "@@ERR нет папки $d"; exit 0; }
tmp=$(mktemp -- "$d/.sp-edit.XXXXXX") || exit 5
base64 -d > "$tmp" <<'%s' || { rm -f -- "$tmp"; exit 5; }
%s%s
if [ -e "$t" ]; then
  chmod --reference="$t" -- "$tmp" 2>/dev/null
  chown --reference="$t" -- "$tmp" 2>/dev/null
else
  chmod 644 -- "$tmp"
fi
mv -f -- "$tmp" "$t" || { rm -f -- "$tmp"; exit 5; }
echo "@@OK $(sha256sum -- "$t" | cut -d' ' -f1) $(stat -c '%%s %%Y' -- "$t")"
`, shq(p), shq(req.SHA), eof, b.String(), eof)
	srv := m.server()
	res := a.runFileScript(ctx, &srv, sudo, script, 64<<10)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	out := strings.TrimSpace(res.Stdout)
	switch {
	case strings.HasPrefix(out, "@@CONFLICT"):
		writeErr(w, 409, "файл изменился на сервере, пока вы его редактировали — откройте его заново")
	case strings.HasPrefix(out, "@@EXISTS"):
		writeErr(w, 409, "такой файл уже есть")
	case strings.HasPrefix(out, "@@ERR "):
		writeErr(w, 400, strings.TrimPrefix(out, "@@ERR "))
	case strings.HasPrefix(out, "@@OK "):
		f := strings.Fields(out[5:])
		resp := map[string]any{"ok": true}
		if len(f) >= 3 {
			resp["sha"] = f[0]
			resp["size"], _ = strconv.ParseInt(f[1], 10, 64)
			resp["mtime"], _ = strconv.ParseInt(f[2], 10, 64)
		}
		writeJSON(w, 200, resp)
	default:
		msg := permError(res.Stderr)
		if msg == "" {
			msg = res.errText()
		}
		if msg == "" {
			msg = "не удалось сохранить"
		}
		writeErr(w, 403, msg)
	}
}

// protectedPath — что нельзя удалять или переименовывать из панели.
func protectedPath(p string) string {
	if strings.Count(p, "/") <= 1 {
		return "системные папки верхнего уровня удалять и переименовывать из панели нельзя"
	}
	base := path.Base(p)
	if base == ".ssh" || base == "authorized_keys" || p == "/etc/ssh" || p == "/etc/sudoers" || p == "/etc/sudoers.d" ||
		p == "/etc/passwd" || p == "/etc/shadow" || p == "/etc/fstab" || strings.HasPrefix(p, "/boot/") || strings.HasPrefix(p, "/proc/") || strings.HasPrefix(p, "/sys/") {
		return "это может лишить доступа к серверу — сделайте это в терминале, если уверены"
	}
	return ""
}

func (a *App) handleFileOp(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Op   string `json:"op"`
		Path string `json:"path"`
		To   string `json:"to"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	p, err := cleanRemotePath(req.Path)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var script string
	switch req.Op {
	case "mkdir":
		script = fmt.Sprintf("mkdir -- %s", shq(p))
	case "delete":
		if msg := protectedPath(p); msg != "" {
			writeErr(w, 400, msg)
			return
		}
		script = fmt.Sprintf("rm -rf -- %s", shq(p))
	case "rename":
		to, err := cleanRemotePath(req.To)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		if msg := protectedPath(p); msg != "" {
			writeErr(w, 400, msg)
			return
		}
		script = fmt.Sprintf("if [ -e %[2]s ] || [ -L %[2]s ]; then echo 'уже есть файл с таким именем' >&2; exit 1; fi\nmv -n -- %[1]s %[2]s", shq(p), shq(to))
	default:
		writeErr(w, 400, "неизвестное действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	srv := m.server()
	res := a.runFileScript(ctx, &srv, sudo, "export LC_ALL=C\n"+script+"\n", 64<<10)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	if res.Code != 0 {
		msg := permError(res.Stderr)
		if strings.Contains(res.Stderr, "File exists") {
			msg = "уже существует"
		}
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 400, msg)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// handleFileDownload отдаёт файл с сервера потоком, не держа его в памяти.
func (a *App) handleFileDownload(w http.ResponseWriter, r *http.Request, m *Monitor) {
	p, err := cleanRemotePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	srv := m.server()
	// первая строка — размер или ошибка, дальше содержимое
	remote := sudo + "sh -c " + shq(`[ -f "$0" ] || { echo "ERR"; exit 0; }; stat -L -c %s -- "$0"; exec cat -- "$0"`) + " " + shq(p)
	cmd := exec.CommandContext(ctx, "ssh", append(a.sshArgs(&srv), remote)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer cmd.Wait()
	var first []byte
	buf := make([]byte, 1)
	for len(first) < 32 {
		n, err := stdout.Read(buf)
		if n == 1 {
			if buf[0] == '\n' {
				break
			}
			first = append(first, buf[0])
		}
		if err != nil {
			break
		}
	}
	size, perr := strconv.ParseInt(string(first), 10, 64)
	if perr != nil {
		cancel()
		_ = cmd.Wait()
		msg := "это не обычный файл"
		if string(first) != "ERR" {
			if msg = permError(stderr.String()); msg == "" {
				msg = "не удалось прочитать файл"
			}
		}
		writeErr(w, 404, msg)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(p)}))
	h.Set("Cache-Control", "no-store")
	_, _ = io.CopyN(w, stdout, size)
}

// handleFileUpload принимает файл телом запроса и записывает его на сервер.
func (a *App) handleFileUpload(w http.ResponseWriter, r *http.Request, m *Monitor) {
	p, err := cleanRemotePath(r.URL.Query().Get("path"))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	sudo, err := a.wantRoot(r, m, ctx)
	if err != nil {
		writeErr(w, 403, err.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<30)
	noClobber := "0"
	if r.URL.Query().Get("overwrite") != "1" {
		noClobber = "1"
	}
	script := `t="$0"; nc="$1"
if [ "$nc" = 1 ] && [ -e "$t" ]; then cat > /dev/null; echo "уже есть файл с таким именем" >&2; exit 7; fi
cat > "$t.sp-up" || { rm -f -- "$t.sp-up"; exit 1; }
if [ -e "$t" ]; then chmod --reference="$t" -- "$t.sp-up" 2>/dev/null; chown --reference="$t" -- "$t.sp-up" 2>/dev/null; else chmod 644 -- "$t.sp-up"; fi
mv -f -- "$t.sp-up" "$t"`
	remote := sudo + "sh -c " + shq(script) + " " + shq(p) + " " + noClobber
	srv := m.server()
	cmd := exec.CommandContext(ctx, "ssh", append(a.sshArgs(&srv), remote)...)
	cmd.Stdin = r.Body
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	cmd.WaitDelay = 2 * time.Second
	err = cmd.Run()
	if err != nil {
		var ee *exec.ExitError
		code := -1
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		msg := permError(stderr.String())
		if code == 7 {
			writeErr(w, 409, "уже есть файл с таким именем")
			return
		}
		if msg == "" {
			msg = err.Error()
		}
		writeErr(w, 400, msg)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
