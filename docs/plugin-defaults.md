# Decision: plugin default changes apply to fresh installs

Accepted: 2026-11-03.

Changing a shipped bundled plugin's default must affect only fresh local
installs. An upgrade must preserve its previous effective enabled state, including
for people who never changed a plugin setting. Explicit On/Off
choices always take precedence, except that Channels remains required.

Disabling a plugin can stop behavior as well as remove navigation. For example,
Reminders owns local due notifications, and Workflows provides the controls for
managing workflows that run on the relay. Keeping their data is insufficient if
an upgrade silently removes the feature that makes it usable. Enabling a plugin
can add navigation and behavior too, so a new default-on policy must not silently
enable it for existing users.

## Storage contract

Both browser and native storage persist each known bundled plugin's resolved
enabled state. The browser requires that write before returning a usable catalog;
native default snapshots are best effort, so readable profiles can still open
when saving fails. Later releases retain saved states even if their bundled
defaults change. A newly introduced plugin
uses its declared default when first encountered, then persists that state too.
Use the existing plugin settings stores and native registry lock; do not add
activation-time usage queries or a second preference owner.

The initial migration backfills Reminders and Workflows as On for existing
profiles without a saved flag. Bestie starts On for fresh installs, but existing
profiles without a saved flag retain its former Off state. Other missing flags
use their declared defaults.
When changing another shipped default, include its previous value in this legacy
backfill if users can upgrade directly from a release that did not persist it.
Tests must cover that upgrade path as well as profiles with a complete snapshot.

Detect existing local state before initialization creates it:

- Native: the plugin-profile directory already exists. Older catalog reads made
  that directory and its lock file even if no `registry.json` was saved.
- Browser: plugin settings or a `buzz-client.v1:<viewer>` record already exists.
  The app reads the plugin catalog before initializing client storage.

A new device, new local profile, or cleared browser storage counts as fresh,
even if the account has older relay data. This local heuristic deliberately
preserves established installs without trying to prove feature usage from
possibly incomplete or offline relay reads. Mere absence of a settings file is
not enough to identify a fresh native install.

Corrupt or unreadable settings require recovery. A failed native default-snapshot
write serves the resolved in-memory state and retries on the next catalog read;
explicit edits and resets still report write failures. If a fresh native profile
cannot save its first snapshot, the directory created during initialization can
make a later launch count as existing. Restart stability requires a saved
snapshot; this is a limitation of the local install heuristic.

A deliberate reset uses current bundled defaults. Browser reset replaces the
settings key in one atomic write, so a failed replacement keeps the old settings.
Once reset succeeds, another launch cannot reapply the legacy backfill. Reset is
an explicit user action, rather than an upgrade.

## Required checks for a default change

Cover fresh first launch and reopen, untouched upgrades with no plugin settings,
partial settings, explicit On and Off, and reset/recovery. Verify that initialized
profiles retain their state across later default changes. Keep the state matrix
in storage tests and retain a representative app journey proving activation and
Settings controls after migration.
