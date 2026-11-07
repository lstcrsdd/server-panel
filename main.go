// Method Network Panel — локальная веб-панель мониторинга и управления серверами по SSH.
//
// Панель ничего не устанавливает на серверы: она подключается к ним так же, как
// обычный `ssh <host>` (через ~/.ssh/config и ваши ключи), читает /proc и
// выполняет команды управления. Веб-интерфейс слушает только 127.0.0.1.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed web
var webFiles embed.FS

func main() {
	// ssh запускает панель как SSH_ASKPASS при добавлении сервера по паролю
	if os.Getenv("SP_ASKPASS") == "1" {
		askpassMain()
		return
	}
	listen := flag.String("listen", "127.0.0.1:7780", "адрес веб-интерфейса")
	noOpen := flag.Bool("no-open", false, "не открывать браузер при запуске")
	interval := flag.Int("interval", 2, "интервал сбора метрик, секунд")
	dataDirFlag := flag.String("data", "", "каталог данных (по умолчанию ~/.server-panel)")
	notify := flag.Bool("notify", true, "отправлять оповещения (уведомления системы, Telegram)")
	flag.Parse()

	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatal(err)
	}
	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = filepath.Join(home, ".server-panel")
	}
	if *interval < 1 {
		*interval = 1
	}

	app, err := NewApp(dataDir, home, time.Duration(*interval)*time.Second, *notify)
	if err != nil {
		log.Fatal(err)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		// повторный запуск (двойной клик по ярлыку, когда панель уже работает
		// в фоне): просто открываем уже запущенную панель
		if u := localURL(*listen); u != "" && panelRunning(u) {
			log.Printf("Панель уже запущена: %s", u)
			if !*noOpen {
				openBrowser(u)
			}
			return
		}
		log.Fatalf("не удалось открыть %s: %v", *listen, err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	url := fmt.Sprintf("http://%s/", displayHostPort(addr))

	token := randomHex(24)
	staticFS, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}
	indexRaw, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		log.Fatal(err)
	}
	indexHTML := []byte(strings.ReplaceAll(string(indexRaw), "__PANEL_TOKEN__", token))
	fileServer := http.FileServer(http.FS(staticFS))

	mux := http.NewServeMux()
	app.routes(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(indexHTML)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})

	app.Start()

	srv := &http.Server{
		Handler:           guard(mux, token, allowedHosts(addr)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	log.Printf("Панель Method Network запущена: %s", url)
	if !*noOpen {
		openBrowser(url)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Println("остановка…")
	app.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

// guard защищает API: только разрешённые Host (защита от DNS rebinding) и
// секретный токен, который знает лишь страница, отданная этим процессом
// (защита от CSRF со сторонних сайтов).
func guard(next http.Handler, token string, hosts map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hosts != nil && !hosts[strings.ToLower(r.Host)] {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			t := r.Header.Get("X-Panel-Token")
			if t == "" && r.Method == http.MethodGet && queryTokenOK(r.URL.Path) {
				t = r.URL.Query().Get("token")
			}
			if subtle.ConstantTimeCompare([]byte(t), []byte(token)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
				return
			}
		} else {
			h.Set("X-Frame-Options", "DENY")
			h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
		}
		next.ServeHTTP(w, r)
	})
}

func allowedHosts(addr *net.TCPAddr) map[string]bool {
	if !addr.IP.IsLoopback() {
		return nil // слушаем не только localhost — остаётся проверка токена
	}
	p := strconv.Itoa(addr.Port)
	return map[string]bool{
		"127.0.0.1:" + p: true,
		"localhost:" + p: true,
		"[::1]:" + p:     true,
	}
}

func displayHostPort(addr *net.TCPAddr) string {
	if addr.IP.IsUnspecified() {
		return "127.0.0.1:" + strconv.Itoa(addr.Port)
	}
	return net.JoinHostPort(addr.IP.String(), strconv.Itoa(addr.Port))
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return
	}
	_ = cmd.Start()
}

// localURL — адрес панели для проверки из этого же компьютера.
func localURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return ""
	}
	if ip := net.ParseIP(host); host == "" || ip != nil && ip.IsUnspecified() {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/"
}

// panelRunning — отвечает ли по адресу именно эта панель, а не другая программа.
func panelRunning(url string) bool {
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return resp.StatusCode == http.StatusOK && strings.Contains(string(b), "<title>Method Network")
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// queryTokenOK — запросы, которые браузер делает сам (EventSource, ссылка на
// скачивание) и не может передать заголовок: им можно передать токен в адресе.
func queryTokenOK(p string) bool {
	return p == "/api/stream" || strings.HasSuffix(p, "/files/download") || strings.HasSuffix(p, "/stream") && strings.Contains(p, "/term/")
}
