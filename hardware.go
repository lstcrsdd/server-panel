package main

// Характеристики железа: процессор, видеокарты, память, накопители и
// платформа. Собираются по запросу одним скриптом. Модули памяти (dmidecode)
// видны только под root или с sudo без пароля — остальное доступно всем.

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const hwScript = `export LC_ALL=C
if [ "$(id -u)" = 0 ]; then D=dmidecode; elif sudo -n true 2>/dev/null; then D="sudo -n dmidecode"; else D=; fi
echo @@CPU; lscpu 2>/dev/null
echo @@CPUINFO; grep -m1 -E '^(model name|Hardware|cpu model|Processor)' /proc/cpuinfo 2>/dev/null; echo "count: $(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
echo @@GPU; if command -v lspci >/dev/null 2>&1; then lspci -mm -nn 2>/dev/null | grep -E '^[^"]*"[^"]*\[03[0-9a-f]{2}\]"'; fi
echo @@GPUSYS
for d in /sys/bus/pci/devices/*; do
  c=$(cat "$d/class" 2>/dev/null)
  case "$c" in 0x03*)
    drv=$(basename "$(readlink "$d/driver" 2>/dev/null)" 2>/dev/null)
    echo "slot=$(basename "$d") vendor=$(cat "$d/vendor") device=$(cat "$d/device") driver=${drv:--} vram=$(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0)" ;;
  esac
done
echo @@NV; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=pci.bus_id,name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null
echo @@MEM; grep -E '^(MemTotal|SwapTotal):' /proc/meminfo
echo @@DMIMEM; [ -n "$D" ] && $D -t memory 2>/dev/null
echo @@DISK; lsblk -bnP -o NAME,PKNAME,TYPE,SIZE,ROTA,TRAN,MODEL,MOUNTPOINT 2>/dev/null
echo @@DMI
for f in sys_vendor product_name board_vendor board_name bios_vendor bios_version bios_date chassis_type; do echo "$f=$(cat /sys/class/dmi/id/$f 2>/dev/null)"; done
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "arch=$(uname -m)"
echo "dmidecode=$([ -z "$D" ] && echo noroot || { command -v dmidecode >/dev/null 2>&1 && echo 1 || echo missing; })"
` + sensSection

type HWCPU struct {
	Model   string  `json:"model"`
	Vendor  string  `json:"vendor,omitempty"`
	Arch    string  `json:"arch,omitempty"`
	Sockets int     `json:"sockets,omitempty"`
	Cores   int     `json:"cores,omitempty"`   // физических ядер всего
	Threads int     `json:"threads,omitempty"` // логических процессоров
	MaxMHz  float64 `json:"maxMHz,omitempty"`
	L3      int64   `json:"l3,omitempty"` // байт, суммарно
	VirtExt string  `json:"virtExt,omitempty"`
	Hyper   string  `json:"hypervisor,omitempty"`
}

type HWGPU struct {
	Name   string `json:"name"`
	Chip   string `json:"chip,omitempty"`
	Vendor string `json:"vendor,omitempty"`
	Kind   string `json:"kind"` // gpu | virtual | bmc
	VRAM   int64  `json:"vram,omitempty"`
	Driver string `json:"driver,omitempty"`
	Slot   string `json:"slot,omitempty"` // PCI-адрес без домена: 2b:00.0
	venID  string
}

type HWModule struct {
	Size  int64  `json:"size"`
	Type  string `json:"type,omitempty"`
	Speed string `json:"speed,omitempty"`
	Maker string `json:"maker,omitempty"`
	Part  string `json:"part,omitempty"`
	Slot  string `json:"slot,omitempty"`
}

type HWMem struct {
	Total   int64      `json:"total"`
	Swap    int64      `json:"swap"`
	Modules []HWModule `json:"modules,omitempty"`
	Slots   int        `json:"slots,omitempty"`
	Max     int64      `json:"max,omitempty"`
	ECC     string     `json:"ecc,omitempty"`
	DMI     string     `json:"dmi"` // ok | noroot | missing
}

type HWDisk struct {
	Name   string   `json:"name"`
	Model  string   `json:"model,omitempty"`
	Size   int64    `json:"size"`
	Kind   string   `json:"kind"` // nvme | ssd | hdd | virtual | usb
	Tran   string   `json:"tran,omitempty"`
	Mounts []string `json:"mounts,omitempty"`
}

type HWPlatform struct {
	Vendor   string `json:"vendor,omitempty"`
	Product  string `json:"product,omitempty"`
	Board    string `json:"board,omitempty"`
	BIOS     string `json:"bios,omitempty"`
	BIOSDate string `json:"biosDate,omitempty"`
	Chassis  string `json:"chassis,omitempty"`
	Virt     string `json:"virt,omitempty"`
}

type Hardware struct {
	CPU      HWCPU      `json:"cpu"`
	GPUs     []HWGPU    `json:"gpus"`
	Mem      HWMem      `json:"mem"`
	Disks    []HWDisk   `json:"disks"`
	Platform HWPlatform `json:"platform"`
	Sensors  HWSensors  `json:"sensors"`
}

func (a *App) handleHardware(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	srv := m.server()
	res := a.runScript(ctx, &srv, hwScript)
	if res.Err != nil && !strings.Contains(res.Stdout, "@@DMI") {
		writeErr(w, 502, res.errText())
		return
	}
	writeJSON(w, 200, parseHardware(res.Stdout))
}

func hwSections(out string) map[string][]string {
	sec := map[string][]string{}
	cur := ""
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.HasPrefix(l, "@@") && !strings.Contains(l, " ") {
			cur = strings.TrimPrefix(l, "@@")
			continue
		}
		if cur != "" {
			sec[cur] = append(sec[cur], l)
		}
	}
	return sec
}

// junk — значения-заглушки, которые производители оставляют в DMI.
func junk(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "unknown", "not specified", "not available", "not applicable", "none", "n/a", "undefined", "other",
		"to be filled by o.e.m.", "default string", "system product name", "system manufacturer", "o.e.m.", "oem",
		"type1productconfigid", "<out of spec>", "not provided", "0x00000000", "00000000":
		return true
	}
	return false
}

var vendorSuffixRe = regexp.MustCompile(`(?i)[,.]?\s+(co\.,?\s*ltd\.?|corporation|corp\.?|inc\.?|incorporated|ltd\.?|llc\.?|gmbh|technology|technologies|computer|international|electronics|systems)\b\.?`)

func shortVendor(v string) string {
	v = strings.TrimSpace(v)
	l := strings.ToLower(v)
	switch {
	case strings.HasPrefix(l, "micro-star"):
		return "MSI"
	case strings.HasPrefix(l, "asustek"):
		return "ASUS"
	case strings.HasPrefix(l, "gigabyte"):
		return "Gigabyte"
	case strings.HasPrefix(l, "super micro"), strings.HasPrefix(l, "supermicro"):
		return "Supermicro"
	case strings.HasPrefix(l, "hewlett"), l == "hpe":
		return "HPE"
	case strings.HasPrefix(l, "dell"):
		return "Dell"
	case l == "lenovo":
		return "Lenovo"
	case strings.HasPrefix(l, "american megatrends"):
		return "AMI"
	}
	for i := 0; i < 3; i++ {
		v = strings.TrimSpace(vendorSuffixRe.ReplaceAllString(v, ""))
	}
	return strings.TrimRight(v, ",. ")
}

// ---------- процессор ----------

func parseSize(s string) int64 {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "("); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	num := strings.TrimRight(s, "KMGTiBkb ")
	unit := strings.ToUpper(strings.TrimSpace(s[len(num):]))
	f, err := strconv.ParseFloat(strings.TrimSpace(num), 64)
	if err != nil {
		return 0
	}
	mul := 1.0
	switch {
	case strings.HasPrefix(unit, "K"):
		mul = 1 << 10
	case strings.HasPrefix(unit, "M"):
		mul = 1 << 20
	case strings.HasPrefix(unit, "G"):
		mul = 1 << 30
	case strings.HasPrefix(unit, "T"):
		mul = 1 << 40
	}
	return int64(f * mul)
}

func parseCPU(lscpu, cpuinfo []string) HWCPU {
	var c HWCPU
	kv := map[string]string{}
	for _, l := range lscpu {
		k, v, ok := strings.Cut(l, ":")
		if ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	atoi := func(k string) int { n, _ := strconv.Atoi(kv[k]); return n }
	c.Model = strings.Join(strings.Fields(kv["Model name"]), " ")
	c.Vendor = kv["Vendor ID"]
	c.Arch = kv["Architecture"]
	c.Threads = atoi("CPU(s)")
	c.Sockets = atoi("Socket(s)")
	if per := atoi("Core(s) per socket"); per > 0 {
		s := c.Sockets
		if s < 1 {
			s = 1
		}
		c.Cores = per * s
	}
	c.MaxMHz, _ = strconv.ParseFloat(kv["CPU max MHz"], 64)
	if v := kv["L3 cache"]; v != "" {
		c.L3 = parseSize(v)
	} else if v := kv["L3"]; v != "" {
		c.L3 = parseSize(v)
	}
	c.VirtExt = kv["Virtualization"]
	c.Hyper = kv["Hypervisor vendor"]
	// без lscpu — хотя бы модель и число процессоров из /proc/cpuinfo
	for _, l := range cpuinfo {
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if strings.TrimSpace(k) == "count" {
			if n, err := strconv.Atoi(v); err == nil && c.Threads == 0 {
				c.Threads = n
			}
		} else if c.Model == "" {
			c.Model = strings.Join(strings.Fields(v), " ")
		}
	}
	return c
}

// ---------- видеокарты ----------

var (
	quotedRe = regexp.MustCompile(`"([^"]*)"`)
	pciIDRe  = regexp.MustCompile(`\s*\[([0-9a-f]{4})\]$`)
	bracket  = regexp.MustCompile(`\[([^\]]+)\]`)
)

var gpuVendors = map[string]string{
	"10de": "NVIDIA", "1002": "AMD", "8086": "Intel", "1a03": "ASPEED", "102b": "Matrox",
	"1013": "Cirrus Logic", "1af4": "Red Hat", "1b36": "Red Hat", "1234": "QEMU", "15ad": "VMware",
	"80ee": "VirtualBox", "1414": "Microsoft", "5333": "S3", "18ca": "XGI", "19e5": "Huawei",
}

func gpuKind(ven string, virt bool) string {
	switch ven {
	case "1af4", "1b36", "1234", "15ad", "80ee", "1414":
		return "virtual"
	case "1013":
		if virt {
			return "virtual"
		}
	case "1a03", "102b", "18ca", "19e5":
		return "bmc"
	}
	return "gpu"
}

func parseGPUs(lspci, sys, nv []string, virt bool) []HWGPU {
	var out []HWGPU
	for _, l := range lspci {
		q := quotedRe.FindAllStringSubmatch(l, -1)
		if len(q) < 3 {
			continue
		}
		slot := strings.TrimSpace(strings.SplitN(l, " ", 2)[0])
		venFull, dev := q[1][1], q[2][1]
		venID := ""
		if m := pciIDRe.FindStringSubmatch(venFull); m != nil {
			venID = m[1]
		}
		venFull = pciIDRe.ReplaceAllString(venFull, "")
		dev = pciIDRe.ReplaceAllString(dev, "")
		g := HWGPU{Slot: slot, venID: venID}
		g.Vendor = gpuVendors[venID]
		if g.Vendor == "" {
			g.Vendor = shortVendor(bracket.ReplaceAllString(venFull, ""))
		}
		// «GT218 [GeForce 210]»: в скобках — торговое название, перед ними — чип
		if m := bracket.FindStringSubmatch(dev); m != nil {
			g.Chip = strings.TrimSpace(dev[:strings.Index(dev, "[")])
			g.Name = g.Vendor + " " + strings.TrimSpace(m[1])
		} else {
			g.Name = g.Vendor + " " + dev
		}
		g.Kind = gpuKind(venID, virt)
		out = append(out, g)
	}
	// драйвер и видеопамять (amdgpu) — из /sys; без lspci — только из /sys
	for _, l := range sys {
		f := map[string]string{}
		for _, p := range strings.Fields(l) {
			if k, v, ok := strings.Cut(p, "="); ok {
				f[k] = v
			}
		}
		slot := strings.TrimPrefix(f["slot"], "0000:")
		ven := strings.TrimPrefix(f["vendor"], "0x")
		drv := f["driver"]
		if drv == "-" {
			drv = ""
		}
		vram, _ := strconv.ParseInt(f["vram"], 10, 64)
		found := false
		for i := range out {
			if out[i].Slot == slot || strings.HasSuffix(f["slot"], out[i].Slot) {
				out[i].Driver, out[i].VRAM, found = drv, vram, true
			}
		}
		if !found && slot != "" {
			name := gpuVendors[ven]
			if name == "" {
				name = "Видеоадаптер " + ven
			}
			out = append(out, HWGPU{Slot: slot, venID: ven, Vendor: gpuVendors[ven], Name: name + " (устройство " + strings.TrimPrefix(f["device"], "0x") + ")",
				Kind: gpuKind(ven, virt), Driver: drv, VRAM: vram})
		}
	}
	// nvidia-smi знает точное название и объём памяти
	for _, l := range nv {
		p := strings.Split(l, ",")
		if len(p) < 4 {
			continue
		}
		bus := strings.ToLower(strings.TrimSpace(p[0]))
		for i := range out {
			if out[i].Slot != "" && strings.HasSuffix(bus, strings.ToLower(out[i].Slot)) {
				if n := strings.TrimSpace(p[1]); n != "" {
					if !strings.HasPrefix(n, "NVIDIA") {
						n = "NVIDIA " + n
					}
					out[i].Name = n
				}
				if mb, err := strconv.ParseInt(strings.TrimSpace(p[2]), 10, 64); err == nil {
					out[i].VRAM = mb << 20
				}
				out[i].Driver = "nvidia " + strings.TrimSpace(p[3])
			}
		}
	}
	return out
}

// ---------- память ----------

func parseMem(meminfo, dmi []string, dmiState string) HWMem {
	var mm HWMem
	for _, l := range meminfo {
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64)
		switch k {
		case "MemTotal":
			mm.Total = n << 10
		case "SwapTotal":
			mm.Swap = n << 10
		}
	}
	mm.DMI = dmiState
	if dmiState != "1" {
		return mm
	}
	mm.DMI = "ok"
	block := ""
	var cur *HWModule
	flush := func() {
		if cur != nil && cur.Size > 0 {
			mm.Modules = append(mm.Modules, *cur)
		}
		cur = nil
	}
	for _, l := range dmi {
		if l == "" {
			continue
		}
		if !strings.HasPrefix(l, "\t") && !strings.HasPrefix(l, " ") {
			if strings.HasPrefix(l, "Handle ") {
				continue
			}
			flush()
			block = strings.TrimSpace(l)
			if block == "Memory Device" {
				cur = &HWModule{}
				mm.Slots++
			}
			continue
		}
		k, v, ok := strings.Cut(strings.TrimSpace(l), ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch block {
		case "Physical Memory Array":
			switch k {
			case "Maximum Capacity":
				mm.Max += parseSize(strings.ReplaceAll(v, " ", ""))
			case "Error Correction Type":
				if mm.ECC == "" || v != "None" {
					mm.ECC = v
				}
			}
		case "Memory Device":
			if cur == nil {
				continue
			}
			switch k {
			case "Size":
				if !strings.Contains(v, "No Module") && !strings.Contains(v, "Not Installed") {
					cur.Size = parseSize(strings.ReplaceAll(v, " ", ""))
				}
			case "Type":
				if !junk(v) && v != "RAM" {
					cur.Type = v
				}
			case "Configured Memory Speed", "Configured Clock Speed":
				if !junk(v) {
					cur.Speed = v
				}
			case "Speed":
				if !junk(v) && cur.Speed == "" {
					cur.Speed = v
				}
			case "Manufacturer":
				if !junk(v) && !strings.HasPrefix(strings.ToLower(v), "manufacturer") {
					cur.Maker = v
				}
			case "Part Number":
				if !junk(v) && !strings.HasPrefix(strings.ToLower(v), "partnum") {
					cur.Part = v
				}
			case "Locator":
				if cur.Slot == "" {
					cur.Slot = v
				} else {
					cur.Slot = v + ", " + cur.Slot
				}
			case "Bank Locator":
				// «P0 CHANNEL A» — на многих платах Locator повторяется в каждом канале
				if m := channelRe.FindStringSubmatch(v); m != nil {
					ch := "канал " + m[1]
					if cur.Slot == "" {
						cur.Slot = ch
					} else {
						cur.Slot += ", " + ch
					}
				}
			}
		}
	}
	flush()
	return mm
}

// ---------- накопители ----------

var channelRe = regexp.MustCompile(`(?i)\bchannel\s*([A-Z0-9])\b`)

var lsblkPairRe = regexp.MustCompile(`([A-Z:-]+)="((?:[^"\\]|\\.)*)"`)
var hexEscRe = regexp.MustCompile(`\\x([0-9a-fA-F]{2})`)

func unescLsblk(s string) string {
	return hexEscRe.ReplaceAllStringFunc(s, func(m string) string {
		n, err := strconv.ParseUint(m[2:], 16, 8)
		if err != nil {
			return m
		}
		return string(rune(n))
	})
}

func parseDisks(lines []string) []HWDisk {
	type row struct {
		name, pk, typ, model, tran, rota, mount string
		size                                    int64
	}
	var rows []row
	byName := map[string]row{}
	for _, l := range lines {
		f := map[string]string{}
		for _, m := range lsblkPairRe.FindAllStringSubmatch(l, -1) {
			f[m[1]] = strings.TrimSpace(unescLsblk(m[2]))
		}
		if f["NAME"] == "" {
			continue
		}
		size, _ := strconv.ParseInt(f["SIZE"], 10, 64)
		r := row{name: f["NAME"], pk: f["PKNAME"], typ: f["TYPE"], model: f["MODEL"], tran: f["TRAN"], rota: f["ROTA"], mount: f["MOUNTPOINT"], size: size}
		rows = append(rows, r)
		if _, ok := byName[r.name]; !ok {
			byName[r.name] = r
		}
	}
	var disks []HWDisk
	idx := map[string]int{}
	for _, r := range rows {
		if r.typ != "disk" || r.pk != "" || r.size == 0 || strings.HasPrefix(r.name, "zram") || strings.HasPrefix(r.name, "ram") || strings.HasPrefix(r.name, "loop") {
			continue
		}
		if _, dup := idx[r.name]; dup {
			continue
		}
		model := strings.Join(strings.Fields(strings.ReplaceAll(r.model, "_", " ")), " ")
		lm := strings.ToLower(model)
		kind := "hdd"
		switch {
		case r.tran == "nvme" || strings.HasPrefix(r.name, "nvme"):
			kind = "nvme"
		case r.tran == "usb":
			kind = "usb"
		case r.tran == "virtio" || strings.HasPrefix(r.name, "vd") || strings.HasPrefix(r.name, "xvd") ||
			strings.Contains(lm, "qemu") || strings.Contains(lm, "vbox") || strings.Contains(lm, "virtual") || strings.Contains(lm, "vmware"):
			kind = "virtual"
		case r.rota == "0":
			kind = "ssd"
		}
		idx[r.name] = len(disks)
		disks = append(disks, HWDisk{Name: r.name, Model: model, Size: r.size, Kind: kind, Tran: r.tran})
	}
	// точки монтирования — поднимаемся от раздела/LVM/RAID к диску
	for _, r := range rows {
		if r.mount == "" {
			continue
		}
		mount := r.mount
		if mount == "[SWAP]" {
			mount = "swap"
		}
		cur := r
		for i := 0; i < 10 && cur.pk != ""; i++ {
			p, ok := byName[cur.pk]
			if !ok {
				break
			}
			cur = p
		}
		if i, ok := idx[cur.name]; ok {
			d := &disks[i]
			dup := false
			for _, x := range d.Mounts {
				dup = dup || x == mount
			}
			if !dup {
				d.Mounts = append(d.Mounts, mount)
			}
		}
	}
	for i := range disks {
		sort.SliceStable(disks[i].Mounts, func(a, b int) bool {
			ma, mb := disks[i].Mounts[a], disks[i].Mounts[b]
			if (ma == "/") != (mb == "/") {
				return ma == "/"
			}
			return ma < mb
		})
	}
	return disks
}

// ---------- платформа ----------

var chassisNames = map[string]string{
	"3": "настольный ПК", "4": "настольный ПК", "5": "настольный ПК", "6": "мини-башня", "7": "башня",
	"8": "ноутбук", "9": "ноутбук", "10": "ноутбук", "14": "ноутбук", "13": "моноблок", "15": "компактный ПК",
	"16": "компактный ПК", "17": "сервер", "23": "стоечный сервер", "24": "сервер", "25": "блейд-шасси",
	"28": "блейд-сервер", "29": "блейд-шасси", "30": "планшет", "31": "трансформер", "35": "мини-ПК", "36": "мини-ПК",
}

func parsePlatform(lines []string) (HWPlatform, string) {
	f := map[string]string{}
	for _, l := range lines {
		if k, v, ok := strings.Cut(l, "="); ok {
			f[k] = strings.Join(strings.Fields(v), " ")
		}
	}
	clean := func(k string) string {
		if junk(f[k]) {
			return ""
		}
		return f[k]
	}
	p := HWPlatform{
		Vendor:   shortVendor(clean("sys_vendor")),
		Product:  clean("product_name"),
		BIOSDate: clean("bios_date"),
		Chassis:  chassisNames[f["chassis_type"]],
	}
	if v := clean("bios_version"); v != "" {
		if bv := shortVendor(clean("bios_vendor")); bv != "" {
			if bv == "SeaBIOS" { // «1.16.0-4.module_el8…» — сборка дистрибутива не нужна
				v, _, _ = strings.Cut(v, "-")
			}
			v = bv + " " + v
		}
		p.BIOS = v
	}
	if bn := clean("board_name"); bn != "" {
		bv := shortVendor(clean("board_vendor"))
		if bv != "" && !strings.HasPrefix(strings.ToLower(bn), strings.ToLower(bv)) {
			bn = bv + " " + bn
		}
		p.Board = bn
	}
	if v := f["virt"]; v != "" && v != "none" {
		p.Virt = v
	}
	return p, f["arch"] + "|" + f["dmidecode"]
}

func parseHardware(out string) Hardware {
	s := hwSections(out)
	plat, rest := parsePlatform(s["DMI"])
	arch, dmiState, _ := strings.Cut(rest, "|")
	hw := Hardware{
		CPU:      parseCPU(s["CPU"], s["CPUINFO"]),
		GPUs:     parseGPUs(s["GPU"], s["GPUSYS"], s["NV"], plat.Virt != ""),
		Mem:      parseMem(s["MEM"], s["DMIMEM"], dmiState),
		Disks:    parseDisks(s["DISK"]),
		Platform: plat,
		Sensors:  parseSensors(s["SENS"], plat.Virt != ""),
	}
	if hw.CPU.Arch == "" {
		hw.CPU.Arch = arch
	}
	if hw.GPUs == nil {
		hw.GPUs = []HWGPU{}
	}
	if hw.Disks == nil {
		hw.Disks = []HWDisk{}
	}
	return hw
}
