# Managed plugin sources

An organization, or a tool that manages a machine for it, can declare "these plugin
sources are recommended here" by writing one JSON file. Buzz reads the file and
offers the listed plugins in **Settings → Plugins**. Nothing in Buzz depends on who
writes the file.

The file only recommends. It never installs, enables, updates or removes anything.
Each plugin still goes through the Git or URL import and its access review, and the person
using Buzz confirms every change. The desktop app reads the file; the browser build
has no native plugin storage, so the feature is absent there.

## File location

`managed-plugins.json` lives in the app data folder, next to `profiles/` and outside
the profile storage Buzz owns. Plugin storage and the policy therefore share one root,
which `BUZZODZ_HOME` moves.

| App | Identifier |
| --- | --- |
| Installed Buzz | `xyz.block.buzz.desktop` |
| Development builds (`just desktop`) | `xyz.block.buzz.desktop.dev` |

| OS | App data folder | Policy file |
| --- | --- | --- |
| macOS | `~/Library/Application Support/<identifier>/` | `<folder>/managed-plugins.json` |
| Windows | `%APPDATA%\<identifier>\` | `<folder>\managed-plugins.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/<identifier>/` | `<folder>/managed-plugins.json` |

Resolution order, the same one `buzzodz` uses for plugin storage:

1. `BUZZ_MANAGED_PLUGINS`, when set and non-empty, is the full path of the file. It must
   be absolute; a relative value makes the policy unusable. Use it for tests.
2. Otherwise `$BUZZODZ_HOME/managed-plugins.json`, when `BUZZODZ_HOME` is set.
3. Otherwise `managed-plugins.json` in the identifier's app data folder above.

One file serves every local profile (`BUZZODZ_PROFILE`) under that folder. A tool that
wants both an installed and a development Buzz to see the policy writes both paths.
The pre-1.0 `dev.local.buzz.foundation` folder is not read.

A missing file means no policy, unless the build carries a
[packaged policy](#packaged-policy). Buzz never creates, edits or deletes the file; the
writer creates the folder if needed. "Sign out and erase local data" clears the whole
app data folder, including this file, so a writer should restore it on its next run.

### Packaged policy

An internal packager can point its build at a policy it publishes, so every install
recommends the same plugins without anything writing the file, and picks up new pins
as the packager re-releases them:

```sh
BUZZ_BUILD_MANAGED_PLUGINS_URL=https://plugins.example/managed-plugins.json bin/pnpm tauri build
```

The value is read from the build process environment or repository-root `.env.local`.
The build fails unless it is an `https` URL without credentials or a fragment. Leave it
unset for OSS builds.

The desktop app fetches the URL when it starts and every 6 hours, or 15 minutes after a
failed attempt. It follows redirects only to `https` URLs, gives up after 30 seconds,
and accepts at most 256 KiB. A response that is not a usable version 1 document (the
rules below) is discarded, and Buzz keeps the last good copy in
`packaged-managed-plugins-<hash of the URL>.json` beside the profile folders. A copy belongs to its URL: a build that names another URL never shows it, and the first usable policy from the new URL deletes it. Entries the copy ignores
are reported as they are for the file. Serve the policy with short-lived or no edge
caching: a stale copy keeps recommending a commit its reference no longer points to.

Until the first fetch succeeds there is no copy to recommend from. Settings → Plugins
then says the list is loading or, after a failure, that it is unavailable, with the
reason and a **Retry** button. Opening Settings after a failure also retries once.
Later failures keep showing the last good copy.

Buzz uses the packaged policy only when no file exists at the resolved location, and
never when `BUZZ_MANAGED_PLUGINS` names a file. A file written by a machine manager
therefore replaces it completely; the two are not merged. "Sign out and erase local
data" deletes the stored copy, and the next fetch restores it. It recommends, exactly
like the file.

### Writing the file safely

- Write UTF-8 JSON, at most 256 KiB, as a regular file. A symlink to a regular file is
  followed; a directory, FIFO or other special file is reported as unusable and never
  opened for reading.
- Write a temporary file in the same folder and rename it over the target, so Buzz never
  reads a half-written file. A truncated file would be reported as unusable, then
  recovered on the next read.
- The file is advisory configuration, not a secret. Anything that can write the app
  data folder can write it, so the review dialog, not the label, is what protects the user.

## Schema (version 1)

```json
{
  "version": 1,
  "source": "Example Org",
  "plugins": [
    {
      "id": "example.notes",
      "repository": "https://github.com/example-org/buzz-plugins",
      "reference": "v1.4.0",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "path": "plugins/notes/dist"
    }
  ]
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `version` | yes | The number `1`. Any other value makes the whole file unusable. |
| `source` | yes | Display name of the managing organization or tool, shown as "Recommended by *source*" and "Managed by *source*". 1 to 80 characters after trimming. Only visible characters and ordinary spaces: no control characters, no Unicode format characters (such as bidirectional overrides or zero-width characters) and no non-ASCII space or line separators. |
| `plugins` | yes | Array of at most 64 entries. Later entries beyond 64 are ignored. |
| `plugins[].id` | yes | The plugin manifest ID: lowercase letters, digits, dots and hyphens, starting with a letter. Not a plugin included with Buzz. |
| `plugins[].repository` | yes | An HTTPS or SSH Git URL, or GitHub `owner/repository`, as the Add dialog accepts. No credentials, query or fragment. Buzz stores the normalized HTTPS or SSH URL. |
| `plugins[].reference` | yes | A branch or tag name: letters, digits, `.`, `_`, `/`, `-`, at most 200 characters, not starting with `-`. |
| `plugins[].commit` | yes | The full 40 digit (SHA-1) or 64 digit (SHA-256) hexadecimal object ID to install. It must be on `reference`: the tip or an earlier commit of that branch or tag. Matching ignores case. Abbreviated IDs are rejected. |
| `plugins[].path` | no | Relative folder of the built plugin (containing `manifest.json` and `plugin.js`, or a signed release pair) inside the repository. Default `.`. Buzz reads only this folder of the commit, so a repository with more than 20,000 files elsewhere still works. Written canonically: `.` alone, or plain segments joined by single `/` (`plugins/notes/dist`). No empty, `.` or `..` segments, so no leading or trailing `/`, `//` or `./`, and no `\`, `:` or control characters. A path that is not written this way is rejected, because it could never match the folder Buzz finds. |

### URL entries

For people without access to the Git host, an entry can name a single plugin artifact
over HTTPS instead of a repository:

```json
{
  "id": "example.notes",
  "url": "https://downloads.example.com/buzz/example.notes-1.4.0.json",
  "sha256": "9f2c…64 hexadecimal digits"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `plugins[].url` | yes | An HTTPS URL without credentials, query or fragment. Buzz downloads at most 8 MiB and follows redirects only to HTTPS. |
| `plugins[].sha256` | yes | The SHA-256 of the artifact, 64 hexadecimal digits. Matching ignores case. Buzz installs nothing unless the download hashes to this value, so the server need not be trusted. |

A URL entry has no `repository`, `reference`, `commit` or `path`. The artifact is the
file `buzzodz plugin pack DIST_DIRECTORY FILE` writes from a built plugin: the exact
bytes Buzz installs, whose SHA-256 is the installed revision. Publish each version at its
own URL, because a changed file at the same URL no longer matches its pin. A release
signature is not carried in the artifact.

Unknown fields are errors, at the top level and inside entries, so a typo is reported
instead of silently ignored. A new schema revision gets a new `version`.

### What makes a file or entry invalid

- **Unusable file.** The file is not readable, not UTF-8 or JSON, larger than 256 KiB, not
  a regular file, not an object, has a wrong or missing `version`, an invalid `source`,
  a `plugins` value that is not an array, or an unknown top-level field. Buzz recommends
  nothing and shows the reason in Settings → Plugins.
- **Ignored entry.** Any entry that breaks the rules above is skipped and reported by
  position (`Plugin 2: …`) while valid entries still apply. A repeated `id` keeps the
  first entry and reports the others. At most 16 problems are reported.

Neither case crashes Buzz or blocks other plugin management.

## How Buzz compares entries with installed plugins

The pinned `commit` identifies exactly what the organization means. When a plugin is
installed or updated from a recommendation, Buzz records that commit in the plugin's
saved source. Plugins added any other way (the Add dialog, an earlier Buzz) have no
recorded commit.

| State | Meaning | Offered |
| --- | --- | --- |
| Missing | No plugin with this ID is installed. | **Review and install** |
| Current | Installed from the same repository at the pinned commit and path. For a URL entry, installed at a revision equal to `sha256`, from any source. | Marked "Managed by *source*" |
| Outdated | Installed from the same repository, but at another or an unrecorded commit or path. For a URL entry, installed from a URL at another revision. | **Review update**; marked "Managed by *source*" |
| Other | Installed from a folder, an unrecorded source, another repository, or included with Buzz. | A note only. Buzz does not replace it. Remove it to see the recommendation again. |

Repositories match when scheme, user, host, port and path agree after normalization. The
host is compared without regard to case, and a trailing `/` or `.git` is ignored. The
path is case-sensitive, and an SSH form and an HTTPS form of the same repository are
different sources: a plugin installed over one is Outdated for an entry written with the
other.

## What the person using Buzz sees

- **Settings → Plugins** shows a **Recommended by *source*** group listing Missing and
  Outdated plugins, and a note for Other ones. Each row shows the repository, reference
  and path. Installed managed plugins carry **Managed by *source*** in their row and
  details.
- **Review and install** and **Review update** open the existing import review. Buzz
  reads the repository at the pinned commit, shows the commit, and lists the plugin's
  host access. For an update it shows what changed from the installed version. Nothing
  is installed until the person chooses **Install plugin** or **Update**. A new plugin
  can be installed disabled using the same "Enable plugin" switch as any import; an
  update keeps the plugin's enabled state.
- **Pending recommendations** show as a small count beside **Plugins** in the profile
  menu and beside **Manage plugins** in Settings. There is no startup prompt or modal.
- **Shell update notices** also check installed Git plugins. For a managed plugin,
  the check and update use the recommended reference, path, and commit pin, and read
  only that folder. A commit that is not on the reference cannot install. Missing recommendations keep their
  existing review flow. The Plugins menu keeps updates available after **Later**.
- **Details of a managed plugin** do not offer the generic update check, which would
  install the reference's tip instead of the pinned commit. They show the same
  **Review update** as the group above when the plugin is Outdated.
- **Disable** works as for any plugin.
- **Remove** works as for any plugin. The recommendation stays visible, so a removed
  plugin returns to the Recommended group and can be reinstalled. Buzz never removes a
  plugin because the file changed or a line was deleted; a plugin no longer listed
  simply loses its Managed by label.
- An invalid file or ignored entries are reported in the same section.

## Pinned commit behavior

The Git import fetches `commit` directly, without its history or file contents, and
reads the recommended `path` at that commit. It then fetches the reference's commit
history and requires `commit` to be an ancestor of (or equal to) the reference's tip, so
the review's "pinned to commit X on *reference*" is true. A commit that is on the
reference but no longer its tip installs; a commit that is not on the reference, such as
one from another branch or a rewritten history, is refused. Because the commit is read
directly, merging more commits to the reference does not break an existing pin.

Some Git hosts refuse to serve a commit by its ID. For those, Buzz falls back to reading
the reference's tip, which must then equal `commit`; if the reference has moved, the
review shows the two commits, says the commit could not be fetched directly, and refuses
to continue. There is no fallback to the new commit. If the policy entry changes while a
review is open, the review reads the new entry again, and it closes if the entry is
removed. Pin a tag, or rewrite the entry's `commit` when you intend a branch to advance.
The app also checks again that the commit it received is the pinned one.

Only an install or update from a recommendation or an agent's request records `commit`
in the plugin's saved source in the profile registry. Older Buzz versions reject that field and offer settings
recovery, so downgrading after installing from a recommendation is not supported, as
with other registry additions. Plugins added through the Add dialog are unaffected.

## Refresh timing

Buzz reads the file when it starts, and again each time it refreshes the plugin
catalog, about once per second while it runs. A new or changed file therefore appears
without a restart, in Settings and in the pending counts.

## Inspecting a policy

```sh
buzzodz plugin managed
buzzodz --home /path/to/app-data plugin managed
BUZZ_MANAGED_PLUGINS=/tmp/policy.json buzzodz plugin managed
```

The command prints the file path, the source name, each valid entry with its state for
the selected profile, and the reason for each ignored entry. `buzzodz` and the desktop
share one implementation, so a writer can use it to check a file it wrote.

To check a packaged policy before publishing it, write it to a scratch file and point
`BUZZ_MANAGED_PLUGINS` at that file.

## Writer checklist

1. Pick the app data folder (or paths) for the identifiers you manage.
2. Build the JSON exactly as above: `version` 1, a short `source`, and for every
   plugin the ID, repository, reference, full commit and built-plugin path.
3. Write it atomically.
4. Run `buzzodz plugin managed` and confirm no entry is reported as ignored.
5. Rewrite the file only when the recommendation changes.
