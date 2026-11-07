#!/bin/bash
# Панель Method Network для macOS (и Linux).
#   двойной клик в Finder         — открыть панель в браузере
#   ./ServerPanel.command autostart    — запускать панель в фоне при входе в систему (macOS)
#   ./ServerPanel.command noautostart  — убрать из автозапуска
# Если панель уже работает, просто открывает её; иначе собирает при необходимости
# и запускает в этом окне Терминала (остановить — Ctrl+C).
cd "$(dirname "$0")" || exit 1
DIR="$PWD"
LABEL="local.server-panel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

build() {
  if [ ! -x ./server-panel ] || [ -n "$(find . \( -name '*.go' -o -path './web/*' \) -newer ./server-panel | head -1)" ]; then
    echo "Сборка…"
    go build -trimpath -o server-panel . || { echo "Не удалось собрать (нужен Go: https://go.dev/dl/ или brew install go)"; read -r; exit 1; }
  fi
}

case "$1" in
  autostart)
    [ "$(uname)" = Darwin ] || { echo "Только для macOS. В Linux — см. README (systemd --user)."; exit 1; }
    build
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.server-panel"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array><string>$DIR/server-panel</string><string>-no-open</string></array>
	<key>WorkingDirectory</key><string>$DIR</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>15</integer>
	<key>ProcessType</key><string>Background</string>
	<key>StandardOutPath</key><string>$HOME/.server-panel/panel.log</string>
	<key>StandardErrorPath</key><string>$HOME/.server-panel/panel.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Автозапуск включён: http://127.0.0.1:7780/ (лог — ~/.server-panel/panel.log)"
    exit $?
    ;;
  noautostart)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$PLIST" && echo "Автозапуск выключен."
    exit 0
    ;;
esac

URL="http://127.0.0.1:7780/"
if curl -s -o /dev/null --max-time 2 "$URL"; then
  if command -v open >/dev/null; then open "$URL"; else xdg-open "$URL" >/dev/null 2>&1 & fi
  exit 0
fi
build
exec ./server-panel "$@"
