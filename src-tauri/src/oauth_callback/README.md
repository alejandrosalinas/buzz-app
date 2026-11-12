# Browser sign-in and OAuth callbacks

This module owns browser sign-in startup, loopback callbacks, optional OAuth state
protection, and the attempt lifecycle for native callers only: it has no IPC
commands, and callback codes never reach the webview. Two native owners use it,
each performing its own code exchange and verification:

- Key-backup restore (`nsec_backup`) uses a standard OAuth `redirect_uri`
  callback with native state protection and the branded callback page below.
- Native FI uses NIP-FA `return_to` and an S256 handoff challenge, without
  inventing an echoed OAuth state. Handoff secrets stay in its native session
  owner. It uses the shared callback template and account card with Buzz
  branding and the existing light web sign-in shell, including cube artwork.
  Success means the callback was received, not that native account verification
  has completed: the page instructs the user to return to the app to finish
  verification. Errors retain their generic recovery copy. Federated pages share
  the three-second close script and manual-close hint.
  After native verification and session installation,
  their attempt-scoped macOS return can focus the visible Buzz window only
  while the captured browser is foreground. Cancellation, replacement, expiry
  and failed verification retire that permission. The signed-in snapshot
  publishes before the return delay. The CSP permits exact embedded style and
  script hashes and self-contained data assets.

Each caller passes an owner key: native FI uses its server's fingerprint and
restore a fixed key. An owner's pending attempt cannot be replaced by that owner.

## Attempts

`begin` validates the request, refuses an owner whose attempt is still pending,
generates an attempt ID, binds `127.0.0.1` on an
ephemeral port, inserts the callback URL as `redirect_uri` and optional state,
and launches the external browser through the caller's opener. Launch failure
cleans up before returning an error. `wait` consumes the matching attempt's
result once, retaining decoded parameter order and duplicates. Valid provider
errors resolve with their parameters; transport failure or cancellation fail with a
generic message; a timeout fails with `TIMED_OUT`, which the app shows as a
sign-in to finish rather than a failure. `cancel` closes and removes the matching attempt; it
is safe to repeat, and a stale ID does not cancel another attempt.

The authorization URL must use HTTPS, with no embedded credentials or fragment.
The callback path must be a canonical absolute path without a query or fragment.
Native code preserves other authorization parameters, including duplicates, while
adding the generated callback URL under `redirect_uri`. Caller-supplied
`state` or `redirect_uri` parameters are rejected. The attempt ID is a lifecycle
handle, separate from state; it is not included in the callback URL.
The returned callback URL is the exact value inserted in the authorization
request. A caller using standard OAuth must send it unchanged as `redirect_uri`
during token exchange, as required by
[RFC 6749 §4.1.3](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.3).

Each owner has one slot. Attempts from different owners may be pending at once,
each on its own port and path, and end only through their own wait, cancel,
timeout, launch failure, or a main-document load. An owner serializes its own
begin/wait/cancel sequence: after its generic listener finishes, its next attempt
can replace the unconsumed result. A native FI result stays until wait or cancel. A captured return permission
survives a successful wait until verified completion or cancellation; each
owner keeps its own permission, so concurrent servers cannot replace it.
Once the handoff is consumed, another sign-in for that owner can supersede its
pending focus return immediately. The previous attempt's cleanup cannot end the new one.

## State protection

By default, native code generates a separate cryptographically random 256-bit,
single-use state value and sends it in the authorization URL. Both success and
provider-error callbacks must contain exactly one matching state. Missing,
duplicate, or mismatched state receives a generic invalid-callback response and
leaves the legitimate attempt pending within its original timeout. Callback HTML
and error messages never expose state or other callback values.

Disabling state omits it from the authorization URL and disables native state
validation entirely. Only native FI does so, because its handoff challenge binds
the attempt instead.

## Cleanup contract

Callers cancel on abort and in final cleanup on every exit, including success and
failure. A failed `begin` leaves no attempt to clean up. Cancellation is
idempotent and affects only the matching ID; stale cleanup cannot close a newer
attempt.

The listener and expected state are cleared on completion, cancellation, timeout,
browser-launch failure, or the start of a main-document load. Loads in other
webviews leave the attempt intact. Listener cleanup does not close the external
browser.

## Callback handling and limits

- Accepts GET requests using HTTP/1.0 or HTTP/1.1, with exactly one matching
  `Host` header and the exact selected path. Rejects `Origin` headers and URI
  fragments. Supports query responses, not POST/form responses.
- Requires one nonempty `code` of at most 4,096 decoded bytes, or an `error`
  parameter, after any enabled state validation. Preserves state, error details,
  and extension parameters in the returned result. Invalid callbacks leave the
  listener available.
- Bounds paths to 1,024 bytes, request reads to 8,192 bytes, each connection to
  five seconds, and the overall attempt to ten minutes.
- Generic OAuth returns a static, responsive page matching the web sign-in branding: Builderlab's
  mark outside a rounded white panel, a pale backdrop and decorative cube artwork.
  It stays light in either browser theme, with the panel near the top on narrow
  windows. Responses use `no-store` and `no-referrer`. Its Content Security Policy
  permits only embedded image/font data and the exact stylesheet and close-window script
  by hash, with no external assets or network
  requests. Inline hashes use HTML-normalized line endings so Windows CRLF
  checkouts receive the same styling and script behavior as LF checkouts.
  A valid callback shows the headline **Signing you in…** and a
  spinner with muted **Closing this window automatically** text for three seconds
  before trying to close its page. The hint reserves its wrapped size through
  script startup and a blocked-close fallback, keeping the panel stationary.
  Manual-close text aligns with the heading; only automatic-closing text reserves
  the spinner's space.
  A page wrapper owns the centering grid so additional body elements, such as
  browser-extension containers, cannot introduce rows that displace the panel.
  Its branded panel fades and scales in with a small bounce over the
  shared 220ms settle duration; reduced motion and error pages stay immediate.
  The hint changes to **You can close this window.** if closing is blocked or
  JavaScript is disabled. The spinner respects reduced motion
  and disappears if closing is blocked, leaving manual-close guidance. Error
  pages remain open. Restoring an unclosed tab later can still fail because the
  loopback listener is temporary.
  The headline describes sign-in in progress. The native owner still performs
  code exchange and account validation after receiving the callback, and reports
  any verification failures in the app.
  The standalone stylesheet mirrors the shared roles without loading the app;
  the app's existing Inter Latin font is embedded, with system fallbacks for other
  characters. It does not inherit
  the app's Appearance preference. `public/builderlab-mark.svg` is a standalone
  export of the 16–32px harness artwork, used here at 28px with the same rounded
  outline, soft-letter mask and inherited color. It needs no React runtime or
  dependency on the harness-picker feature. The cropped `cubes.webp` is embedded
  in the response rather than fetched from the short-lived listener. The same
  branded shell serves key-backup restore. Federated identity shares the template,
  embedded font, artwork, and account card, using `public/buzz-mark.svg` and a
  visible Buzz label above the card. Both callbacks retain the web sign-in
  shell's light colors regardless of browser color scheme. See `NOTICE.md` for
  artwork provenance.

## Standards scope

External browser authorization and the loopback HTTP redirect pattern follow
[RFC 8252 §§6, 7.3 and 8.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-6):
an ephemeral port, binding only to loopback, and a listener limited to the attempt.
Caller-selected paths support the registered redirect requirement in
[§8.4](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.4): a registered path
stays fixed while the loopback port may vary. A custom protocol can instead select
its own random path.

Success and error query parameters follow the response shape in
[RFC 6749 §§4.1.2 and 4.1.2.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2).
Default native state protection follows
[RFC 8252 §8.9](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.9) and the
state-based CSRF defense in
[RFC 9700 §2.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1).
The explicit state-disabled exception does not provide that defense.

This is not a complete OAuth client or a claim of full OAuth conformance. PKCE,
redirect registration, and provider-specific semantics remain the native owner's
concerns.
IPv6 fallback is not implemented; request bounds and rejection of `Origin`
headers are local policies.
