#!/usr/bin/env bash
# uni-adb — make adb to Aaron's Android devices boring.
#
# Symlinked to ~/.local/bin/uni-adb. Named devices live in
#   ${UNI_ADB_DEVICES:-~/.config/uni/adb-devices}   (one per line: name  host  [port])
# host is normally the device's Tailscale 100.x IP or MagicDNS name.
#
#   uni-adb pair <ip:port> <code>      one-time pairing (Wireless debugging → "Pair device with pairing code")
#   uni-adb connect <name|ip:port>     connect (name uses saved host + last-known/5555 port)
#   uni-adb add <name> <host> [port]   save/update a named device
#   uni-adb list                       saved devices + what adb currently sees
#   uni-adb install [apk] [name]       install newest built APK (or given one) on the device
#   uni-adb logs [name]                follow logcat for the Uni app (RustStdoutStderr + Tauri tags)
#   uni-adb url                        print the tailnet download URL for the APK
#   uni-adb publish [apk]              copy APK to the tailnet download dir (see docs/android-devices.md)
#
# See docs/android-devices.md for the device-side steps.
set -euo pipefail

[[ -r ~/.config/uni/android.env ]] && source ~/.config/uni/android.env
ADB="${ADB:-$(command -v adb || echo "$HOME/Android/Sdk/platform-tools/adb")}"
CONF="${UNI_ADB_DEVICES:-$HOME/.config/uni/adb-devices}"
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
APP_ID="org.unforced.uni"
SERVE_DIR="${UNI_APK_DIR:-$HOME/.local/share/uni/apk}"
SERVE_URL="${UNI_APK_URL:-https://uni-1.taildf9ce2.ts.net:8443/uni.apk}"

die() { echo "uni-adb: $*" >&2; exit 1; }

ensure_conf() {
  [[ -f $CONF ]] && return
  mkdir -p "$(dirname "$CONF")"
  cat >"$CONF" <<'EOF'
# name     host (Tailscale IP or MagicDNS name)   port (optional; wireless-debugging port changes, `connect` updates it)
# Fill the host in once each device is on the tailnet:  uni-adb add pixel 100.x.y.z
pixel      -
daylight   -
EOF
}

lookup() { # name -> "host port"
  ensure_conf
  awk -v n="$1" '$1==n && $2!="-" {print $2, ($3==""?"":$3); exit}' "$CONF"
}

save() { # name host port
  ensure_conf
  local tmp; tmp=$(mktemp)
  awk -v n="$1" -v h="$2" -v p="${3:-}" '
    $1==n {print n"\t"h"\t"p; found=1; next} {print}
    END {if(!found) print n"\t"h"\t"p}' "$CONF" >"$tmp" && mv "$tmp" "$CONF"
}

serial_for() { # name|ip:port -> adb serial
  local t="$1"
  if [[ $t == *:* ]]; then echo "$t"; return; fi
  read -r host port <<<"$(lookup "$t")" || true
  [[ -n ${host:-} ]] || die "unknown device '$t' — run: uni-adb add $t <tailscale-ip>"
  echo "$host:${port:-5555}"
}

pick_serial() { # optional name -> serial; default: the only connected device
  if [[ -n ${1:-} ]]; then serial_for "$1"; return; fi
  local s; s=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
  [[ $(wc -l <<<"$s") -eq 1 && -n $s ]] || die "need a device name (connected: ${s:-none})"
  echo "$s"
}

newest_apk() {
  ls -t "$REPO"/src-tauri/gen/android/app/build/outputs/apk/*/*/*.apk 2>/dev/null | head -1
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  pair)
    [[ $# -ge 1 ]] || die "usage: uni-adb pair <ip:port> [code]"
    if [[ $# -ge 2 ]]; then "$ADB" pair "$1" "$2"; else "$ADB" pair "$1"; fi
    echo "Paired. Now: uni-adb connect <name|ip:PORT-from-main-Wireless-debugging-screen>"
    ;;
  connect)
    [[ $# -ge 1 ]] || die "usage: uni-adb connect <name|ip:port> [port]"
    target="$1"
    if [[ $target != *:* && -n ${2:-} ]]; then  # name + fresh port from the phone screen
      read -r host _ <<<"$(lookup "$target")"; [[ -n ${host:-} ]] || die "unknown device $target"
      save "$target" "$host" "$2"
    fi
    s=$(serial_for "$target")
    out=$("$ADB" connect "$s" 2>&1); echo "$out"
    grep -q "connected to" <<<"$out" || die "not connected. Check: Tailscale on, Wireless debugging on, and the PORT on the device's Wireless debugging screen (it changes). Retry: uni-adb connect $target <port>"
    ;;
  add)
    [[ $# -ge 2 ]] || die "usage: uni-adb add <name> <host> [port]"
    save "$1" "$2" "${3:-}"; echo "saved $1 → $2 ${3:-}"
    ;;
  list)
    ensure_conf
    echo "# saved ($CONF)"; grep -v '^#' "$CONF" | sed '/^\s*$/d'
    echo; echo "# adb"; "$ADB" devices -l
    ;;
  install)
    apk=""; dev=""
    for a in "$@"; do if [[ $a == *.apk ]]; then apk=$a; else dev=$a; fi; done
    apk="${apk:-$(newest_apk)}"; [[ -f $apk ]] || die "no APK found — build one: pnpm exec tauri android build --debug --apk --target aarch64"
    s=$(pick_serial "$dev")
    echo "installing $(basename "$apk") ($(du -h "$apk" | cut -f1)) → $s"
    "$ADB" -s "$s" install -r "$apk"
    "$ADB" -s "$s" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
    ;;
  logs)
    s=$(pick_serial "${1:-}")
    pid=$("$ADB" -s "$s" shell pidof "$APP_ID" 2>/dev/null || true)
    if [[ -n $pid ]]; then "$ADB" -s "$s" logcat --pid="$pid"
    else echo "(app not running; showing Rust/Tauri tags)"; "$ADB" -s "$s" logcat -s RustStdoutStderr:V Tauri:V Console:V AndroidRuntime:E; fi
    ;;
  publish)
    apk="${1:-$(newest_apk)}"; [[ -f $apk ]] || die "no APK"
    mkdir -p "$SERVE_DIR"; cp "$apk" "$SERVE_DIR/uni.apk"
    sha256sum "$SERVE_DIR/uni.apk" | cut -d' ' -f1 >"$SERVE_DIR/uni.apk.sha256"
    echo "published $(du -h "$SERVE_DIR/uni.apk" | cut -f1) → $SERVE_URL"
    ;;
  url) echo "$SERVE_URL" ;;
  help|-h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$cmd' (try: uni-adb help)" ;;
esac
