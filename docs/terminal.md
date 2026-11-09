# Terminal plugin

In a channel, click **Terminal** in the conversation header or press **Cmd+J**
(macOS) / **Ctrl+J** (Linux desktop). The bottom drawer starts a login shell the
first time it opens for that community/account/channel. **Hide** and the shortcut
hide the drawer without stopping work; reopening reattaches the same emulator and
shell. **End session** explicitly terminates it; **Restart** starts a fresh shell.
An exited shell remains visible until ended/restarted and never respawns automatically.

Pointer openings reuse the panel dock’s 180ms fade and strong ease-out, with 12px
of upward travel. Closing reclaims the conversation height immediately, matching
docked side panels. Keyboard openings are immediate; reduced motion keeps only
the fade. Session lifetime and focus restoration stay with their existing owners.

Settings → Shortcuts can rebind the toggle. Before xterm translates a key into
shell input, a private synchronous DOM handoff gives the original keydown to the
host's existing dispatcher. Live overrides, eligibility and plugin lifetime stay
host-owned; Terminal neither reads preferences nor reserves the old default.
Handled keys are prevented once, not also sent to the shell. Ordinary message
editors retain their local-first bubbling behavior. The launcher tooltip still
shows the registered default rather than the effective binding.

The renderer pins xterm 6.0.0 and FitAddon 0.11.0. Buzz preserves xterm 5.5's
Alt-arrow sequences after shortcut dispatch: Option+Left/Right send backward/forward
word navigation on macOS, while Alt+arrows send the corresponding Ctrl-arrow
sequences on Linux. Additional modifiers retain xterm's normal translation.
Compatible terminal applications can use synchronized output (DEC mode 2026)
to batch redraws; xterm recovers an unfinished frame after its safety timeout.
The scrollbar is now xterm's own themed control. User input and parser replies
still use the pinned private `coreService.onUserInput` signal for provenance;
the public `onData` event does not expose that distinction.

## Run locally

From the agreed feature worktree, use `bin/just desktop`. Native commands require
a rebuilt/restarted desktop process; Vite HMR alone cannot install the PTY bridge.
Use the normal public `BUZZ_DEV_VIEWER` [development setup](contributing.md#live-relay-development)
for live channels. Do not copy private keys into `.env.local`. The launcher derives this
worktree's port from its path; pass `--port` only if another server already owns
it.

Local PTYs are implemented for macOS/Linux. Terminal remains enabled by default,
but Windows desktop and browser-only Buzz register neither its panel nor its
launcher or shortcut. Windows PTY support is not implemented; there is no HTTP shell endpoint. Automated macOS native tests and browser engines do
not establish Linux or packaged desktop acceptance.

## Appearance and welcome

BuzzTerm follows the host's shared Light/Dark colors,
including xterm's background, text, cursor and selection. Explicit ANSI colors retain
xterm's distinct palette rather than collapsing CLI foreground/background pairs
onto shared UI roles; xterm's minimum-contrast adjustment keeps ordinary text readable.
Appearance updates the existing emulator in place, preserving shell and scrollback.
Applications that emit true-color escape sequences still select their palette;
xterm may adjust foreground lightness for contrast. The launcher and drawer use
the shared design system: Base UI-backed buttons, Tabler icons, `PanelHeader`,
named text roles and the system mono face. The drawer is a precise `data-buzz-ui`
boundary inside the otherwise legacy channel screen, not a second rounded Panel.
In **Settings → Plugins → Terminal**, choose an installed **Font family** and
**Font size (px)**, then **Apply**. Nerd Fonts must be installed separately;
use a Mono variant for cell alignment. Applying a new family requires a successful
load check; failures show an inline error with Retry. The preview is a plain
text sample and follows drafts; Apply updates open terminals without
restarting their shells. Choices are saved on this device and sync across its
Buzz windows. **Use default** resets both choices to JetBrains Mono at 12 CSS px.
Size accepts 8–32 CSS px, including fractions, independently of interface text
size. Terminal letter spacing is zero; its line-height multiplier is 1.0 for
compact rows and closer prompt-glyph joins. The renderer remains xterm's DOM renderer.
Missing bold and italic faces may be synthesized so ANSI text styles still work
when an installed family has only one face.
If storage fails, the active choice still applies; use Retry in the notice to
repeat the failed restore or save.
If a saved family later becomes unavailable, the terminal falls back to
JetBrains Mono and its settings show a notice without clearing the saved name.
The host still owns global styles, appearance and keyboard-only focus; no viewer
preferences or second reset are imported. Decorative color stays confined to the
welcome lettering, not terminal colors or ordinary controls.

A compact “buzz” wordmark appears once per new shell, after its first output,
for at most 3 seconds. A canvas draws spaced, hatched hexagons; the lettering and
neutral background share the same slow wave. The orange/amber artwork roles use
mode-specific OKLCH adjustments. Background hexagons have 15% group opacity in
light mode and 25% in dark mode. The artwork scales to narrow and shallow drawers
independently of xterm text size.

Mouse movement gently disturbs the field; clicks send a small outward pulse
without dismissing the welcome or writing terminal input. Typing dismisses it
immediately, and hide/reopen does not replay it. Reduced motion renders a static
frame and disables pointer effects. Animation pauses in hidden documents, and
all animation/listeners are released when the welcome ends. Session actions use
labeled shared icon buttons so short drawers retain terminal rows at enlarged
text sizes.

## Public shell context

At **shell creation**, Buzz supplies:

- `BUZZ_CHANNEL_ID`: exact channel UUID.
- `BUZZ_CHANNEL`: safe display name, or the UUID if the name is unsuitable for a
  shell environment (alphanumeric/space/`-_.`, 1–64 characters).
- `BUZZ_NPUB`, `BUZZ_RELAY_URL`: public viewer and credential-free WebSocket URL.
- `BUZZ_TERM_SESSION`, `BUZZ_TERM_VERSION`.
- `BUZZ_THREAD_ID` when a thread is open; otherwise the variable is absent.

Changing threads/channels never injects commands into an existing shell. Its toolbar
retains the context it was created with; **Restart** captures the current displayed
context. Different community/account/channel scopes do not reuse one another's shell.
Navigation hides old work, while plugin disable/replacement and app shutdown terminate
all sessions owned by that plugin lifetime.

The native spawn clears inherited environment first and rebuilds a small allowlist,
sets a standard system PATH, and runs the user's login shell so their startup files
can add their tools. Buzz private keys, auth tags, arbitrary parent credentials and
its Hermit build PATH are not inherited. This is **not a sandbox** against your shell
startup files or commands you choose to execute, and it does not authenticate the
Buzz CLI on your behalf.

## Ownership and bounds

Terminal UI/emulation and retained session controllers are plugin-owned. Native
owner UUIDs fence late spawns after disposal; they are lifecycle identities, not an
untrusted-plugin security boundary. All plugins remain trusted same-process code.

The native registry caps 20 sessions and 32 owners. Reads/flushes process at most
64 KiB per call; queued native input is capped at 1 MiB. The frontend bounds pending
input to 1 MiB, serializes reads (including hidden sessions), waits for emulator
parsing, and retains at most 5,000 scrollback lines. PTY dimensions are bounded at
2–500 columns and 1–300 rows. Native `exited` requires both final-output EOF and
child exit; final output is rendered before native cleanup.

Unix cleanup targets the shell group and its current foreground job, drains during
termination, escalates after a grace period, and reaps the leader. Explicitly detached
processes and arbitrary background job-control groups are not a process sandbox;
see native source for the exact termination boundary. Failed cleanup retains its
handle for retry.

## Verification and remaining acceptance

Focused coverage lives in `src/bundled/terminal/sessions.test.ts`, the channel/panel
composition tests, `src-tauri/src/terminal/tests.rs`, and the two
`tests/browser/terminal*.spec.mjs` journeys. The separate renderer journey exercises
real xterm input/Ctrl+C, resize, alternate-screen restoration, detach/reopen and
focused-terminal rebinding/reset/storage restore through the actual bundled
registration and dispatcher, without starting a shell. The fixture replaces the
native bridge and surrounding channel/relay services, not xterm or dispatch. The
channel journey exercises actual browser launcher/shortcut absence, including
plugin disable/re-enable. Desktop
registration is covered by `src/bundled/terminal/index.test.ts`; the actual desktop
header/dispatcher journey remains an attended acceptance check. Native tests exercise real PTYs,
public-context/environment fencing, limits, final output and teardown.

Before shipping, exercise the real desktop integration: open a channel terminal,
inspect only public BUZZ variables, type a command, use Ctrl+C/full-screen tools,
resize, hide/reopen, change channel/thread, restart/end, and disable Terminal in
Settings. Broad CI, packaged desktop acceptance and other operating systems are
separate from the **ready-to-try** development handoff.
