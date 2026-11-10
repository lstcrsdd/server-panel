package main

// Температуры: процессор, видеокарты, память, накопители и материнская плата.
// Читаются из /sys/class/hwmon прямо в потоке метрик — без lm-sensors и root.
// Диски (drivetemp) опрашиваются раз в ~минуту: каждое чтение — команда диску.
// Для плат и SATA-дисков ядро само драйверы не грузит — их можно включить
// кнопкой (handleSensors), панель пропишет их в /etc/modules-load.d.

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// tempFuncs — функция сканирования датчиков для streamScript. Печатает
// @@TM и строки «путь\tчип\tустройство\tподпись\tmax\tcrit»; пути к значениям
// складывает в TF (каждый кадр) и TS (диски, реже).
const tempFuncs = `tscan() {
  TF=; TS=
  echo @@TM
  for h in /sys/class/hwmon/hwmon*; do
    [ -r "$h/name" ] || continue
    n=$(cat "$h/name" 2>/dev/null)
    d=$(readlink -f "$h/device" 2>/dev/null); d=${d##*/}
    [ "$n" = drivetemp ] && d=$(ls "$h/device/block" 2>/dev/null | head -n 1)
    for f in "$h"/temp*_input; do
      [ -r "$f" ] || continue
      b=${f%_input}; l=; x=; c=
      [ -r "${b}_label" ] && l=$(cat "${b}_label" 2>/dev/null)
      [ -r "${b}_max" ] && x=$(cat "${b}_max" 2>/dev/null)
      [ -r "${b}_crit" ] && c=$(cat "${b}_crit" 2>/dev/null)
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$n" "${d:--}" "${l:--}" "${x:--}" "${c:--}"
      if [ "$n" = drivetemp ]; then TS="$TS $f"; else TF="$TF $f"; fi
    done
  done
}
NV=$(command -v nvidia-smi 2>/dev/null)
HS=
`

// tempTick — чтение датчиков в каждом кадре (внутри fmt.Sprintf, поэтому %%).
const tempTick = `  set -- /sys/class/hwmon/hwmon*
  if [ "$*" != "$HS" ] || [ $((i %% 300)) -eq 0 ]; then HS="$*"; tscan; fi
  if [ -n "$TF" ] || { [ -n "$TS" ] && [ $((i %% 30)) -eq 0 ]; }; then
    echo @@T
    [ -n "$TF" ] && grep -sH . $TF
    [ -n "$TS" ] && [ $((i %% 30)) -eq 0 ] && grep -sH . $TS
  fi
  if [ -n "$NV" ] && [ $((i %% 5)) -eq 0 ]; then echo @@NV; "$NV" --query-gpu=pci.bus_id,name,temperature.gpu --format=csv,noheader,nounits 2>/dev/null; fi
`

// TempSensor — один датчик в метриках.
type TempSensor struct {
	Kind  string  `json:"kind"` // cpu | gpu | ram | disk | board | other
	Chip  string  `json:"chip"`
	Label string  `json:"label,omitempty"`
	Dev   string  `json:"dev,omitempty"` // sda, nvme0, 0000:2b:00.0, 0-0018
	C     float64 `json:"c"`
	High  float64 `json:"high,omitempty"`
	Crit  float64 `json:"crit,omitempty"`
}

type tempMeta struct {
	path, chip, dev, label string
	high, crit             float64
	slow                   bool
}

type tempVal struct {
	v  float64
	at time.Time
}

type nvTemp struct {
	bus, name string
	c         float64
}

func milliC(s string) float64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0
	}
	return n / 1000
}

func parseTempMeta(l string) (tempMeta, bool) {
	p := strings.Split(l, "\t")
	if len(p) < 6 || !strings.HasPrefix(p[0], "/sys/") {
		return tempMeta{}, false
	}
	dash := func(s string) string {
		if s == "-" {
			return ""
		}
		return strings.TrimSpace(s)
	}
	t := tempMeta{path: p[0], chip: p[1], dev: dash(p[2]), label: dash(p[3])}
	if v := dash(p[4]); v != "" {
		t.high = milliC(v)
	}
	if v := dash(p[5]); v != "" {
		t.crit = milliC(v)
	}
	t.slow = t.chip == "drivetemp"
	return t, true
}

// parseNV: «00000000:2B:00.0, NVIDIA GeForce RTX 3060, 45»
func parseNV(l string) (nvTemp, bool) {
	p := strings.Split(l, ",")
	if len(p) < 3 {
		return nvTemp{}, false
	}
	c, err := strconv.ParseFloat(strings.TrimSpace(p[len(p)-1]), 64)
	if err != nil {
		return nvTemp{}, false
	}
	bus := strings.ToLower(strings.TrimSpace(p[0]))
	if i := strings.Index(bus, ":"); i >= 0 && len(bus) > 12 {
		bus = bus[i+1:] // 00000000:2b:00.0 → 2b:00.0 после домена
		bus = strings.TrimPrefix(bus, "0000:")
	}
	return nvTemp{bus: bus, name: strings.TrimSpace(strings.Join(p[1:len(p)-1], ",")), c: c}, true
}

var (
	boardChipRe = regexp.MustCompile(`^(nct|it8|w83|f71|f75|asus|gigabyte|sch5|dell_smm|hp_wmi|thinkpad|acpitz|pch_|lm\d|adt7|emc\d|max\d|tmp\d|smsc|mlxreg|ipmi|ibm|applesmc|nzxt)`)
	cpuLikeRe   = regexp.MustCompile(`(?i)cpu|peci|tsi|tctl|tdie|package|core`)
)

func tempKind(chip string) string {
	switch {
	case chip == "k10temp" || chip == "zenpower" || chip == "coretemp" || chip == "via_cputemp" || strings.Contains(chip, "cpu"):
		return "cpu"
	case chip == "nouveau" || chip == "amdgpu" || chip == "radeon" || chip == "xe" || chip == "i915" || chip == "nvidia":
		return "gpu"
	case chip == "jc42" || chip == "spd5118":
		return "ram"
	case chip == "drivetemp" || chip == "nvme":
		return "disk"
	case boardChipRe.MatchString(chip):
		return "board"
	}
	return "other"
}

var kindOrder = map[string]int{"cpu": 0, "gpu": 1, "ram": 2, "disk": 3, "board": 4, "other": 5}

// plausible отсекает пустые входы Super I/O (−128, 127, 0) и мусор.
func plausible(c float64) bool { return c > 0 && c < 125 }

// limit: порог из драйвера; 120 °C и выше — заглушка (у nct6683 бывает 126)
func limit(v float64) float64 {
	if v > 0 && v < 120 {
		return v
	}
	return 0
}

// updateTemps переносит датчики из кадра в состояние монитора (под m.mu).
func (m *Monitor) updateTemps(f *frame, now time.Time) {
	if f.hasTM {
		m.tmeta = f.tmeta
		keep := map[string]tempVal{}
		for _, t := range m.tmeta {
			if v, ok := m.tlast[t.path]; ok {
				keep[t.path] = v
			}
		}
		m.tlast = keep
	}
	if m.tlast == nil {
		m.tlast = map[string]tempVal{}
	}
	for p, v := range f.tvals {
		m.tlast[p] = tempVal{v, now}
	}
	if f.hasNV {
		m.nv, m.nvAt = f.nv, now
	}
}

// buildTemps собирает датчики для метрик и главные значения для истории.
func (m *Monitor) buildTemps(now time.Time) (out []TempSensor, cpu, gpu, disk, board float64) {
	iv := m.app.interval
	fresh := 5*iv + 10*time.Second
	slow := 35*iv + 30*time.Second
	seen := map[string]bool{}
	for _, t := range m.tmeta {
		// nct6683 отдаёт один и тот же вход в двух каналах — оставляем первый
		key := t.chip + "|" + t.dev + "|" + t.label
		if t.label != "" && seen[key] {
			continue
		}
		v, ok := m.tlast[t.path]
		age := fresh
		if t.slow {
			age = slow
		}
		if !ok || now.Sub(v.at) > age || !plausible(v.v) {
			continue
		}
		seen[key] = true
		out = append(out, TempSensor{Kind: tempKind(t.chip), Chip: t.chip, Label: t.label, Dev: t.dev, C: round1(v.v), High: limit(t.high), Crit: limit(t.crit)})
	}
	if now.Sub(m.nvAt) < 6*5*iv+10*time.Second {
		for _, n := range m.nv {
			if plausible(n.c) {
				out = append(out, TempSensor{Kind: "gpu", Chip: "nvidia", Label: n.name, Dev: n.bus, C: n.c})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if kindOrder[a.Kind] != kindOrder[b.Kind] {
			return kindOrder[a.Kind] < kindOrder[b.Kind]
		}
		if a.Chip != b.Chip {
			return a.Chip < b.Chip
		}
		if a.Dev != b.Dev {
			return a.Dev < b.Dev
		}
		return natLess(a.Label, b.Label)
	})
	return out, mainCPU(out), mainPer(out, "gpu", gpuMain), mainPer(out, "disk", diskMain), mainBoard(out)
}

// mainCPU: Tdie → Tctl → Package id → самый горячий датчик процессора;
// без драйвера процессора — CPU-датчик платы.
func mainCPU(ts []TempSensor) float64 {
	best := map[string]float64{}
	for _, t := range ts {
		if t.Kind != "cpu" {
			continue
		}
		key := "any"
		switch {
		case t.Label == "Tdie":
			key = "tdie"
		case t.Label == "Tctl":
			key = "tctl"
		case strings.HasPrefix(t.Label, "Package id"):
			key = "pkg"
		}
		if t.C > best[key] {
			best[key] = t.C
		}
	}
	for _, k := range []string{"tdie", "tctl", "pkg", "any"} {
		if best[k] > 0 {
			return best[k]
		}
	}
	mx := 0.0
	for _, t := range ts {
		if t.Kind == "board" && cpuLikeRe.MatchString(t.Label) && t.C > mx {
			mx = t.C
		}
	}
	return mx
}

// gpuMain: у amdgpu главный датчик — edge; junction и память горячее и скачут
func gpuMain(label string) bool {
	switch strings.ToLower(label) {
	case "junction", "mem", "hotspot", "vram":
		return false
	}
	return true
}

func diskMain(label string) bool { return label == "" || label == "Composite" }

// mainPer — самый горячий из «главных» датчиков каждого устройства.
func mainPer(ts []TempSensor, kind string, main func(string) bool) float64 {
	mx := 0.0
	for _, t := range ts {
		if t.Kind == kind && main(t.Label) && t.C > mx {
			mx = t.C
		}
	}
	if mx == 0 {
		for _, t := range ts {
			if t.Kind == kind && t.C > mx {
				mx = t.C
			}
		}
	}
	return mx
}

func mainBoard(ts []TempSensor) float64 {
	mx := 0.0
	for _, t := range ts {
		if t.Kind == "board" && !cpuLikeRe.MatchString(t.Label) && t.C > mx {
			mx = t.C
		}
	}
	return mx
}

func natLess(a, b string) bool {
	na, ea := trailingNum(a)
	nb, eb := trailingNum(b)
	if ea && eb && strings.TrimRight(a, "0123456789") == strings.TrimRight(b, "0123456789") {
		return na < nb
	}
	return a < b
}

func trailingNum(s string) (int, bool) {
	i := len(s)
	for i > 0 && s[i-1] >= '0' && s[i-1] <= '9' {
		i--
	}
	if i == len(s) {
		return 0, false
	}
	n, err := strconv.Atoi(s[i:])
	return n, err == nil
}

// ---------- драйверы датчиков ----------

// HWSensors — что можно включить, чтобы появились температуры дисков и платы.
type HWSensors struct {
	Root     bool     `json:"root"`               // root или sudo без пароля
	SATA     bool     `json:"sata"`               // есть SATA/SAS-диски
	Drives   bool     `json:"drives"`             // drivetemp загружен
	Board    bool     `json:"board"`              // есть датчики платы
	RAM      bool     `json:"ram"`                // есть датчики памяти
	Missing  []string `json:"missing,omitempty"`  // драйверы, которые стоит попробовать
	Panel    []string `json:"panel,omitempty"`    // включены панелью (modules-load.d)
	Chips    []string `json:"chips,omitempty"`    // все чипы hwmon
	PanelCfg bool     `json:"panelCfg,omitempty"` // есть файл панели
}

const sensorsConf = "/etc/modules-load.d/method-panel-sensors.conf"

// superIOMods — драйверы микросхем мониторинга материнских плат (Super I/O).
var superIOMods = []string{"nct6683", "nct6775", "it87", "w83627ehf", "f71882fg"}

const sensSection = `echo @@SENS
for m in drivetemp nct6683 nct6775 it87 w83627ehf f71882fg; do
  modinfo -n $m >/dev/null 2>&1 && echo "mod $m $(grep -c "^$m " /proc/modules)"
done
echo "sata $(ls /sys/class/scsi_disk 2>/dev/null | wc -l)"
[ -f ` + sensorsConf + ` ] && echo "conf $(grep -v '^#' ` + sensorsConf + ` | tr '\n' ' ')"
if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then echo "root 1"; fi
for h in /sys/class/hwmon/hwmon*; do [ -r "$h/name" ] && echo "chip $(cat "$h/name")"; done
:
`

func parseSensors(lines []string, virt bool) HWSensors {
	var s HWSensors
	avail, loaded := map[string]bool{}, map[string]bool{}
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) < 1 {
			continue
		}
		switch f[0] {
		case "mod":
			if len(f) == 3 {
				avail[f[1]] = true
				loaded[f[1]] = f[2] != "0"
			}
		case "sata":
			s.SATA = len(f) > 1 && f[1] != "0"
		case "conf":
			s.PanelCfg = true
			s.Panel = f[1:]
		case "root":
			s.Root = true
		case "chip":
			if len(f) > 1 {
				s.Chips = append(s.Chips, f[1])
				switch tempKind(f[1]) {
				case "board":
					s.Board = true
				case "ram":
					s.RAM = true
				}
				if f[1] == "drivetemp" {
					s.Drives = true
				}
			}
		}
	}
	if virt {
		return s
	}
	if s.SATA && !s.Drives && avail["drivetemp"] {
		s.Missing = append(s.Missing, "drivetemp")
	}
	if !s.Board {
		for _, m := range superIOMods {
			if avail[m] && !loaded[m] {
				s.Missing = append(s.Missing, m)
			}
		}
	}
	return s
}

const sensorsEnableScript = `CONF=` + sensorsConf + `
keep=
loaded() { grep -q "^$1 " /proc/modules; }
if [ "$(ls /sys/class/scsi_disk 2>/dev/null | wc -l)" -gt 0 ] && modinfo -n drivetemp >/dev/null 2>&1 && ! grep -qx drivetemp /sys/class/hwmon/*/name 2>/dev/null; then
  was=0; loaded drivetemp && was=1
  if modprobe drivetemp 2>/dev/null && grep -qx drivetemp /sys/class/hwmon/*/name 2>/dev/null; then keep="$keep drivetemp"
  elif [ $was = 0 ]; then modprobe -r drivetemp 2>/dev/null; fi
fi
if ! grep -qE '^(nct|it8|w83|f71|f75|asus|gigabyte|sch5|dell_smm)' /sys/class/hwmon/*/name 2>/dev/null; then
  for m in nct6683 nct6775 it87 w83627ehf f71882fg; do
    modinfo -n $m >/dev/null 2>&1 || continue
    was=0; loaded $m && was=1
    if modprobe $m 2>/dev/null && ls /sys/bus/platform/drivers/$m 2>/dev/null | grep -q '\.'; then keep="$keep $m"; break; fi
    [ $was = 0 ] && modprobe -r $m 2>/dev/null
  done
fi
if [ -n "$keep" ]; then
  old=$(grep -v '^#' "$CONF" 2>/dev/null)
  { echo "# Датчики температуры — добавлено Method Network Panel"; for m in $old $keep; do echo "$m"; done | sort -u; } > "$CONF" || exit 1
fi
echo "@@KEEP$keep"
`

const sensorsDisableScript = `CONF=` + sensorsConf + `
mods=$(grep -v '^#' "$CONF" 2>/dev/null)
rm -f "$CONF" || exit 1
for m in $mods; do
  case $m in *[!a-z0-9_]*) continue ;; esac
  modprobe -r "$m" 2>/dev/null
done
echo "@@OFF $mods"
`

// handleSensors включает или отключает драйверы датчиков (нужен root).
func (a *App) handleSensors(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var req struct {
		Action string `json:"action"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	script := ""
	switch req.Action {
	case "enable":
		script = sensorsEnableScript
	case "disable":
		script = sensorsDisableScript
	default:
		writeErr(w, 400, "неизвестное действие")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	in := m.ensureInfo(ctx)
	if in == nil {
		writeErr(w, 502, "сервер недоступен")
		return
	}
	if in.UID != 0 && !in.Sudo {
		writeErr(w, 403, "нужен root или sudo без пароля")
		return
	}
	srv := m.server()
	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", script, true, 16<<10)
	out := res.Stdout
	switch {
	case strings.Contains(out, "@@KEEP"):
		_, rest, _ := strings.Cut(out, "@@KEEP")
		mods := strings.Fields(strings.SplitN(rest, "\n", 2)[0])
		writeJSON(w, 200, map[string]any{"ok": true, "modules": mods})
	case strings.Contains(out, "@@OFF"):
		writeJSON(w, 200, map[string]any{"ok": true})
	default:
		msg := strings.TrimSpace(out)
		if msg == "" {
			msg = res.errText()
		}
		writeErr(w, 500, "не получилось: "+lastLines(msg, 4))
	}
}
