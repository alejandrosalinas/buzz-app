# Local artifact storage

`ctx.artifactStorage` gives plugins durable local reads through IndexedDB. The
bounded channel cache stays separate. The host delivery service owns shared edits.
The plugin owns task fields, parent rules, search tokens, and device preferences.

```ts
const tasks = ctx.artifactStorage.open({
  name: "tasks",
  type: "example.task",
  version: 1,
  project({ record, preference }) {
    return [{ index: "all", value: "", order: record.id }];
  },
});
const stop = tasks.subscribe(() => { /* Read the affected page again. */ });
const page = await tasks.page({ index: "all", value: "", limit: 100 });
const next = page.next
  ? await tasks.page({ index: "all", value: "", after: page.next, limit: 100 })
  : undefined;
```

## Scope and indexes

Cordis supplies the plugin identity. The saved community selection supplies the
viewer and normalized relay, including while offline. The read-only `scope`
contains `viewer`, `relay`, and the legacy `partition` string for migration.
A handle closes when its identity or community changes. Close it when its view ends.

Records and preferences are isolated by viewer, relay, plugin, and collection.
Each collection admits one artifact type and one fixed authoritative query. Sync
binds that query through its opaque `source` string. A different source fails.
Change the collection version when projection behavior, index definitions, or
saved query semantics change. The host checks the declared version in each read
and write transaction. It cannot detect undeclared changes to projector behavior.
An incompatible type fails explicitly. An index rebuild commits atomically; a
failure preserves the saved version and data. Old handles then reject operations.

The projector defines exact string index values and lexical order keys. Several
entries can index a record. Pages use an exclusive `(order, id)` cursor and read
only selected records, with a maximum of 1,000 rows. Pages are independent
transactions. Restart a query after a notification when rows can move between pages.
Notifications follow commit and reach other windows through BroadcastChannel.
They contain no saved content. Subscribe before the first read, then read again.

## Device data

`preferences.update(id, change)` reads the latest preference, calls the synchronous
callback, saves the result, and rebuilds that row's indexes in one transaction.
Preferences stay in a separate store. Values such as `false` and `null` remain
explicit. The callback must return JSON and must not start asynchronous work.

`importBatch` inserts absent local snapshots and preferences. Import fills a missing
local snapshot while preserving a saved shared revision. Retries preserve
later edits. It does not invent a shared revision. A completion marker commits
with the last batch. Keep migration source data until `imported(marker)` succeeds.

## Confirmed shared state

The relay supplies one authoritative current revision per artifact. The store
saves that result without an ancestry graph, inferred conflicts, revision homes,
or timestamp ordering. `get(id)` returns the current revision, availability,
optional plugin-owned local snapshot, and separate preference. Cached content
alone does not establish current access. Publication conflicts are delivery errors;
the delivery view retains the user's attempted edit for correction.

`ArtifactStorageService.onOpen` supplies the host with the real collection
definition, its handle, scope, and lifetime AbortSignal. Sync uses one Web Lock per
`{viewer, relay, owner, collectionName}`. Only a window with that definition can
own its sync. Outbox ownership stays separate. The owner cancels its work before
it releases the lock. The collection also aborts its pending transactions on close.

The host-only contract provides:

- `beginRefresh(source)` binds the fixed query and starts a fresh local generation.
  A newer generation retires the previous one.
- `applyBatch({source, refresh, records, availability}, signal)` commits explicit
  authoritative changes atomically. It requires the active generation. An
  availability change compares `expectedRevision` with the current ID observed
  locally. That ID need not be the relay's previous revision. A mismatch throws
  and rolls back the page; sync resolves it before it advances progress.
- `completeRefresh(refresh, checkpoint, signal)` commits progress after all pages
  and their local transactions succeed. It compares the expected checkpoint and
  clears the refresh error. It does not scan records or infer absence.
- `knownIds({after, limit, channelId})` gives host sync bounded pages of saved IDs.
  A host channel index supports channel removals without projector assumptions.
  Key cursors do not load record bodies. The result includes local-only and
  imported records; presence does not establish shared origin or current access.
- `setRefreshError(refresh, message, signal)` saves an error for the active
  generation and publishes a notification. Plugins read `refreshError()` and show
  a nonempty error. A new attempt retains that error until successful delta
  completion.
- `checkpoint()` reads the saved opaque progress value.

Sync serializes each whole paged delta and each bounded current-ID read from
request start through local commit. Raw live events request fresh authoritative
reads; they never write raw revisions. A duplicate or delayed push therefore does
not replace current state with its old payload. Generation, query, schema,
checkpoint, and cancellation checks run inside the commit path. An old owner cannot
commit late pages, completion, or errors after cancellation or a generation change.

A current-ID read uses `beginRefresh` and `applyBatch`. It does not advance delta
progress or clear an error from a failed delta. Only a whole successful delta calls
`completeRefresh`. A failed read can leave already committed authoritative rows,
but progress stays unchanged. Replay must be idempotent. Explicit unavailable
results preserve saved content and preferences. An empty delta leaves all saved
rows unchanged. An error or truncated response is not an unavailable result.

The relay's incremental protocol uses a 120-second overlap. Relay and sync own the
server timestamp, stable pagination, policy recovery, and retention-gap rules.
The overlap is a recovery assumption; the store does not treat it as proof that
no update can be missed. Recovery can revalidate known IDs through the relay's
uniform current-ID response. Explicit revalidation restores availability when
access returns. The store does not compare timestamps or construct ancestry.

## Immediate local feedback

Device preferences update immediately. Shared edits use the existing delivery
journal and appear immediately in the plugin's pending view. An accepted edit needs
an authoritative current-ID read actually started after its acknowledgement. Sync
retains that confirmation obligation until success or an explicit error. It cannot
attach acceptance to an older in-flight response. An empty delta cannot reconcile
the pending view. The read may report the accepted edit, a later revision, or a
uniform unavailable result. Reconciling an older operation preserves newer pending
edits. Sync and delivery own this boundary; the row store does not merge optimistic
edits into confirmed state. Publication conflicts remain failed edits with the
attempted value retained. Offline shared edits remain undecided.

## Artifact publication outcomes

`session.configArtifactWriter.isNotSent(error)` returns true only when the host
proves that the rejected publication did not deliver the event. A caller can then
retry its saved event after a transient refusal. It must check current access
before each attempt. The method does not grant access or waive relay validation.

The method is optional for older hosts and other writers. Without a true result,
the caller must treat the send as uncertain and read back its outcome before a
retry. Do not classify delivery from error text or a class name. An accepted
receipt confirms publication; a network error does not prove non-delivery.

## Storage costs

Writes request strict durability. Transactions include only the object stores that each operation uses. Row writes
and indexed pages use all four stores. Metadata operations use only metadata.
Large row batches can still delay other collections' reads or writes. A changed row rewrites
its indexes. Index upgrades scan the collection. Delta completion does not scan records.
An unchanged record and preference need no row writes or index rebuild.
Source, refresh, and revision checks still run before this comparison.
Ancestry comparison and separate source-membership writes are absent. The database upgrade removes the obsolete membership store, builds the host
channel index, and preserves records and device preferences. Leaving a community purges only its saved partition. If database
opening fails, close that handle and open another after the cause clears.
