package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- обновления и безопасность ----------

func systemScript(sudo string) string {
	return fmt.Sprintf(`export LC_ALL=C
S=%q
echo "@@APT"
if command -v apt >/dev/null 2>&1; then echo "have=1"; apt list --upgradable 2>/dev/null | grep -F '[upgradable from' ; fi
echo "@@REBOOT"
if [ -f /var/run/reboot-required ]; then echo "required"; cat /var/run/reboot-required.pkgs 2>/dev/null | sort -u | head -n 40; fi
echo "@@TIMES"
for f in /var/lib/apt/periodic/update-success-stamp /var/lib/apt/lists/partial /var/cache/apt/pkgcache.bin; do
  [ -e "$f" ] && { echo "update=$(stat -c %%Y "$f")"; break; }
done
l=$(grep -h ' upgrade \| install ' /var/log/dpkg.log 2>/dev/null | tail -n 1 | cut -c1-19)
[ -n "$l" ] && echo "upgrade=$(date -d "$l" +%%s 2>/dev/null)"
echo "@@AUTO"
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null | grep -v '^\s*//'
echo "unattended=$(systemctl is-enabled unattended-upgrades 2>/dev/null)/$(systemctl is-active unattended-upgrades 2>/dev/null)"
echo "@@JOB"
systemctl list-units 'sp-apt-*' --all --no-legend --no-pager --plain 2>/dev/null | awk '{print $1, $3, $4}'
echo "@@SSHD"
$S sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|permitemptypasswords|maxauthtries|x11forwarding|allowusers|allowgroups|listenaddress) '
echo "@@F2B"
if command -v fail2ban-client >/dev/null 2>&1; then
  echo "have=1"
  echo "active=$(systemctl is-active fail2ban 2>/dev/null)"
  for j in $($S fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
    echo "@@JAIL $j"
    $S fail2ban-client status "$j" 2>/dev/null | sed -n 's/^[ |\x60-]*//p'
  done
fi
echo "@@UFW"
if command -v ufw >/dev/null 2>&1; then echo "have=1"; $S ufw status verbose 2>/dev/null | head -n 80; fi
echo "@@AUTH"
{ $S journalctl -t sshd -t sshd-session --since "-24h" -o short-iso --no-pager 2>/dev/null || $S cat /var/log/auth.log 2>/dev/null; } | awk '
function after(w,   i) { for (i = 1; i < NF; i++) if ($i == w) return $(i+1); return "" }
/Invalid user / { u = after("user"); ip = after("from"); fail++; byip[ip]++; byuser[u]++; next }
/Failed (password|publickey|keyboard-interactive)/ && !/invalid user/ { u = after("for"); ip = after("from"); fail++; byip[ip]++; byuser[u]++; next }
/Connection closed by authenticating user|Disconnected from authenticating user/ { u = after("user"); ip = $(NF-3); fail++; byip[ip]++; byuser[u]++; next }
/Accepted (publickey|password|keyboard-interactive)/ { ok++; k = after("for") " " after("from") " " after("Accepted"); accn[k]++; acct[k] = $1 }
END {
  print "fail=" fail+0; print "ok=" ok+0
  for (k in byip) print "ip", byip[k], k
  for (k in byuser) print "user", byuser[k], k
  for (k in accn) print "acc", accn[k], acct[k], k
}'
echo "@@END"
`, sudo)
}

type AptPkg struct {
	Name     string `json:"name"`
	From     string `json:"from"`
	To       string `json:"to"`
	Security bool   `json:"security,omitempty"`
}

type F2BJail struct {
	Name        string   `json:"name"`
	Banned      int      `json:"banned"`
	TotalBanned int      `json:"totalBanned"`
	Failed      int      `json:"failed"`
	IPs         []string `json:"ips"`
}

type Login struct {
	N      int    `json:"n"`
	User   string `json:"user"`
	IP     string `json:"ip"`
	Method string `json:"method"`
	Time   string `json:"time"`
}

type CountItem struct {
	Key string `json:"key"`
	N   int    `json:"n"`
}

type SystemInfo struct {
	Apt         bool              `json:"apt"`
	Upgrades    []AptPkg          `json:"upgrades"`
	Security    int               `json:"security"`
	Reboot      bool              `json:"reboot"`
	RebootPkgs  []string          `json:"rebootPkgs,omitempty"`
	LastUpdate  int64             `json:"lastUpdate,omitempty"`
	LastUpgrade int64             `json:"lastUpgrade,omitempty"`
	AutoUpdate  bool              `json:"autoUpdate"`
	AutoUpgrade bool              `json:"autoUpgrade"`
	Unattended  string            `json:"unattended,omitempty"`
	Job         string            `json:"job,omitempty"` // работающее задание обновления
	SSHD        map[string]string `json:"sshd"`
	F2B         bool              `json:"f2b"`
	F2BActive   string            `json:"f2bActive,omitempty"`
	Jails       []F2BJail         `json:"jails"`
	UFW         bool              `json:"ufw"`
	UFWStatus   string            `json:"ufwStatus,omitempty"`
	UFWText     string            `json:"ufwText,omitempty"`
	AuthFail    int               `json:"authFail"`
	AuthOK      int               `json:"authOk"`
	AuthIPs     []CountItem       `json:"authIps"`
	AuthUsers   []CountItem       `json:"authUsers"`
	Accepted    []Login           `json:"accepted"`
	Privileged  bool              `json:"privileged"`
}

var aptLineRe = regexp.MustCompile(`^([^/\s]+)/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]`)

func parseSystem(out string) *SystemInfo {
	si := &SystemInfo{SSHD: map[string]string{}, Upgrades: []AptPkg{}, Jails: []F2BJail{}, AuthIPs: []CountItem{}, AuthUsers: []CountItem{}, Accepted: []Login{}}
	section := ""
	var jail *F2BJail
	var ufw []string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			f := strings.Fields(l[2:])
			if len(f) == 0 {
				continue
			}
			section = f[0]
			if section == "JAIL" && len(f) > 1 {
				si.Jails = append(si.Jails, F2BJail{Name: f[1], IPs: []string{}})
				jail = &si.Jails[len(si.Jails)-1]
			}
			continue
		}
		t := strings.TrimSpace(l)
		if t == "" {
			continue
		}
		switch section {
		case "APT":
			if t == "have=1" {
				si.Apt = true
				continue
			}
			if m := aptLineRe.FindStringSubmatch(t); m != nil {
				p := AptPkg{Name: m[1], To: m[3], From: m[4], Security: strings.Contains(m[2], "-security")}
				if p.Security {
					si.Security++
				}
				si.Upgrades = append(si.Upgrades, p)
			}
		case "REBOOT":
			if t == "required" {
				si.Reboot = true
			} else {
				si.RebootPkgs = append(si.RebootPkgs, t)
			}
		case "TIMES":
			k, v, _ := strings.Cut(t, "=")
			n, _ := strconv.ParseInt(v, 10, 64)
			if k == "update" {
				si.LastUpdate = n * 1000
			} else if k == "upgrade" {
				si.LastUpgrade = n * 1000
			}
		case "AUTO":
			if strings.HasPrefix(t, "unattended=") {
				si.Unattended = strings.TrimPrefix(t, "unattended=")
				continue
			}
			on := strings.Contains(t, `"1"`)
			if strings.Contains(t, "Update-Package-Lists") {
				si.AutoUpdate = on
			}
			if strings.Contains(t, "Unattended-Upgrade") {
				si.AutoUpgrade = on
			}
		case "JOB":
			f := strings.Fields(t)
			if len(f) >= 2 && (f[1] == "active" || f[1] == "activating") {
				si.Job = f[0]
			}
		case "SSHD":
			if k, v, ok := strings.Cut(t, " "); ok {
				k = strings.ToLower(k)
				if prev, ok := si.SSHD[k]; ok {
					v = prev + ", " + v
				}
				si.SSHD[k] = v
			}
		case "F2B":
			if t == "have=1" {
				si.F2B = true
			} else if strings.HasPrefix(t, "active=") {
				si.F2BActive = strings.TrimPrefix(t, "active=")
			}
		case "JAIL":
			if jail == nil {
				continue
			}
			k, v, ok := strings.Cut(t, ":")
			if !ok {
				continue
			}
			v = strings.TrimSpace(v)
			switch strings.TrimSpace(k) {
			case "Currently banned":
				jail.Banned, _ = strconv.Atoi(v)
			case "Total banned":
				jail.TotalBanned, _ = strconv.Atoi(v)
			case "Currently failed":
				jail.Failed, _ = strconv.Atoi(v)
			case "Banned IP list":
				for _, ip := range strings.Fields(v) {
					if net.ParseIP(ip) != nil && len(jail.IPs) < 500 {
						jail.IPs = append(jail.IPs, ip)
					}
				}
			}
		case "UFW":
			if t == "have=1" {
				si.UFW = true
				continue
			}
			if strings.HasPrefix(t, "Status:") {
				si.UFWStatus = strings.TrimSpace(strings.TrimPrefix(t, "Status:"))
			}
			ufw = append(ufw, strings.TrimRight(l, " "))
		case "AUTH":
			switch {
			case strings.HasPrefix(t, "fail="):
				si.AuthFail, _ = strconv.Atoi(t[5:])
			case strings.HasPrefix(t, "ok="):
				si.AuthOK, _ = strconv.Atoi(t[3:])
			case strings.HasPrefix(t, "ip "), strings.HasPrefix(t, "user "):
				f := strings.Fields(t)
				if len(f) >= 3 {
					n, _ := strconv.Atoi(f[1])
					it := CountItem{Key: f[2], N: n}
					if f[0] == "ip" {
						si.AuthIPs = append(si.AuthIPs, it)
					} else {
						si.AuthUsers = append(si.AuthUsers, it)
					}
				}
			case strings.HasPrefix(t, "acc "):
				// acc <число> <время> <пользователь> <адрес> <способ>
				f := strings.Fields(t)
				if len(f) >= 6 {
					n, _ := strconv.Atoi(f[1])
					lg := Login{N: n, User: f[3], IP: f[4], Method: f[5]}
					if strings.Contains(f[2], "T") {
						lg.Time = f[2]
					}
					si.Accepted = append(si.Accepted, lg)
				}
			}
		}
	}
	si.UFWText = strings.Join(ufw, "\n")
	top := func(xs []CountItem) []CountItem {
		sort.Slice(xs, func(i, j int) bool { return xs[i].N > xs[j].N || xs[i].N == xs[j].N && xs[i].Key < xs[j].Key })
		if len(xs) > 12 {
			xs = xs[:12]
		}
		return xs
	}
	si.AuthIPs, si.AuthUsers = top(si.AuthIPs), top(si.AuthUsers)
	sort.Slice(si.Accepted, func(i, j int) bool { return si.Accepted[i].Time > si.Accepted[j].Time })
	if len(si.Accepted) > 10 {
		si.Accepted = si.Accepted[:10]
	}
	sort.Slice(si.Upgrades, func(i, j int) bool {
		if si.Upgrades[i].Security != si.Upgrades[j].Security {
			return si.Upgrades[i].Security
		}
		return si.Upgrades[i].Name < si.Upgrades[j].Name
	})
	return si
}

func (a *App) handleSystem(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, systemScript(strings.TrimSpace(m.sudo(ctx))))
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	si := parseSystem(res.Stdout)
	in := m.ensureInfo(ctx)
	si.Privileged = in != nil && (in.UID == 0 || in.Sudo)
	writeJSON(w, 200, si)
}

var jobUnitRe = regexp.MustCompile(`^sp-apt-[0-9]+$`)

// handleAptJob запускает apt update/upgrade фоновым заданием systemd: оно
// продолжит работу, даже если SSH-соединение оборвётся.
func (a *App) handleAptJob(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil || (req.Action != "update" && req.Action != "upgrade") {
		writeErr(w, 400, "неизвестное действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	in := m.ensureInfo(ctx)
	if in == nil || (in.UID != 0 && !in.Sudo) {
		writeErr(w, 403, "нужен root или sudo без пароля")
		return
	}
	sudo := m.sudo(ctx)
	steps := "apt-get update"
	if req.Action == "upgrade" {
		steps = "apt-get update && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade"
	}
	unit := fmt.Sprintf("sp-apt-%d", time.Now().Unix())
	// команду кладём во временный файл: systemd подставляет переменные вида $X
	// в аргументы systemd-run, поэтому сам скрипт в командную строку не передаём
	script := fmt.Sprintf(`export LC_ALL=C
if systemctl list-units 'sp-apt-*' --no-legend --no-pager --plain --state=active,activating 2>/dev/null | grep -q .; then
  echo "@@BUSY $(systemctl list-units 'sp-apt-*' --no-legend --no-pager --plain --state=active,activating | awk 'NR==1{print $1}')"; exit 0
fi
if pgrep -x 'apt|apt-get|dpkg|unattended-upgr' >/dev/null 2>&1; then echo "@@LOCKED"; exit 0; fi
f=$(mktemp /tmp/sp-apt.XXXXXX) || exit 1
cat > "$f" <<'SP_APT_EOF'
%[4]s
rc=$?
echo "@@EXIT $rc"
rm -f -- "$0"
exit $rc
SP_APT_EOF
%[1]ssystemd-run --unit=%[2]s --collect --description="Method Panel: apt %[3]s" \
  --setenv=DEBIAN_FRONTEND=noninteractive --setenv=NEEDRESTART_MODE=l --setenv=LC_ALL=C \
  sh "$f" 2>&1 && echo "@@STARTED" || rm -f -- "$f"
`, sudo, unit, req.Action, steps)
	srv := m.server()
	res := a.runScript(ctx, &srv, script)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	out := res.Stdout
	switch {
	case strings.Contains(out, "@@BUSY"):
		u := strings.TrimSuffix(strings.TrimSpace(strings.SplitN(out, "@@BUSY", 2)[1]), ".service")
		writeJSON(w, 200, map[string]any{"unit": u, "already": true})
	case strings.Contains(out, "@@LOCKED"):
		writeErr(w, 409, "на сервере уже работает apt или dpkg (например, автоматические обновления) — попробуйте через несколько минут")
	case strings.Contains(out, "@@STARTED"):
		writeJSON(w, 200, map[string]any{"unit": unit})
	default:
		msg := strings.TrimSpace(out + "\n" + res.Stderr)
		writeErr(w, 500, "не удалось запустить: "+lastLines(msg, 4))
	}
}

func (a *App) handleAptJobLog(w http.ResponseWriter, r *http.Request, m *Monitor) {
	unit := r.URL.Query().Get("unit")
	if !jobUnitRe.MatchString(unit) {
		writeErr(w, 400, "неверное задание")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	sudo := m.sudo(ctx)
	script := fmt.Sprintf(`export LC_ALL=C
echo "@@STATE $(systemctl show -p ActiveState --value %[2]s.service 2>/dev/null)"
%[1]sjournalctl -u %[2]s.service -o cat --no-pager -n 600 2>/dev/null
`, sudo, unit)
	srv := m.server()
	res := a.runScript(ctx, &srv, script)
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	head, log, _ := strings.Cut(res.Stdout, "\n")
	state := strings.TrimSpace(strings.TrimPrefix(head, "@@STATE"))
	exit := -1
	var lines []string
	for _, l := range strings.Split(log, "\n") {
		if strings.HasPrefix(l, "@@EXIT ") {
			exit, _ = strconv.Atoi(strings.TrimSpace(l[7:]))
			continue
		}
		lines = append(lines, l)
	}
	running := state == "active" || state == "activating"
	writeJSON(w, 200, map[string]any{"running": running, "exit": exit, "log": strings.TrimRight(strings.Join(lines, "\n"), "\n")})
}

var jailRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

func (a *App) handleUnban(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Jail string `json:"jail"`
		IP   string `json:"ip"`
	}
	if err := readJSON(r, &req); err != nil || !jailRe.MatchString(req.Jail) || net.ParseIP(req.IP) == nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, fmt.Sprintf("%sfail2ban-client set %s unbanip %s 2>&1", m.sudo(ctx), shq(req.Jail), shq(req.IP)))
	actionResult(w, res)
}
