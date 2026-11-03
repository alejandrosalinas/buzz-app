# Onboarding test build

This branch is `main` plus a separate app identity. Internal developers can use
it to walk first-run onboarding against production without touching the Buzz
they use every day. It is not meant to merge.

## What is different from `main`

- **App identifier:** `xyz.block.buzz.desktop.onboarding-test`, in
  `tauri.conf.json` and the launcher overlay. That gives it its own Application
  Support and Caches folders, its own Agents folder, its own plugin home and its
  own single-instance lock. Unlike the `.dev` build, it never copies storage
  from the installed Buzz.
- **WebView storage:** an unbundled `just desktop` run keeps its WebView data in
  `~/Library/WebKit/buzz`, split by origin. This branch salts the worktree port
  hash, so it gets an origin that no other branch in the same checkout uses.
  Don't pass `--port`.
- **Keychain:** every item is under `xyz.block.buzz.desktop.onboarding-test.*`.
  That covers the identity, agent keys, federated sessions and the TypeSafe key.
  The pre-1.0 services it falls back to are renamed too
  (`dev.local.buzz.foundation.onboarding-test.*`), so it can never pick up your
  real key. The same rename gives it its own nsec backups folder and sign-out
  records.
- **No old-Buzz import:** first run doesn't offer the pre-1.0 Buzz key or
  communities (see below).
- **Production only:** `just desktop` refuses to start if `.env.local`, a Vite
  mode file or the shell sets anything that would point it elsewhere, fake first
  run, or supply an existing identity. Examples are a `BUZZ_BUILDERLAB_URL`
  other than `https://app.builderlab.xyz`, `BUZZ_DEV_VIEWER`,
  `BUZZ_DEV_FIRST_RUN_ACCOUNT`, `BUZZ_DEV_CREDENTIAL_HELPER`, nsec backup
  service overrides, `BUZZODZ_HOME`, and relay or federated-identity overrides.
  It names the variables to remove.

## Run it

```sh
git fetch origin
git worktree add ../buzz-onboarding-test origin/onboarding-test
cd ../buzz-onboarding-test
bin/pnpm install --frozen-lockfile
just desktop
```

If you bootstrap with `scripts/bootstrap-worktree.sh` and it copies a
`.env.local` that points at staging, remove those lines. The launcher tells you
which ones.

Use `just desktop`, not `just desktop-bundle`. A bundle makes itself the
`buzz://` handler. Your installed Buzz takes `buzz://` back the next time it
launches.

## Start over

To erase everything this build keeps on the Mac, quit it and run:

```sh
scripts/onboarding-test-reset.sh
```

That removes its folders, its WebView origin, its nsec backups and its Keychain
items, and nothing that belongs to another Buzz.

Your Builderlab account still remembers what you linked and saved during the
test, so a later run with the same account follows the returning-user path.

This build never looks for the pre-1.0 Buzz
(`~/Library/Application Support/xyz.block.buzz.app`). It doesn't offer to
import that key or its communities, so everyone gets the new-user path. Revert
the "Skip old-Buzz detection" commit to test the upgrade path instead.
