package main

// Сторож: маленький скрипт на самом сервере, который раз в минуту (таймер
// systemd) проверяет VPN-службы, упавшие службы, место на дисках, перегрев и
// перезагрузки и сам пишет в Telegram. Работает, даже когда панель выключена
// или компьютер спит. Упавшие VPN-службы (по желанию — и другие) он
// перезапускает сам, не чаще трёх раз в час.
//
// Пороги — те же, что в «Оповещениях» панели. Пока на сервере стоит сторож,
// панель не дублирует его события в Telegram (см. Alerts.deliver), но
// по-прежнему сообщает, что сервер недоступен: этого сторож сказать не может.
//
// На сервере:
//   /etc/server-panel-watchdog/watchdog.sh    скрипт (0700, root)
//   /etc/server-panel-watchdog/watchdog.conf  настройки и токен бота (0600, root)
//   /var/lib/server-panel-watchdog/           состояние, очередь неотправленного
//   /etc/systemd/system/server-panel-watchdog.{service,timer}
// Имя без «method-panel-»: так задания «Расписания» его не видят.
//
// Чужое не трогаем: в каждом файле сторожа и в его каталогах есть метка
// watchdogMark. Если на сервере уже лежит файл или юнит с тем же именем, но
// без метки, панель не ставит, не обновляет и не удаляет сторожа (@@FOREIGN).

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const watchdogVer = 1

// watchdogMark — метка файлов сторожа: по ней панель отличает своё от чужого.
const watchdogMark = "server-panel:watchdog"

// watchdogPrelude — общее начало скриптов установки, состояния и удаления:
// пути и проверка, что под этими именами на сервере нет чужих файлов.
const watchdogPrelude = `export LC_ALL=C
N=server-panel-watchdog
U=/etc/systemd/system/$N
E=/etc/$N
V=/var/lib/$N
ours() { grep -qs '` + watchdogMark + `' "$1"; }
# foreign печатает первый чужой файл с именем сторожа, если он есть
foreign() {
  for f in "$U.service" "$U.timer" "$E/watchdog.sh"; do
    if [ -e "$f" ] || [ -L "$f" ]; then ours "$f" || { echo "$f"; return 0; }; fi
  done
  if command -v systemctl >/dev/null 2>&1; then
    for u in $N.service $N.timer; do
      p=$(systemctl show -p FragmentPath --value "$u" 2>/dev/null)
      [ -n "$p" ] && [ -e "$p" ] && ! ours "$p" && { echo "$p"; return 0; }
    done
  fi
  for d in "$E" "$V"; do
    if [ -e "$d" ] && ! ours "$d/.owner"; then
      [ -d "$d" ] && [ -z "$(ls -A "$d" 2>/dev/null)" ] && continue
      echo "$d"; return 0
    fi
  done
  return 1
}
`

const watchdogScript = `#!/bin/sh
# ` + watchdogMark + `
# Сторож Method Network: раз в минуту проверяет сервер и пишет в Telegram.
# Поставлен панелью Method Network (Оповещения → Сторож на серверах) и
# работает сам, даже когда панель выключена. Удалить — в панели или вручную:
#   systemctl disable --now server-panel-watchdog.timer
#   rm -rf /etc/server-panel-watchdog /var/lib/server-panel-watchdog \
#     /etc/systemd/system/server-panel-watchdog.timer /etc/systemd/system/server-panel-watchdog.service
#   systemctl daemon-reload
# Запуск руками: watchdog.sh [run|dry|test] — dry печатает сообщения вместо отправки.
VER=@@VER@@
CONF=${WD_CONF:-/etc/server-panel-watchdog/watchdog.conf}
ST=${WD_STATE:-/var/lib/server-panel-watchdog}
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
NAME=$(cat /proc/sys/kernel/hostname 2>/dev/null); TG_TOKEN=; TG_CHAT=; TG_API=https://api.telegram.org; TZ_USER=UTC0; MUTE=0
DISK_PCT=0; FAILED=0; VPN_WAIT=-1; TEMP_WAIT=-1; REBOOT=0; RECOVERY=1
RESTART_VPN=0; RESTART_OTHER=0; RESTART_MAX=3; VPN_RE=vpn; CONF_ID=
[ -r "$CONF" ] || { echo "нет $CONF" >&2; exit 1; }
. "$CONF"
MODE=${1:-run}
SD=$ST/s; RD=$ST/r; QD=$ST/q
mkdir -p "$SD" "$RD" "$QD" || exit 1
exec 9>"$ST/lock"
if command -v flock >/dev/null 2>&1; then flock -w 120 9 || exit 0; fi
NOW=$(date +%s)
SC=$(command -v systemctl 2>/dev/null)
MSG=
SEEN=' '
RAN=' '

line() { MSG="$MSG$1
"; }
fid() { printf '%s' "$1" | cksum | cut -d' ' -f1; }
ago() {
  s=$1
  if [ "$s" -lt 90 ]; then echo "$s с"
  elif [ "$s" -lt 5400 ]; then echo "$(( (s + 30) / 60 )) мин"
  elif [ "$s" -lt 172800 ]; then
    m=$(( s % 3600 / 60 ))
    if [ "$m" -gt 0 ]; then echo "$((s / 3600)) ч $m мин"; else echo "$((s / 3600)) ч"; fi
  else echo "$((s / 86400)) д"; fi
}
hm() { TZ="$TZ_USER" date -d "@$1" +%H:%M 2>/dev/null || TZ="$TZ_USER" date +%H:%M; }
state_ru() {
  case "$1" in
    failed) echo ошибка ;;
    inactive) echo остановлена ;;
    deactivating) echo останавливается ;;
    *) echo "$1/$2" ;;
  esac
}

# Состояние условия — файл в $SD: «ключ|с какого времени|сообщили ли|текст».
st_get() {
  since=$NOW; fired=0
  f=$SD/$(fid "$1")
  [ -f "$f" ] || return 1
  IFS='|' read -r _k since fired _t < "$f" || true
  case "$since" in ''|*[!0-9]*) since=$NOW ;; esac
  return 0
}
st_put() { i=$(fid "$1"); printf '%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" > "$SD/$i"; SEEN="$SEEN$i "; }
st_del() { rm -f "$SD/$(fid "$1")"; }

# cond <ключ> <ждать, с> <текст> — условие выполняется сейчас
cond() {
  st_get "$1"
  if [ "$fired" != 1 ] && [ $((NOW - since)) -ge "$2" ]; then fired=1; line "🔴 $3"; fi
  st_put "$1" "$since" "$fired" "$3"
}

# Перезапуск: не чаще раза в 10 минут и не больше RESTART_MAX раз в час.
can_restart() {
  rf=$RD/$(fid "$1"); n=0; last=0
  if [ -f "$rf" ]; then
    awk -v t=$((NOW - 3600)) '$1 > t' "$rf" > "$rf.n" && mv "$rf.n" "$rf"
    n=$(wc -l < "$rf" | tr -d ' ')
    last=$(tail -n 1 "$rf"); [ -n "$last" ] || last=0
  fi
  [ "$n" -lt "$RESTART_MAX" ] && [ $((NOW - last)) -ge 600 ]
}
restart_unit() {
  echo "$NOW" >> "$RD/$(fid "$1")"
  timeout 90 "$SC" restart "$1" >/dev/null 2>&1
  sleep 5
  [ "$("$SC" is-active "$1" 2>/dev/null)" = active ]
}

# unit_bad <вид> <служба> <ждать, с> <что> <состояние> <перезапускать: 0|1>
unit_bad() {
  key="$1:$2"; short=${2%.service}
  st_get "$key"
  text="$4 $short не работает ($5)"
  if [ "$fired" != 1 ]; then
    if [ $((NOW - since)) -lt "$3" ]; then st_put "$key" "$since" 0 "$text"; return; fi
    if [ "$6" = 1 ] && can_restart "$2"; then
      if restart_unit "$2"; then line "🔁 $4 $short упала ($5) — перезапустил, работает"; st_del "$key"; return; fi
      text="$text, перезапуск не помог"
    fi
    line "🔴 $text"
    st_put "$key" "$since" 1 "$text"
    return
  fi
  if [ "$6" = 1 ] && can_restart "$2" && restart_unit "$2"; then
    line "🟢 $4 $short снова работает — помог повторный перезапуск (не работала $(ago $((NOW - since))))"
    st_del "$key"; return
  fi
  st_put "$key" "$since" 1 "$text"
}

show() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

check_vpn() {
  RAN="${RAN}vpn "
  sf=$ST/vpn-seen; touch "$sf"
  "$SC" list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null |
    awk -v re="$VPN_RE" 'tolower($1) ~ re && $3 == "active" {print $1}' > "$ST/vpn-now"
  sort -u "$sf" "$ST/vpn-now" > "$sf.all"
  : > "$sf.n"
  while read -r u; do
    [ -n "$u" ] || continue
    inf=$("$SC" show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result "$u" 2>/dev/null)
    ld=$(show "$inf" LoadState); a=$(show "$inf" ActiveState); s=$(show "$inf" SubState)
    uf=$(show "$inf" UnitFileState); res=$(show "$inf" Result)
    case "$ld" in ''|not-found) continue ;; esac
    case "$uf" in disabled|masked) [ "$a" = active ] || continue ;; esac
    echo "$u" >> "$sf.n"
    case "$a" in active|activating|reloading) continue ;; esac
    rs=0
    if [ "$RESTART_VPN" = 1 ]; then
      case "$a" in failed) rs=1 ;; inactive) [ "$res" = success ] || rs=1 ;; esac
    fi
    unit_bad vpn "$u" "$VPN_WAIT" "VPN-служба" "$(state_ru "$a" "$s")" "$rs"
  done < "$sf.all"
  mv "$sf.n" "$sf"; rm -f "$sf.all"
}

check_failed() {
  RAN="${RAN}failed "
  "$SC" list-units --state=failed --type=service --no-legend --no-pager --plain 2>/dev/null |
    awk -v re="$VPN_RE" '$1 ~ /\.service$/ && !(tolower($1) ~ re) {print $1}' > "$ST/failed-now"
  while read -r u; do
    [ -n "$u" ] || continue
    rs=0
    if [ "$RESTART_OTHER" = 1 ]; then
      t=$(show "$("$SC" show -p Type "$u" 2>/dev/null)" Type)
      [ "$t" = oneshot ] || rs=1
    fi
    unit_bad failed "$u" 50 "служба" "ошибка" "$rs"
  done < "$ST/failed-now"
}

check_disk() {
  RAN="${RAN}disk "
  df -kP 2>/dev/null | awk 'NR > 1 && NF >= 6 {
      m = $6; for (i = 7; i <= NF; i++) m = m " " $i; d = $1
      if (m != "/") {
        if (m ~ /^\/(snap|run|sys|proc|dev)(\/|$)/ || m ~ /^\/var\/lib\/docker(\/|$)/) next
        if (d ~ /^\/dev\/loop/) next
        if (!(d ~ /^\/dev\// || d ~ /:\// || d ~ /^\/\//)) next
      }
      if (seen[d]++) next
      if ($3 + $4 > 0) printf "%d %s\n", int($3 * 100 / ($3 + $4) + 0.5), m
    }' > "$ST/df-now"
  while read -r p m; do
    [ -n "$m" ] || continue
    st_get "disk:$m"; thr=$DISK_PCT
    [ "$fired" = 1 ] && thr=$((DISK_PCT - 1))
    [ "$p" -ge "$thr" ] && cond "disk:$m" 0 "диск $m заполнен на $p %"
  done < "$ST/df-now"
}

# Самый показательный датчик микросхемы: «температура порог» в °C.
chip_temp() {
  for f in "$1"/temp*_input; do
    [ -r "$f" ] || continue
    b=${f%_input}
    v=$(cat "$f" 2>/dev/null) || continue
    l=$(cat "${b}_label" 2>/dev/null | tr ' ' '_')
    c=$(cat "${b}_crit" 2>/dev/null)
    echo "${l:--} ${v:-0} ${c:-0}"
  done | awk -v k="$2" '
    { l = $1; v = $2 / 1000; c = $3 / 1000
      if (v <= 0 || v >= 125) next
      if (k == "cpu") p = (l == "Tdie") ? 4 : (l == "Tctl") ? 3 : (l ~ /^Package_id/) ? 2 : 1
      else if (k == "gpu") { ll = tolower(l); p = (ll == "junction" || ll == "mem" || ll == "hotspot" || ll == "vram") ? 0 : 1 }
      else p = (l == "-" || l == "Composite") ? 2 : 1
      if (!n++ || p > bp || (p == bp && v > bv)) { bp = p; bv = v; bc = (c > 0 && c < 120) ? c : 0 } }
    END { if (n) printf "%.0f %.0f\n", bv, bc }'
}

check_temp() {
  RAN="${RAN}temp "
  disks=0
  # диски — раз в 15 минут: каждое чтение — команда диску
  at=$(cat "$ST/dt-at" 2>/dev/null); [ -n "$at" ] || at=0
  if [ $((NOW - at)) -ge 840 ]; then disks=1; RAN="${RAN}tdisk "; echo "$NOW" > "$ST/dt-at"; fi
  for h in /sys/class/hwmon/hwmon*; do
    [ -r "$h/name" ] || continue
    dev=
    case "$(cat "$h/name")" in
      k10temp|zenpower|coretemp|via_cputemp) k=cpu; who=процессор; key="temp:cpu:${h##*/}"; d=95 ;;
      amdgpu|radeon|nouveau|i915|xe) k=gpu; who=видеокарта; key="temp:gpu:${h##*/}"; d=95 ;;
      drivetemp|nvme)
        [ "$disks" = 1 ] || continue
        k=disk; d=80
        dev=$(ls "$h/device/block" 2>/dev/null | head -n 1)
        [ -n "$dev" ] || dev=$(basename "$(readlink -f "$h/device")")
        case "$dev" in sd*)
          [ "$(cat "/sys/block/$dev/queue/rotational" 2>/dev/null)" = 1 ] && d=60
          # спящий HDD не будим: hdparm -C его не трогает
          if command -v hdparm >/dev/null 2>&1 && hdparm -C "/dev/$dev" 2>/dev/null | grep -q standby; then
            st_get "tdisk:$dev" && SEEN="$SEEN$(fid "tdisk:$dev") "
            [ -n "${WD_DEBUG:-}" ] && echo "датчик tdisk:$dev: диск спит, не трогаю" >&2
            continue
          fi ;;
        esac
        who="диск $dev"; key="tdisk:$dev" ;;
      *) continue ;;
    esac
    set -- $(chip_temp "$h" "$k")
    [ -n "$1" ] || continue
    t=$1; c=$2
    [ "$c" -gt 0 ] || c=$d
    st_get "$key"; thr=$c
    [ "$fired" = 1 ] && thr=$((c - 3))
    w=$TEMP_WAIT; [ "$k" = disk ] && w=0
    [ -n "${WD_DEBUG:-}" ] && echo "датчик $key: $t °C, порог $thr °C" >&2
    [ "$t" -ge "$thr" ] && cond "$key" "$w" "перегрев: $who $t °C (порог $c °C)"
  done
}

check_reboot() {
  b=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
  [ -n "$b" ] || return
  old=$(cat "$ST/boot" 2>/dev/null)
  if [ -n "$old" ] && [ "$old" != "$b" ]; then
    up=$(cut -d. -f1 /proc/uptime)
    line "🔄 сервер перезагрузился $(ago "$up") назад"
  fi
  echo "$b" > "$ST/boot"
}

# То, что больше не выполняется, — «в норме».
recover() {
  for f in "$SD"/*; do
    [ -f "$f" ] || continue
    id=${f##*/}
    case "$SEEN" in *" $id "*) continue ;; esac
    IFS='|' read -r k since fired _t < "$f" || continue
    kind=${k%%:*}
    case "$RAN" in *" $kind "*) ;; *) continue ;; esac
    rm -f "$f"
    [ "$fired" = 1 ] && [ "$RECOVERY" = 1 ] || continue
    sub=${k#*:}
    case "$since" in ''|*[!0-9]*) since=$NOW ;; esac
    d=$(ago $((NOW - since)))
    case "$kind" in
      vpn) line "🟢 VPN-служба ${sub%.service} снова работает (не работала $d)" ;;
      failed) line "🟢 служба ${sub%.service} больше не в ошибке" ;;
      disk) line "🟢 на диске $sub снова есть место" ;;
      temp) case "$sub" in cpu:*) line "🟢 процессор остыл" ;; *) line "🟢 видеокарта остыла" ;; esac ;;
      tdisk) line "🟢 диск $sub остыл" ;;
    esac
  done
}

tg() {
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || { echo "не задан Telegram" > "$ST/err"; return 1; }
  command -v curl >/dev/null 2>&1 || { echo "на сервере нет curl" > "$ST/err"; return 1; }
  # токен — через stdin (-K -), а не в аргументах: их видно в списке процессов
  r=$(printf 'url = "%s/bot%s/sendMessage"\n' "$TG_API" "$TG_TOKEN" |
    curl -sS -m 20 -K - --data-urlencode "chat_id=$TG_CHAT" --data-urlencode "text=$1" -d disable_web_page_preview=true 2>&1)
  case "$r" in *'"ok":true'*) rm -f "$ST/err"; echo "$NOW" > "$ST/sent"; return 0 ;; esac
  e=$(printf '%s' "$r" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$e" ] || e=$(printf '%s' "$r" | head -n 1 | cut -c1-200)
  printf '%s\n' "${e:-нет ответа}" > "$ST/err"
  return 1
}

flush() {
  for q in $(ls "$QD" 2>/dev/null | sort -n); do
    f=$QD/$q
    t=$(head -n 1 "$f"); body=$(tail -n +2 "$f")
    case "$t" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
    hdr="🛡 $NAME"
    [ $((NOW - t)) -ge 180 ] && hdr="$hdr · $(hm "$t"), сообщение задержалось"
    tg "$hdr
$body" || break
    rm -f "$f"
  done
  n=$(ls "$QD" | wc -l | tr -d ' ')
  if [ "$n" -gt 50 ]; then ls "$QD" | sort -n | head -n $((n - 50)) | while read -r x; do rm -f "$QD/$x"; done; fi
}

status() {
  {
    echo "ver=$VER"; echo "conf=$CONF_ID"; echo "run=$NOW"
    echo "queue=$(ls "$QD" | wc -l | tr -d ' ')"
    echo "sent=$(cat "$ST/sent" 2>/dev/null)"
    echo "err=$(cat "$ST/err" 2>/dev/null)"
    for f in "$SD"/*; do
      [ -f "$f" ] || continue
      IFS='|' read -r _k s fd t < "$f" || continue
      [ "$fd" = 1 ] && echo "firing=$s|$t"
    done
  } > "$ST/status.n" && mv "$ST/status.n" "$ST/status"
}

if [ "$MODE" = test ]; then
  what=
  [ "$VPN_WAIT" -ge 0 ] && what="$what, VPN-службы"
  [ "$FAILED" = 1 ] && what="$what, службы с ошибкой"
  [ "$DISK_PCT" -gt 0 ] && what="$what, место на дисках (порог $DISK_PCT %)"
  [ "$TEMP_WAIT" -ge 0 ] && what="$what, перегрев"
  [ "$REBOOT" = 1 ] && what="$what, перезагрузки"
  what=${what#, }
  rs="Сам ничего не перезапускаю — только сообщаю."
  [ "$RESTART_VPN" = 1 ] && rs="Упавшие VPN-службы перезапускаю сам."
  [ "$RESTART_VPN" = 1 ] && [ "$RESTART_OTHER" = 1 ] && rs="Упавшие службы перезапускаю сам."
  [ "$RESTART_VPN" != 1 ] && [ "$RESTART_OTHER" = 1 ] && rs="Упавшие службы, кроме VPN, перезапускаю сам."
  if tg "🛡 $NAME
Сторож на связи. Раз в минуту проверяю: ${what:-ничего не включено}. Если что-то случится — напишу сюда, даже когда панель выключена.
$rs"; then echo @@SENT; else echo "@@ERR $(cat "$ST/err" 2>/dev/null)"; fi
  exit 0
fi

if [ -n "$SC" ]; then
  [ "$VPN_WAIT" -ge 0 ] && check_vpn
  [ "$FAILED" = 1 ] && check_failed
fi
[ "$DISK_PCT" -gt 0 ] && check_disk
[ "$TEMP_WAIT" -ge 0 ] && check_temp
[ "$REBOOT" = 1 ] && check_reboot
recover

if [ "$MODE" = dry ]; then
  printf '%s' "$MSG"
elif [ -n "$MSG" ] && [ "$MUTE" != 1 ] && [ -n "$TG_TOKEN" ]; then
  printf '%s\n%s' "$NOW" "$MSG" > "$QD/$NOW-$$"
fi
[ "$MODE" = dry ] || flush
status
`

const watchdogService = `# ` + watchdogMark + `
# Создано панелью Method Network: сторож сервера.
[Unit]
Description=Method Network: сторож сервера
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/sh /etc/server-panel-watchdog/watchdog.sh
TimeoutStartSec=10min
Nice=10
# каждая минута иначе оставляла бы в журнале «Starting…/Finished…»
LogLevelMax=notice
`

const watchdogTimer = `# ` + watchdogMark + `
# Создано панелью Method Network: сторож сервера, раз в минуту.
[Unit]
Description=Method Network: сторож сервера, раз в минуту

[Timer]
OnActiveSec=10s
OnBootSec=1min
OnUnitInactiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
`

const watchdogStatusScript = watchdogPrelude + `command -v systemctl >/dev/null 2>&1 && echo systemd=1
command -v curl >/dev/null 2>&1 && echo curl=1
if f=$(foreign); then
  echo "foreign=$f"
elif [ -f "$U.timer" ]; then
  echo installed=1
  echo "active=$(systemctl is-active $N.timer 2>/dev/null)"
  cat "$V/status" 2>/dev/null
  # версия и настройки — из самих файлов: так они верны и до первой проверки
  sed -n 's/^VER=\([0-9]*\)$/ver=\1/p' "$E/watchdog.sh" 2>/dev/null | head -n 1
  sed -n 's/^CONF_ID=\([0-9a-f]*\)$/conf=\1/p' "$E/watchdog.conf" 2>/dev/null | head -n 1
fi
echo "now=$(date +%s)"
`

// Удаляет только своё: если под именем сторожа лежит чужой файл — ничего.
const watchdogRemoveScript = watchdogPrelude + `if f=$(foreign); then echo "@@FOREIGN $f"; exit 0; fi
SC=$(command -v systemctl)
if [ -n "$SC" ]; then
  $SC disable --now $N.timer >/dev/null 2>&1
  $SC stop $N.service >/dev/null 2>&1
fi
rm -f "$U.timer" "$U.service"
rm -rf "$E" "$V"
[ -n "$SC" ] && $SC daemon-reload
echo @@OK
`

// Проверочное сообщение — только если там действительно скрипт панели.
const watchdogTestScript = watchdogPrelude + `ours "$E/watchdog.sh" || { echo "@@ERR сторожа панели на сервере нет"; exit 0; }
sh "$E/watchdog.sh" test
`

// WatchCfg — что сторож делает сам, кроме сообщений.
type WatchCfg struct {
	RestartVPN   *bool `json:"restartVpn,omitempty"` // nil — да (по умолчанию)
	RestartOther bool  `json:"restartOther"`
}

func (w WatchCfg) restartVPN() bool { return w.RestartVPN == nil || *w.RestartVPN }

// posixTZ — часовой пояс этого компьютера для date на сервере («<+0300>-3»):
// время в задержавшихся сообщениях — по часам пользователя.
func posixTZ() string {
	_, off := time.Now().Zone()
	sign, inv := "+", "-"
	if off < 0 {
		sign, inv, off = "-", "+", -off
	}
	h, m := off/3600, off%3600/60
	if m == 0 {
		return fmt.Sprintf("<%s%02d%02d>%s%d", sign, h, m, inv, h)
	}
	return fmt.Sprintf("<%s%02d%02d>%s%d:%02d", sign, h, m, inv, h, m)
}

// watchdogConf — настройки сторожа для сервера и их отпечаток: по нему панель
// понимает, что на сервере устаревшие настройки.
func (a *App) watchdogConf(srv Server) (conf, id string) {
	cfg := a.alertConfig()
	r := cfg.Rules
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	wait := func(x Rule) int {
		if !x.On {
			return -1
		}
		return int(math.Round(x.Min * 60))
	}
	disk := 0
	if r.Disk.On {
		disk = int(math.Round(r.Disk.Pct))
	}
	token, chat := "", ""
	if cfg.Channels.Telegram {
		token, chat = cfg.Channels.TGToken, cfg.Channels.TGChat
	}
	var b strings.Builder
	kv := func(k, v string) { fmt.Fprintf(&b, "%s=%s\n", k, shq(v)) }
	kv("NAME", cleanLine(srv.Name, 120))
	kv("TG_TOKEN", token)
	kv("TG_CHAT", chat)
	kv("TZ_USER", posixTZ())
	kv("MUTE", strconv.Itoa(b2i(srv.Mute)))
	kv("DISK_PCT", strconv.Itoa(disk))
	kv("FAILED", strconv.Itoa(b2i(r.Failed.On)))
	kv("VPN_WAIT", strconv.Itoa(wait(r.VPN)))
	kv("TEMP_WAIT", strconv.Itoa(wait(*r.Temp)))
	kv("REBOOT", strconv.Itoa(b2i(r.Offline.On)))
	kv("RECOVERY", strconv.Itoa(b2i(r.Recovery)))
	kv("RESTART_VPN", strconv.Itoa(b2i(cfg.Watch.restartVPN())))
	kv("RESTART_OTHER", strconv.Itoa(b2i(cfg.Watch.RestartOther)))
	kv("VPN_RE", vpnPattern)
	sum := sha256.Sum256([]byte(fmt.Sprintf("v%d\n%s", watchdogVer, b.String())))
	id = hex.EncodeToString(sum[:6])
	return "# Настройки сторожа — пишет панель Method Network, правки вручную она перезапишет.\n" + b.String() + "CONF_ID=" + id + "\n", id
}

// WatchStatus — сторож на сервере глазами панели.
type WatchStatus struct {
	Installed bool     `json:"installed"`
	Active    bool     `json:"active"`
	Stale     bool     `json:"stale"` // настройки или скрипт отличаются от нужных
	Ver       int      `json:"ver,omitempty"`
	Run       int64    `json:"run,omitempty"`  // последняя проверка, unix
	Now       int64    `json:"now,omitempty"`  // время на сервере
	Sent      int64    `json:"sent,omitempty"` // последнее отправленное сообщение
	Queue     int      `json:"queue"`
	Err       string   `json:"err,omitempty"`
	Firing    []string `json:"firing,omitempty"`
	Systemd   bool     `json:"systemd"`
	Curl      bool     `json:"curl"`
	Root      bool     `json:"root"`
	Foreign   string   `json:"foreign,omitempty"` // чужой файл с именем сторожа
}

// foreignErr — ответ на @@FOREIGN: под именем сторожа на сервере чужой файл.
func foreignErr(out string) error {
	_, f, _ := strings.Cut(out, "@@FOREIGN")
	f = strings.TrimSpace(strings.SplitN(strings.TrimSpace(f), "\n", 2)[0])
	return fmt.Errorf("на сервере уже есть чужой %s с именем сторожа — панель его не трогает, ничего не изменено", f)
}

func parseWatchStatus(out, wantConf string) WatchStatus {
	var st WatchStatus
	conf := ""
	for _, l := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(l), "=")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(v, 10, 64)
		switch k {
		case "systemd":
			st.Systemd = v == "1"
		case "curl":
			st.Curl = v == "1"
		case "installed":
			st.Installed = v == "1"
		case "active":
			st.Active = v == "active"
		case "ver":
			st.Ver = int(n)
		case "conf":
			conf = v
		case "run":
			st.Run = n
		case "now":
			st.Now = n
		case "sent":
			st.Sent = n
		case "queue":
			st.Queue = int(n)
		case "err":
			st.Err = v
		case "foreign":
			st.Foreign = v
		case "firing":
			if _, t, ok := strings.Cut(v, "|"); ok && len(st.Firing) < 20 {
				st.Firing = append(st.Firing, t)
			}
		}
	}
	st.Stale = st.Installed && (st.Ver != watchdogVer || conf != wantConf)
	return st
}

func (a *App) watchdogStatus(ctx context.Context, m *Monitor) (WatchStatus, error) {
	srv := m.server()
	in := m.ensureInfo(ctx)
	if in == nil {
		return WatchStatus{}, fmt.Errorf("сервер недоступен")
	}
	_, want := a.watchdogConf(srv)
	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", watchdogStatusScript, true, 64<<10)
	if res.Err != nil && res.Stdout == "" {
		return WatchStatus{}, fmt.Errorf("%s", res.errText())
	}
	st := parseWatchStatus(res.Stdout, want)
	st.Root = in.UID == 0 || in.Sudo
	m.setWatchdog(st.Installed)
	return st, nil
}

// watchdogInstall ставит или обновляет сторожа (скрипт, настройки, таймер).
func (a *App) watchdogInstall(ctx context.Context, m *Monitor) error {
	srv := m.server()
	in := m.ensureInfo(ctx)
	if in == nil {
		return fmt.Errorf("сервер недоступен")
	}
	if in.UID != 0 && !in.Sudo {
		return fmt.Errorf("нужен root или sudo без пароля")
	}
	conf, _ := a.watchdogConf(srv)
	script := strings.Replace(watchdogScript, "@@VER@@", strconv.Itoa(watchdogVer), 1)
	eof := "SP_EOF_" + newID(8)
	var b strings.Builder
	b.WriteString(watchdogPrelude)
	b.WriteString("umask 022\n")
	b.WriteString("SC=$(command -v systemctl) || { echo @@NOSYSTEMD; exit 0; }\n")
	b.WriteString("command -v curl >/dev/null 2>&1 || { echo @@NOCURL; exit 0; }\n")
	// чужие файлы с тем же именем — ничего не меняем
	b.WriteString("if f=$(foreign); then echo \"@@FOREIGN $f\"; exit 0; fi\n")
	b.WriteString("set -e\nmkdir -p \"$E\" \"$V\"\nchmod 700 \"$E\" \"$V\"\n")
	fmt.Fprintf(&b, "for d in \"$E\" \"$V\"; do echo '# %s' > \"$d/.owner\"; done\n", watchdogMark)
	fmt.Fprintf(&b, "cat > \"$E/watchdog.sh.n\" <<'%s'\n%s%s\n", eof, script, eof)
	b.WriteString("chmod 700 \"$E/watchdog.sh.n\"\nmv -f \"$E/watchdog.sh.n\" \"$E/watchdog.sh\"\n")
	fmt.Fprintf(&b, "(umask 077; cat > \"$E/watchdog.conf.n\" <<'%s'\n%s%s\n)\n", eof, conf, eof)
	b.WriteString("mv -f \"$E/watchdog.conf.n\" \"$E/watchdog.conf\"\n")
	fmt.Fprintf(&b, "cat > \"$U.service\" <<'%s'\n%s%s\n", eof, watchdogService, eof)
	fmt.Fprintf(&b, "cat > \"$U.timer\" <<'%s'\n%s%s\n", eof, watchdogTimer, eof)
	b.WriteString("$SC daemon-reload\nout=$($SC enable --now $N.timer 2>&1) || { echo \"$out\"; exit 1; }\necho @@OK\n")

	res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", b.String(), true, 64<<10)
	out := res.Stdout
	switch {
	case strings.Contains(out, "@@OK"):
		m.setWatchdog(true)
		return nil
	case strings.Contains(out, "@@NOSYSTEMD"):
		return fmt.Errorf("на сервере нет systemd")
	case strings.Contains(out, "@@NOCURL"):
		return fmt.Errorf("на сервере нет curl — установите его (apt install curl) и повторите")
	case strings.Contains(out, "@@FOREIGN"):
		return foreignErr(out)
	}
	msg := strings.TrimSpace(out)
	if msg == "" {
		msg = res.errText()
	}
	return fmt.Errorf("не удалось поставить сторожа: %s", lastLines(msg, 4))
}

func (a *App) handleWatchdog(w http.ResponseWriter, r *http.Request, m *Monitor) {
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	st, err := a.watchdogStatus(ctx, m)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, st)
}

func (a *App) handleWatchdogAction(w http.ResponseWriter, r *http.Request, m *Monitor) {
	var q struct {
		Action string `json:"action"` // install | remove | test
	}
	if err := readJSON(r, &q); err != nil {
		writeErr(w, 400, "неверный запрос")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	srv := m.server()
	switch q.Action {
	case "install":
		if !a.alertConfig().Channels.Telegram {
			writeErr(w, 400, "сторож пишет в Telegram — сначала подключите его в настройках оповещений")
			return
		}
		if err := a.watchdogInstall(ctx, m); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
	case "remove":
		res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", watchdogRemoveScript, true, 16<<10)
		if strings.Contains(res.Stdout, "@@FOREIGN") {
			writeErr(w, 409, foreignErr(res.Stdout).Error())
			return
		}
		if !strings.Contains(res.Stdout, "@@OK") {
			writeErr(w, 500, "не удалось убрать сторожа: "+lastLines(strings.TrimSpace(res.Stdout+" "+res.errText()), 3))
			return
		}
		m.setWatchdog(false)
	case "test":
		res := a.runSSH(ctx, &srv, m.sudo(ctx)+"sh -s", watchdogTestScript, true, 16<<10)
		out := res.Stdout
		if !strings.Contains(out, "@@SENT") {
			msg := strings.TrimSpace(strings.TrimPrefix(lastLines(strings.TrimSpace(out), 1), "@@ERR"))
			if msg == "" {
				msg = res.errText()
			}
			writeErr(w, 502, "сообщение не ушло: "+msg)
			return
		}
	default:
		writeErr(w, 400, "неизвестное действие")
		return
	}
	st, err := a.watchdogStatus(ctx, m)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	writeJSON(w, 200, st)
}

// watchdogOn — стоит ли сторож на сервере с этим id.
func (a *App) watchdogOn(id string) bool {
	a.mu.RLock()
	m := a.mons[id]
	a.mu.RUnlock()
	return m != nil && m.watchdogOn()
}

// ---------- настройки сторожей следуют за настройками панели ----------

type watchSync struct {
	mu    sync.Mutex
	timer *time.Timer
	busy  map[string]bool
}

// syncWatchdogs через несколько секунд после изменения настроек (они
// сохраняются на каждое нажатие) обновляет настройки сторожей на серверах.
func (a *App) syncWatchdogs() {
	a.wsync.mu.Lock()
	defer a.wsync.mu.Unlock()
	if a.wsync.timer != nil {
		a.wsync.timer.Stop()
	}
	a.wsync.timer = time.AfterFunc(5*time.Second, func() {
		a.mu.RLock()
		mons := make([]*Monitor, 0, len(a.mons))
		for _, m := range a.mons {
			mons = append(mons, m)
		}
		a.mu.RUnlock()
		for _, m := range mons {
			if m.watchdogOn() {
				go a.syncWatchdog(m)
			}
		}
	})
}

// syncWatchdog обновляет сторожа на одном сервере, если его настройки устарели.
func (a *App) syncWatchdog(m *Monitor) {
	id := m.server().ID
	a.wsync.mu.Lock()
	if a.wsync.busy == nil {
		a.wsync.busy = map[string]bool{}
	}
	if a.wsync.busy[id] {
		a.wsync.mu.Unlock()
		return
	}
	a.wsync.busy[id] = true
	a.wsync.mu.Unlock()
	defer func() {
		a.wsync.mu.Lock()
		delete(a.wsync.busy, id)
		a.wsync.mu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(a.ctx, 90*time.Second)
	defer cancel()
	st, err := a.watchdogStatus(ctx, m)
	if err != nil || !st.Installed || !st.Stale || !st.Root {
		return
	}
	_ = a.watchdogInstall(ctx, m)
}
