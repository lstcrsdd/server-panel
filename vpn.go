package main

import (
	"context"
	"fmt"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// vpnScript собирает сведения о VPN- и прокси-службах: состояние systemd,
// процессы, порты, соединения, пиры WireGuard/AmneziaWG и версии программ.
func vpnScript(sudo string) string {
	return fmt.Sprintf(`export LC_ALL=C
S=%q
echo "@@UP $(cut -d' ' -f1 /proc/uptime)"
for u in $(systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk -v re='%s' '$2=="loaded" && tolower($1) ~ re {print $1}'); do
  echo "@@UNIT $u"
  systemctl show "$u" -p Id,Description,ActiveState,SubState,MainPID,ActiveEnterTimestampMonotonic,MemoryCurrent,NRestarts,ExecStart,CPUUsageNSec,UnitFileState,FragmentPath,ControlGroup 2>/dev/null
  cg=$(systemctl show -p ControlGroup --value "$u" 2>/dev/null)
  if [ -n "$cg" ]; then
    for b in /sys/fs/cgroup /sys/fs/cgroup/unified /sys/fs/cgroup/systemd; do
      if [ -r "$b$cg/cgroup.procs" ]; then echo "Pids=$(cat "$b$cg/cgroup.procs" 2>/dev/null | tr '\n' ' ')"; break; fi
    done
  fi
  exe=$(systemctl show -p ExecStart --value "$u" 2>/dev/null | sed -n 's/^.*path=\([^ ;]*\).*$/\1/p' | head -n 1)
  case "$(basename "$exe" 2>/dev/null)" in
    xray|v2ray|sing-box|hysteria|hysteria2) echo "Version=$(timeout 3 "$exe" version 2>&1 | grep -m 1 -E '[0-9]+[.][0-9]+')" ;;
    mtg|telemt|tuic-server|tuic|naive|trojan-go|ss-server|ssserver|ocserv|openvpn|juicity-server|brook|gost|3proxy|danted|chisel|frps|frpc|amneziawg-go|wireguard-go)
      echo "Version=$(timeout 3 "$exe" --version 2>&1 | grep -m 1 -E '[0-9]+[.][0-9]+')" ;;
  esac
done
echo "@@LISTEN"
$S ss -Hltunp 2>/dev/null
echo "@@EST"
ss -Htn state established 2>/dev/null | awk '{l=$3; sub(/.*:/,"",l); p=$4; sub(/:[0-9]+$/,"",p); c[l]++; if(!((l SUBSEP p) in s)){s[l SUBSEP p]=1; u[l]++}} END{for(k in c) print k, c[k], u[k]}'
echo "@@WG"
command -v wg >/dev/null 2>&1 && $S wg show all dump 2>/dev/null | awk -F'\t' 'NF<=5 || $4 ~ /^[0-9]+$/ {print "I\t" $1 "\t" $4; next} {print "P\t" $0}'
command -v awg >/dev/null 2>&1 && $S awg show all dump 2>/dev/null | awk -F'\t' '$4 ~ /^[0-9]+$/ {print "I\t" $1 "\t" $4; next} {print "P\t" $0}'
echo "@@END"
`, sudo, vpnPattern)
}

type VPNPort struct {
	Proto string `json:"proto"`
	Addr  string `json:"addr"`
	Port  int    `json:"port"`
	Conns int    `json:"conns,omitempty"`
	IPs   int    `json:"ips,omitempty"`
	Eph   bool   `json:"eph,omitempty"` // похоже на исходящий UDP-сокет, а не на порт сервера
}

type WGPeer struct {
	Key       string `json:"key"`
	Endpoint  string `json:"endpoint,omitempty"`
	Allowed   string `json:"allowed,omitempty"`
	Handshake int64  `json:"handshake,omitempty"` // unix ms
	Rx        uint64 `json:"rx"`
	Tx        uint64 `json:"tx"`
}

type WGIface struct {
	Name   string   `json:"name"`
	Port   int      `json:"port,omitempty"`
	Peers  int      `json:"peers"`
	Active int      `json:"active"` // рукопожатие за последние 3 минуты
	Rx     uint64   `json:"rx"`
	Tx     uint64   `json:"tx"`
	List   []WGPeer `json:"list"`
}

type VPNService struct {
	Unit        string    `json:"unit"`
	Description string    `json:"description,omitempty"`
	Active      string    `json:"active"`
	Sub         string    `json:"sub"`
	Enabled     string    `json:"enabled,omitempty"`
	PID         int       `json:"pid,omitempty"`
	Since       float64   `json:"since,omitempty"` // сколько секунд работает
	Mem         uint64    `json:"mem,omitempty"`
	CPUSec      float64   `json:"cpuSec,omitempty"`
	Restarts    int       `json:"restarts"`
	Exec        string    `json:"exec,omitempty"`
	Fragment    string    `json:"fragment,omitempty"`
	Config      string    `json:"config,omitempty"`
	Version     string    `json:"version,omitempty"`
	Ports       []VPNPort `json:"ports"`
	Conns       int       `json:"conns"`
	WG          []WGIface `json:"wg,omitempty"`
	pids        map[int]bool
}

var (
	pidRe       = regexp.MustCompile(`pid=(\d+)`)
	argvRe      = regexp.MustCompile(`argv\[\]=([^;]*)`)
	wgUnitRe    = regexp.MustCompile(`^(?:awg|wg)-quick@(.+)\.service$`)
	cfgFlagRe   = regexp.MustCompile(`^--?(c|conf|config|confdir|config-file|cfg)$`)
	cfgInlineRe = regexp.MustCompile(`^--?(?:c|conf|config|config-file|cfg)=(.+)$`)
	cfgExtRe    = regexp.MustCompile(`\.(json|jsonc|ya?ml|toml|conf|cfg|ini)$`)
)

func parseVPN(out string) (svcs []*VPNService, wgAll []WGIface) {
	var uptime float64
	var cur *VPNService
	section := ""
	type listen struct {
		VPNPort
		pids []int
	}
	var listens []listen
	est := map[int][2]int{}
	wgMap := map[string]*WGIface{}
	var wgOrder []string
	now := time.Now().Unix()

	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			f := strings.Fields(l[2:])
			if len(f) == 0 {
				continue
			}
			section = f[0]
			switch section {
			case "UP":
				if len(f) > 1 {
					uptime, _ = strconv.ParseFloat(f[1], 64)
				}
			case "UNIT":
				if len(f) > 1 && unitRe.MatchString(f[1]) {
					cur = &VPNService{Unit: f[1], pids: map[int]bool{}, Ports: []VPNPort{}}
					svcs = append(svcs, cur)
				} else {
					cur = nil
				}
			}
			continue
		}
		switch section {
		case "UNIT":
			if cur == nil {
				continue
			}
			k, v, ok := strings.Cut(l, "=")
			if !ok {
				continue
			}
			switch k {
			case "Description":
				cur.Description = v
			case "ActiveState":
				cur.Active = v
			case "SubState":
				cur.Sub = v
			case "UnitFileState":
				cur.Enabled = v
			case "MainPID":
				cur.PID, _ = strconv.Atoi(v)
				if cur.PID > 0 {
					cur.pids[cur.PID] = true
				}
			case "ActiveEnterTimestampMonotonic":
				if us, err := strconv.ParseFloat(v, 64); err == nil && us > 0 && uptime > 0 {
					cur.Since = uptime - us/1e6
				}
			case "MemoryCurrent":
				if n, err := strconv.ParseUint(v, 10, 64); err == nil && n < 1<<62 {
					cur.Mem = n
				}
			case "CPUUsageNSec":
				if n, err := strconv.ParseUint(v, 10, 64); err == nil && n < 1<<62 {
					cur.CPUSec = float64(n) / 1e9
				}
			case "NRestarts":
				cur.Restarts, _ = strconv.Atoi(v)
			case "ExecStart":
				if m := argvRe.FindStringSubmatch(v); m != nil {
					cur.Exec = strings.TrimSpace(m[1])
				}
			case "FragmentPath":
				cur.Fragment = v
			case "Pids":
				for _, p := range strings.Fields(v) {
					if n, err := strconv.Atoi(p); err == nil {
						cur.pids[n] = true
					}
				}
			case "Version":
				cur.Version = cleanVersion(v)
			}
		case "LISTEN":
			f := strings.Fields(l)
			if len(f) < 5 {
				continue
			}
			addr, port := splitHostPort(f[4])
			if port == 0 {
				continue
			}
			ls := listen{VPNPort: VPNPort{Proto: f[0], Addr: addr, Port: port}}
			for _, m := range pidRe.FindAllStringSubmatch(l, -1) {
				n, _ := strconv.Atoi(m[1])
				ls.pids = append(ls.pids, n)
			}
			listens = append(listens, ls)
		case "EST":
			f := strings.Fields(l)
			if len(f) == 3 {
				p, _ := strconv.Atoi(f[0])
				c, _ := strconv.Atoi(f[1])
				u, _ := strconv.Atoi(f[2])
				est[p] = [2]int{c, u}
			}
		case "WG":
			f := strings.Split(l, "\t")
			if len(f) >= 3 && f[0] == "I" {
				if _, ok := wgMap[f[1]]; !ok {
					port, _ := strconv.Atoi(f[2])
					wgMap[f[1]] = &WGIface{Name: f[1], Port: port, List: []WGPeer{}}
					wgOrder = append(wgOrder, f[1])
				}
				continue
			}
			// P iface pubkey psk endpoint allowed handshake rx tx keepalive
			if len(f) >= 9 && f[0] == "P" {
				w := wgMap[f[1]]
				if w == nil {
					w = &WGIface{Name: f[1], List: []WGPeer{}}
					wgMap[f[1]] = w
					wgOrder = append(wgOrder, f[1])
				}
				hs, _ := strconv.ParseInt(f[6], 10, 64)
				rx, _ := strconv.ParseUint(f[7], 10, 64)
				tx, _ := strconv.ParseUint(f[8], 10, 64)
				p := WGPeer{Key: shortKey(f[2]), Rx: rx, Tx: tx}
				if f[4] != "(none)" {
					p.Endpoint = f[4]
				}
				if f[5] != "(none)" {
					p.Allowed = f[5]
				}
				if hs > 0 {
					p.Handshake = hs * 1000
					if now-hs < 180 {
						w.Active++
					}
				}
				w.Peers++
				w.Rx += rx
				w.Tx += tx
				w.List = append(w.List, p)
			}
		}
	}

	for _, name := range wgOrder {
		w := wgMap[name]
		sort.Slice(w.List, func(i, j int) bool { return w.List[i].Handshake > w.List[j].Handshake })
		if len(w.List) > 200 {
			w.List = w.List[:200]
		}
		wgAll = append(wgAll, *w)
	}

	for _, s := range svcs {
		seen := map[string]bool{}
		for _, ls := range listens {
			match := false
			for _, p := range ls.pids {
				if s.pids[p] {
					match = true
				}
			}
			if !match {
				continue
			}
			k := fmt.Sprintf("%s/%d", ls.Proto, ls.Port)
			if seen[k] {
				continue
			}
			seen[k] = true
			vp := ls.VPNPort
			if vp.Proto == "tcp" {
				e := est[vp.Port]
				vp.Conns, vp.IPs = e[0], e[1]
				s.Conns += e[0]
			}
			s.Ports = append(s.Ports, vp)
		}
		// много UDP-сокетов на случайных высоких портах — это исходящие
		// соединения (QUIC и т.п.), а не порты, на которых служба принимает клиентов
		var eph []int
		for i, p := range s.Ports {
			if p.Proto == "udp" && p.Port >= 32768 && p.Port <= 60999 {
				eph = append(eph, i)
			}
		}
		if len(eph) >= 3 {
			for _, i := range eph {
				s.Ports[i].Eph = true
			}
		}
		if s.Active != "active" {
			s.Since = 0
		}
		sort.Slice(s.Ports, func(i, j int) bool {
			if s.Ports[i].Port != s.Ports[j].Port {
				return s.Ports[i].Port < s.Ports[j].Port
			}
			return s.Ports[i].Proto > s.Ports[j].Proto
		})
		if m := wgUnitRe.FindStringSubmatch(s.Unit); m != nil {
			if w := wgMap[m[1]]; w != nil {
				s.WG = append(s.WG, *w)
				if w.Port > 0 {
					s.Ports = append(s.Ports, VPNPort{Proto: "udp", Port: w.Port})
				}
			}
		}
		s.Config = guessConfig(s)
	}
	sort.SliceStable(svcs, func(i, j int) bool {
		ai, aj := svcs[i].Active == "active", svcs[j].Active == "active"
		if ai != aj {
			return ai
		}
		return svcs[i].Unit < svcs[j].Unit
	})
	return svcs, wgAll
}

func shortKey(k string) string {
	if len(k) > 12 {
		return k[:8] + "…" + k[len(k)-4:]
	}
	return k
}

var verRe = regexp.MustCompile(`v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?`)

// cleanVersion оставляет из вывода `программа version` только номер версии.
func cleanVersion(v string) string {
	if strings.Contains(strings.ToLower(v), "not found") {
		return ""
	}
	return verRe.FindString(v)
}

// guessConfig ищет путь к конфигурации в командной строке службы.
func guessConfig(s *VPNService) string {
	if m := wgUnitRe.FindStringSubmatch(s.Unit); m != nil {
		if strings.HasPrefix(s.Unit, "awg") {
			return "/etc/amnezia/amneziawg/" + m[1] + ".conf"
		}
		return "/etc/wireguard/" + m[1] + ".conf"
	}
	args := strings.Fields(s.Exec)
	for i, a := range args {
		if m := cfgInlineRe.FindStringSubmatch(a); m != nil && strings.HasPrefix(m[1], "/") {
			return m[1]
		}
		if cfgFlagRe.MatchString(a) && i+1 < len(args) && strings.HasPrefix(args[i+1], "/") {
			return args[i+1]
		}
	}
	for _, a := range args[min(1, len(args)):] {
		if strings.HasPrefix(a, "/") && cfgExtRe.MatchString(a) {
			return a
		}
	}
	if len(args) > 0 {
		switch path.Base(args[0]) {
		case "xray":
			return "/usr/local/etc/xray/config.json"
		case "sing-box":
			return "/etc/sing-box/config.json"
		}
	}
	return ""
}

func (a *App) handleVPN(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, vpnScript(strings.TrimSpace(m.sudo(ctx))))
	if res.Err != nil {
		writeErr(w, 502, res.errText())
		return
	}
	svcs, wg := parseVPN(res.Stdout)
	if svcs == nil {
		svcs = []*VPNService{}
	}
	in := m.ensureInfo(ctx)
	priv := in != nil && (in.UID == 0 || in.Sudo)
	writeJSON(w, 200, map[string]any{"services": svcs, "wg": wg, "privileged": priv, "t": time.Now().UnixMilli()})
}
