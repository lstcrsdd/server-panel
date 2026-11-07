package main

import (
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------- процессы ----------

type procSample struct {
	at     time.Time
	uptime float64
	ticks  map[int]uint64
}

type Proc struct {
	PID     int     `json:"pid"`
	PPID    int     `json:"ppid"`
	Name    string  `json:"name"`
	State   string  `json:"state"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu"`
	Mem     float64 `json:"mem"`
	RSS     uint64  `json:"rss"`
	Threads int     `json:"threads"`
	Elapsed float64 `json:"elapsed"`
	Cmd     string  `json:"cmd"`
	Kernel  bool    `json:"kernel"`
}

func procScript(double bool) string {
	s := `export LC_ALL=C
snap() { echo @@U; cat /proc/uptime; echo @@S; cat /proc/[0-9]*/stat 2>/dev/null; }
echo @@C; getconf CLK_TCK 2>/dev/null || echo 100; getconf PAGESIZE 2>/dev/null || echo 4096; grep MemTotal /proc/meminfo
`
	if double {
		s += "snap; sleep 1\n"
	}
	s += `snap
echo @@P; ps -e -ww -o pid=,user:32=,args= 2>/dev/null
echo @@E
`
	return s
}

type procStat struct {
	pid, ppid, threads int
	comm, state        string
	ticks, start, rss  uint64
}

type procOutput struct {
	clk, page, memTotal float64
	snaps               []struct {
		uptime float64
		procs  []procStat
	}
	users map[int]string
	cmds  map[int]string
}

func parseProcOutput(out string) *procOutput {
	po := &procOutput{clk: 100, page: 4096, users: map[int]string{}, cmds: map[int]string{}}
	section := ""
	cline := 0
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			section = l[2:]
			if section == "U" {
				po.snaps = append(po.snaps, struct {
					uptime float64
					procs  []procStat
				}{})
			}
			continue
		}
		switch section {
		case "C":
			cline++
			switch cline {
			case 1:
				if v, err := strconv.ParseFloat(strings.TrimSpace(l), 64); err == nil && v > 0 {
					po.clk = v
				}
			case 2:
				if v, err := strconv.ParseFloat(strings.TrimSpace(l), 64); err == nil && v > 0 {
					po.page = v
				}
			case 3:
				fs := strings.Fields(l)
				if len(fs) >= 2 {
					v, _ := strconv.ParseFloat(fs[1], 64)
					po.memTotal = v * 1024
				}
			}
		case "U":
			if fs := strings.Fields(l); len(fs) > 0 && len(po.snaps) > 0 {
				po.snaps[len(po.snaps)-1].uptime, _ = strconv.ParseFloat(fs[0], 64)
			}
		case "S":
			if ps, ok := parseProcStat(l); ok && len(po.snaps) > 0 {
				s := &po.snaps[len(po.snaps)-1]
				s.procs = append(s.procs, ps)
			}
		case "P":
			fs := strings.Fields(l)
			if len(fs) < 2 {
				continue
			}
			pid, err := strconv.Atoi(fs[0])
			if err != nil {
				continue
			}
			po.users[pid] = fs[1]
			// команда — всё после второго поля, с сохранением пробелов
			rest := strings.TrimLeft(l, " ")
			rest = strings.TrimLeft(rest[len(fs[0]):], " ")
			rest = strings.TrimLeft(rest[len(fs[1]):], " ")
			po.cmds[pid] = rest
		}
	}
	return po
}

func parseProcStat(l string) (procStat, bool) {
	var ps procStat
	open := strings.IndexByte(l, '(')
	close := strings.LastIndexByte(l, ')')
	if open < 0 || close < open {
		return ps, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(l[:open]))
	if err != nil {
		return ps, false
	}
	ps.pid = pid
	ps.comm = l[open+1 : close]
	rest := strings.Fields(l[close+1:])
	if len(rest) < 22 {
		return ps, false
	}
	ps.state = rest[0]
	ps.ppid, _ = strconv.Atoi(rest[1])
	ut, _ := strconv.ParseUint(rest[11], 10, 64)
	st, _ := strconv.ParseUint(rest[12], 10, 64)
	ps.ticks = ut + st
	ps.threads, _ = strconv.Atoi(rest[17])
	ps.start, _ = strconv.ParseUint(rest[19], 10, 64)
	ps.rss, _ = strconv.ParseUint(rest[21], 10, 64)
	return ps, true
}

func buildProcs(po *procOutput, base *procSample) ([]Proc, *procSample) {
	if len(po.snaps) == 0 {
		return nil, nil
	}
	cur := po.snaps[len(po.snaps)-1]
	if len(po.snaps) >= 2 {
		first := po.snaps[0]
		base = &procSample{uptime: first.uptime, ticks: map[int]uint64{}}
		for _, p := range first.procs {
			base.ticks[p.pid] = p.ticks
		}
	}
	sample := &procSample{at: time.Now(), uptime: cur.uptime, ticks: map[int]uint64{}}
	dt := 0.0
	if base != nil && cur.uptime > base.uptime {
		dt = cur.uptime - base.uptime
	}
	out := make([]Proc, 0, len(cur.procs))
	for _, p := range cur.procs {
		sample.ticks[p.pid] = p.ticks
		pr := Proc{
			PID: p.pid, PPID: p.ppid, Name: p.comm, State: p.state, Threads: p.threads,
			RSS:    uint64(float64(p.rss) * po.page),
			User:   po.users[p.pid],
			Cmd:    po.cmds[p.pid],
			Kernel: p.pid == 2 || p.ppid == 2,
		}
		if el := cur.uptime - float64(p.start)/po.clk; el > 0 {
			pr.Elapsed = math_round(el)
		}
		if po.memTotal > 0 {
			pr.Mem = round2(float64(pr.RSS) / po.memTotal * 100)
		}
		if dt > 0 && base != nil {
			if prev, ok := base.ticks[p.pid]; ok && p.ticks >= prev {
				pr.CPU = round1(float64(p.ticks-prev) / po.clk / dt * 100)
			}
		}
		if pr.Cmd == "" {
			pr.Cmd = "[" + pr.Name + "]"
		}
		out = append(out, pr)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CPU != out[j].CPU {
			return out[i].CPU > out[j].CPU
		}
		return out[i].RSS > out[j].RSS
	})
	return out, sample
}

func math_round(x float64) float64 { return float64(int64(x + 0.5)) }

// ---------- службы systemd ----------

type Service struct {
	Unit        string `json:"unit"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Description string `json:"description"`
	Enabled     string `json:"enabled"`
}

const servicesScript = `export LC_ALL=C SYSTEMD_COLORS=0
systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
echo @@F
systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
`

func parseServices(out string) []Service {
	units := map[string]*Service{}
	var order []string
	enabled := map[string]string{}
	section := "U"
	for _, l := range strings.Split(out, "\n") {
		if l == "@@F" {
			section = "F"
			continue
		}
		fs := strings.Fields(l)
		if len(fs) > 0 && (fs[0] == "●" || fs[0] == "*" || fs[0] == "×") {
			fs = fs[1:]
		}
		if section == "U" {
			if len(fs) < 4 || !strings.HasSuffix(fs[0], ".service") {
				continue
			}
			s := &Service{Unit: fs[0], Load: fs[1], Active: fs[2], Sub: fs[3], Description: strings.Join(fs[4:], " ")}
			if _, dup := units[s.Unit]; !dup {
				order = append(order, s.Unit)
			}
			units[s.Unit] = s
		} else if len(fs) >= 2 && strings.HasSuffix(fs[0], ".service") {
			enabled[fs[0]] = fs[1]
		}
	}
	for u, st := range enabled {
		if _, ok := units[u]; ok || strings.Contains(u, "@.") {
			continue
		}
		if st == "enabled" || st == "disabled" {
			units[u] = &Service{Unit: u, Load: "not-loaded", Active: "inactive", Sub: "dead"}
			order = append(order, u)
		}
	}
	out2 := make([]Service, 0, len(order))
	for _, u := range order {
		s := units[u]
		if st, ok := enabled[u]; ok {
			s.Enabled = st
		} else if i := strings.Index(u, "@"); i > 0 {
			s.Enabled = enabled[u[:i+1]+".service"]
		}
		out2 = append(out2, *s)
	}
	sort.Slice(out2, func(i, j int) bool { return out2[i].Unit < out2[j].Unit })
	return out2
}

var unitRe = regexp.MustCompile(`^[A-Za-z0-9@:_.\\][A-Za-z0-9@:_.\\-]*\.service$`)

// ---------- журнал ----------

type LogEntry struct {
	T     int64  `json:"t"`
	Prio  int    `json:"p"`
	Ident string `json:"id"`
	Unit  string `json:"u,omitempty"`
	PID   string `json:"pid,omitempty"`
	Msg   string `json:"m"`
}

func parseJournal(out string) (entries []LogEntry, cursor string, notes []string) {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if l == "" {
			continue
		}
		if !strings.HasPrefix(l, "{") {
			if len(notes) < 5 {
				notes = append(notes, l)
			}
			continue
		}
		var raw map[string]json.RawMessage
		if json.Unmarshal([]byte(l), &raw) != nil {
			continue
		}
		e := LogEntry{Prio: 6}
		str := func(k string) string {
			v, ok := raw[k]
			if !ok {
				return ""
			}
			var s string
			if json.Unmarshal(v, &s) == nil {
				return s
			}
			var bs []byte
			var arr []int
			if json.Unmarshal(v, &arr) == nil {
				for _, b := range arr {
					bs = append(bs, byte(b))
				}
				return strings.ToValidUTF8(string(bs), "�")
			}
			return ""
		}
		if ts, err := strconv.ParseInt(str("__REALTIME_TIMESTAMP"), 10, 64); err == nil {
			e.T = ts / 1000
		}
		if p, err := strconv.Atoi(str("PRIORITY")); err == nil {
			e.Prio = p
		}
		e.Ident = str("SYSLOG_IDENTIFIER")
		if e.Ident == "" {
			e.Ident = str("_COMM")
		}
		e.Unit = str("_SYSTEMD_UNIT")
		e.PID = str("_PID")
		e.Msg = str("MESSAGE")
		if c := str("__CURSOR"); c != "" {
			cursor = c
		}
		entries = append(entries, e)
	}
	return
}

// ---------- сеть ----------

type ListenSock struct {
	Proto string   `json:"proto"`
	Addr  string   `json:"addr"`
	Port  int      `json:"port"`
	Procs []string `json:"procs"`
}

type PeerCount struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

type NetInfo struct {
	Listen      []ListenSock `json:"listen"`
	Established int          `json:"established"`
	Inbound     int          `json:"inbound"`
	Outbound    int          `json:"outbound"`
	Peers       []PeerCount  `json:"peers"`
	LocalPorts  []PeerCount  `json:"localPorts"`
	RemotePorts []PeerCount  `json:"remotePorts"`
	UniquePeers int          `json:"uniquePeers"`
}

const networkScript = `export LC_ALL=C
echo @@L; %sss -H -tulpn 2>/dev/null || ss -tulpn 2>/dev/null | tail -n +2
echo @@C; ss -Htn state established 2>/dev/null || ss -tn state established 2>/dev/null | tail -n +2
echo @@E
`

var ssUserRe = regexp.MustCompile(`"([^"]+)",pid=(\d+)`)

func splitHostPort(s string) (string, int) {
	i := strings.LastIndexByte(s, ':')
	if i < 0 {
		return s, 0
	}
	host := strings.Trim(s[:i], "[]")
	if j := strings.IndexByte(host, '%'); j >= 0 {
		host = host[:j]
	}
	host = strings.TrimPrefix(host, "::ffff:")
	p, _ := strconv.Atoi(s[i+1:])
	return host, p
}

func parseNetwork(out string) NetInfo {
	var ni NetInfo
	peers := map[string]int{}
	lports := map[string]int{}
	rports := map[string]int{}
	seen := map[string]bool{}
	listening := map[int]bool{}
	type conn struct {
		lp, rp int
		peer   string
	}
	var conns []conn
	section := ""
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "@@") {
			section = l[2:]
			continue
		}
		fs := strings.Fields(l)
		switch section {
		case "L":
			if len(fs) < 5 {
				continue
			}
			addr, port := splitHostPort(fs[4])
			ls := ListenSock{Proto: fs[0], Addr: addr, Port: port}
			if len(fs) >= 7 {
				for _, m := range ssUserRe.FindAllStringSubmatch(strings.Join(fs[6:], " "), -1) {
					name := m[1] + " (" + m[2] + ")"
					dup := false
					for _, x := range ls.Procs {
						if x == name {
							dup = true
						}
					}
					if !dup {
						ls.Procs = append(ls.Procs, name)
					}
				}
			}
			if strings.HasPrefix(ls.Proto, "tcp") {
				listening[port] = true
			}
			key := fmt.Sprintf("%s|%s|%d|%v", ls.Proto, ls.Addr, ls.Port, ls.Procs)
			if !seen[key] {
				seen[key] = true
				ni.Listen = append(ni.Listen, ls)
			}
		case "C":
			if len(fs) < 4 {
				continue
			}
			_, lp := splitHostPort(fs[2])
			ph, rp := splitHostPort(fs[3])
			if ip := net.ParseIP(ph); ip != nil && ip.IsLoopback() {
				continue
			}
			conns = append(conns, conn{lp, rp, ph})
		}
	}
	for _, c := range conns {
		ni.Established++
		peers[c.peer]++
		if listening[c.lp] {
			ni.Inbound++
			lports[strconv.Itoa(c.lp)]++
		} else {
			ni.Outbound++
			rports[strconv.Itoa(c.rp)]++
		}
	}
	sort.Slice(ni.Listen, func(i, j int) bool {
		if ni.Listen[i].Port != ni.Listen[j].Port {
			return ni.Listen[i].Port < ni.Listen[j].Port
		}
		return ni.Listen[i].Proto < ni.Listen[j].Proto
	})
	ni.UniquePeers = len(peers)
	ni.Peers = topCounts(peers, 25)
	ni.LocalPorts = topCounts(lports, 10)
	ni.RemotePorts = topCounts(rports, 10)
	return ni
}

func topCounts(m map[string]int, n int) []PeerCount {
	out := make([]PeerCount, 0, len(m))
	for k, v := range m {
		out = append(out, PeerCount{k, v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// ---------- docker ----------

func parseJSONLines(s string) []map[string]any {
	var out []map[string]any
	for _, l := range strings.Split(s, "\n") {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "{") {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

var containerRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
