#!/usr/bin/env bash
# Serves a published desktop release on its rolling updater feed: previews on
# preview-feed (release.yml), stable releases on stable-feed
# (desktop-stable-feed.yml). Betas reach neither. scripts/preview-feed.mjs
# verifies every signature and the embedded updater configuration, and refuses
# rollback, before the manifest is replaced; it is then read back.
# Needs GH_TOKEN, GH_REPO, GITHUB_SHA and RUNNER_TEMP.
set -euo pipefail

[[ "$#" -eq 2 ]] || { echo "usage: $0 preview-feed|stable-feed VERSION" >&2; exit 1; }
feed="$1"
VERSION="$2"
# Validate the version before using it in release asset paths.
case "$feed" in
  preview-feed)
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-preview\.[0-9]+\.[0-9]+$ ]] || exit 1
    prerelease=true
    title='Buzz preview updater feed'
    notes='Rolling manifest for desktop previews. Not the stable channel.' ;;
  stable-feed)
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::$VERSION is not a stable version"; exit 1; }
    prerelease=false
    title='Buzz stable updater feed'
    notes='Rolling manifest for stable desktop releases.' ;;
  *) echo "::error::Unknown feed $feed"; exit 1 ;;
esac

archive="Buzz_${VERSION}_aarch64.app.tar.gz"
mkdir -p "$RUNNER_TEMP/candidate" "$RUNNER_TEMP/current" "$RUNNER_TEMP/served"
# A failed publication can leave a draft whose asset URLs 404 for the public.
gh release view "v$VERSION" --json isDraft,isPrerelease --jq '"\(.isDraft) \(.isPrerelease)"' | grep -qx "false $prerelease"
for asset in "$archive" "Buzz_${VERSION}_x64.app.tar.gz" "Buzz_${VERSION}_x64_unsigned.exe" "Buzz_${VERSION}_amd64.deb" "Buzz_${VERSION}_x86_64.AppImage"; do
  gh release download "v$VERSION" --pattern "$asset" --pattern "$asset.sig" --dir "$RUNNER_TEMP/candidate"
  [[ -s "$RUNNER_TEMP/candidate/$asset" && -s "$RUNNER_TEMP/candidate/$asset.sig" ]]
done
tar -xOzf "$RUNNER_TEMP/candidate/$archive" Buzz.app/Contents/MacOS/Buzz > "$RUNNER_TEMP/candidate/Buzz"
test -s "$RUNNER_TEMP/candidate/Buzz"
current=''
if gh release view "$feed" >/dev/null 2>&1; then
  gh release download "$feed" --pattern latest.json --dir "$RUNNER_TEMP/current"
  current="$RUNNER_TEMP/current/latest.json"
fi
node scripts/preview-feed.mjs generate "$VERSION" "$RUNNER_TEMP/candidate" "$RUNNER_TEMP/candidate/latest.json" "$RUNNER_TEMP/candidate/Buzz" ${current:+"$current"}
node scripts/preview-feed.mjs verify "$VERSION" "$RUNNER_TEMP/candidate" "$RUNNER_TEMP/candidate/latest.json" "$RUNNER_TEMP/candidate/Buzz" ${current:+"$current"}
if [[ -z "$current" ]]; then
  # A prerelease, so a feed never becomes the repository's Latest release.
  gh release create "$feed" "$RUNNER_TEMP/candidate/latest.json" \
    --target "$GITHUB_SHA" --prerelease --latest=false \
    --title "$title" \
    --notes "$notes"
elif cmp -s "$RUNNER_TEMP/candidate/latest.json" "$current"; then
  echo "$feed already points to this candidate."
else
  gh release upload "$feed" "$RUNNER_TEMP/candidate/latest.json" --clobber
fi
gh release download "$feed" --pattern latest.json --dir "$RUNNER_TEMP/served"
cmp "$RUNNER_TEMP/candidate/latest.json" "$RUNNER_TEMP/served/latest.json"
