#!/bin/sh
# Preparation only, executed inside each newly allocated evaluation desktop.
set -eu
as_root() {
    if [ "$(id -u)" = 0 ]; then
        "$@"
    else
        sudo -n "$@"
    fi
}

packages=""
for app in gedit thunar xdotool; do
    if ! command -v "$app" >/dev/null 2>&1; then
        packages="$packages $app"
    fi
done
case "${1:-}" in
    T08)
        if [ "$(dpkg-query -W -f='${db:Status-Status}' libreoffice-calc 2>/dev/null || true)" != installed ]; then
            packages="$packages libreoffice-calc"
        fi
        ;;
    T11)
        for app in evince file-roller unzip; do
            if ! command -v "$app" >/dev/null 2>&1; then
                packages="$packages $app"
            fi
        done
        ;;
esac
if ! python3 -c 'import flask' >/dev/null 2>&1; then
    packages="$packages python3-flask"
fi
if ! command -v firefox >/dev/null 2>&1; then
    as_root apt-get update
    if apt-cache show firefox-esr >/dev/null 2>&1; then
        packages="$packages firefox-esr"
    else
        packages="$packages firefox"
    fi
fi
if [ -n "$packages" ]; then
    as_root apt-get update
    # Intentional word splitting: packages is a list of fixed names above.
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y $packages
fi
command -v firefox
command -v gedit
command -v thunar
command -v xdotool
python3 -c 'import flask'
# A prepared template must not contain old trial output.
test ! -e /home/user/gauntlet/out
as_root mkdir -p /home/user/gauntlet/docs /home/user/gauntlet/out
as_root chown -R user: /home/user/gauntlet
