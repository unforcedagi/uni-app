#!/usr/bin/env bash
# T-45 walk: run the REAL debug Linux build of the Uni app inside a headless `cage` compositor (adapted from T-124's
# launch.sh). Isolated: its own app home, a test key from $KEY_FILE
# (never the owner's), no relay (a dead local URL), no hub.
# Mail goes to $UNI_MAIL_URL (the fake bridge, or the live one). Prints the cage wayland socket into $OUT/socket.
set -euo pipefail
: "${BIN:?}" "${OUT:?}" "${WALK_HOME:?}" "${KEY_FILE:?nsec file of a test key}"
NSEC=$(cat "$KEY_FILE")
mkdir -p "$OUT" "$WALK_HOME/data/org.unforced.uni" "$WALK_HOME/config" "$WALK_HOME/cache" "$WALK_HOME/state"
printf '{"hub":"http://127.0.0.1:9","vault":"uni"}' > "$WALK_HOME/data/org.unforced.uni/vault.json"
export HOME=$WALK_HOME XDG_DATA_HOME=$WALK_HOME/data XDG_CONFIG_HOME=$WALK_HOME/config XDG_CACHE_HOME=$WALK_HOME/cache XDG_STATE_HOME=$WALK_HOME/state
export UNI_NSEC=$NSEC UNI_NO_KEYRING=1 UNI_PAIR_NO_UNLOCK=1 UNI_RELAY_URL=ws://127.0.0.1:9
export UNI_T76_DIR=$OUT UNI_T76_INIT=${UNI_T76_INIT:?driver}
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=wayland
unset WAYLAND_DISPLAY DISPLAY HYPRLAND_INSTANCE_SIGNATURE
RT=/run/user/$(id -u)
BEFORE=$(ls "$RT" | grep -E '^wayland-[0-9]+$' || true)
timeout "${WALK_TIMEOUT:-180}" cage -s -- "$BIN" > "$OUT/app.log" 2>&1 &
APP=$!
echo $APP > "$OUT/pid"
for _ in $(seq 1 50); do
  NEW=$(comm -13 <(echo "$BEFORE" | sort) <(ls "$RT" | grep -E '^wayland-[0-9]+$' | sort) | head -1 || true)
  [ -n "${NEW:-}" ] && break; sleep 0.2
done
echo "${NEW:-}" > "$OUT/socket"
wait $APP || true
