#!/usr/bin/env bash
# Poll origin/main; release it when that exact commit has no uni-v* tag yet.
# Wrapped in a function so bash parses the whole file before the checkout below rewrites it.
main() {
  set -euo pipefail
  export PATH="$HOME/.local/share/mise/shims:$HOME/.cargo/bin:$HOME/Android/Sdk/platform-tools:/usr/local/bin:/usr/bin:/bin"
  cd "$(dirname "$0")/.."
  mkdir -p "$HOME/.config/uni/updater"
  exec 9>"$HOME/.config/uni/updater/publish.lock"
  flock -n 9 || { echo 'A Uni release is already running' >&2; exit 1; }
  git fetch --quiet origin main --tags
  local sha; sha="$(git rev-parse origin/main)"
  if git tag --points-at "$sha" | grep -q '^uni-v'; then exit 0; fi
  # T-335: publish.sh asked the owner to approve signing this commit and he did not (declined, expired, broker down).
  # Don't rebuild and ask again every tick: wait for a new main commit, or run with UNI_RELEASE_ASK_AGAIN=1.
  local asked_sha asked_version asked_at
  if [[ ${UNI_RELEASE_ASK_AGAIN:-} != 1 && -s $HOME/.config/uni/updater/sign-asked ]] &&
    read -r asked_sha asked_version asked_at <"$HOME/.config/uni/updater/sign-asked" && [[ $asked_sha == "$sha" ]]; then
    echo "origin/main $sha: signing $asked_version was asked at $asked_at and not approved; not asking again (new commit or UNI_RELEASE_ASK_AGAIN=1 to retry)" >&2
    exit 0
  fi
  [[ -z $(git status --porcelain) ]] || { echo 'Release checkout is dirty; not building' >&2; exit 1; }
  git checkout --quiet --detach "$sha"
  echo "origin/main $sha is unreleased; publishing" >&2
  exec bash scripts/publish.sh
}
main "$@"
