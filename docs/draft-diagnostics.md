# Draft conflict diagnostics

Desktop builds keep the latest 100 draft operations in memory. A draft conflict
or save failure writes that trace to `draft-diagnostics.json` in the app's log
directory. This works in release builds. It does not need a plugin or developer
mode. A new trace replaces the previous file. The app does not upload it.

On macOS, open `~/Library/Logs/<app identifier>/draft-diagnostics.json`.
The identifier comes from the installed build. On Linux, use
`$XDG_DATA_HOME/<app identifier>/logs` (or
`~/.local/share/<app identifier>/logs`). On Windows, use
`%LOCALAPPDATA%\<app identifier>\logs`.

Reproduce the warning. Select **Keep my draft** if you want to keep the current reply.
If the warning returns, collect the new trace. Copy the file before restarting or reproducing
another conflict. Do not send the draft to collect a trace. A failed diagnostics
write leaves draft save and send behavior unchanged.

The file contains the app version, capture time, process ID, and operation order.
Draft and editor IDs are local numbers. They do not identify a person, channel,
or thread. Editor `0` marks the shared store. IDs restart when the page reloads.
The trace contains no draft text, attachments, URLs, keys, tokens, or content
hashes. The file uses owner-only permissions on Unix when first created.

`expected`, `current`, and `next` describe serialized revision kinds only:
`missing` means no saved item; `unreadable` means the revision read failed.
`null`, `string`, `object`, and `other` describe the saved format.
`sameExpected` compares the saved revision with the editor's expected revision.
`sameNext` compares it with the proposed draft. Store notifications have no
revision comparisons. `flags` uses bit `1` for unsaved editor changes, bit `2`
for a save in progress, and bit `4` for a send attempt.

A `persist` followed by `write`, `notify`, and `saved` shows a local save.
A `storage` event marks a notification from another window. `changed` marks a
save or reconciliation conflict. `send-start-conflict`, `send-upload-conflict`, `send-prepare-conflict`, and
`send-publish-conflict` identify the send guard that detects a mismatch.
`write-mismatch` marks a failed read-back. `serialize-failed`, `write-failed`,
and `notify-failed` identify the write phase that throws. `keep` and `use-saved` mark explicit conflict choices.
Multiple editor IDs for one draft can show which mounted editors observe a
write. These records locate the guard and operation order. They do not prove
which external process changed storage or why it did so.

## macOS storage locks

WebKit can replace a Networking helper but fail to stop the old helper. The
abandoned helper can keep a SQLite write lock that blocks later draft saves.
An immediate read-back can succeed before WebKit reports the storage failure.
This is one possible cause, not a diagnosis for every draft conflict.

Buzz extends its GPU recovery to Networking helpers reported by the main
webview's data store. GPU helpers get two valid missing checks. Networking
helpers get ten checks, about ten seconds, before the watcher signals them. This
gives a Networking helper more time to exit. The helper's expected executable,
process ID, and start time must still match. An unreadable reported identity
pauses that helper watch.
Current helpers and helpers Buzz never observed remain untouched.

This recovery runs only while Buzz is open. It does not scan for helpers left
by earlier launches, delete storage, or bypass draft conflict checks. It is not
a storage-flush barrier for pending writes in an abandoned helper. Unified log
messages containing `WebKit Networking process` record each recovery attempt.
Collect those messages alongside the draft trace when investigating a lock.

### Native regression check

Run this check from a graphical macOS session with the Xcode command-line tools:

```sh
bin/cargo run --locked -p buzz-webkit-reaper-test
```

The check loads the production watcher in an isolated Tauri host with temporary
storage. It starts no Buzz services and uses no saved identity. It drives the
real timer callbacks and suspends only its own Networking helper to hold a
SQLite write lock. It checks recovery, active helpers, the committed draft, and
a new durable write without reloading. It cleans up its own Networking helpers
and temporary storage.

This check needs WebKit's directory-based data-store fixture API. It fails
before exercising recovery if that API is unavailable. It does not exercise
the Buzz composer or establish human acceptance.

## Glossary

- **Helper:** a separate WebKit process used by the app's webview.
- **Networking helper:** the WebKit process that also manages local website storage.
- **SQLite:** the database engine WebKit uses for saved local data.
- **Webview:** the native view that renders Buzz's web interface.
