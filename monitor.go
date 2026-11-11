package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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

// infoScript собирает статические сведения о сервере.
const infoScript = `export LC_ALL=C
echo "hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$PRETTY_NAME"; fi
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "cpu=$(grep -m1 -E '^(model name|Hardware|cpu model|Processor)' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
echo "cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "uid=$(id -u)"
echo "user=$(id -un)"
if [ "$(id -u)" = 0 ] || sudo -n true >/dev/null 2>&1; then echo sudo=1; else echo sudo=0; fi
command -v systemctl >/dev/null 2>&1 && echo systemd=1
command -v journalctl >/dev/null 2>&1 && echo journal=1
command -v docker >/dev/null 2>&1 && echo docker=1
grep -qs '` + watchdogMark + `' /etc/systemd/system/server-panel-watchdog.timer && echo watchdog=1
echo "ips=$(hostname -I 2>/dev/null || ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
echo "tz=$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"
`

// streamScript: сначала сведения о сервере, затем бесконечный цикл кадров
// с сырыми счётчиками из /proc. Скорости и проценты считает панель.
func streamScript(interval time.Duration) string {
	sec := int(interval / time.Second)
	if sec < 1 {
		sec = 1
	}
	return "echo @@I\n" + infoScript + "echo @@E\n" + tempFuncs + fmt.Sprintf(`i=0
SC=$(command -v systemctl 2>/dev/null)
while :; do
  echo @@F
  cat /proc/uptime
  grep '^cpu' /proc/stat
  grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|Shmem|SwapTotal|SwapFree):' /proc/meminfo
  echo @@N; tail -n +3 /proc/net/dev
  echo @@D; cat /proc/diskstats 2>/dev/null
  echo @@L; cat /proc/loadavg
  echo @@S; cat /proc/net/sockstat 2>/dev/null
  if [ $((i %% 10)) -eq 0 ]; then echo @@FS; df -kP 2>/dev/null; fi
`+tempTick+`  if [ $((i %% 15)) -eq 0 ] && [ -n "$SC" ]; then
    echo @@U; systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk -v re='%s' '$3=="failed" || tolower($1) ~ re {print $1, $2, $3, $4}'
  fi
  echo @@E
  i=$((i+1))
  sleep %d
done
`, vpnPattern, sec)
}

type Info struct {
	Hostname string   `json:"hostname"`
	OS       string   `json:"os"`
	Kernel   string   `json:"kernel"`
	Arch     string   `json:"arch"`
	CPU      string   `json:"cpu"`
	Cores    int      `json:"cores"`
	Virt     string   `json:"virt"`
	User     string   `json:"user"`
	UID      int      `json:"uid"`
	Sudo     bool     `json:"sudo"`
	Systemd  bool     `json:"systemd"`
	Journal  bool     `json:"journal"`
	Docker   bool     `json:"docker"`
	IPs      []string `json:"ips"`
	TZ       string   `json:"tz"`
	Watchdog bool     `json:"watchdog,omitempty"` // на сервере стоит сторож панели
}

func parseInfo(lines []string) *Info {
	in := &Info{UID: -1}
	for _, l := range lines {
		k, v, ok := strings.Cut(l, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "hostname":
			in.Hostname = v
		case "os":
			in.OS = v
		case "kernel":
			in.Kernel = v
		case "arch":
			in.Arch = v
		case "cpu":
			in.CPU = strings.Join(strings.Fields(v), " ")
		case "cores":
			in.Cores, _ = strconv.Atoi(v)
		case "virt":
			if v != "none" {
				in.Virt = v
			}
		case "uid":
			if n, err := strconv.Atoi(v); err == nil {
				in.UID = n
			}
		case "user":
			in.User = v
		case "sudo":
			in.Sudo = v == "1"
		case "systemd":
			in.Systemd = v == "1"
		case "journal":
			in.Journal = v == "1"
		case "docker":
			in.Docker = v == "1"
		case "ips":
			for _, ip := range strings.Fields(v) {
				if len(in.IPs) < 12 {
					in.IPs = append(in.IPs, ip)
				}
			}
		case "tz":
			in.TZ = v
		case "watchdog":
			in.Watchdog = v == "1"
		}
	}
	return in
}

// ---------- метрики ----------

type IfaceStat struct {
	Name    string  `json:"name"`
	Rx      float64 `json:"rx"`
	Tx      float64 `json:"tx"`
	RxTotal uint64  `json:"rxTotal"`
	TxTotal uint64  `json:"txTotal"`
	Virtual bool    `json:"virtual"`
}

type DiskStat struct {
	Name string  `json:"name"`
	R    float64 `json:"r"`
	W    float64 `json:"w"`
	Util float64 `json:"util"`
}

type FSStat struct {
	Dev   string  `json:"dev"`
	Mount string  `json:"mount"`
	Size  uint64  `json:"size"`
	Used  uint64  `json:"used"`
	Avail uint64  `json:"avail"`
	Pct   float64 `json:"pct"`
}

type Metrics struct {
	T         int64        `json:"t"`
	Uptime    float64      `json:"uptime"`
	CPU       float64      `json:"cpu"`
	User      float64      `json:"user"`
	System    float64      `json:"system"`
	IOWait    float64      `json:"iowait"`
	Steal     float64      `json:"steal"`
	Cores     []float64    `json:"cores"`
	MemTotal  uint64       `json:"memTotal"`
	MemUsed   uint64       `json:"memUsed"`
	MemCache  uint64       `json:"memCache"`
	MemAvail  uint64       `json:"memAvail"`
	SwapTotal uint64       `json:"swapTotal"`
	SwapUsed  uint64       `json:"swapUsed"`
	NetRx     float64      `json:"netRx"`
	NetTx     float64      `json:"netTx"`
	Ifaces    []IfaceStat  `json:"ifaces"`
	DiskR     float64      `json:"diskR"`
	DiskW     float64      `json:"diskW"`
	DiskUtil  float64      `json:"diskUtil"`
	Disks     []DiskStat   `json:"disks"`
	Load      [3]float64   `json:"load"`
	ProcsRun  int          `json:"procsRun"`
	Procs     int          `json:"procs"`
	TCP       int          `json:"tcp"`
	FS        []FSStat     `json:"fs"`
	Temps     []TempSensor `json:"temps,omitempty"`
}

// Point — компактная точка истории для графиков.
type Point struct {
	T   int64   `json:"t"`
	CPU float64 `json:"c"`
	U   float64 `json:"u"`
	S   float64 `json:"s"`
	W   float64 `json:"w"`
	St  float64 `json:"st"`
	Mem float64 `json:"m"`
	MU  float64 `json:"mu"`
	MC  float64 `json:"mc"`
	MT  float64 `json:"mt"`
	Rx  float64 `json:"rx"`
	Tx  float64 `json:"tx"`
	DR  float64 `json:"dr"`
	DW  float64 `json:"dw"`
	L1  float64 `json:"l"`
	TCP float64 `json:"tcp"`
	CX  float64 `json:"cx,omitempty"` // максимум CPU за минуту (в минутных точках)
	// температуры, °C: процессор, видеокарта, самый горячий диск, плата; 0 — нет датчика
	TC  float64 `json:"tc,omitempty"`
	TG  float64 `json:"tg,omitempty"`
	TD  float64 `json:"td,omitempty"`
	TB  float64 `json:"tb,omitempty"`
	Avg bool    `json:"a,omitempty"` // точка — среднее за минуту
}

type cpuRaw [8]uint64 // user nice system idle iowait irq softirq steal

type frame struct {
	uptime    float64
	cpus      map[string]cpuRaw
	coreOrder []string
	mem       map[string]uint64
	net       map[string][2]uint64
	netOrder  []string
	disk      map[string][3]uint64
	diskOrder []string
	load      [3]float64
	procRun   int
	procTotal int
	tcp       int
	fs        []FSStat
	hasFS     bool
	units     []UnitState
	hasUnits  bool
	tmeta     []tempMeta
	hasTM     bool
	tvals     map[string]float64
	nv        []nvTemp
	hasNV     bool
}

func newFrame() *frame {
	return &frame{cpus: map[string]cpuRaw{}, mem: map[string]uint64{}, net: map[string][2]uint64{}, disk: map[string][3]uint64{}, tvals: map[string]float64{}}
}

var (
	diskRe    = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`)
	virtIfRe  = regexp.MustCompile(`^(lo|veth|docker|br-|virbr|tun|tap|wg|tailscale|zt|cni|flannel|cali|vxlan|kube|dummy|ifb|gre|gretap|erspan|sit|ip6tnl|ip_vti|ip6_vti|nlmon|awg|amn|warp|lxc|vnet|podman|cilium|nebula|ham)`)
	pseudoFSm = []string{"/snap/", "/var/lib/docker/", "/run/", "/sys/", "/proc/", "/dev/"}
)

// vpnPattern — службы VPN и прокси (регулярное выражение POSIX ERE: его же
// использует awk на сервере).
const vpnPattern = `xray|v2ray|v2fly|hysteria|sing-box|singbox|mtg|mtproto|mtproxy|telemt|awg|amnezia|wg-quick|wireguard|openvpn|x-ui|marzban|marzneshin|remnanode|remnawave|hiddify|shadowsocks|ss-server|ssserver|ss-rust|shadow-tls|shadowtls|outline|ocserv|trojan|naive|tuic|juicity|brook|gost|3proxy|danted|tinyproxy|squid|xl2tpd|strongswan|ipsec|softether|vpn|mihomo|clash|dnstt|udp2raw|kcptun|chisel|frps|frpc`

var vpnUnitRe = regexp.MustCompile(vpnPattern)

func isVPNUnit(unit string) bool { return vpnUnitRe.MatchString(strings.ToLower(unit)) }

// UnitState — служба с ошибкой или служба VPN из потока метрик.
type UnitState struct {
	Unit   string `json:"unit"`
	Load   string `json:"load"`
	Active string `json:"active"`
	Sub    string `json:"sub"`
	VPN    bool   `json:"vpn,omitempty"`
}

type streamParser struct {
	m       *Monitor
	section string
	inInfo  bool
	info    []string
	cur     *frame
}

func (p *streamParser) line(l string) {
	if strings.HasPrefix(l, "@@") {
		switch tag := strings.TrimSpace(l[2:]); tag {
		case "I":
			p.inInfo, p.info, p.cur = true, nil, nil
		case "F":
			p.inInfo, p.cur, p.section = false, newFrame(), "F"
		case "E":
			if p.cur != nil {
				p.m.ingest(p.cur)
				p.cur = nil
			} else if p.inInfo {
				p.inInfo = false
				p.m.setInfo(parseInfo(p.info))
			}
			p.section = ""
		default:
			p.section = tag
			if tag == "FS" && p.cur != nil {
				p.cur.hasFS = true
			}
			if tag == "U" && p.cur != nil {
				p.cur.hasUnits = true
			}
			if tag == "TM" && p.cur != nil {
				p.cur.hasTM = true
			}
			if tag == "NV" && p.cur != nil {
				p.cur.hasNV = true
			}
		}
		return
	}
	if p.inInfo {
		p.info = append(p.info, l)
		return
	}
	f := p.cur
	if f == nil {
		return
	}
	switch p.section {
	case "F":
		switch {
		case strings.HasPrefix(l, "cpu"):
			fs := strings.Fields(l)
			var c cpuRaw
			for i := 0; i < 8 && i+1 < len(fs); i++ {
				c[i], _ = strconv.ParseUint(fs[i+1], 10, 64)
			}
			f.cpus[fs[0]] = c
			if fs[0] != "cpu" {
				f.coreOrder = append(f.coreOrder, fs[0])
			}
		case strings.Contains(l, ":"):
			k, v, _ := strings.Cut(l, ":")
			fs := strings.Fields(v)
			if len(fs) > 0 {
				n, _ := strconv.ParseUint(fs[0], 10, 64)
				f.mem[k] = n * 1024
			}
		default:
			fs := strings.Fields(l)
			if len(fs) > 0 {
				f.uptime, _ = strconv.ParseFloat(fs[0], 64)
			}
		}
	case "N":
		name, rest, ok := strings.Cut(l, ":")
		if !ok {
			return
		}
		name = strings.TrimSpace(name)
		fs := strings.Fields(rest)
		if len(fs) < 9 {
			return
		}
		rx, _ := strconv.ParseUint(fs[0], 10, 64)
		tx, _ := strconv.ParseUint(fs[8], 10, 64)
		f.net[name] = [2]uint64{rx, tx}
		f.netOrder = append(f.netOrder, name)
	case "D":
		fs := strings.Fields(l)
		if len(fs) < 13 || !diskRe.MatchString(fs[2]) {
			return
		}
		rd, _ := strconv.ParseUint(fs[5], 10, 64)
		wr, _ := strconv.ParseUint(fs[9], 10, 64)
		io, _ := strconv.ParseUint(fs[12], 10, 64)
		f.disk[fs[2]] = [3]uint64{rd, wr, io}
		f.diskOrder = append(f.diskOrder, fs[2])
	case "L":
		fs := strings.Fields(l)
		if len(fs) >= 4 {
			for i := 0; i < 3; i++ {
				f.load[i], _ = strconv.ParseFloat(fs[i], 64)
			}
			if a, b, ok := strings.Cut(fs[3], "/"); ok {
				f.procRun, _ = strconv.Atoi(a)
				f.procTotal, _ = strconv.Atoi(b)
			}
		}
	case "S":
		if strings.HasPrefix(l, "TCP:") {
			fs := strings.Fields(l)
			for i := 1; i+1 < len(fs); i++ {
				if fs[i] == "inuse" {
					f.tcp, _ = strconv.Atoi(fs[i+1])
				}
			}
		}
	case "U":
		fs := strings.Fields(l)
		if len(fs) < 4 || !unitRe.MatchString(fs[0]) {
			return
		}
		u := UnitState{Unit: fs[0], Load: fs[1], Active: fs[2], Sub: fs[3], VPN: isVPNUnit(fs[0])}
		if u.Active == "failed" || (u.VPN && u.Load == "loaded") {
			f.units = append(f.units, u)
		}
	case "TM":
		if t, ok := parseTempMeta(l); ok {
			f.tmeta = append(f.tmeta, t)
		}
	case "T":
		if path, v, ok := strings.Cut(l, ":"); ok && strings.HasPrefix(path, "/sys/") {
			f.tvals[path] = milliC(v)
		}
	case "NV":
		if t, ok := parseNV(l); ok {
			f.nv = append(f.nv, t)
		}
	case "FS":
		fs := strings.Fields(l)
		if len(fs) < 6 || fs[0] == "Filesystem" {
			return
		}
		dev, mount := fs[0], strings.Join(fs[5:], " ")
		if !keepFS(dev, mount) {
			return
		}
		for _, x := range f.fs {
			if x.Dev == dev {
				return
			}
		}
		size, _ := strconv.ParseUint(fs[1], 10, 64)
		used, _ := strconv.ParseUint(fs[2], 10, 64)
		avail, _ := strconv.ParseUint(fs[3], 10, 64)
		pct := 0.0
		if used+avail > 0 {
			pct = round1(float64(used) / float64(used+avail) * 100)
		}
		f.fs = append(f.fs, FSStat{Dev: dev, Mount: mount, Size: size * 1024, Used: used * 1024, Avail: avail * 1024, Pct: pct})
	}
}

func keepFS(dev, mount string) bool {
	if mount == "/" {
		return true
	}
	for _, p := range pseudoFSm {
		if strings.HasPrefix(mount+"/", p) {
			return false
		}
	}
	if strings.HasPrefix(dev, "/dev/loop") {
		return false
	}
	return strings.HasPrefix(dev, "/dev/") || strings.Contains(dev, ":/") || strings.HasPrefix(dev, "//")
}

func compute(a, b *frame, dt float64) *Metrics {
	m := &Metrics{Uptime: b.uptime, Load: b.load, ProcsRun: b.procRun, Procs: b.procTotal, TCP: b.tcp}

	if c0, ok := a.cpus["cpu"]; ok {
		if c1, ok := b.cpus["cpu"]; ok {
			d, tot := cpuDelta(c0, c1)
			if tot > 0 {
				m.User = round1(float64(d[0]+d[1]) / tot * 100)
				m.System = round1(float64(d[2]+d[5]+d[6]) / tot * 100)
				m.IOWait = round1(float64(d[4]) / tot * 100)
				m.Steal = round1(float64(d[7]) / tot * 100)
				m.CPU = round1((tot - float64(d[3]) - float64(d[4])) / tot * 100)
			}
		}
	}
	for _, name := range b.coreOrder {
		c0, ok := a.cpus[name]
		if !ok {
			continue
		}
		d, tot := cpuDelta(c0, b.cpus[name])
		v := 0.0
		if tot > 0 {
			v = round1((tot - float64(d[3]) - float64(d[4])) / tot * 100)
		}
		m.Cores = append(m.Cores, v)
	}

	mem := b.mem
	m.MemTotal = mem["MemTotal"]
	avail, hasAvail := mem["MemAvailable"]
	if !hasAvail {
		avail = mem["MemFree"] + mem["Buffers"] + mem["Cached"]
	}
	m.MemAvail = avail
	if m.MemTotal > avail {
		m.MemUsed = m.MemTotal - avail
	}
	cache := int64(mem["Buffers"]+mem["Cached"]+mem["SReclaimable"]) - int64(mem["Shmem"])
	if cache < 0 {
		cache = 0
	}
	if room := int64(m.MemTotal) - int64(m.MemUsed); cache > room {
		cache = room
	}
	m.MemCache = uint64(cache)
	m.SwapTotal = mem["SwapTotal"]
	if mem["SwapTotal"] > mem["SwapFree"] {
		m.SwapUsed = mem["SwapTotal"] - mem["SwapFree"]
	}

	var physRx, physTx, allRx, allTx float64
	nPhys := 0
	for _, name := range b.netOrder {
		cur := b.net[name]
		st := IfaceStat{Name: name, RxTotal: cur[0], TxTotal: cur[1], Virtual: virtIfRe.MatchString(name)}
		if prev, ok := a.net[name]; ok {
			st.Rx = math.Round(rate(prev[0], cur[0], dt))
			st.Tx = math.Round(rate(prev[1], cur[1], dt))
		}
		if name != "lo" {
			allRx += st.Rx
			allTx += st.Tx
		}
		if !st.Virtual {
			physRx += st.Rx
			physTx += st.Tx
			nPhys++
		}
		m.Ifaces = append(m.Ifaces, st)
	}
	if nPhys > 0 {
		m.NetRx, m.NetTx = physRx, physTx
	} else {
		m.NetRx, m.NetTx = allRx, allTx
	}

	for _, name := range b.diskOrder {
		cur := b.disk[name]
		prev, ok := a.disk[name]
		if !ok {
			continue
		}
		ds := DiskStat{
			Name: name,
			R:    math.Round(rate(prev[0], cur[0], dt) * 512),
			W:    math.Round(rate(prev[1], cur[1], dt) * 512),
			Util: round1(math.Min(100, rate(prev[2], cur[2], dt)/10)),
		}
		m.DiskR += ds.R
		m.DiskW += ds.W
		if ds.Util > m.DiskUtil {
			m.DiskUtil = ds.Util
		}
		m.Disks = append(m.Disks, ds)
	}
	return m
}

func cpuDelta(x, y cpuRaw) (d cpuRaw, total float64) {
	for i := range x {
		if y[i] >= x[i] {
			d[i] = y[i] - x[i]
		}
		total += float64(d[i])
	}
	return
}

func rate(a, b uint64, dt float64) float64 {
	if b < a || dt <= 0 {
		return 0
	}
	return float64(b-a) / dt
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }
func round2(x float64) float64 { return math.Round(x*100) / 100 }

func pointFrom(m *Metrics) Point {
	p := Point{
		T: m.T, CPU: m.CPU, U: m.User, S: m.System, W: m.IOWait, St: m.Steal,
		MU: float64(m.MemUsed), MC: float64(m.MemCache), MT: float64(m.MemTotal),
		Rx: m.NetRx, Tx: m.NetTx, DR: m.DiskR, DW: m.DiskW, L1: m.Load[0], TCP: float64(m.TCP),
	}
	if m.MemTotal > 0 {
		p.Mem = round1(float64(m.MemUsed) / float64(m.MemTotal) * 100)
	}
	return p
}

// ---------- монитор одного сервера ----------

type Monitor struct {
	app *App

	mu        sync.RWMutex
	srv       Server
	status    string // off | connecting | online | offline
	err       string
	since     int64
	info      *Info
	latest    *Metrics
	prev      *frame
	fs        []FSStat
	raw       []Point
	tiers     []*tier // минутные, 5-минутные и 30-минутные средние
	units     []UnitState
	unitsAt   time.Time          // когда пришёл последний список служб
	tmeta     []tempMeta         // датчики температуры (последнее сканирование)
	tlast     map[string]tempVal // последние значения датчиков
	nv        []nvTemp
	nvAt      time.Time
	downSince time.Time // с какого момента нет связи
	lastFrame time.Time
	cancel    context.CancelFunc
	done      chan struct{}
	infoMu    sync.Mutex
}

func newMonitor(a *App, s Server) *Monitor {
	m := &Monitor{app: a, srv: s, status: "off", tiers: newTiers()}
	m.loadHistory()
	return m
}

func (m *Monitor) server() Server {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.srv
}

func (m *Monitor) setServer(s Server) {
	m.mu.Lock()
	m.srv = s
	m.mu.Unlock()
}

func (m *Monitor) maxRaw() int {
	n := int(time.Hour / m.app.interval)
	if n < 60 {
		n = 60
	}
	return n
}

func (m *Monitor) view(withSpark bool) ServerView {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v := ServerView{Server: m.srv, Status: m.status, Error: m.err, Since: m.since, Info: m.info, Latest: m.latest, Units: m.units}
	v.PanelKey = m.srv.KeyFile != "" && m.srv.KeyFile == m.app.panelKeyPath()
	if withSpark {
		n := int(5 * time.Minute / m.app.interval)
		if n > len(m.raw) {
			n = len(m.raw)
		}
		v.Spark = append([]Point(nil), m.raw[len(m.raw)-n:]...)
	}
	return v
}

func (m *Monitor) setStatus(status, errText string) {
	m.mu.Lock()
	changed := m.status != status || m.err != errText
	m.status, m.err = status, errText
	switch status {
	case "offline":
		if m.downSince.IsZero() {
			m.downSince = time.Now()
		}
	case "online", "off":
		m.downSince = time.Time{}
	}
	if status == "online" {
		if m.since == 0 {
			m.since = time.Now().UnixMilli()
		}
	} else {
		m.since = 0
	}
	m.mu.Unlock()
	if changed {
		m.broadcastStatus()
	}
}

func (m *Monitor) broadcastStatus() {
	v := m.view(false)
	m.app.hub.send("status", map[string]any{"id": v.ID, "status": v.Status, "error": v.Error, "since": v.Since, "info": v.Info})
}

func (m *Monitor) setInfo(in *Info) {
	m.mu.Lock()
	m.info = in
	m.mu.Unlock()
	m.setStatus("online", "")
	m.broadcastStatus()
	if in.Watchdog {
		// пока сервер был недоступен, настройки могли поменяться
		go m.app.syncWatchdog(m)
	}
}

// setWatchdog отмечает, стоит ли на сервере сторож (Info копируется: её же
// читают при отправке состояния в браузер).
func (m *Monitor) setWatchdog(on bool) {
	m.mu.Lock()
	changed := m.info != nil && m.info.Watchdog != on
	if changed {
		cp := *m.info
		cp.Watchdog = on
		m.info = &cp
	}
	m.mu.Unlock()
	if changed {
		m.broadcastStatus()
	}
}

func (m *Monitor) watchdogOn() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.info != nil && m.info.Watchdog
}

// ensureInfo возвращает сведения о сервере; если монитор выключен — один раз
// запрашивает их отдельной командой.
func (m *Monitor) ensureInfo(ctx context.Context) *Info {
	m.mu.RLock()
	in := m.info
	m.mu.RUnlock()
	if in != nil {
		return in
	}
	m.infoMu.Lock()
	defer m.infoMu.Unlock()
	m.mu.RLock()
	in = m.info
	m.mu.RUnlock()
	if in != nil {
		return in
	}
	srv := m.server()
	res := m.app.runScript(ctx, &srv, infoScript)
	if res.Err != nil || res.Code != 0 {
		return nil
	}
	in = parseInfo(strings.Split(res.Stdout, "\n"))
	m.mu.Lock()
	m.info = in
	m.mu.Unlock()
	return in
}

// sudo — префикс для привилегированных команд.
func (m *Monitor) sudo(ctx context.Context) string {
	in := m.ensureInfo(ctx)
	if in == nil || in.UID == 0 || !in.Sudo {
		return ""
	}
	return "sudo -n "
}

func (m *Monitor) start(parent context.Context) {
	m.mu.Lock()
	if m.cancel != nil {
		m.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	m.cancel = cancel
	m.done = make(chan struct{})
	done := m.done
	m.mu.Unlock()
	go m.loop(ctx, done)
}

func (m *Monitor) stop() {
	m.mu.Lock()
	cancel, done := m.cancel, m.done
	m.cancel, m.done = nil, nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	m.mu.Lock()
	m.prev = nil
	m.mu.Unlock()
	m.setStatus("off", "")
}

func (m *Monitor) restart(parent context.Context) {
	m.stop()
	srv := m.server()
	m.app.closeMaster(&srv)
	if srv.Monitor && !srv.Hidden {
		m.start(parent)
	}
}

func (m *Monitor) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	backoff := 3 * time.Second
	for {
		// при повторных попытках оставляем «нет связи» с последней ошибкой,
		// чтобы статус не мигал между «подключение» и «офлайн»
		m.mu.RLock()
		wasOffline := m.status == "offline"
		m.mu.RUnlock()
		if !wasOffline {
			m.setStatus("connecting", "")
		}
		started := time.Now()
		err := m.stream(ctx)
		if ctx.Err() != nil {
			return
		}
		msg := "соединение закрыто"
		if err != nil {
			msg = err.Error()
		}
		m.mu.Lock()
		m.prev = nil
		m.mu.Unlock()
		m.setStatus("offline", msg)
		if time.Since(started) > time.Minute {
			backoff = 3 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > time.Minute {
			backoff = time.Minute
		}
	}
}

func (m *Monitor) stream(ctx context.Context) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	srv := m.server()
	args := append(m.app.sshArgs(&srv), "sh -s")
	cmd := exec.CommandContext(sctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(streamScript(m.app.interval))
	parser := &streamParser{m: m}
	cmd.Stdout = &lineWriter{fn: parser.line}
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	cmd.WaitDelay = 2 * time.Second

	m.mu.Lock()
	m.lastFrame = time.Now()
	m.mu.Unlock()

	// сторож: если кадры перестали приходить — рвём соединение
	stalled := false
	var stallMu sync.Mutex
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		limit := 6*m.app.interval + 25*time.Second
		for {
			select {
			case <-sctx.Done():
				return
			case <-t.C:
				m.mu.RLock()
				last := m.lastFrame
				m.mu.RUnlock()
				if time.Since(last) > limit {
					stallMu.Lock()
					stalled = true
					stallMu.Unlock()
					cancel()
					return
				}
			}
		}
	}()

	err := cmd.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if msg := sshError(stderr.String()); msg != "" {
		return errors.New(msg)
	}
	stallMu.Lock()
	wasStalled := stalled
	stallMu.Unlock()
	if wasStalled {
		return errors.New("сервер перестал присылать данные")
	}
	if s := strings.TrimSpace(stderr.String()); s != "" {
		return errors.New(lastLines(s, 3))
	}
	if err != nil {
		return fmt.Errorf("ssh: %v", err)
	}
	return nil
}

func (m *Monitor) ingest(f *frame) {
	m.mu.Lock()
	m.lastFrame = time.Now()
	prev := m.prev
	m.prev = f
	if f.hasFS {
		sort.SliceStable(f.fs, func(i, j int) bool {
			if f.fs[i].Mount == "/" {
				return true
			}
			if f.fs[j].Mount == "/" {
				return false
			}
			return f.fs[i].Mount < f.fs[j].Mount
		})
		m.fs = f.fs
	}
	var unitsChanged bool
	if f.hasUnits {
		sort.Slice(f.units, func(i, j int) bool { return f.units[i].Unit < f.units[j].Unit })
		unitsChanged = !unitsEqual(m.units, f.units)
		m.units, m.unitsAt = f.units, time.Now()
		if m.units == nil {
			m.units = []UnitState{}
		}
	}
	if unitsChanged {
		id, units := m.srv.ID, m.units
		defer m.app.hub.send("units", map[string]any{"id": id, "units": units})
	}
	now := time.Now()
	m.updateTemps(f, now)
	if prev == nil || f.uptime <= prev.uptime {
		m.mu.Unlock()
		return
	}
	met := compute(prev, f, f.uptime-prev.uptime)
	met.T = now.UnixMilli()
	met.FS = m.fs
	var tc, tg, td, tb float64
	met.Temps, tc, tg, td, tb = m.buildTemps(now)
	p := pointFrom(met)
	p.TC, p.TG, p.TD, p.TB = tc, tg, td, tb
	m.latest = met
	if max := m.maxRaw(); len(m.raw) >= max {
		copy(m.raw, m.raw[len(m.raw)-max+1:])
		m.raw = m.raw[:max-1]
	}
	m.raw = append(m.raw, p)
	m.pushRollups(p)
	id := m.srv.ID
	m.mu.Unlock()
	m.app.hub.send("frame", map[string]any{"id": id, "p": p, "m": met})
}

func unitsEqual(a, b []UnitState) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---------- история ----------

// tier — уровень усреднения истории: точки за period мс, хранятся keep.
type tier struct {
	period int64
	keep   time.Duration
	pts    []Point
	roll   roller
}

func newTiers() []*tier {
	mk := func(period int64, keep time.Duration) *tier {
		return &tier{period: period, keep: keep, roll: roller{period: period}}
	}
	return []*tier{
		mk(60_000, 24*time.Hour),       // минута — до суток
		mk(300_000, 7*24*time.Hour),    // 5 минут — до недели
		mk(1_800_000, 31*24*time.Hour), // 30 минут — до месяца
	}
}

func (t *tier) push(p Point) {
	t.pts = append(t.pts, p)
	cut := time.Now().Add(-t.keep).UnixMilli()
	i := 0
	for i < len(t.pts) && t.pts[i].T < cut {
		i++
	}
	if i > 0 {
		t.pts = append([]Point(nil), t.pts[i:]...)
	}
}

// pushRollups передаёт новую точку по цепочке уровней (под m.mu).
func (m *Monitor) pushRollups(p Point) {
	in := p
	for _, t := range m.tiers {
		out := t.roll.add(in)
		if out == nil {
			return
		}
		t.push(*out)
		in = *out
	}
}

// history возвращает точки за период и шаг между ними: до часа — исходные
// точки, до суток — минутные средние, до недели — 5-минутные, дальше — 30-минутные.
func (m *Monitor) history(rng time.Duration) ([]Point, int64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cut := time.Now().Add(-rng).UnixMilli()
	var src []Point
	step := m.app.interval.Milliseconds()
	switch {
	case rng <= time.Hour:
		src = m.raw
	default:
		ti := 0
		if rng > 24*time.Hour {
			ti = 1
		}
		if rng > 7*24*time.Hour {
			ti = 2
		}
		t := m.tiers[ti]
		src, step = t.pts, t.period
		if cur := t.roll.peek(); cur != nil {
			src = append(append([]Point(nil), t.pts...), *cur)
		}
	}
	i := sort.Search(len(src), func(i int) bool { return src[i].T >= cut })
	out := append([]Point(nil), src[i:]...)
	// после перезапуска панели исходных точек мало — дополняем начало периода
	// сохранёнными минутными средними
	if rng <= time.Hour && len(m.tiers[0].pts) > 0 {
		first := time.Now().UnixMilli()
		if len(out) > 0 {
			first = out[0].T
		}
		if first-cut > 3*60000 {
			var pre []Point
			for _, p := range m.tiers[0].pts {
				if p.T >= cut && p.T < first-60000 {
					pre = append(pre, p)
				}
			}
			if len(pre) > 0 {
				out = append(pre, out...)
				step = 60000
			}
		}
	}
	return out, step
}

// roller копит средние за period мс.
type roller struct {
	period int64
	bucket int64
	n      int
	sum    Point
	cmax   float64
	tn     [4]int // сколько точек с каждой температурой
}

func (r *roller) add(p Point) *Point {
	b := p.T / r.period
	var out *Point
	if r.n > 0 && b != r.bucket {
		out = r.result()
		r.n = 0
	}
	if r.n == 0 {
		r.bucket, r.sum, r.cmax, r.tn = b, Point{}, 0, [4]int{}
	}
	r.n++
	s := &r.sum
	s.CPU += p.CPU
	s.U += p.U
	s.S += p.S
	s.W += p.W
	s.St += p.St
	s.Mem += p.Mem
	s.MU += p.MU
	s.MC += p.MC
	s.MT = p.MT
	s.Rx += p.Rx
	s.Tx += p.Tx
	s.DR += p.DR
	s.DW += p.DW
	s.L1 += p.L1
	s.TCP += p.TCP
	for i, v := range [4]float64{p.TC, p.TG, p.TD, p.TB} {
		if v > 0 {
			r.tn[i]++
			switch i {
			case 0:
				s.TC += v
			case 1:
				s.TG += v
			case 2:
				s.TD += v
			case 3:
				s.TB += v
			}
		}
	}
	peak := p.CPU
	if p.Avg {
		peak = p.CX
	}
	if peak > r.cmax {
		r.cmax = peak
	}
	return out
}

func (r *roller) peek() *Point {
	if r.n == 0 {
		return nil
	}
	return r.result()
}

func (r *roller) result() *Point {
	n := float64(r.n)
	s := r.sum
	return &Point{
		T: r.bucket * r.period, CPU: round1(s.CPU / n), U: round1(s.U / n), S: round1(s.S / n), W: round1(s.W / n), St: round1(s.St / n),
		Mem: round1(s.Mem / n), MU: math.Round(s.MU / n), MC: math.Round(s.MC / n), MT: s.MT,
		Rx: math.Round(s.Rx / n), Tx: math.Round(s.Tx / n), DR: math.Round(s.DR / n), DW: math.Round(s.DW / n),
		L1: round2(s.L1 / n), TCP: math.Round(s.TCP / n), CX: r.cmax, Avg: true,
		TC: avgTemp(s.TC, r.tn[0]), TG: avgTemp(s.TG, r.tn[1]), TD: avgTemp(s.TD, r.tn[2]), TB: avgTemp(s.TB, r.tn[3]),
	}
}

func avgTemp(sum float64, n int) float64 {
	if n == 0 {
		return 0
	}
	return round1(sum / float64(n))
}

func (m *Monitor) historyPath() string {
	return filepath.Join(m.app.histDir, safeFileName(m.srv.ID)+".json")
}

var tierKeys = []string{"minutes", "m5", "m30"}

func (m *Monitor) loadHistory() {
	b, err := os.ReadFile(m.historyPath())
	if err != nil {
		return
	}
	var h map[string][]Point
	if json.Unmarshal(b, &h) != nil {
		return
	}
	for i, t := range m.tiers {
		cut := time.Now().Add(-t.keep).UnixMilli()
		for _, p := range h[tierKeys[i]] {
			if p.T >= cut {
				p.Avg = true
				t.pts = append(t.pts, p)
			}
		}
	}
	// заполняем незавершённые интервалы старших уровней из младших (и строим
	// недостающие уровни для файлов старого формата)
	for i := 1; i < len(m.tiers); i++ {
		t, lower := m.tiers[i], m.tiers[i-1]
		from := int64(0)
		if n := len(t.pts); n > 0 {
			from = t.pts[n-1].T + t.period
		}
		for _, p := range lower.pts {
			if p.T >= from {
				if out := t.roll.add(p); out != nil {
					t.push(*out)
				}
			}
		}
	}
}

func (m *Monitor) saveHistory() {
	m.mu.RLock()
	if len(m.tiers[0].pts) == 0 {
		m.mu.RUnlock()
		return
	}
	data := map[string][]Point{}
	for i, t := range m.tiers {
		data[tierKeys[i]] = t.pts
	}
	b, err := json.Marshal(data)
	path := m.historyPath()
	m.mu.RUnlock()
	if err == nil {
		_ = writeFileAtomic(path, b)
	}
}
