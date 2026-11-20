# Pi

Create agents that run Pi on your computer, with any provider Pi supports, and answer you in Buzz. Each conversation continues its own Pi conversation.

## Getting started

1. Turn on **Pi** in **Settings** → **Plugins**. Pi needs Node.js 22.19 or later on this computer.
2. Choose **New agent** → **Create a new agent**, pick **Pi** as the **Harness**, and choose its provider and model.
3. Mention your agent in a conversation to give it work.

To give your Pi agents your own tools, hooks or providers, see
[Add your own Pi extensions to Buzz](https://github.com/block/buzz-app/blob/main/src/bundled/pi/EXTENSIONS.md).

---

# Pi for Agents

Agents run on [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) in one Node
host ([`host.mjs`](host.mjs)). Each agent has its own SQLite storage, and each
Buzz thread or channel is one durable Pi conversation. Agents owns identity,
admission and signing; this plugin owns the turn after handover. The host also
loads the Pi durable parts of the Pi packages in Pi's settings
([`EXTENSIONS.md`](EXTENSIONS.md)).

```sh
bin/pnpm exec vitest run src/bundled/pi
PI_DEPS=<installed deps folder> bin/pnpm exec vitest run src/bundled/pi/host.live.test.ts
```

The live test runs the real host on Pi's faux provider.

## Packages

[`launch.mjs`](launch.mjs) installs [`deps/package-lock.json`](deps/package-lock.json)
with `npm ci` (no install scripts) into a per-lock folder under Buzz's app data
`pi/deps/`, shared by every Buzz build. To update Pi, change
[`deps/package.json`](deps/package.json), then:

```sh
cd src/bundled/pi/deps
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

## Gateway mode

A Pi agent whose route the configured model gateway makes eligible, and which
that gateway enables for Pi, sends a gateway run's requests to the gateway:
Pi's own built-in Anthropic or OpenAI model, by its own ID, under the Pi
upstream base of the build's `BUZZ_AGENT_GATEWAY` descriptor. That base must be
the gateway's routed ingress, which resolves Pi's own IDs (such as
`claude-haiku-4-5` or `gpt-5.4-mini`) to its endpoints. A raw provider
pass-through base rejects them, and Buzz does no name mapping of its own.
Without that descriptor, or without a Pi upstream in it, every route is
external. Pi's providers, models
and setup are as without the gateway: the gateway lists nothing, and a saved
choice is an ordinary `anthropic/…` or `openai/…` model.

A request is a gateway request when its Buzz request was bound through the
gateway. Each one is admitted as it is made, by the agent's current route,
and built then from the run's own model and that route. A request made while
access is revoked is refused visibly, so revocation during a gateway run
stops it visibly at its next request.

When the runner sends a turn without the gateway (a blocked route: readiness,
identity or network failure; a 401/403 fails the turn instead), Pi runs it
on the agent's own provider and model, with the runner's shared fallback
notice on the prompt. The saved
choice is never rewritten. A request already bound to the gateway keeps that
mode when asked again and is never resent without it.

Each provider uses one protocol, with pi-ai 1.5.0's own client. Nothing
retries a request on another protocol:

| Pi provider | Protocol under the base | pi-ai API |
|---|---|---|
| `anthropic` | `anthropic/v1/messages` | `anthropic-messages` |
| `openai` | `openai/v1/responses` | `openai-responses` |

pi-ai's Anthropic client sends Messages through the SDK's beta resource, so
its path is `anthropic/v1/messages?beta=true`.

A gateway turn on any other provider's model fails visibly before it binds.
Models the gateway serves only over MLflow chat completions (such as
gpt-oss, Qwen and GLM) can't be reached from Pi. Which models an agent may
use is the gateway's policy: a request for one it doesn't serve fails
visibly with the gateway's answer.

Every model request carries:
- the Buzz context headers of the request its durable task serves, recorded
  before that request was submitted. Pi durable keeps the request in each
  submission's and task's trace (the host's telemetry adapter carries only
  that ID and records nothing), so a queued run, its compactions and
  retries, before or after a restart, carry their own request. An owner's
  Compact is its own request, whose context is the conversation's channel
  and thread with no message, since no signed event caused it;
- `x-session-affinity`, set to Pi's native session ID. This is the
  conversation's `ProviderDoc` session, not the Buzz session. pi-ai drops
  its own session headers when compaction disables caching, so without this
  the request would carry no session ID.

Buzz context a caller set is replaced. A request whose other session
headers name a different session is refused. A request is also refused
while its binding is no longer admitted, and when its record is another
conversation's. A request whose task carries no Buzz request, or one never
bound through the gateway, runs on Pi's own provider, dispatched as it is.

An agent's conversation with no gateway work runs as without the gateway:
its turns, New session and Compact are Pi's own. For a conversation key
with gateway state, New session is recorded as an intent, with what the next
turn is shown, before its reset is written by a request ID, so a host that
stops between them writes it at the next turn and writing it again adds
nothing. The intent stays until the binding that replaces the session,
before that turn is submitted, so the key's next gateway turn starts a new
Buzz session. An owner's Compact while the route is blocked runs on Pi's own
provider and model, as a blocked turn does.

A turn steers only a run in its own mode, through the gateway or not. A turn
in the other mode waits until Pi holds no work in that mode, read from Pi's
storage: no unfinished input, and no live task, such as a background
compaction whose retry sleeps after its input settled. A task's mode is that
of the request its trace carries. Its own wait for that work continues work a stopped host left. It
fails visibly ("The previous run didn't finish") once no run works in the
conversation and that work shows no progress for 15 minutes; a run that works
silently, such as a long tool call, never fails it. In a conversation with
gateway work, Interrupt withdraws every turn of it that Pi doesn't have yet,
and Stop on a waiting turn's Activity withdraws that turn alone; an ordinary
conversation's Interrupt is as on `main`. A withdrawn turn is never submitted, and its record and
reply destination are removed.

Responses transport is verified.

## Limits

- Pi's `read`, `write`, `edit` and `bash` run in the workspace with no sandbox
  or approvals. Buzz tools are `buzz_<name>`.
- Keys in Pi's `auth.json` must be literal: Buzz runs no `!command` key and
  reads no `$NAME` key. Set up a provider that needs more than a key with
  `pi`.
- Pi packages load only from a local folder, and only their `pi.durable`
  parts, when the host starts. See [`EXTENSIONS.md`](EXTENSIONS.md).
- Runs left unfinished when the app quit continue at the next turn. A
  mention's run posts only what the agent sends, plus a report if it fails,
  and shows no steps; its thread's session controls interrupt it. An
  unaddressed watch's or timer's run is ended, and so is a plugin wake's
  unless a run that continues shares its conversation.
- When the app quits or the host stops during a Buzz tool call, Pi tells the
  model the call may have run, so a `send` it makes again may be posted
  twice. A Stop or Interrupt ends the run instead.
- A conversation keeps the `core` memory it was first shown until Pi compacts
  it, as a Claude session keeps the memory it started with, so a memory edit
  leaves its cached prompt as it is. Only the note that it has none is
  replaced at once.
- Pi durable records compaction's usage only in each conversation's totals,
  not per compaction. Usage dates all of it at the newest compaction, so each
  compaction moves the conversation's earlier compaction spend to its day.
- On Windows, Pi's `bash` tool needs Git Bash. Linux and Windows are not yet
  validated.
