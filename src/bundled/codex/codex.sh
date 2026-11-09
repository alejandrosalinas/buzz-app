# Buzz's own copy of Codex, apart from any `codex` the user installed.
# The plugin runs it as `bash -c` (see `withScript` in setup.ts), each time
# with one of these steps:
#
#   run [ARGS...]                  runs the copy in use with ARGS, in Buzz's home
#   install VERSION TARGET SHA256  downloads a release and checks it
#   use VERSION                    makes a downloaded release the one in use
#   adopt THREAD                   copies a thread Buzz saved in the user's
#                                  Codex home into Buzz's
#   home                           prints Buzz's Codex home
#   login                          signs in to Codex in Buzz's review home,
#                                  records the ChatGPT workspace, and leaves
#                                  the sign-in for the shared one
#   review                         makes Buzz's review home, and prints it, the
#                                  state folder it links to and the workspace,
#                                  while the sign-in still names it
set -eu

# Shared by every Buzz build on this computer, so there is one download.
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/Buzz/codex" nofollow=-h physical=-P
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex" nofollow='' physical=''
fi
# Versions name folders, so only digits and dots: no `..` or `/` escapes.
valid() {
  case "$1" in "" | [!0-9]* | *[!0-9.]*) return 1 ;; esac
}

# Prints the one ChatGPT workspace the sign-in in file $1 names; fails for an
# API key or any other sign-in. Reviews refuse those.
chatgpt_workspace() {
  id=$(sed -n 's/^ *"account_id": "\(.*\)",\{0,1\}$/\1/p' "$1" 2>/dev/null) || return
  grep -q '^ *"auth_mode": "chatgpt",\{0,1\}$' "$1" &&
    case "$id" in "" | *[!0-9A-Za-z_-]*) false ;; *) printf '%s\n' "$id" ;; esac
}

# Whether release $1 is newer than release $2.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0)
    exit 1
  }'
}

# Holds an exclusive lock on file $1 through descriptor 9 until it closes. The
# kernel releases it when the process ends, however it ends.
lock() {
  exec 9>>"$1"
  if command -v flock >/dev/null; then
    flock 9
  else # macOS has no flock(1)
    perl -MFcntl=:flock -e 'open(my $lock, ">&=9") or die "$!\n";
      flock($lock, LOCK_EX) or die "$!\n"'
  fi
}

command="$1"
shift
# Buzz keeps its own Codex home, beside the releases, so its conversations stay
# out of the user's Codex history, and the Codex app, which holds a writer lock
# on each recent thread it reopens, can't block them. It links in only the
# settings, sign-in and instructions, and never replaces a file in the way.
case "$command" in run | adopt | home | login | review)
  mkdir -p "${CODEX_HOME:-$HOME/.codex}"
  shared=$(cd "${CODEX_HOME:-$HOME/.codex}" && pwd -P)
  mkdir -p -m 700 "$dir-home"
  home=$(cd "$dir-home" && pwd -P)
  # A desktop build launched by a Buzz agent inherits this isolated home.
  # Recover its original shared home from our existing absolute config link,
  # then let the usual checks validate every link before starting Codex.
  if [ "$shared" = "$home" ]; then
    config=$(readlink "$home/config.toml" 2>/dev/null || true)
    case "$config" in
      /*/config.toml) shared=$(cd "${config%/config.toml}" && pwd -P) ;;
    esac
  fi
  [ "$home" != "$shared" ] ||
    { echo "Buzz's Codex home must differ from the shared one" >&2; exit 1; }
  # Codex can't make its skills folder through a link to nothing. Something
  # else in the way is left for Codex to handle, as it would in the shared home.
  mkdir -p "$shared/skills" "$shared/rules" 2>/dev/null || true
  # `codex login` signs out first, removing the link, so signing in from Buzz
  # leaves a file here. It replaces the shared sign-in, which that revoked, even
  # a link, as `codex login` there would, unless the shared one is newer. Under a
  # lock, so runs starting at once hand it over once. An empty file is one Codex
  # is still writing.
  if [ -s "$home/auth.json" ] && [ ! -L "$home/auth.json" ]; then
    lock "$dir-home.lock"
    if [ -s "$home/auth.json" ] && [ ! -L "$home/auth.json" ]; then
      # Moved, never read or written through a link: a contained worker can
      # make both, and this script is not contained. A rename replaces the
      # whole file, and on macOS (-h) never moves it into a linked folder.
      [ "$shared/auth.json" -nt "$home/auth.json" ] ||
        mv -f $nofollow "$home/auth.json" "$shared/auth.json" || {
        echo "Buzz couldn't save the Codex sign-in to $shared/auth.json" >&2
        exit 1
      }
      rm -f "$home/auth.json"
    fi
    exec 9>&-
  fi
  for name in config.toml auth.json AGENTS.md rules skills; do
    [ -e "$home/$name" ] || [ -L "$home/$name" ] ||
      ln -sn "$shared/$name" "$home/$name" 2>/dev/null || true
    [ "$(readlink "$home/$name")" = "$shared/$name" ] ||
      { echo "Buzz's Codex setup conflicts with $home/$name" >&2; exit 1; }
  done
  export CODEX_HOME="$home"
  ;;
esac
case "$command" in
run)
  # Even a shared `sqlite_home` setting must not lead back to the user's history.
  set -- -c "sqlite_home=$home" "$@"
  # A failed exec returns (execfail, without errexit), so the launcher can
  # look again when a release it read was pruned before it started.
  set +e
  shopt -s execfail
  while :; do
    # The plugin names a release to test it before it is in use.
    version="${BUZZ_CODEX_VERSION:-$(cat "$dir/current" 2>/dev/null)}"
    # 127, as for a missing program: the plugin reads it as "not installed".
    valid "$version" || { echo "Codex is not installed" >&2; exit 127; }
    exec "$dir/$version/bin/codex" "$@"
    # Builds that switched after the read above may have pruned its release;
    # then start the one `current` names now.
    [ -z "${BUZZ_CODEX_VERSION:-}" ] &&
      [ "$(cat "$dir/current" 2>/dev/null)" != "$version" ] || exit 127
  done
  ;;
install)
  version="$1" target="$2" checksum="$3"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  case "$target" in
  aarch64-apple-darwin | x86_64-apple-darwin | \
    aarch64-unknown-linux-musl | x86_64-unknown-linux-musl) ;;
  *) echo "Unsupported platform" >&2; exit 2 ;;
  esac
  # Each download unpacks in its own hidden folder, so two Buzz builds
  # updating at once do not write over each other, and a stopped one leaves
  # nothing.
  part="$dir/.install.$$"
  mkdir -p "$part/package"
  trap 'rm -rf "$part"' EXIT
  trap 'exit 143' INT TERM
  # Give up on a stalled download rather than holding the update forever.
  curl -fsSL --speed-limit 1024 --speed-time 60 -o "$part/package.tar.gz" \
    "https://releases.openai.com/codex/releases/$version/codex-package-$target.tar.gz"
  # The release's published checksum, which the plugin passes in.
  actual=$( (shasum -a 256 "$part/package.tar.gz" 2>/dev/null ||
    sha256sum "$part/package.tar.gz") | cut -d" " -f1)
  [ "$actual" = "$checksum" ] || { echo "The download did not match its checksum" >&2; exit 1; }
  tar -xzf "$part/package.tar.gz" -C "$part/package"
  test -x "$part/package/bin/codex"
  # A rename, so a session starting now sees no folder or the whole release.
  # Another build that already installed this release keeps its folder.
  [ -d "$dir/$version" ] || mv "$part/package" "$dir/$version"
  ;;
use)
  version="$1"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  # One switch at a time across Buzz builds, so none prunes the release
  # another just switched to.
  lock "$dir/.lock"
  # Checked under the lock: another build may have pruned it meanwhile.
  test -x "$dir/$version/bin/codex" ||
    { echo "Codex $version is no longer downloaded" >&2; exit 1; }
  previous=$(cat "$dir/current" 2>/dev/null || true)
  printf %s "$version" >"$dir/current.$$"
  mv -f "$dir/current.$$" "$dir/current"
  # Keep the new release, the one before it to fall back to, and any newer
  # one, which another build may be testing; remove the rest.
  for folder in "$dir"/*/; do
    folder=$(basename "$folder")
    [ "$folder" = "$version" ] || [ "$folder" = "$previous" ] ||
      newer "$folder" "$version" || rm -rf "${dir:?}/$folder"
  done
  ;;
adopt)
  # Threads Buzz saved before it had its own home stay in the user's, which
  # keeps them; Buzz continues from a copy. Codex names each rollout with its
  # thread id.
  thread="$1"
  case "$thread" in "" | *[!0-9A-Za-z-]*) echo "Invalid thread" >&2; exit 2 ;; esac
  for rollout in "$shared"/sessions/*/*/*/rollout-*-"$thread".jsonl; do
    # Never a link, which a contained worker could point at a file it can't read.
    [ -f "$rollout" ] && [ ! -L "$rollout" ] || continue
    copy="$home/${rollout#"$shared"/}"
    # Never over a copy Buzz already continued, here or in another build.
    [ -e "$copy" ] && continue
    mkdir -p "$(dirname "$copy")"
    # A new file, never one planted in the way, with the rollout's time.
    (set -C && cat "$rollout" >"$copy.$$")
    touch -r "$rollout" "$copy.$$"
    # The Codex app may be writing the thread now. A line it has not finished
    # is skipped when read, and must not join the next line Buzz writes.
    [ -z "$(tail -c 1 "$copy.$$")" ] || echo >>"$copy.$$"
    # A hard link publishes the whole copy, and fails if one is already there.
    # -P links the name itself, never a file a link there points to. Linux
    # always does, so it is passed only on macOS.
    ln $physical "$copy.$$" "$copy" 2>/dev/null || true
    rm -f "$copy.$$"
  done
  ;;
home)
  printf '%s\n' "$home"
  ;;
login | review)
  # The security plugin keeps this home read-only to every contained worker, so
  # nothing one writes (config.toml, AGENTS.md, skills, memories, rules) can
  # reach a review: it holds only the sign-in, the workspace a Buzz sign-in
  # recorded, and the names Codex must write at startup, linked to a state
  # folder. Shared with the plugin, by path. Anything else, such as a file
  # planted before the plugin protected it, is removed.
  mkdir -p -m 700 "$dir-review-state" "$dir-review-home"
  state=$(cd "$dir-review-state" && pwd -P)
  review=$(cd "$dir-review-home" && pwd -P)
  # So a review never relinks a sign-in still being made here.
  lock "$dir-home.lock"
  mkdir -p "$state/tmp" "$state/.tmp"
  find "$review" -mindepth 1 -maxdepth 1 ! -name auth.json ! -name installation_id \
    ! -name .sandbox_migration ! -name tmp ! -name .tmp \
    ! \( -name workspace -type f \) -exec rm -rf {} +
  for name in auth.json installation_id .sandbox_migration tmp .tmp; do
    target="$state/$name"
    [ "$name" != auth.json ] || target="$shared/auth.json"
    [ "$(readlink "$review/$name")" = "$target" ] ||
      { rm -rf "${review:?}/$name"; ln -sfn "$target" "$review/$name"; }
  done
  if [ "$command" = login ]; then
    version="${BUZZ_CODEX_VERSION:-$(cat "$dir/current" 2>/dev/null)}"
    valid "$version" || { echo "Codex is not installed" >&2; exit 127; }
    # Codex set to keep sign-ins in the keyring reads only the one saved for
    # its home, so that sign-in is made in Buzz's home, as `run` would. Reviews
    # read only a file, so they refuse it.
    if grep -Eq "^[[:space:]]*cli_auth_credentials_store[[:space:]]*=[[:space:]]*[\"']keyring[\"']" \
      "$shared/config.toml" 2>/dev/null; then
      rm -f "$review/workspace"
      echo "Codex security reviews can't use a sign-in kept in the keyring." >&2
      exec "$dir/$version/bin/codex" -c "sqlite_home=$home" login 9>&-
    fi
    # Codex signs out first, revoking the sign-in it finds, so it must not find
    # the shared one: a cancelled sign-in would sign Codex out everywhere. The
    # new sign-in is written here, where no contained worker can change it
    # before its workspace is read. The browser it opens must not keep the lock.
    rm -f "$review/auth.json"
    CODEX_HOME="$review" "$dir/$version/bin/codex" login 9>&-
    [ -s "$review/auth.json" ] && [ ! -L "$review/auth.json" ] ||
      { echo "Codex did not save a sign-in" >&2; exit 1; }
    if workspace=$(chatgpt_workspace "$review/auth.json"); then
      printf '%s\n' "$workspace" >"$review/workspace"
    else
      rm -f "$review/workspace"
      echo "Codex security reviews can't use this sign-in: it names no ChatGPT workspace." >&2
    fi
    # As a sign-in made in Buzz's home, which the next step hands to the shared one.
    mv -f $nofollow "$review/auth.json" "$home/auth.json"
    ln -sfn "$shared/auth.json" "$review/auth.json"
    exit
  fi
  printf '%s\n%s\n' "$review" "$state"
  # Codex enforces the workspace. This read of a sign-in contained workers can
  # replace only lets a review Codex would refuse say where to sign in again.
  workspace=$(cat "$review/workspace" 2>/dev/null) || true
  if [ -n "$workspace" ] && [ "$(chatgpt_workspace "$review/auth.json")" = "$workspace" ]; then
    printf '%s\n' "$workspace"
  fi
  ;;
read-from)
  # A session file from byte "$2", counting from 1, in base64; it fails
  # saying so when the file is now shorter than what was read before.
  set -o pipefail
  size=$(wc -c <"$1") || exit 1
  if [ "$size" -lt "$(($2 - 1))" ]; then
    echo "$1 shrank" >&2
    exit 3
  fi
  tail -c "+$2" -- "$1" | base64
  ;;
*)
  echo "Unknown command: $command" >&2
  exit 2
  ;;
esac
