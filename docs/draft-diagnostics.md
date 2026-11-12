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
