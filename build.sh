#!/bin/sh
# Собирает панель под все поддерживаемые системы в каталог dist/.
#   ./build.sh                            — все платформы
#   ./build.sh linux/amd64 windows/amd64  — только перечисленные
#   PACK=1 ./build.sh                     — ещё и архивы для релиза + SHA256SUMS
# Нужен только Go: внешних зависимостей нет, cgo не используется.
set -eu
cd "$(dirname "$0")"

targets=${*:-"darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64"}
rm -rf dist
mkdir -p dist

# pack <os> <arch> <бинарник> — папка server-panel/ с панелью и инструкцией:
# zip для Windows, tar.gz для macOS и Linux (сохраняет право на запуск)
pack() {
  label=$1
  [ "$1" = darwin ] && label=macos
  name="server-panel-$label-$2"
  stage="dist/.stage/server-panel"
  rm -rf dist/.stage
  mkdir -p "$stage"
  cp README.md "$stage/"
  if [ "$1" = windows ]; then
    cp "$3" "$stage/server-panel.exe"
    cp start-windows.bat "$stage/"
    (cd dist/.stage && zip -qX -r "../$name.zip" server-panel)
  else
    cp "$3" "$stage/server-panel"
    chmod 755 "$stage/server-panel"
    [ "$1" = darwin ] && cp ServerPanel.command "$stage/"
    # владелец в архиве — root, без имени пользователя этого компьютера
    if tar --version 2>/dev/null | grep -q bsdtar; then
      own="--uid 0 --gid 0 --uname root --gname root --no-xattrs --no-mac-metadata"
    else
      own="--owner=0 --group=0 --numeric-owner"
    fi
    (cd dist/.stage && COPYFILE_DISABLE=1 tar $own -czf "../$name.tar.gz" server-panel)
  fi
  rm -rf dist/.stage
}

for t in $targets; do
  os=${t%/*}
  arch=${t#*/}
  out="dist/server-panel-$os-$arch"
  [ "$os" = windows ] && out="$out.exe"
  echo "→ $out"
  # -trimpath убирает из бинарника пути к исходникам на этом компьютере
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$out" .
  if [ "${PACK:-}" = 1 ]; then
    pack "$os" "$arch" "$out"
    rm -f "$out"
  fi
done

if [ "${PACK:-}" = 1 ]; then
  if command -v sha256sum >/dev/null; then sum="sha256sum"; else sum="shasum -a 256"; fi
  (cd dist && set -- $(ls -- *.zip *.tar.gz 2>/dev/null) && $sum "$@" > SHA256SUMS)
fi
echo "Готово:"
ls -1 dist
