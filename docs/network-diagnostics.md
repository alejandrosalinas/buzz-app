# Reading network diagnostics

Install the optional Network diagnostics desktop plugin from the Block plugin
marketplace, then enable it in Settings → Manage plugins,
then open Settings → Buzz → Network diagnostics and select Debug. Reproduce the
problem and export JSON. The selected level stays active until you change it;
optionally enable **Return to Info automatically** and set **Capture duration
(minutes)**. Desktop
keeps the full current launch in the displayed JSONL file; the recent UI is a
bounded view. Capture does not change networking, authentication or retry policy.

## Collection and performance controls

Buzz owns the collectors, native IPC and log writer; the external plugin owns
its controls and activates capture. Buzz builds and runs without the plugin.
The plugin owns capture, including while its settings page is closed. Disabling
it stops diagnostic collection, timers, forwarding IPC and file writes. Small
connection-state registrations remain so enabling capture can display sockets
already open. A desktop file and its idle writer remain available after disabling
for export; there is no diagnostic history for disabled periods. The session
file is created only on first activation in an app launch.

Info (also Warn/Error) collects fixed counters and histograms. It saves one
`metrics.summary` per observed relay every five seconds. Debug/Trace add individual
request, stage, frame and sanitized cause-chain records. They stay selected by
default. **Return to Info automatically** is unchecked by default; enabling it
starts a countdown for Debug/Trace using the editable duration (initially 15
minutes). Changing the level or duration restarts that countdown; unchecking the
option cancels it. Closing Settings does not change capture or cancel the
countdown. The choice and duration last for the current app session; restarting
Buzz starts at Info with automatic reset off. Silent pauses both metrics and logs. Resuming from
Silent, re-enabling the plugin or clearing history resets the measurement period;
an operation begun before that boundary cannot contribute a completion or latency
sample afterward. Connection gauges still show existing sockets.
Passive latency samples begin at dispatch, so time spent waiting for
authentication or admission is excluded. They use the existing traffic at Info
and above; Debug/Trace is not required and no extra request or probe is sent.

The settings page offers last-minute, last-five-minutes and current-capture
windows. Five-second buckets make rolling boundaries approximate. Latency p50/p95
are upper histogram bucket bounds, not exact sampled percentiles; values above
90 seconds are shown as `>90,000 ms`. No samples means **Not measured**, never zero.

| Metric | Measurement |
| --- | --- |
| Active connections | Actual open, authenticated and connecting relay sockets, plus tracked native HTTP requests still in flight. An abandoned native request remains in flight until cancellation or completion acknowledges through IPC. |
| Handshake latency | Transport construction to open, open to authenticated, and construction to authenticated. Native opening includes its existing discovery/admission/upgrade work. Only attempts begun in this capture produce samples. |
| Reconnection rate | Failure-driven connect attempts per minute; successful restorations, planned credential renewals and manual retries are separate counters. |
| Heartbeat timeouts | The existing idle liveness probe's sent, timeout, deferred and cancelled counts. This adds no probes or network traffic. |
| Application RTT | The existing probe REQ to matching EOSE, including relay processing and renderer scheduling. It is not transport Ping/Pong or pure network RTT. A busy connection may have no samples. |
| Publication acknowledgement | EVENT dispatch to a matching valid OK, whether accepted or refused. Unmatched/malformed receipts, cancellation, timeout and disconnected work add no latency sample. |
| Native HTTP response | Native IPC dispatch to the complete response delivered to the app, including authorization/signing, relay work, response-body transfer and IPC. Non-2xx responses count; transport failures and responses discarded after cancellation do not. |
| Subscription first response | REQ dispatch to the first verified event accepted by the route, or EOSE for an empty result. Later live events do not add samples. Applies to live routes and direct sync subscriptions. |
| Subscription catch-up | REQ dispatch to EOSE. Replay size and relay processing affect this value; it is kept separate from acknowledgement latency and probe RTT. |
| Message throughput | Text frames and UTF-8 bytes in/out per second. Native counts completed sends and received frames; browser sockets count accepted sends and received frames. Native frames are merged once, without renderer double counting. |
| Error/failure rates | Failed / (successful + failed) completed connection attempts, shared reads, native HTTP requests and tracked socket publications. Deadlines are failures; caller cancellation is reported separately. Partial read-consumer cancellation does not finish shared work. |

Browser capture has shared-read and socket metrics, but does not aggregate the
development broker's HTTP or internal relay traffic. HTTP counters are explicitly
native-only. These metrics cover the instrumented relay paths, not every app
request, upload, protocol control frame or connection to another service.
The passive histograms appear in each exported `metrics.summary` under
`latency.publicationAck`, `latency.http`, `latency.subscriptionFirst` and
`latency.subscriptionEose` within each window. All report sample count, mean and
estimated p50/p95. A missing handshake or probe sample does not imply a failure:
an existing connection may have opened before capture/the selected window, and
ordinary traffic can keep the idle probe from running.

Aggregate state is bounded to 64 relay labels plus an overflow label, with 60
five-second buckets and fixed histograms. A fully populated JavaScript relay
uses about 78 KiB of numeric array storage, plus object overhead; native frame
counters use about 2.4 KiB per relay. Individual frames and latency samples are
not retained by the metric collector. The full desktop session log has no entry
limit and can grow on disk; the recent UI history remains bounded. Detailed
events are forwarded in batches of up to 64 after a 100 ms batching interval.
The settings page displays writer queue depth and its peak so backlog is visible.

Local collector microbenchmark (2026-11-04, macOS arm64, pinned Node 24.18.0;
seven repetitions of 200,000 frames after 20,000 warmup frames):

| Mode | Known-byte counter/recorder path | Browser path including a 2 KiB UTF-8 size scan |
| --- | --- | --- |
| Disabled | ~0.003 µs/frame | ~0.003 µs/frame |
| Info | ~0.070 µs/frame | ~2.84 µs/frame |
| Debug | ~0.62 µs/frame | ~3.38 µs/frame |

A one-relay snapshot with all buckets populated measured ~17 µs. A representative
summary line was 3,117 bytes: about 2.2 MB/hour/relay at the five-second cadence,
before other lifecycle records. Debug volume scales with actual traffic and can
be much larger. These are collector measurements, not app CPU percentages: they
exclude native mutex cost, IPC, disk I/O, React rendering and WebKit execution.
Whole-app responsiveness under a real workload has not been measured.
Starting and completing a passive timer measured ~0.16 µs with capture enabled
(~0.002 µs for the disabled check). The four extra histograms increase full
numeric storage from about 46 to 78 KiB/relay and representative summary volume
from about 1.7 to 2.2 MB/hour/relay. They add no forwarding timer, IPC cadence or
individual response log record.

## Following an outage

Each desktop JSONL line has `source` (`client` or `native`) and `event`. Exported
JSON contains the same records in `events`. Use these fields to follow an outage:

| Evidence | Meaning |
| --- | --- |
| `recovery`, `recovery.retry-*` | One recovery episode's `operationId`, failed sources, notice state, retry scheduling, callback lateness and immediate-retry trigger. |
| `read.started`, `read.finished` | One shared reader job; `outcome` distinguishes success, failure, cancellation and deadline expiry. The terminal record precedes cleanup cancellation. |
| `read.consumer-*` | Consumers joining/leaving shared work. One consumer cancelling does not imply the shared job ended. `parentId` on attachment identifies its caller operation. |
| `read.attempt`, `read.retry` | One finite retry owner; reader jobs link to it through `parentId`. Roster pages and metadata similarly link to one roster operation. |
| `read.stage-*`, `read.stage` | Available queue, fetch and verification timings under the opaque reader ID. Generic local projection IDs are excluded. |
| `admission.*` | HTTP queue admission and wait duration, carrying the reader context when available. |
| Native `http.authorization`, `http.sign`, `http.query`, `http.body`, `federated.http` | Authorization, signing, request and response processing phases. `operationId` joins the logical read; native `operation` pairs each phase's start/end. |
| `native.result-discarded` | IPC completed after caller cancellation. This is distinct from native transport failure; the admission lease remains held until native work settles. |
| Native `socket.enqueue`, `socket.write` | Queue acceptance versus the actual asynchronous socket send. Match `operationId`, connection and outgoing `frameSequence`; `queueMs` measures time to worker dequeue. Write timing excludes assertion re-admission. |
| Native `socket.receive`, client `socket.delivered`, `ws.frame` | Match connection and incoming `frameSequence` to join native receipt, renderer delivery and protocol handling. Owned `subscriptionId` and operation IDs join REQ/EOSE/CLOSE and route replacement. |

Errors retain allowlisted original messages, structured error classes, bounded
causes and available native OS codes. Unrecognized text is marked redacted rather
than persisted. Frames, headers, credentials and message bodies are excluded;
only locally owned subscription IDs enter structured correlation metadata.

Cancellation attribution covers instrumented owners (deadlines, supersession,
session disposal and consumer release). Other callers remain explicitly
`caller`/`unattributed`; do not infer navigation or recovery from an AbortError
alone. Navigation admission pause/resume records explain queued reads without
claiming the document was destroyed.

`latenessMs` reports observed timer callback delay. A `wake-gap` trigger means a
large scheduling gap was detected, which can also reflect suspension or a blocked
process. It is not proof of OS sleep. Renderer delivery delay uses wall-clock
native timestamps and is approximate. Native socket write completion means the
transport accepted the frame, not that the relay processed it. Fast HTTP alone
does not establish that a stalled subscription or another request was healthy.
