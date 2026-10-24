# T-207: the post-publish checks, sourced by publish.sh and tested by scripts/test_release_check.py with a stub gh.
# GitHub caches releases/latest for a while after a release, so 0.1.56 failed its check after publishing and skipped
# the device installs; the next tick then saw the tag and never retried them. The release is read by its tag, and
# every check is retried with backoff.

# retry TRIES DELAY CMD...: run CMD until it succeeds, at most TRIES times, waiting DELAY seconds, then twice as long
# each time.
retry() {
  local tries=$1 delay=$2 n
  shift 2
  for ((n = 1; ; n++)); do
    "$@" && return 0
    ((n < tries)) || return 1
    echo "$1 failed (try $n of $tries); again in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
}

# manifest_version: the "version" of the JSON manifest on stdin; nothing for anything else.
manifest_version() { python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])' 2>/dev/null; }

# release_serves REPO TAG VERSION: the release tagged TAG has a latest.json for VERSION.
release_serves() {
  local json
  json="$(gh release download "$2" --repo "$1" --pattern latest.json --output -)" || return 1
  [[ $(manifest_version <<<"$json") == "$3" ]]
}

# release_is_latest REPO VERSION: the address installed apps poll for updates serves VERSION.
release_is_latest() {
  local json
  json="$(curl -fsSL "https://github.com/$1/releases/latest/download/latest.json")" || return 1
  [[ $(manifest_version <<<"$json") == "$2" ]]
}
