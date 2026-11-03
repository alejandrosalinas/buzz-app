#!/bin/sh
# Erase everything the onboarding-test build keeps on this Mac, so its next
# launch is a first run again. Removes only this build's exact folder names,
# its dot-files beside them, and its Keychain services; the installed and
# development Buzz are left alone.
set -eu
[ "$(uname)" = Darwin ] || { echo "macOS only" >&2; exit 1; }

id=xyz.block.buzz.desktop.onboarding-test
store=dev.local.buzz.foundation.onboarding-test

root=$(cd "$(dirname "$0")/.." && pwd)
# A `just desktop` app runs from this checkout's src-tauri folder.
for pid in $(pgrep -f "/target/debug/Buzz\$" || true); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd" in
  "$root" | "$root"/*)
    echo "Quit the onboarding-test Buzz (pid $pid) first; nothing was removed." >&2
    exit 1
    ;;
  esac
done

support="$HOME/Library/Application Support"
for path in \
  "$support/$id" "$support/$id.sign-out-trash" \
  "$HOME/Library/Caches/$id" \
  "$HOME/Library/WebKit/$id" \
  "$HOME/Library/HTTPStorages/$id" \
  "$HOME/Library/Saved Application State/$id.savedState" \
  "$HOME/.buzz-foundation/nsec-backups/$store.identity" \
  "$HOME/.buzz-foundation/nsec-backups/$store.identity.debug"; do
  [ -e "$path" ] || continue
  rm -rf -- "$path"
  echo "Removed $path"
done
# Sign-out records, key locks and federated-session markers beside app data.
find "$support" -mindepth 1 -maxdepth 1 \
  \( -name ".$id.*" -o -name ".$id--*" -o -name ".$store.*" \) \
  -print -exec rm -rf -- {} +

# An unbundled run keeps its WebView data under ~/Library/WebKit/buzz, shared
# by every `just desktop` and split by origin. Remove only this checkout's
# origin, http://localhost:<its port>: WebKit records it in each origin
# folder's `origin` file as "localhost", 0x01, then the port little-endian.
node=node
[ -x "$root/bin/node" ] && node="$root/bin/node"
port=$("$node" --input-type=module -e "
import { worktreePort } from '$root/scripts/worktree-port.mjs';
console.log(worktreePort(process.argv[1]));" "$root")
key=$(printf '6c6f63616c686f737401%02x%02x' $((port % 256)) $((port / 256)))
for dir in "$HOME/Library/WebKit/buzz/WebsiteData/Default"/*/; do
  [ -d "$dir" ] || continue
  for origin in "$dir"*/origin; do
    [ -f "$origin" ] || continue
    if xxd -p "$origin" | tr -d '\n' | grep -q "$key"; then
      rm -rf -- "${dir%/}"
      echo "Removed WebView data for http://localhost:$port"
      break
    fi
  done
done

for service in \
  "$id.identity.debug" "$id.identity" \
  "$id.jev-key.debug" "$id.jev-key" \
  "$id.federated-session.debug" "$id.federated-session" \
  "$id.agents" \
  "$store.identity.debug" "$store.identity" \
  "$store.jev-key.debug" "$store.jev-key" \
  "$store.agents"; do
  # One item per call; each account under the service goes in turn.
  n=0
  while [ "$n" -lt 1000 ] &&
    security delete-generic-password -s "$service" >/dev/null 2>&1; do
    n=$((n + 1))
  done
  [ "$n" -eq 0 ] || echo "Removed $n Keychain item(s) from $service"
done
