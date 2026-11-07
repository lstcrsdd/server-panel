#!/bin/sh
# Собирает панель под все поддерживаемые системы в каталог dist/.
#   ./build.sh            — все платформы
#   ./build.sh linux/amd64 windows/amd64 — только перечисленные
# Нужен только Go: внешних зависимостей нет, cgo не используется.
set -eu
cd "$(dirname "$0")"

targets=${*:-"darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64"}
mkdir -p dist
for t in $targets; do
  os=${t%/*}
  arch=${t#*/}
  out="dist/server-panel-$os-$arch"
  [ "$os" = windows ] && out="$out.exe"
  echo "→ $out"
  # -trimpath убирает из бинарника пути к исходникам на этом компьютере
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out" .
done
echo "Готово: $(ls dist | wc -l | tr -d ' ') файл(ов) в dist/"
