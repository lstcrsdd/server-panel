package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Виртуальные машины на серверах: процессы QEMU/KVM (в том числе запущенные
// службой systemd), домены libvirt и машины Proxmox VE.
//
// Сбор идёт в два захода. Первый перечисляет процессы QEMU (аргументы
// командной строки, cgroup, счётчики времени), службы, в которых упомянут
// qemu-system, домены virsh и машины qm. Второй — то, что панель решила
// спросить по итогам первого: состояние служб, QMP (состояние, сеть slirp,
// VNC-клиенты), размеры образов дисков, соседей по ARP и соединения на
// проброшенных портах. Пути и имена во второй заход попадают только после
// проверки и в кавычках.

const qemuProcRe = `^[^ ]*(qemu-system-[a-z0-9_]+|qemu-kvm|/kvm)( |$)`

func vmScan1(sudo string) string {
	return fmt.Sprintf(`export LC_ALL=C
S=%q
echo "@@TICK $(getconf CLK_TCK 2>/dev/null || echo 100)"
echo "@@UP $(cut -d' ' -f1 /proc/uptime)"
for p in $(pgrep -f '%s' 2>/dev/null); do
  [ -r /proc/$p/cmdline ] || continue
  echo "@@Q $p"
  echo "CG=$(grep -m1 -E '^0::|:name=systemd:' /proc/$p/cgroup 2>/dev/null | cut -d: -f3-)"
  echo "ET=$(ps -o etimes= -p $p 2>/dev/null | tr -d ' ')"
  echo "ST=$(sed 's/.*) //' /proc/$p/stat 2>/dev/null | awk '{print $12+$13}')"
  echo "RSS=$(awk '/^VmRSS:/{print $2}' /proc/$p/status 2>/dev/null)"
  tr '\0' '\n' < /proc/$p/cmdline 2>/dev/null | sed 's/^/A /'
done
for f in /etc/systemd/system/*.service /usr/local/lib/systemd/system/*.service; do
  [ -f "$f" ] || continue
  case "$f" in *@.service) continue ;; esac
  if grep -qs 'qemu-system\|qemu-kvm' "$f"; then echo "@@CAND $(basename "$f")"; continue; fi
  x=$(sed -n 's/^ExecStart=[-@+!:]*\([^ ]*\).*/\1/p' "$f" | head -n 1)
  [ -f "$x" ] && [ "$(stat -c %%s "$x" 2>/dev/null || echo 999999)" -lt 65536 ] && grep -qs 'qemu-system\|qemu-kvm' "$x" && echo "@@CAND $(basename "$f")"
done
if command -v virsh >/dev/null 2>&1; then
  V="$S virsh -c qemu:///system"
  $V list --all --name 2>/dev/null | while IFS= read -r d; do
    [ -n "$d" ] || continue
    echo "@@LV $d"
    $V dominfo "$d" 2>/dev/null
    echo "@@LVIF"; $V domiflist "$d" 2>/dev/null
    echo "@@LVIP"; $V domifaddr "$d" 2>/dev/null; $V domifaddr "$d" --source arp 2>/dev/null
    echo "@@LVDISP"; $V domdisplay --all "$d" 2>/dev/null
  done
fi
if command -v qm >/dev/null 2>&1; then
  $S qm list 2>/dev/null | awk 'NR>1 {print $1}' | while read -r id; do
    case "$id" in *[!0-9]*|'') continue ;; esac
    echo "@@PVE $id"
    $S qm status "$id" 2>/dev/null
    $S qm config "$id" 2>/dev/null
  done
fi
echo "@@END"
`, sudo, qemuProcRe)
}

// vmQMPPy спрашивает QMP: состояние, сеть slirp и клиентов VNC. Только чтение.
const vmQMPPy = `import json,socket,sys
for p in sys.argv[1:]:
    o={"sock":p}
    try:
        s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(p);f=s.makefile("rw");f.readline()
        def c(n,**a):
            m={"execute":n}
            if a:m["arguments"]=a
            f.write(json.dumps(m)+"\n");f.flush()
            while 1:
                r=json.loads(f.readline())
                if "return" in r or "error" in r:return r.get("return")
        c("qmp_capabilities")
        o["status"]=(c("query-status") or {}).get("status")
        o["usernet"]=c("human-monitor-command",**{"command-line":"info usernet"})
        v=c("query-vnc")
        if isinstance(v,dict):o["vnc"]=len(v.get("clients") or [])
        s.close()
    except Exception as e:
        o["err"]=str(e)[:200]
    print("@@QMP "+json.dumps(o))
`

type vmProbe struct {
	units []string
	socks []string
	imgs  []string
	pids  []int
	ports bool
}

func vmScan2(sudo string, p vmProbe) string {
	var b strings.Builder
	fmt.Fprintf(&b, "export LC_ALL=C\nS=%q\n", sudo)
	if len(p.pids) > 0 {
		// второй замер времени процессора — для загрузки ЦП
		b.WriteString("sleep 1\necho \"@@UP $(cut -d' ' -f1 /proc/uptime)\"\n")
		for _, pid := range p.pids {
			fmt.Fprintf(&b, "echo \"@@ST %d $(sed 's/.*) //' /proc/%d/stat 2>/dev/null | awk '{print $12+$13}')\"\n", pid, pid)
		}
	}
	for _, u := range p.units {
		fmt.Fprintf(&b, "echo %s\nsystemctl show %s -p Id,Description,ActiveState,SubState,MainPID,UnitFileState,NRestarts,ExecStop,MemoryMax,CPUQuotaPerSecUSec,AllowedCPUs,ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic 2>/dev/null\n", shq("@@UNIT "+u), shq(u))
	}
	if len(p.socks) > 0 {
		args := make([]string, len(p.socks))
		for i, s := range p.socks {
			args[i] = shq(s)
		}
		fmt.Fprintf(&b, "if command -v python3 >/dev/null 2>&1; then P=''; for s in %s; do [ -w \"$s\" ] || P=\"$S\"; done; timeout 12 $P python3 -I -c %s %s 2>/dev/null; fi\n",
			strings.Join(args, " "), shq(vmQMPPy), strings.Join(args, " "))
	}
	for _, f := range p.imgs {
		fmt.Fprintf(&b, "echo %s\nif command -v qemu-img >/dev/null 2>&1; then if [ -r %s ]; then timeout 5 qemu-img info -U --output=json %s 2>/dev/null; else timeout 5 $S qemu-img info -U --output=json %s 2>/dev/null; fi; fi | tr -d '\\n'; echo\n",
			shq("@@IMG "+f), shq(f), shq(f), shq(f))
	}
	b.WriteString("echo @@NEIGH\nip neigh show 2>/dev/null\n")
	if p.ports {
		b.WriteString("echo @@EST\nss -Htn state established 2>/dev/null | awk '{l=$3; sub(/.*:/,\"\",l); c[l]++} END{for(k in c) print k, c[k]}'\n")
	}
	b.WriteString("echo @@END\n")
	return b.String()
}

// ---------- данные ----------

type VMDisk struct {
	File    string `json:"file"`
	Format  string `json:"format,omitempty"`
	Media   string `json:"media,omitempty"` // cdrom
	Virtual uint64 `json:"virtual,omitempty"`
	Actual  uint64 `json:"actual,omitempty"`
}

type VMNet struct {
	Mode   string   `json:"mode"` // user | tap | bridge | network | …
	MAC    string   `json:"mac,omitempty"`
	Model  string   `json:"model,omitempty"`
	Bridge string   `json:"bridge,omitempty"`
	IPs    []string `json:"ips,omitempty"`
	id     string
}

type VMFwd struct {
	Proto     string `json:"proto"`
	HostAddr  string `json:"hostAddr,omitempty"`
	HostPort  int    `json:"hostPort"`
	GuestPort int    `json:"guestPort"`
	Conns     int    `json:"conns,omitempty"`
}

type VMDisplay struct {
	Kind    string `json:"kind"` // vnc | spice
	Socket  string `json:"socket,omitempty"`
	Addr    string `json:"addr,omitempty"`
	Port    int    `json:"port,omitempty"`
	Pass    bool   `json:"pass,omitempty"`
	PassAt  string `json:"passFile,omitempty"` // где лежит пароль (сам пароль панель не читает)
	Clients int    `json:"clients,omitempty"`
}

type VMConnect struct {
	Kind  string   `json:"kind"` // rdp | ssh | vnc | spice | console | web
	Label string   `json:"label"`
	Addr  string   `json:"addr,omitempty"` // что вписать в программу подключения
	URL   string   `json:"url,omitempty"`  // открыть одним нажатием
	Pre   string   `json:"pre,omitempty"`  // сначала выполнить (туннель SSH)
	Cmds  []string `json:"cmds,omitempty"`
	Note  string   `json:"note,omitempty"`
}

type VMLimits struct {
	CPU    float64 `json:"cpu,omitempty"` // ядер (CPUQuota)
	Mem    uint64  `json:"mem,omitempty"`
	CPUSet string  `json:"cpuset,omitempty"`
}

type VM struct {
	Key       string      `json:"key"`
	Name      string      `json:"name"`
	Kind      string      `json:"kind"`              // qemu | libvirt | proxmox
	Manager   string      `json:"manager,omitempty"` // systemd | libvirt | proxmox | qmp | ""
	Unit      string      `json:"unit,omitempty"`
	Ref       string      `json:"ref,omitempty"` // домен libvirt или VMID Proxmox
	State     string      `json:"state"`         // running | paused | stopped | starting | stopping | failed | crashed | unknown
	Detail    string      `json:"detail,omitempty"`
	UUID      string      `json:"uuid,omitempty"`
	PID       int         `json:"pid,omitempty"`
	Up        float64     `json:"up,omitempty"` // секунд работает
	CPUs      int         `json:"cpus,omitempty"`
	Topo      string      `json:"topo,omitempty"`
	MemMB     int         `json:"memMB,omitempty"`
	RSS       uint64      `json:"rss,omitempty"`
	CPUPct    *float64    `json:"cpuPct,omitempty"` // доля от своих vCPU
	Limits    *VMLimits   `json:"limits,omitempty"`
	Accel     string      `json:"accel,omitempty"`
	Machine   string      `json:"machine,omitempty"`
	Guest     string      `json:"guest,omitempty"` // windows | ""
	Autostart string      `json:"autostart,omitempty"`
	Graceful  bool        `json:"graceful,omitempty"` // остановка выключает гостя через ACPI
	Disks     []VMDisk    `json:"disks,omitempty"`
	Nets      []VMNet     `json:"nets,omitempty"`
	Fwds      []VMFwd     `json:"fwds,omitempty"`
	Display   *VMDisplay  `json:"display,omitempty"`
	GuestIP   string      `json:"guestIP,omitempty"` // адрес внутри NAT slirp
	GuestConn int         `json:"guestConns,omitempty"`
	Connect   []VMConnect `json:"connect,omitempty"`
	Actions   []string    `json:"actions,omitempty"`
	Ran       bool        `json:"ran,omitempty"`     // панель видела её работающей
	Stopped   int64       `json:"stopped,omitempty"` // остановлена из панели (unix ms)
	LastRun   int64       `json:"lastRun,omitempty"` // когда видели работающей (unix ms)

	qmp       string
	vncSecret string
	st1       float64
	pveID     string
}

func (v *VM) running() bool { return v.State == "running" }

// ---------- разбор командной строки QEMU ----------

// qemuOpts разбирает "a,b=c,d=e" (",," — запятая внутри значения).
func qemuOpts(s string) (first string, kv map[string]string) {
	kv = map[string]string{}
	s = strings.ReplaceAll(s, ",,", "\x00")
	for i, part := range strings.Split(s, ",") {
		part = strings.ReplaceAll(part, "\x00", ",")
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			if i == 0 {
				first = part
			} else {
				kv[part] = "on"
			}
			continue
		}
		if _, dup := kv[k]; dup && k == "hostfwd" {
			kv[k] += "\x01" + v
			continue
		}
		kv[k] = v
	}
	return
}

func parseMemMB(s string) int {
	first, kv := qemuOpts(s)
	if v := kv["size"]; v != "" {
		first = v
	}
	first = strings.TrimSpace(first)
	if first == "" {
		return 0
	}
	mult := 1.0
	switch strings.ToUpper(first[len(first)-1:]) {
	case "K":
		mult, first = 1.0/1024, first[:len(first)-1]
	case "M":
		first = first[:len(first)-1]
	case "G":
		mult, first = 1024, first[:len(first)-1]
	case "T":
		mult, first = 1024*1024, first[:len(first)-1]
	case "B":
		mult, first = 1.0/1024/1024, first[:len(first)-1]
	}
	f, err := strconv.ParseFloat(first, 64)
	if err != nil {
		return 0
	}
	return int(f * mult)
}

var hostfwdRe = regexp.MustCompile(`^(?:(tcp|udp):)?([^:]*):(\d+)-([^:]*):(\d+)$`)

func parseHostfwd(s string) (VMFwd, bool) {
	m := hostfwdRe.FindStringSubmatch(s)
	if m == nil {
		return VMFwd{}, false
	}
	hp, _ := strconv.Atoi(m[3])
	gp, _ := strconv.Atoi(m[5])
	proto := m[1]
	if proto == "" {
		proto = "tcp"
	}
	return VMFwd{Proto: proto, HostAddr: m[2], HostPort: hp, GuestPort: gp}, true
}

// parseVNC: "unix:/path,…", ":1", "127.0.0.1:1", "0.0.0.0:0,password=on", "none".
func parseVNC(s string) *VMDisplay {
	first, kv := qemuOpts(s)
	if first == "" || first == "none" {
		return nil
	}
	d := &VMDisplay{Kind: "vnc", Pass: kv["password-secret"] != "" || kv["password"] == "on"}
	if p, ok := strings.CutPrefix(first, "unix:"); ok {
		d.Socket = p
		return d
	}
	i := strings.LastIndex(first, ":")
	if i < 0 {
		return nil
	}
	n, err := strconv.Atoi(first[i+1:])
	if err != nil {
		return nil
	}
	d.Addr = strings.Trim(first[:i], "[]")
	if n < 100 { // номер дисплея; "-vnc :5901" встречается редко
		d.Port = 5900 + n
	} else {
		d.Port = n
	}
	return d
}

func parseQEMU(args []string) *VM {
	v := &VM{Kind: "qemu", State: "running"}
	netdevs := map[string]*VMNet{}
	var netOrder []string
	chardevs := map[string]string{}
	secrets := map[string]string{} // id секрета → файл
	var monChar string
	addNet := func(id, mode string) *VMNet {
		n := netdevs[id]
		if n == nil {
			n = &VMNet{id: id}
			netdevs[id] = n
			netOrder = append(netOrder, id)
		}
		if mode != "" {
			n.Mode = mode
		}
		return n
	}
	diskSeen := map[string]bool{}
	addDisk := func(d VMDisk) {
		if d.File == "" || diskSeen[d.File] || strings.HasPrefix(d.File, "/dev/fd/") {
			return
		}
		diskSeen[d.File] = true
		v.Disks = append(v.Disks, d)
	}
	for i := 1; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			continue
		}
		opt := "-" + strings.TrimLeft(a, "-")
		// у флагов значения нет: следующий аргумент — уже новая опция
		val := ""
		if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			val = args[i+1]
			i++
		}
		switch opt {
		case "-name":
			first, kv := qemuOpts(val)
			v.Name = first
			if g := kv["guest"]; g != "" {
				v.Name = g
			}
		case "-uuid":
			v.UUID = strings.ToLower(val)
		case "-id":
			v.pveID = val
		case "-smp":
			first, kv := qemuOpts(val)
			if c := kv["cpus"]; c != "" {
				first = c
			}
			v.CPUs, _ = strconv.Atoi(first)
			var parts []string
			for _, k := range []string{"sockets", "cores", "threads"} {
				if kv[k] != "" {
					parts = append(parts, k+"="+kv[k])
				}
			}
			v.Topo = strings.Join(parts, ",")
			if v.CPUs == 0 && kv["sockets"] != "" {
				s, _ := strconv.Atoi(kv["sockets"])
				c, _ := strconv.Atoi(kv["cores"])
				t, _ := strconv.Atoi(kv["threads"])
				v.CPUs = max(s, 1) * max(c, 1) * max(t, 1)
			}
		case "-m":
			v.MemMB = parseMemMB(val)
		case "-machine", "-M":
			first, kv := qemuOpts(val)
			if first != "" && !strings.Contains(first, "=") {
				v.Machine = first
			} else if kv["type"] != "" {
				v.Machine = kv["type"]
			}
			if kv["accel"] != "" {
				v.Accel = strings.Split(kv["accel"], ":")[0]
			}
		case "-accel":
			first, _ := qemuOpts(val)
			v.Accel = first
		case "-enable-kvm":
			v.Accel = "kvm"
		case "-cpu":
			if strings.Contains(val, "hv_") || strings.Contains(val, "hv-") {
				v.Guest = "windows"
			}
		case "-drive":
			first, kv := qemuOpts(val)
			_ = first
			if kv["if"] == "pflash" {
				break
			}
			addDisk(VMDisk{File: kv["file"], Format: kv["format"], Media: map[bool]string{true: "cdrom"}[kv["media"] == "cdrom"]})
		case "-blockdev":
			if strings.HasPrefix(val, "{") {
				var bd map[string]any
				if json.Unmarshal([]byte(val), &bd) == nil {
					if bd["driver"] == "file" || bd["driver"] == "host_device" {
						if f, _ := bd["filename"].(string); f != "" && !strings.HasSuffix(f, ".fd") {
							addDisk(VMDisk{File: f})
						}
					}
				}
			} else {
				_, kv := qemuOpts(val)
				if (kv["driver"] == "file" || kv["driver"] == "host_device") && !strings.HasSuffix(kv["filename"], ".fd") {
					addDisk(VMDisk{File: kv["filename"]})
				}
			}
		case "-hda", "-hdb", "-hdc", "-hdd":
			addDisk(VMDisk{File: val})
		case "-cdrom":
			addDisk(VMDisk{File: val, Media: "cdrom"})
		case "-netdev", "-nic", "-net":
			mode, kv := qemuOpts(val)
			if opt == "-net" && mode == "nic" {
				n := addNet("net:"+kv["vlan"], "")
				n.MAC, n.Model = kv["macaddr"], kv["model"]
				break
			}
			id := kv["id"]
			if id == "" {
				id = fmt.Sprintf("%s%d", opt, i)
			}
			n := addNet(id, mode)
			if kv["br"] != "" {
				n.Bridge = kv["br"]
			}
			if opt == "-nic" {
				n.MAC, n.Model = kv["mac"], kv["model"]
			}
			if kv["ifname"] != "" && n.Bridge == "" {
				n.Bridge = kv["ifname"]
			}
			for _, h := range strings.Split(kv["hostfwd"], "\x01") {
				if f, ok := parseHostfwd(h); ok {
					v.Fwds = append(v.Fwds, f)
				}
			}
		case "-device":
			model, kv := qemuOpts(val)
			if nd := kv["netdev"]; nd != "" {
				n := addNet(nd, "")
				n.MAC, n.Model = strings.ToLower(kv["mac"]), model
			}
		case "-vnc":
			v.Display = parseVNC(val)
			_, kv := qemuOpts(val)
			v.vncSecret = kv["password-secret"]
		case "-spice":
			_, kv := qemuOpts(val)
			p, _ := strconv.Atoi(kv["port"])
			if p == 0 {
				p, _ = strconv.Atoi(kv["tls-port"])
			}
			if kv["unix"] == "on" {
				v.Display = &VMDisplay{Kind: "spice", Socket: kv["addr"]}
			} else if p > 0 {
				v.Display = &VMDisplay{Kind: "spice", Addr: kv["addr"], Port: p, Pass: kv["disable-ticketing"] != "on"}
			}
		case "-qmp":
			if p, ok := strings.CutPrefix(val, "unix:"); ok {
				v.qmp, _ = qemuOpts(p)
			}
		case "-chardev":
			kind, kv := qemuOpts(val)
			if kind == "socket" && kv["path"] != "" && kv["id"] != "" {
				chardevs[kv["id"]] = kv["path"]
			}
		case "-object":
			kind, kv := qemuOpts(val)
			if kind == "secret" && kv["id"] != "" && kv["file"] != "" {
				secrets[kv["id"]] = kv["file"]
			}
		case "-mon":
			_, kv := qemuOpts(val)
			if kv["mode"] == "control" {
				monChar = kv["chardev"]
			}
		}
	}
	if v.Display != nil && v.vncSecret != "" {
		v.Display.PassAt = secrets[v.vncSecret]
	}
	if v.qmp == "" && monChar != "" {
		v.qmp = chardevs[monChar]
	}
	if v.Name == "" {
		v.Name = filepath.Base(args[0])
	}
	if v.Guest == "" && strings.Contains(strings.ToLower(v.Name), "win") {
		v.Guest = "windows"
	}
	for _, id := range netOrder {
		n := netdevs[id]
		if n.Mode == "" {
			n.Mode = "nic"
		}
		v.Nets = append(v.Nets, *n)
	}
	return v
}

// ---------- первый заход ----------

type vmScanRaw struct {
	tick  float64
	up1   float64
	vms   []*VM // процессы QEMU
	cands []string
	lv    []*VM
	pve   []*VM
	units map[int]string // pid → служба systemd
}

var qemuSkipUnits = map[string]bool{"libvirtd.service": true, "virtqemud.service": true, "pvedaemon.service": true, "qemu-server.service": true}

func parseScan1(out string) *vmScanRaw {
	r := &vmScanRaw{tick: 100, units: map[int]string{}}
	var cur *VM
	var args []string
	var cg string
	var et, st, rss float64
	var pid int
	flush := func() {
		if pid == 0 {
			return
		}
		if len(args) > 0 {
			v := parseQEMU(args)
			v.PID = pid
			v.Up = et
			v.st1 = st
			v.RSS = uint64(rss) * 1024
			if strings.HasSuffix(cg, ".service") {
				u := cg[strings.LastIndex(cg, "/")+1:]
				if unitRe.MatchString(u) && !qemuSkipUnits[u] {
					v.Unit = u
					r.units[pid] = u
				}
			}
			r.vms = append(r.vms, v)
		}
		pid, args, cg, et, st, rss = 0, nil, "", 0, 0, 0
	}
	section := ""
	var lvIP *VM
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			head, rest, _ := strings.Cut(l[2:], " ")
			switch head {
			case "TICK":
				if f, err := strconv.ParseFloat(rest, 64); err == nil && f > 0 {
					r.tick = f
				}
			case "UP":
				r.up1, _ = strconv.ParseFloat(rest, 64)
			case "Q":
				flush()
				pid, _ = strconv.Atoi(rest)
			case "CAND":
				flush()
				if unitRe.MatchString(rest) {
					r.cands = append(r.cands, rest)
				}
			case "LV":
				flush()
				cur = &VM{Kind: "libvirt", Manager: "libvirt", Ref: rest, Name: rest, State: "unknown"}
				r.lv = append(r.lv, cur)
				lvIP = cur
			case "PVE":
				flush()
				cur = &VM{Kind: "proxmox", Manager: "proxmox", Ref: rest, pveID: rest, Name: "VM " + rest, State: "unknown"}
				r.pve = append(r.pve, cur)
			case "LVIF", "LVIP", "LVDISP":
			case "END":
				flush()
				cur = nil
			}
			section = head
			continue
		}
		switch section {
		case "Q":
			switch {
			case strings.HasPrefix(l, "A "):
				args = append(args, l[2:])
			case strings.HasPrefix(l, "CG="):
				cg = strings.TrimSpace(l[3:])
			case strings.HasPrefix(l, "ET="):
				et, _ = strconv.ParseFloat(strings.TrimSpace(l[3:]), 64)
			case strings.HasPrefix(l, "ST="):
				st, _ = strconv.ParseFloat(strings.TrimSpace(l[3:]), 64)
			case strings.HasPrefix(l, "RSS="):
				rss, _ = strconv.ParseFloat(strings.TrimSpace(l[4:]), 64)
			}
		case "LV":
			parseDominfo(cur, l)
		case "LVIF":
			// Interface  Type  Source  Model  MAC
			f := strings.Fields(l)
			if len(f) >= 5 && strings.Count(f[4], ":") == 5 {
				cur.Nets = append(cur.Nets, VMNet{Mode: f[1], Bridge: f[2], Model: f[3], MAC: strings.ToLower(f[4])})
			}
		case "LVIP":
			// vnet0  52:54:00:..  ipv4  192.168.122.10/24
			f := strings.Fields(l)
			if len(f) >= 4 && strings.Count(f[1], ":") == 5 && lvIP != nil {
				ip, _, _ := strings.Cut(f[3], "/")
				addNetIP(lvIP, strings.ToLower(f[1]), ip)
			}
		case "LVDISP":
			if d := parseDisplayURI(strings.TrimSpace(l)); d != nil && cur != nil && cur.Display == nil {
				cur.Display = d
			}
		case "PVE":
			parsePVE(cur, l)
		}
	}
	flush()
	return r
}

func parseDominfo(v *VM, l string) {
	k, val, ok := strings.Cut(l, ":")
	if !ok || v == nil {
		return
	}
	val = strings.TrimSpace(val)
	switch strings.TrimSpace(k) {
	case "UUID":
		v.UUID = strings.ToLower(val)
	case "State":
		v.Detail = val
		v.State = libvirtState(val)
	case "CPU(s)":
		v.CPUs, _ = strconv.Atoi(val)
	case "Max memory":
		f := strings.Fields(val)
		if len(f) > 0 {
			kb, _ := strconv.Atoi(f[0])
			v.MemMB = kb / 1024
		}
	case "Autostart":
		if val == "enable" {
			v.Autostart = "enabled"
		} else {
			v.Autostart = "disabled"
		}
	}
}

func libvirtState(s string) string {
	switch s {
	case "running", "idle":
		return "running"
	case "paused", "pmsuspended":
		return "paused"
	case "shut off":
		return "stopped"
	case "in shutdown":
		return "stopping"
	case "crashed":
		return "crashed"
	}
	return "unknown"
}

var pveMACRe = regexp.MustCompile(`(?i)(?:^|,)(e1000e?|virtio|rtl8139|vmxnet3)=([0-9a-f:]{17})`)

func parsePVE(v *VM, l string) {
	if v == nil {
		return
	}
	if st, ok := strings.CutPrefix(l, "status: "); ok {
		v.Detail = st
		switch st {
		case "running":
			v.State = "running"
		case "stopped":
			v.State = "stopped"
		case "paused":
			v.State = "paused"
		}
		return
	}
	k, val, ok := strings.Cut(l, ": ")
	if !ok {
		return
	}
	switch {
	case k == "name":
		v.Name = val
	case k == "cores":
		c, _ := strconv.Atoi(val)
		v.CPUs = max(v.CPUs, 1) * c
	case k == "sockets":
		s, _ := strconv.Atoi(val)
		v.CPUs = max(v.CPUs, 1) * s
	case k == "memory":
		v.MemMB, _ = strconv.Atoi(val)
	case k == "onboot":
		v.Autostart = map[bool]string{true: "enabled", false: "disabled"}[val == "1"]
	case k == "smbios1":
		_, kv := qemuOpts(val)
		if kv["uuid"] != "" {
			v.UUID = strings.ToLower(kv["uuid"])
		}
	case k == "ostype":
		if strings.HasPrefix(val, "win") {
			v.Guest = "windows"
		}
	case strings.HasPrefix(k, "net") && len(k) <= 5:
		n := VMNet{Mode: "bridge"}
		if m := pveMACRe.FindStringSubmatch(val); m != nil {
			n.Model, n.MAC = strings.ToLower(m[1]), strings.ToLower(m[2])
		}
		_, kv := qemuOpts(val)
		n.Bridge = kv["bridge"]
		v.Nets = append(v.Nets, n)
	}
}

func parseDisplayURI(s string) *VMDisplay {
	for _, kind := range []string{"vnc", "spice"} {
		rest, ok := strings.CutPrefix(s, kind+"://")
		if !ok {
			continue
		}
		rest, _, _ = strings.Cut(rest, "?")
		i := strings.LastIndex(rest, ":")
		if i < 0 {
			return nil
		}
		p, _ := strconv.Atoi(rest[i+1:])
		return &VMDisplay{Kind: kind, Addr: strings.Trim(rest[:i], "[]"), Port: p}
	}
	return nil
}

func addNetIP(v *VM, mac, ip string) {
	if ip == "" {
		return
	}
	for i := range v.Nets {
		if v.Nets[i].MAC == mac {
			for _, x := range v.Nets[i].IPs {
				if x == ip {
					return
				}
			}
			v.Nets[i].IPs = append(v.Nets[i].IPs, ip)
			return
		}
	}
}

// ---------- второй заход ----------

type unitShow struct {
	active, sub, enabled, desc string
	execStop                   bool
	pid                        int
	restarts                   int
	lim                        VMLimits
}

type vmScanRaw2 struct {
	up2   float64
	st2   map[int]float64
	units map[string]*unitShow
	qmp   map[string]map[string]any
	imgs  map[string][2]uint64
	fmts  map[string]string
	neigh map[string][]string // mac → ip
	est   map[int]int
}

var quotaRe = regexp.MustCompile(`^([\d.]+)(ms|s|us)$`)

func parseScan2(out string) *vmScanRaw2 {
	r := &vmScanRaw2{st2: map[int]float64{}, units: map[string]*unitShow{}, qmp: map[string]map[string]any{}, imgs: map[string][2]uint64{}, fmts: map[string]string{}, neigh: map[string][]string{}, est: map[int]int{}}
	section := ""
	var cu *unitShow
	var img string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			head, rest, _ := strings.Cut(l[2:], " ")
			switch head {
			case "UP":
				r.up2, _ = strconv.ParseFloat(rest, 64)
			case "ST":
				a, b, _ := strings.Cut(rest, " ")
				pid, _ := strconv.Atoi(a)
				if f, err := strconv.ParseFloat(b, 64); err == nil && pid > 0 {
					r.st2[pid] = f
				}
			case "UNIT":
				cu = &unitShow{}
				r.units[rest] = cu
			case "QMP":
				var o map[string]any
				if json.Unmarshal([]byte(rest), &o) == nil {
					if s, _ := o["sock"].(string); s != "" {
						r.qmp[s] = o
					}
				}
			case "IMG":
				img = rest
			}
			section = head
			continue
		}
		switch section {
		case "UNIT":
			k, v, ok := strings.Cut(l, "=")
			if !ok || cu == nil {
				continue
			}
			switch k {
			case "ActiveState":
				cu.active = v
			case "SubState":
				cu.sub = v
			case "UnitFileState":
				cu.enabled = v
			case "Description":
				cu.desc = v
			case "MainPID":
				cu.pid, _ = strconv.Atoi(v)
			case "NRestarts":
				cu.restarts, _ = strconv.Atoi(v)
			case "ExecStop":
				cu.execStop = strings.Contains(v, "path=")
			case "MemoryMax":
				if n, err := strconv.ParseUint(v, 10, 64); err == nil {
					cu.lim.Mem = n
				}
			case "CPUQuotaPerSecUSec":
				if m := quotaRe.FindStringSubmatch(v); m != nil {
					f, _ := strconv.ParseFloat(m[1], 64)
					switch m[2] {
					case "ms":
						f /= 1000
					case "us":
						f /= 1e6
					}
					cu.lim.CPU = f
				}
			case "AllowedCPUs":
				cu.lim.CPUSet = v
			}
		case "IMG":
			var o struct {
				Virtual uint64 `json:"virtual-size"`
				Actual  uint64 `json:"actual-size"`
				Format  string `json:"format"`
			}
			if img != "" && json.Unmarshal([]byte(l), &o) == nil && o.Virtual > 0 {
				r.imgs[img] = [2]uint64{o.Virtual, o.Actual}
				r.fmts[img] = o.Format
			}
			img = ""
		case "NEIGH":
			// 192.168.122.10 dev virbr0 lladdr 52:54:00:… REACHABLE
			f := strings.Fields(l)
			if len(f) == 0 || strings.Count(f[0], ".") != 3 || strings.HasSuffix(l, "FAILED") {
				continue
			}
			for i := 1; i+1 < len(f); i++ {
				if f[i] == "lladdr" {
					mac := strings.ToLower(f[i+1])
					r.neigh[mac] = append(r.neigh[mac], f[0])
				}
			}
		case "EST":
			f := strings.Fields(l)
			if len(f) == 2 {
				p, _ := strconv.Atoi(f[0])
				n, _ := strconv.Atoi(f[1])
				r.est[p] = n
			}
		}
	}
	return r
}

// parseUsernet достаёт адрес гостя и число его соединений из «info usernet».
func parseUsernet(s string) (guestIP string, conns int) {
	for _, l := range strings.Split(s, "\n") {
		f := strings.Fields(l)
		if len(f) < 7 {
			continue
		}
		switch {
		case strings.Contains(f[0], "HOST_FORWARD"):
			if guestIP == "" {
				guestIP = f[4]
			}
		case strings.Contains(f[0], "ESTABLISHED"):
			conns++
			if guestIP == "" && strings.HasPrefix(f[2], "10.") {
				guestIP = f[2]
			}
		}
	}
	return
}

func qmpState(s string) string {
	switch s {
	case "running":
		return "running"
	case "paused", "suspended", "prelaunch", "inmigrate", "postmigrate", "finish-migrate", "save-vm", "restore-vm", "debug", "colo":
		return "paused"
	case "shutdown":
		return "stopping"
	case "guest-panicked", "internal-error", "io-error", "watchdog":
		return "crashed"
	}
	return "running"
}

func vmStateText(s string) string {
	switch s {
	case "running":
		return L("работает")
	case "paused":
		return L("на паузе")
	case "stopped":
		return L("выключена")
	case "starting":
		return L("запускается")
	case "stopping":
		return L("выключается")
	case "failed":
		return L("ошибка службы")
	case "crashed":
		return L("сбой")
	}
	return L("неизвестно")
}

func unitVMState(u *unitShow) string {
	switch u.active {
	case "active":
		return "running"
	case "activating":
		return "starting"
	case "deactivating":
		return "stopping"
	case "failed":
		return "failed"
	case "inactive":
		return "stopped"
	}
	return "unknown"
}

// ---------- хранилище ----------

type vmSnap struct {
	at  time.Time
	vms []*VM
	err string
}

type vmStore struct {
	mu    sync.Mutex
	path  string
	Seen  map[string][]*VM `json:"seen"` // сервер → ВМ, которые панель видела
	live  map[string]*vmSnap
	scan  map[string]*sync.Mutex
	dirty bool
}

func newVMStore(dataDir string) *vmStore {
	s := &vmStore{path: filepath.Join(dataDir, "vms.json"), Seen: map[string][]*VM{}, live: map[string]*vmSnap{}, scan: map[string]*sync.Mutex{}}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, s)
		if s.Seen == nil {
			s.Seen = map[string][]*VM{}
		}
	}
	return s
}

// saveLocked вызывается под s.mu.
func (s *vmStore) saveLocked() {
	b, err := json.MarshalIndent(struct {
		Seen map[string][]*VM `json:"seen"`
	}{s.Seen}, "", "  ")
	if err == nil {
		_ = writeFileAtomic(s.path, b)
	}
	s.dirty = false
}

func (s *vmStore) lockFor(id string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.scan[id]
	if m == nil {
		m = &sync.Mutex{}
		s.scan[id] = m
	}
	return m
}

func (s *vmStore) snapshot(id string) *vmSnap {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.live[id]
}

func (s *vmStore) forget(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.live, id)
	if _, ok := s.Seen[id]; ok {
		delete(s.Seen, id)
		s.saveLocked()
	}
}

// VMSum — сводка для табло.
type VMSum struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Bad     int `json:"bad"` // остановлена сама, упала или на паузе
}

func (s *vmStore) summary(id string) *VMSum {
	s.mu.Lock()
	defer s.mu.Unlock()
	sn := s.live[id]
	if sn == nil || len(sn.vms) == 0 {
		return nil
	}
	sum := &VMSum{Total: len(sn.vms)}
	for _, v := range sn.vms {
		if v.running() {
			sum.Running++
		} else if vmAlarming(v) {
			sum.Bad++
		}
	}
	return sum
}

// vmAlarming — ВМ должна работать, но не работает.
func vmAlarming(v *VM) bool {
	if v.running() || v.State == "starting" {
		return false
	}
	if v.State == "crashed" || v.State == "failed" || v.State == "paused" {
		return true
	}
	return v.Ran && v.Stopped == 0
}

// ---------- сбор ----------

func vmKey(v *VM) string {
	switch {
	case v.Unit != "":
		return "unit:" + v.Unit
	case v.Kind == "libvirt" && v.UUID != "":
		return "libvirt:" + v.UUID
	case v.Kind == "proxmox":
		return "pve:" + v.pveID
	case v.UUID != "":
		return "uuid:" + v.UUID
	}
	return "qemu:" + v.Name
}

func (a *App) scanVMs(ctx context.Context, m *Monitor) ([]*VM, error) {
	srv := m.server()
	mu := a.vms.lockFor(srv.ID)
	mu.Lock()
	defer mu.Unlock()
	sudo := strings.TrimSpace(m.sudo(ctx))
	res := a.runScript(ctx, &srv, vmScan1(sudo))
	if res.Err != nil {
		a.vms.mu.Lock()
		if sn := a.vms.live[srv.ID]; sn != nil {
			sn.err = res.errText()
		}
		a.vms.mu.Unlock()
		return nil, fmt.Errorf("%s", res.errText())
	}
	r1 := parseScan1(res.Stdout)

	// процессы libvirt и Proxmox сливаем с их доменами
	byUUID := map[string]*VM{}
	byPVE := map[string]*VM{}
	for _, v := range r1.lv {
		if v.UUID != "" {
			byUUID[v.UUID] = v
		}
	}
	for _, v := range r1.pve {
		byPVE[v.pveID] = v
	}
	var list []*VM
	for _, p := range r1.vms {
		var dom *VM
		if p.pveID != "" {
			dom = byPVE[p.pveID]
		}
		if dom == nil && p.UUID != "" {
			dom = byUUID[p.UUID]
		}
		if dom == nil {
			if p.pveID != "" {
				p.Kind = "proxmox"
			}
			list = append(list, p)
			continue
		}
		mergeProc(dom, p)
	}
	list = append(list, r1.lv...)
	list = append(list, r1.pve...)

	a.vms.mu.Lock()
	prev := map[string]*VM{}
	for _, v := range a.vms.Seen[srv.ID] {
		prev[v.Key] = v
	}
	a.vms.mu.Unlock()

	// службы: у запущенных процессов, найденные в файлах служб и запомненные
	units := map[string]bool{}
	for _, v := range list {
		if v.Unit != "" {
			units[v.Unit] = true
		}
	}
	for _, u := range r1.cands {
		units[u] = true
	}
	for _, v := range prev {
		if v.Unit != "" {
			units[v.Unit] = true
		}
	}
	probe := vmProbe{}
	for u := range units {
		probe.units = append(probe.units, u)
	}
	sort.Strings(probe.units)
	for _, v := range list {
		if v.PID > 0 {
			probe.pids = append(probe.pids, v.PID)
		}
		if v.qmp != "" && v.PID > 0 && cleanAbsPath(v.qmp) {
			probe.socks = append(probe.socks, v.qmp)
		}
		for _, d := range v.Disks {
			if d.Media != "cdrom" && cleanAbsPath(d.File) && len(probe.imgs) < 32 {
				probe.imgs = append(probe.imgs, d.File)
			}
		}
		if len(v.Fwds) > 0 {
			probe.ports = true
		}
	}
	r2 := &vmScanRaw2{}
	if len(probe.units)+len(probe.pids)+len(probe.imgs) > 0 || len(list) > 0 {
		res2 := a.runScript(ctx, &srv, vmScan2(sudo, probe))
		if res2.Err != nil {
			return nil, fmt.Errorf("%s", res2.errText())
		}
		r2 = parseScan2(res2.Stdout)
	}

	// служба без процесса — остановленная ВМ
	have := map[string]bool{}
	for _, v := range list {
		if v.Unit != "" {
			have[v.Unit] = true
		}
	}
	for _, u := range probe.units {
		if have[u] {
			continue
		}
		us := r2.units[u]
		if us == nil {
			continue
		}
		key := "unit:" + u
		var v *VM
		if p := prev[key]; p != nil {
			cp := *p
			v = &cp
			clearVolatile(v)
		} else {
			v = &VM{Kind: "qemu", Name: strings.TrimSuffix(u, ".service")}
		}
		v.Unit = u
		v.State = unitVMState(us)
		list = append(list, v)
	}

	dt := r2.up2 - r1.up1
	now := time.Now().UnixMilli()
	for _, v := range list {
		v.Key = vmKey(v)
		if v.Unit != "" {
			v.Manager = "systemd"
			if us := r2.units[v.Unit]; us != nil {
				if v.PID > 0 && us.active == "active" {
					v.State = "running"
				} else if v.PID == 0 {
					v.State = unitVMState(us)
				}
				if v.PID > 0 && us.active == "deactivating" {
					v.State = "stopping"
				}
				v.Autostart = us.enabled
				v.Graceful = us.execStop
				if us.lim.CPU > 0 || us.lim.Mem > 0 || us.lim.CPUSet != "" {
					l := us.lim
					v.Limits = &l
				}
				if us.active == "failed" {
					v.Detail = "failed"
				}
			}
		} else if v.Kind == "libvirt" || v.Kind == "proxmox" {
			v.Graceful = true
		} else if v.qmp != "" {
			v.Manager = "qmp"
			v.Graceful = true
		}
		if v.PID > 0 {
			if st2, ok := r2.st2[v.PID]; ok && dt > 0.3 && st2 >= v.st1 {
				pct := (st2 - v.st1) / r1.tick / dt * 100
				if v.CPUs > 0 {
					pct /= float64(v.CPUs)
				}
				pct = min(pct, 100)
				v.CPUPct = &pct
			}
			if q := r2.qmp[v.qmp]; q != nil {
				if s, _ := q["status"].(string); s != "" {
					v.Detail = s
					if v.State == "running" {
						v.State = qmpState(s)
					}
				}
				if un, _ := q["usernet"].(string); un != "" {
					v.GuestIP, v.GuestConn = parseUsernet(un)
				}
				if n, ok := q["vnc"].(float64); ok && v.Display != nil && v.Display.Kind == "vnc" {
					v.Display.Clients = int(n)
				}
			}
		}
		for i := range v.Disks {
			d := &v.Disks[i]
			if sz, ok := r2.imgs[d.File]; ok {
				d.Virtual, d.Actual = sz[0], sz[1]
				if d.Format == "" {
					d.Format = r2.fmts[d.File]
				}
			}
		}
		for i := range v.Nets {
			n := &v.Nets[i]
			if n.MAC == "" || n.Mode == "user" {
				continue
			}
			for _, ip := range r2.neigh[n.MAC] {
				addNetIP(v, n.MAC, ip)
			}
		}
		for i := range v.Fwds {
			v.Fwds[i].Conns = r2.est[v.Fwds[i].HostPort]
		}
		p := prev[v.Key]
		if p != nil {
			v.Ran, v.Stopped, v.LastRun = p.Ran, p.Stopped, p.LastRun
			if v.PID == 0 {
				// у остановленной ВМ нет командной строки — берём запомненное
				fillFrom(v, p)
			}
		}
		if v.running() || v.State == "paused" {
			v.Ran, v.Stopped, v.LastRun = true, 0, now
		}
		v.Actions = vmActions(v)
		v.Connect = vmConnect(v, srv)
	}

	// ручной QEMU, которого больше нет: показываем как остановленный
	cur := map[string]bool{}
	for _, v := range list {
		cur[v.Key] = true
	}
	for k, p := range prev {
		if cur[k] || p.Kind != "qemu" || p.Unit != "" {
			continue
		}
		cp := *p
		v := &cp
		clearVolatile(v)
		v.State = "stopped"
		v.Manager = ""
		v.Actions = vmActions(v)
		v.Connect = nil
		list = append(list, v)
	}
	sort.SliceStable(list, func(i, j int) bool {
		ri, rj := vmRank(list[i]), vmRank(list[j])
		if ri != rj {
			return ri < rj
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})

	a.vms.mu.Lock()
	seen := make([]*VM, 0, len(list))
	for _, v := range list {
		cp := *v
		clearVolatile(&cp)
		cp.Connect, cp.Actions = nil, nil
		seen = append(seen, &cp)
	}
	changed := !sameVMs(a.vms.Seen[srv.ID], seen)
	if len(seen) > 0 {
		a.vms.Seen[srv.ID] = seen
	} else {
		delete(a.vms.Seen, srv.ID)
	}
	prevSum := summaryOf(a.vms.live[srv.ID])
	a.vms.live[srv.ID] = &vmSnap{at: time.Now(), vms: list}
	if changed {
		a.vms.saveLocked()
	}
	a.vms.mu.Unlock()
	if !sameSum(prevSum, a.vms.summary(srv.ID)) {
		m.broadcastStatus()
	}
	a.hub.send("vms", map[string]any{"id": srv.ID, "vms": list, "t": now})
	return list, nil
}

func summaryOf(sn *vmSnap) *VMSum {
	if sn == nil || len(sn.vms) == 0 {
		return nil
	}
	s := &VMSum{Total: len(sn.vms)}
	for _, v := range sn.vms {
		if v.running() {
			s.Running++
		} else if vmAlarming(v) {
			s.Bad++
		}
	}
	return s
}

func sameSum(a, b *VMSum) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// sameVMs сравнивает без LastRun: он меняется при каждом опросе, а файл
// ради него переписывать незачем (сохранится при выходе или при изменении).
func sameVMs(a, b []*VM) bool {
	enc := func(l []*VM) string {
		c := make([]VM, len(l))
		for i, v := range l {
			c[i] = *v
			c[i].LastRun = 0
		}
		b, _ := json.Marshal(c)
		return string(b)
	}
	return enc(a) == enc(b)
}

func (s *vmStore) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.Seen) > 0 || s.dirty {
		s.saveLocked()
	}
}

func vmRank(v *VM) int {
	switch {
	case vmAlarming(v):
		return 0
	case v.running():
		return 1
	case v.State == "starting" || v.State == "stopping":
		return 2
	}
	return 3
}

// clearVolatile убирает то, что меняется от замера к замеру: в хранилище
// остаётся только устройство ВМ.
func clearVolatile(v *VM) {
	v.PID, v.Up, v.RSS, v.CPUPct, v.Detail, v.GuestConn = 0, 0, 0, nil, "", 0
	v.State = ""
	if v.Display != nil {
		d := *v.Display
		d.Clients = 0
		v.Display = &d
	}
	fw := make([]VMFwd, len(v.Fwds))
	for i, f := range v.Fwds {
		f.Conns = 0
		fw[i] = f
	}
	if len(fw) == 0 {
		fw = nil
	}
	v.Fwds = fw
	nets := make([]VMNet, len(v.Nets))
	copy(nets, v.Nets)
	if len(nets) == 0 {
		nets = nil
	}
	v.Nets = nets
	disks := make([]VMDisk, len(v.Disks))
	copy(disks, v.Disks)
	if len(disks) == 0 {
		disks = nil
	}
	v.Disks = disks
}

func fillFrom(v, p *VM) {
	if v.CPUs == 0 {
		v.CPUs, v.Topo = p.CPUs, p.Topo
	}
	if v.MemMB == 0 {
		v.MemMB = p.MemMB
	}
	if len(v.Disks) == 0 {
		v.Disks = p.Disks
	}
	if len(v.Nets) == 0 {
		v.Nets = p.Nets
	}
	if len(v.Fwds) == 0 {
		v.Fwds = p.Fwds
	}
	if v.Display == nil {
		v.Display = p.Display
	}
	if v.UUID == "" {
		v.UUID = p.UUID
	}
	if v.Guest == "" {
		v.Guest = p.Guest
	}
	if v.Accel == "" {
		v.Accel, v.Machine = p.Accel, p.Machine
	}
	if v.Name == "" || (v.Unit != "" && v.Name == strings.TrimSuffix(v.Unit, ".service")) {
		v.Name = p.Name
	}
	if v.qmp == "" {
		v.qmp = p.qmp
	}
}

func mergeProc(dom, p *VM) {
	dom.PID, dom.Up, dom.RSS, dom.st1 = p.PID, p.Up, p.RSS, p.st1
	dom.qmp = p.qmp
	if dom.CPUs == 0 {
		dom.CPUs = p.CPUs
	}
	dom.Topo = p.Topo
	if dom.MemMB == 0 {
		dom.MemMB = p.MemMB
	}
	dom.Accel, dom.Machine = p.Accel, p.Machine
	if dom.Guest == "" {
		dom.Guest = p.Guest
	}
	dom.Disks = p.Disks
	if len(dom.Nets) == 0 {
		dom.Nets = p.Nets
	} else {
		for _, n := range p.Nets {
			found := false
			for i := range dom.Nets {
				if dom.Nets[i].MAC == n.MAC {
					found = true
					if dom.Nets[i].Model == "" {
						dom.Nets[i].Model = n.Model
					}
				}
			}
			if !found {
				dom.Nets = append(dom.Nets, n)
			}
		}
	}
	dom.Fwds = p.Fwds
	if dom.Display == nil {
		dom.Display = p.Display
	}
	if dom.State == "unknown" {
		dom.State = "running"
	}
}

func cleanAbsPath(p string) bool {
	return strings.HasPrefix(p, "/") && filepath.Clean(p) == p && !strings.ContainsAny(p, "\n\r\x00")
}

func vmActions(v *VM) []string {
	switch v.Manager {
	case "systemd", "libvirt", "proxmox":
		switch v.State {
		case "running", "paused":
			if v.Manager == "systemd" {
				return []string{"stop", "restart"}
			}
			return []string{"stop", "restart", "poweroff"}
		case "starting", "stopping":
			if v.Manager == "systemd" {
				return []string{"stop"}
			}
			return []string{"poweroff"}
		default:
			return []string{"start"}
		}
	case "qmp":
		if v.running() || v.State == "paused" {
			return []string{"stop"}
		}
	}
	if v.Kind == "qemu" && v.Unit == "" && !v.running() && v.PID == 0 {
		return []string{"forget"}
	}
	return nil
}

// ---------- подключение ----------

func sshTarget(s Server) string {
	if s.Alias != "" {
		return s.Alias
	}
	t := s.Host
	if s.User != "" {
		t = s.User + "@" + t
	}
	if s.Port != 0 && s.Port != 22 {
		t = fmt.Sprintf("-p %d %s", s.Port, t)
	}
	return t
}

// jumpTarget — тот же сервер в виде для ssh -J (user@host:port).
func jumpTarget(s Server) string {
	if s.Alias != "" {
		return s.Alias
	}
	t := s.Host
	if s.User != "" {
		t = s.User + "@" + t
	}
	if s.Port != 0 && s.Port != 22 {
		t = fmt.Sprintf("%s:%d", t, s.Port)
	}
	return t
}

func localAddr(a string) bool {
	return a == "127.0.0.1" || a == "::1" || a == "localhost" || strings.HasPrefix(a, "127.")
}

func hostPort(addr string, port int) string {
	if strings.Contains(addr, ":") {
		return fmt.Sprintf("[%s]:%d", addr, port)
	}
	return fmt.Sprintf("%s:%d", addr, port)
}

func rdpEntry(addr string, port int, label, pre string) VMConnect {
	hp := addr
	if port != 3389 {
		hp = hostPort(addr, port)
	}
	return VMConnect{Kind: "rdp", Label: label, Pre: pre, Addr: hostPort(addr, port),
		URL:  "rdp://full%20address=s:" + hp,
		Cmds: []string{"mstsc /v:" + hp, "xfreerdp /v:" + hp + " /dynamic-resolution"}}
}

func vmConnect(v *VM, s Server) []VMConnect {
	var out []VMConnect
	target := sshTarget(s)
	alias := target
	srvHost := s.Host
	localPort := 13389
	for _, f := range v.Fwds {
		if f.Proto != "tcp" {
			continue
		}
		addr := f.HostAddr
		if addr == "" || addr == "0.0.0.0" || addr == "::" {
			addr = srvHost
		}
		pre := ""
		if localAddr(addr) {
			pre = fmt.Sprintf("ssh -N -L %d:%s %s", localPort, hostPort(addr, f.HostPort), alias)
			addr = "localhost"
			f.HostPort = localPort
			localPort++
		}
		switch f.GuestPort {
		case 3389:
			out = append(out, rdpEntry(addr, f.HostPort, L("Удалённый рабочий стол"), pre))
		case 22:
			cmd := "ssh " + addr
			if f.HostPort != 22 {
				cmd = fmt.Sprintf("ssh -p %d %s", f.HostPort, addr)
			}
			out = append(out, VMConnect{Kind: "ssh", Label: "SSH", Addr: hostPort(addr, f.HostPort), Cmds: []string{cmd}, Pre: pre})
		}
	}
	// мост/tap: адрес гостя виден только с сервера — через туннель
	if v.running() {
		for _, n := range v.Nets {
			if n.Mode == "user" || len(n.IPs) == 0 {
				continue
			}
			ip := n.IPs[0]
			if v.Guest == "windows" {
				out = append(out, rdpEntry("localhost", localPort, L("Удалённый рабочий стол через сервер"), fmt.Sprintf("ssh -N -L %d:%s %s", localPort, hostPort(ip, 3389), alias)))
				localPort++
			} else {
				out = append(out, VMConnect{Kind: "ssh", Label: L("SSH через сервер"), Addr: ip, Cmds: []string{fmt.Sprintf("ssh -J %s %s", jumpTarget(s), ip)}})
			}
			break
		}
	}
	if d := v.Display; d != nil {
		lp := 5901
		switch {
		case d.Socket != "":
			out = append(out, VMConnect{Kind: d.Kind, Label: L("Экран ВМ"),
				Pre:  fmt.Sprintf("ssh -N -L %d:%s %s", lp, d.Socket, alias),
				Addr: fmt.Sprintf("localhost:%d", lp), URL: fmt.Sprintf("%s://localhost:%d", d.Kind, lp), Note: vncNote(d)})
		case d.Port > 0:
			addr := d.Addr
			if addr == "" || addr == "0.0.0.0" || addr == "::" {
				addr = srvHost
			}
			if localAddr(addr) {
				out = append(out, VMConnect{Kind: d.Kind, Label: L("Экран ВМ"),
					Pre:  fmt.Sprintf("ssh -N -L %d:%s %s", lp, hostPort(addr, d.Port), alias),
					Addr: fmt.Sprintf("localhost:%d", lp), URL: fmt.Sprintf("%s://localhost:%d", d.Kind, lp), Note: vncNote(d)})
			} else {
				out = append(out, VMConnect{Kind: d.Kind, Label: L("Экран ВМ"), Addr: hostPort(addr, d.Port),
					URL: fmt.Sprintf("%s://%s", d.Kind, hostPort(addr, d.Port)), Note: vncNote(d)})
			}
		}
	}
	switch v.Kind {
	case "libvirt":
		if s.Alias != "" {
			out = append(out, VMConnect{Kind: "console", Label: "virt-viewer", Cmds: []string{fmt.Sprintf("virt-viewer -c qemu+ssh://%s/system %s", s.Alias, shq(v.Ref))}})
		}
		out = append(out, VMConnect{Kind: "console", Label: L("Последовательная консоль"), Cmds: []string{fmt.Sprintf("ssh -t %s sudo virsh console %s", alias, shq(v.Ref))}})
	case "proxmox":
		out = append(out, VMConnect{Kind: "web", Label: L("Консоль Proxmox"), URL: fmt.Sprintf("https://%s/#v1:0:=qemu%%2F%s:4:::::::", hostPort(srvHost, 8006), v.pveID)})
	}
	return out
}

func vncNote(d *VMDisplay) string {
	switch {
	case d.PassAt != "":
		return fmt.Sprintf(L("Нужен пароль VNC — он в файле %s на сервере."), d.PassAt)
	case d.Pass:
		return L("Нужен пароль VNC.")
	}
	return ""
}

// ---------- опрос ----------

func (a *App) runVMs(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(20 * time.Second):
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		a.mu.RLock()
		var mons []*Monitor
		for _, id := range a.order {
			mons = append(mons, a.mons[id])
		}
		a.mu.RUnlock()
		sem := make(chan struct{}, 4)
		var wg sync.WaitGroup
		for _, m := range mons {
			m.mu.RLock()
			ok := m.srv.Monitor && !m.srv.Hidden && m.status == "online" && m.info != nil && m.info.VM
			m.mu.RUnlock()
			if !ok {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func(m *Monitor) {
				defer wg.Done()
				defer func() { <-sem }()
				c, cancel := context.WithTimeout(ctx, 45*time.Second)
				defer cancel()
				_, _ = a.scanVMs(c, m)
			}(m)
		}
		wg.Wait()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ---------- HTTP ----------

func (a *App) handleVMs(w http.ResponseWriter, r *http.Request, m *Monitor) {
	srv := m.server()
	if sn := a.vms.snapshot(srv.ID); sn != nil && time.Since(sn.at) < 5*time.Second && r.URL.Query().Get("fresh") == "" {
		writeJSON(w, 200, map[string]any{"vms": sn.vms, "t": sn.at.UnixMilli()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	list, err := a.scanVMs(ctx, m)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	if list == nil {
		list = []*VM{}
	}
	in := m.ensureInfo(ctx)
	priv := in != nil && (in.UID == 0 || in.Sudo)
	writeJSON(w, 200, map[string]any{"vms": list, "privileged": priv, "t": time.Now().UnixMilli()})
}

func (a *App) handleVMAction(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Key    string `json:"key"`
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, L("недопустимый запрос"))
		return
	}
	srv := m.server()
	sn := a.vms.snapshot(srv.ID)
	var v *VM
	if sn != nil {
		for _, x := range sn.vms {
			if x.Key == req.Key {
				v = x
			}
		}
	}
	if v == nil {
		writeErr(w, 404, L("ВМ не найдена — обновите список"))
		return
	}
	allowed := false
	for _, x := range v.Actions {
		allowed = allowed || x == req.Action
	}
	if !allowed {
		writeErr(w, 400, L("недопустимое действие"))
		return
	}
	if req.Action == "forget" {
		a.vms.mu.Lock()
		var keep []*VM
		for _, x := range a.vms.Seen[srv.ID] {
			if x.Key != v.Key {
				keep = append(keep, x)
			}
		}
		a.vms.Seen[srv.ID] = keep
		a.vms.saveLocked()
		a.vms.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	sudo := m.sudo(ctx)
	var script string
	switch v.Manager {
	case "systemd":
		if !unitRe.MatchString(v.Unit) {
			writeErr(w, 400, L("недопустимое имя службы"))
			return
		}
		// --no-block: выключение гостя через ACPI может идти минуты
		script = fmt.Sprintf("%ssystemctl --no-block %s %s 2>&1", sudo, req.Action, shq(v.Unit))
	case "libvirt":
		cmd := map[string]string{"start": "start", "stop": "shutdown", "restart": "reboot", "poweroff": "destroy"}[req.Action]
		script = fmt.Sprintf("%svirsh -c qemu:///system %s %s 2>&1", sudo, cmd, shq(v.Ref))
	case "proxmox":
		if _, err := strconv.Atoi(v.pveID); err != nil {
			writeErr(w, 400, L("недопустимый запрос"))
			return
		}
		cmd := map[string]string{"start": "start", "stop": "shutdown", "restart": "reboot", "poweroff": "stop"}[req.Action]
		script = fmt.Sprintf("(setsid %sqm %s %s >/dev/null 2>&1 &) ; echo ok", sudo, cmd, v.pveID)
	case "qmp":
		if !cleanAbsPath(v.qmp) {
			writeErr(w, 400, L("недопустимый запрос"))
			return
		}
		py := `import json,socket,sys
s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(sys.argv[1]);f=s.makefile("rw");f.readline()
for c in ("qmp_capabilities","system_powerdown"):
    f.write(json.dumps({"execute":c})+"\n");f.flush()
    while 1:
        r=json.loads(f.readline())
        if "return" in r or "error" in r: break
    if "error" in r: print(r["error"].get("desc","error"));sys.exit(1)
`
		script = fmt.Sprintf("P=''; [ -w %s ] || P=%q; timeout 10 $P python3 -I -c %s %s 2>&1", shq(v.qmp), strings.TrimSpace(sudo), shq(py), shq(v.qmp))
	default:
		writeErr(w, 400, L("недопустимое действие"))
		return
	}
	res := a.runScript(ctx, &srv, script)
	if res.Err == nil && res.Code == 0 && (req.Action == "stop" || req.Action == "poweroff") {
		// остановлена из панели — не оповещаем, что она не работает
		a.vms.mu.Lock()
		for _, x := range a.vms.Seen[srv.ID] {
			if x.Key == v.Key {
				x.Stopped = time.Now().UnixMilli()
			}
		}
		a.vms.saveLocked()
		a.vms.mu.Unlock()
	}
	if res.Err == nil && res.Code == 0 {
		go func() {
			time.Sleep(3 * time.Second)
			c, cancel := context.WithTimeout(a.ctx, 45*time.Second)
			defer cancel()
			_, _ = a.scanVMs(c, m)
		}()
	}
	actionResult(w, res)
}
