package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Подставной systemctl: список служб — из файла $STUB_UNITS («имя load active sub»).
const stubSystemctl = `#!/bin/sh
case "$1" in
  list-units) cat "$STUB_UNITS" ;;
  show)
    u=; for a in "$@"; do u=$a; done
    awk -v u="$u" '$1 == u {print "LoadState=" $2; print "ActiveState=" $3; print "SubState=" $4; f=1}
      END {if (!f) print "LoadState=not-found"; print "UnitFileState=enabled"; print "Result=exit-code"; print "Type=oneshot"}' "$STUB_UNITS" ;;
  is-active) echo failed ;;
esac
`

type wdRig struct {
	t                  *testing.T
	dir, script, units string
	env                []string
}

func newWDRig(t *testing.T) *wdRig {
	if runtime.GOOS == "windows" {
		t.Skip("нужен sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("нет sh")
	}
	d := t.TempDir()
	r := &wdRig{t: t, dir: d, script: filepath.Join(d, "watchdog.sh"), units: filepath.Join(d, "units")}
	write := func(name, body string, mode os.FileMode) {
		if err := os.WriteFile(filepath.Join(d, name), []byte(body), mode); err != nil {
			t.Fatal(err)
		}
	}
	write("watchdog.sh", strings.Replace(watchdogScript, "@@VER@@", strconv.Itoa(watchdogVer), 1), 0o700)
	write("systemctl", stubSystemctl, 0o700)
	write("watchdog.conf", "NAME=test\nFAILED=1\nVPN_WAIT=60\nVPN_RE=xray\nRECOVERY=1\n", 0o600)
	r.env = append(os.Environ(),
		"WD_CONF="+filepath.Join(d, "watchdog.conf"),
		"WD_STATE="+filepath.Join(d, "state"),
		"WD_SYSTEMCTL="+filepath.Join(d, "systemctl"),
		"STUB_UNITS="+r.units)
	return r
}

// run — один запуск сторожа в момент now с таким списком служб; возвращает его сообщения.
func (r *wdRig) run(now int, units ...string) string {
	r.t.Helper()
	if err := os.WriteFile(r.units, []byte(strings.Join(units, "\n")+"\n"), 0o600); err != nil {
		r.t.Fatal(err)
	}
	cmd := exec.Command("sh", r.script, "dry")
	cmd.Env = append(r.env, "WD_NOW="+strconv.Itoa(1_800_000_000+now))
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("t=%d: %v\n%s", now, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (r *wdRig) expect(now int, want string, units ...string) {
	r.t.Helper()
	got := r.run(now, units...)
	if want == "" && got != "" || want != "" && !strings.Contains(got, want) {
		r.t.Fatalf("t=%d: ждали %q, получили %q", now, want, got)
	}
}

// Упавшая oneshot-служба по таймеру: пока она снова выполняется, её нет в
// списке упавших — сторож не должен писать «в норме», а через минуту «🔴» снова.
func TestWatchdogFailedOneshotNoFlap(t *testing.T) {
	r := newWDRig(t)
	failed := "feed.service loaded failed failed"
	r.expect(0, "", failed)
	r.expect(60, "🔴 служба feed не работает (ошибка)", failed)
	r.expect(120, "", "feed.service loaded activating start") // таймер запустил её заново
	r.expect(180, "", failed)                                 // и она снова упала — без повторного «🔴»
	// починилась: в списке её нет, «в норме» — только через 2 минуты
	r.expect(240, "")
	r.expect(300, "")
	r.expect(360, "🟢 служба feed больше не в ошибке")
	r.expect(420, "")
}

// Restart=always: служба то «activating (auto-restart)», то на миг active.
func TestWatchdogRestartLoop(t *testing.T) {
	r := newWDRig(t)
	loop := "api.service loaded activating auto-restart"
	r.expect(0, "", loop)
	r.expect(60, "", loop)
	r.expect(120, "🔴 служба api не работает (падает и перезапускается по кругу)", loop)
	r.expect(180, "", "api.service loaded active running") // попали на миг между падениями
	r.expect(240, "", loop)
}

func TestWatchdogVPNRestartLoop(t *testing.T) {
	r := newWDRig(t)
	r.expect(0, "", "xray.service loaded active running")
	loop := "xray.service loaded activating auto-restart"
	r.expect(60, "", loop)
	r.expect(120, "🔴 VPN-служба xray не работает (падает и перезапускается по кругу)", loop)
	r.expect(180, "", "xray.service loaded active running")
	r.expect(240, "", loop)
	r.expect(300, "", "xray.service loaded active running")
	r.expect(360, "", "xray.service loaded active running")
	r.expect(420, "🟢 VPN-служба xray снова работает (не работала 4 мин)", "xray.service loaded active running")
}
