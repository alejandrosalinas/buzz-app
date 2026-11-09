# Contributor instructions for AI agents

Read [the contribution workflow](docs/contributing.md) for commands and validation.
For interactive product work, default to edit → human tries the running app →
adjust in the agreed worktree. Do not gate each feedback round on E2E, native
builds, or full validation. Use mandatory hooks and focused behavior checks not
covered by them; use existing CI for broad validation. `just iterate` is optional.
Run `just scan` only when explicitly requested or needed to reproduce a broad
integration failure, not as a routine pre-push or handoff gate.
Track deferred checks: **ready to try** is not **validated**. Check
auth/signing, persistence/migrations, protocol semantics, and destructive writes
before live use.

Files marked `FOUNDATION` require explicit human guidance before editing and
stricter review. Escalate needed changes rather than editing without authorization.

When reviewing CI or test-cost changes, inspect job-summary counts, elapsed wall
time, summed test execution time, and slowest-test/file evidence for regressions.

## UI and design-system work

For any Buzz UI change—including features, shell, bundled plugins, and fixes to
existing screens—read the [design guide](src/shared/design-system/DESIGN.md)
before editing, starting with its screen-building decision table and
[whole-surface recipes](src/shared/design-system/DESIGN.md#compose-the-whole-surface).
For plugin UI, identify [what the host supplies](src/shared/design-system/DESIGN.md#plugin-contribution-boundaries)
before adding framing, navigation, scrolling, or overlays.
It applies to consumers throughout the repository, not only files
inside the design-system directory. Use the
[adoption map](docs/design-system-adoption.md) to find existing shared owners and
feature-owned behavior. For changes to shared tokens, recipes, or components,
also read [Maintaining the design system](src/shared/design-system/MAINTAINING_DESIGN_SYSTEM.md)
and the [local agent guide](src/shared/design-system/AGENTS.md).

New addressable dialogs, content tabs and changes to their history behavior must follow the
[navigation history and dismissal contract](docs/navigation-history.md): Back/Forward
preserves a return path; explicit Close retires it. Preserve lifecycle guards
and cover the contract when changing behavior. Transient confirmations, menus and
popovers are nested surfaces: they dismiss only themselves and do not create
addressable history visits.

- In the scope checkpoint, name the existing component/recipe to reuse and the
  guide sections governing the change. Read its implementation and current uses
  before introducing a replacement or variant.
- Use shared components, semantic color roles, complete type roles, and spacing,
  shape, and motion tokens. Features own layout and product behavior; do not
  repaint shared controls or recreate their interaction states locally. Preserve
  the guide's explicit renderer exceptions and ownership boundaries.
- If the system cannot express the requested design, explain the concrete gap
  and smallest owner-level change before expanding scope. Do not silently promote
  proposed guidance, broaden guard exceptions, or weaken checks to pass a local
  treatment. Follow the existing FOUNDATION and scope-approval rules.
- Review the affected UI against the relevant guide sections, including component
  choice, surface, hierarchy, nesting, focus, and applicable interaction states.
  Inspect it in the app in both themes, at narrow and wide widths, and with enlarged
  text; exercise keyboard and pointer behavior. Shared specimens supplement this
  check but do not establish correct host integration. Follow the contribution
  workflow's iteration gates and record checks deferred during human feedback.
- Use the existing design hook/CI checks; do not duplicate them on each feedback
  round. `design:check` provides static evidence, not full design conformance.
  At handoff, name the shared owners used, the rendered/interaction checks actually
  performed, and any remaining design gaps or approved exceptions.

## Worktree creation

Before creating a worktree, run `git worktree list` and choose the existing
checkout whose local development configuration should be inherited. Immediately
after `git worktree add`, run this from the new worktree:

```sh
scripts/bootstrap-worktree.sh /absolute/path/to/source/checkout
```

Do not start development before bootstrap completes. The script copies the
git-ignored `.env.local` without overwriting an existing target, then uses that
worktree's Hermit proxies to run `bin/rustup toolchain install` and
`bin/pnpm install --frozen-lockfile`. Do not copy
other ignored paths: Keychain credentials and pnpm's package cache are
machine-shared, while dependencies and build output are regenerated. Git hooks
need no per-worktree setup; see [Git hooks](docs/contributing.md#git-hooks).

Agents run the desktop app with plain `just desktop`, never `just desktop me`:
`me` signs in with the owner's release key and sets up their Keychain helper.

## Engineering standard

When changing a shipped plugin to default-off, follow the
[plugin-defaults decision](docs/plugin-defaults.md): apply it to fresh installs
and preserve existing installs' effective states, including implicit defaults.

When changing user-facing Buzz behavior, update [the agent help guide](docs/buzz-help.md)
if the change affects how someone uses or understands the app. Keep it concise,
describe implemented behavior, and distinguish optional or platform-dependent
features. The `buzz_help` tool bundles this file with the app; it is not fetched
from the repository at runtime.

Before editing, state the intended outcome and non-goals. Read the owning code,
callers, and relevant design docs; preserve documented product decisions and
ownership boundaries. Resolve answerable questions from evidence; ask before
deviating from agreed scope or product behavior.

For cross-host changes, follow [shared logic and host boundaries](docs/contributing.md#shared-logic-and-host-boundaries).
Name the existing feature owner/current callers, preserved behavior or approved
host differences, and which host the validation actually exercises. Keep shared
contracts executable in the existing tests; frontend checks do not replace host
signing or IPC enforcement.

Agent selection must consume `session.agentChoices`, not independently reconstruct
native/legacy inventories. Keep usable partial choices distinct from complete
inference evidence; preserve each action's membership/archive policy. See
[shared agent selection](docs/agents.md#shared-agent-selection).

Target **9/10+ for minimalness, elegance, and correctness**: the smallest complete
solution, clear ownership, and no known material defects. Prefer existing patterns
and subtraction. No opportunistic refactors, speculative abstractions, or new
features disguised as fixes. Before expanding into another shared subsystem or
adding alternate-adapter support, show the human the scope change and smallest
complete alternative. Require a current caller or explicit approval for adapter
parity. Review necessity separately from correctness; passing tests do not justify
scope growth. Split at real ownership boundaries, not by deleting safety coverage.

For non-trivial work, make that standard operational:

- Before coding, publish a short scope checkpoint: required behavior, non-goals,
  existing owners/platform support to reuse, expected files, and a rough production
  diff budget (separate from tests/docs). A small fix needs only a sentence, not a
  design ceremony.
- Use one implementation owner per end-to-end change. Reviewers challenge necessity
  as well as correctness; delegate bounded evidence/review, not competing rewrites.
  Review the first working slice before expanding the design, without blocking
  ordinary human UI feedback on a full validation cycle.
- Justify each new abstraction, lifecycle owner, timer, retry policy, or shared
  contract expansion against a current requirement. If the implementation materially
  exceeds the checkpoint, stop adding machinery and show the smallest alternative
  and any behavior tradeoff before continuing. Do not silently weaken agreed behavior.
- Assess the combined feature diff, including stacked PRs. Passing tests, splitting
  PRs, or already-invested work do not establish proportionality. Preserve required
  regression coverage; do not game the budget by deleting tests or compressing code.
  Keep speculative hardening and unrelated failures outside the task.
- Close with one verified end-to-end result and explicit remaining gaps, not a chain
  of green intermediate repairs presented as completion.

Keep files cohesive and group modules and tests by owner. Treat size as a review
signal, not a quota. Extract stable boundaries only when they simplify the
requested change.

Minimal does not mean happy-path-only. Handle relevant boundary inputs, failures,
recovery, and lifecycle transitions; consider concurrency, persistence, security,
and performance where the change affects them. Do not add machinery for
hypothetical requirements.

Design every relay-facing path for the whole fleet running it at once. A relay
rollout, restart, or network blip makes every client reconnect, renew, and catch
up in the same few seconds, so relay reads per client times clients is the real
load. Before adding or changing a connect, reconnect, renewal, poll, or catch-up
path:

- State its relay reads per client, and reconnect from a cursor rather than
  rebuilding state. One replay filter per channel meant ~306 filters per
  reconnect for a 300-channel client
  ([block/buzz-app#2308](https://github.com/block/buzz-app/pull/2308)). Skip a
  repair read only when the replay proves continuity and the client can
  reconcile every projection it touched; otherwise keep the repair, bounded.
- Jitter its start, and back off on failure with a cap.
- Prefer an event-driven refresh with a long backstop over a short poll. A
  60-second full channel-list read became a 15-minute one
  ([block/buzz-app#2215](https://github.com/block/buzz-app/pull/2215)).

Validate the affected user contract, not just isolated helpers. Add regression
coverage for changed behavior and relevant failure paths; exercise real integration
boundaries where practical. Follow the contribution workflow's iteration and batch
gates, rather than adding full validation to every edit.

Self-review before handoff; seek independent review for risky changes before
integration. Report what changed, evidence tied to the checked snapshot, and
remaining risks or deferred checks. Green CI is evidence, not proof of user behavior.

Review by the rules in [Reviewing](#reviewing).

## Choose tests by behavior

Default to colocated Vitest tests. Mount React with React Testing Library for
component behavior; do not mock React hooks or implement a substitute lifecycle.
Use Node for logic/services and opt into jsdom only when a DOM is needed.

Before adding a browser journey, name the browser behavior or integration boundary
it proves that lower-layer tests cannot. Keep scenario matrices in the lowest
layer that preserves that contract; retain representative app wiring coverage.
Do not infer layout, native editing or cross-window correctness from a DOM emulator.
When moving coverage, map removed assertions to replacements and demonstrate that
the replacement catches the regression before deleting the browser case.

Make minimal fixture data the default and opt into larger datasets only for an
explicit scale, pagination or geometry contract. Share immutable builds and stateless
servers, never mutable test state, identities or browser contexts. Preserve large
datasets and isolated runners when scale or performance is the behavior under test.
Record browser cases added/removed, their browser-only justification, replacement
coverage and fail-then-pass evidence in the PR description. For test infrastructure
changes, report before/after setup and execution timings with the command, engine,
environment and checked snapshots; distinguish local measurements from hosted CI.
List deferred checks. Do not meet time budgets by skipping engines, dropping
failure paths or weakening assertions. Enforce these rules during agent review;
do not rely on contributors filling in a PR template. Follow the
[test-layer review rules](docs/contributing.md#choosing-a-test-layer).

## Deterministic tests

Tests must control the ordering they assert, not depend on runner speed.

- For intermediate states (loading, disabled, closing), hold the responsible
  operation with an explicit fixture gate or deferred promise. Observe that it
  started, assert the pending state, release it in `finally`, then verify recovery.
  A short artificial delay is not a synchronization primitive.
- Before capturing request counts, scroll anchors, or other baselines, establish
  the relevant lifecycle boundary: completed startup/catch-up, mounted result,
  applied layout, or observed event. Visible initial content does not prove that
  background work finished. Register event observers before triggering actions.
- Wait for observable conditions with retrying assertions, not fixed sleeps or
  immediate snapshots of asynchronous effects (lint rejects `waitForTimeout`). Negative assertions need a
  completion barrier proving the work that could violate them has finished.
  Scope selectors to the semantic content being tested, not unrelated UI.
- Browser journeys import `test` from `tests/browser/playwright-test.mjs`
  (lint enforces it). Its teardown stops routes that are still in flight
  before the context closes, so a route handler that a finished test never
  waited for cannot fail that test. A fixture that closes a page itself must
  call `stopRoutes(context)` first, as `fixture.mjs` `app` does.
- When elapsed time is the behavior under test (expiry, debounce, retry), use a
  controlled clock and assert before/after the boundary. Keep real clocks for
  performance measurements; preserve their documented isolation and budgets.
- Do not hide failures with test retries, longer delays/timeouts, relaxed counts
  or tolerances, disabled animation, or broad error allowlists. Establish whether
  the defect belongs to the product, fixture, or assertion and repair that owner.
  Exercise adversarial ordering and the affected full test files in both browser
  engines for browser changes. Report exact validation scope and remaining gaps;
  a green run does not establish that all flakes are gone.

## Open-source boundary

This repository is public. Never commit values that only make sense inside
Block: Block's employee-only community and its hosts (bb-block:
`block.builderlab.xyz`, `buzz.block.builderlab.xyz`, `*.communities.block.xyz`),
private GitHub organizations, repositories or org SSH users, internal hosts,
cloud accounts, IAM roles or buckets, internal ticket keys, go/ links, Slack
channels, or personal setups. Public Builderlab
(`app.builderlab.xyz`, `*.communities.builderlab.xyz`) is a supported public
service and is fine, as is the generic rule that routes any
`buzz.{name}.builderlab.xyz` community to `{name}.builderlab.xyz` sign-in.

The rule covers functionality, not only identifiers. Every feature here must be
generic: useful and complete for any community or distributor, with no knowledge
of one company's internal services, workflows or identity setup. Functionality
that only serves Block belongs in a plugin kept in a private repository and
bundled by Block's own builds. A host change made for such a plugin must be a
general-purpose extension point: a documented public contract that an
independent plugin author could reasonably use, inert when no plugin uses it,
and never naming, detecting or special-casing a specific plugin, organization or
service. Review judges a change's purpose and approach, not just its strings.

A distributor's values come from build-time settings set by that distributor's
release build: `BUZZ_BUILDERLAB_URL`, `BUZZ_BUILDERLAB_APPS_DOMAIN`,
`BUZZ_BUILDERLAB_APPS_CONTROL_PLANE`, `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG`,
`BUZZ_BUILD_REPOSITORY_ACCESS`, `BUZZ_EXTERNAL_MCP_COMMUNITIES`,
`BUZZ_DEFAULT_COMMUNITY_URL`, `BUZZ_NSEC_BACKUP_SERVICE_URL` and
`BUZZ_NSEC_BACKUP_NAMESPACE` (see [configuration](docs/configuration.md)). If
one is missing, add a generic setting; never hardcode the value or special-case
a host or organization.

Tests, fixtures, docs and examples use example values (`example.org`,
`example-org`). Reviewers treat a violation as a blocking
finding.

## Commit attribution and DCO

Every PR commit needs a `Signed-off-by` (the hosted **DCO Check** fails without
one, and hooks do not add it): commit with `git commit --signoff`, which signs
off as your effective git identity. Credit the other party with a
`Co-authored-by` trailer: an agent committing as its human credits itself, and
an agent committing as itself credits its human.

## Before opening a PR

Open work in progress as a draft PR. Mark it ready for review only when this
checklist holds for the current change. Scale it to what changed:
documentation-only changes need content, link, and diff checks plus human
confirmation, not app runs.

1. **Agent review ran** under [Reviewing](#reviewing), and its recommended
   blockers were fixed or explicitly declined by the human author. Optional
   suggestions do not gate readiness.
2. **An agent exercised the changed behavior.** Client changes: the affected flow
   in the app, using the native app or a device when the behavior needs it
   (browser or headless Playwright counts only for what it can exercise). Relay
   changes: a local relay, exercising the changed events or endpoints. CLI or
   tooling changes: the affected command or workflow. The human may skip this
   step, for example for a small change or while iterating.
3. **A human then tested it themselves**: in the app, against the local relay
   (through the app or `curl`), or by running the changed command. Agent testing
   does not substitute. Agents give the human exact steps and what working looks
   like, then wait for explicit confirmation. Never mark this step done yourself.
4. **Add `buzz-review-completed` to the PR description** once steps 1–3 hold. It
   attests the checklist, and automated reviewers may skip review because of it.
   If later edits change behavior, remove it and return the PR to draft until the
   affected steps are redone.

## Reviewing

- For UI changes, apply [UI and design-system work](#ui-and-design-system-work)
  to feature consumers as well as shared components. Cite the applicable design
  rule and concrete mismatch in findings; distinguish adopted requirements from
  proposals and optional visual preferences. Passing token guards alone does not
  establish conformance.
- Before reviewing, read block/buzz's [`VISION.md` and `VISION_*.md` docs](https://github.com/block/buzz) for the affected surface, the relevant design docs under `docs/`, and the PR's stated goal and linked
  issue. Review the change against what it is trying to do.
- Judge the change against the 9/10 bar in [Engineering standard](#engineering-standard). A score below 9 names the concrete defect and the fix.
- Recommend blocking only for concrete correctness, security, or agreed-contract
  defects with a realistic failure scenario: state the defect, how it fails, and
  the fix. Label everything else (nits, wording, speculative hardening,
  out-of-scope improvements) as optional.
- Put all findings in the first review. Later reviews check prior blockers and
  defects the fixes introduced; reopen other areas only on new evidence of a
  material defect.
- Agents post reviews as comments, never Request Changes. Humans decide which
  findings must be fixed.

## Before pushing

- Use the agreed feature worktree and pinned `bin/` tools. Follow
  [hook setup](docs/contributing.md#pre-commit-checks) once per clone where lhm
  is absent; never bypass failures.
- Refresh remote refs; confirm destination, base, and head. Review `git status`,
  the full PR diff, and `git diff --check` against the base. Include only intended
  files: no credentials, local configuration, or raw agent/session data.
- Follow the [validation workflow](docs/contributing.md#interactive-product-iteration).
  Documentation-only changes need content, link, and diff checks, not source
  builds. Keep incomplete work in draft with deferred checks listed; hook success
  or a draft push does not establish validation.
- Push the actual PR head ref. Never rewrite others' commits; authorized rewrites
  require `--force-with-lease`. Verify the remote head matches reported checks.
- Inspect current hosted checks and repository rules, including external checks.
  Resolve relevant failures before declaring readiness; obtain required reviewer
  and code-owner approval. This preflight is not automatic permission to merge.

Icons use Tabler only, through `src/shared/design-system/icons`. Add individual exports as needed; icon and weight choices belong to the designer. The local lint and design checks enforce this import boundary.

## Inspect a live agent session

When asked to inspect or debug an Agent conversation, open its live session viewer
for the human:

```sh
bin/node scripts/session-debug.mjs '<Buzz thread ID or link>'
```

Keep it running for live updates. See [details](docs/session-debugging.md) if needed.
