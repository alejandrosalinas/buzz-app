# Browser sign-in and OAuth callbacks

This module owns browser sign-in startup, loopback callbacks, optional OAuth state
protection, and the attempt lifecycle. Plugins supply provider-specific
authorization parameters and callback paths, handle code exchange and account
verification, and own credentials. Outbound API requests use the host HTTP feature.

Native FI additionally uses this callback owner internally with NIP-FA `return_to`
and an S256 handoff challenge, without inventing an echoed OAuth state. Its
native session owner performs exchange and verification; callback codes and
handoff secrets never cross IPC. A pending callback cannot be replaced by a new
consumer. The generic commands below retain their provider OAuth contract. Native
FI uses the shared callback template and account card with Buzz branding and
browser light/dark styling. Success means the callback was received, not that
native account verification has completed: the page instructs the user to return
to the app to finish verification. Errors retain their generic recovery copy.
Federated pages have no script, auto-close hint, artwork, or focus return; their
CSP permits only the embedded stylesheet by hash and self-contained data assets.
The Builderlab presentation below applies to generic OAuth callbacks and is
selected when each attempt starts.

## Commands

These Tauri commands are available to the main webview only. Invoke `begin` with
these named arguments:

```js
const { id, callbackUrl } = await invoke("oauth_callback_begin", {
  authorizationUrl: "https://provider.example/authorize?client_id=buzz&response_type=code",
  callbackPath: "/oauth2redirect/provider",
  useState: true, // optional; this is the default
});
```

| Command | Contract |
| --- | --- |
| `oauth_callback_begin({ authorizationUrl, callbackPath, useState? })` | Validates the request, generates an attempt ID, binds `127.0.0.1` on an ephemeral port, inserts the callback URL as `redirect_uri` and optional state, and launches the external browser through the existing opener. Returns `{ "id": "…", "callbackUrl": "http://127.0.0.1:{port}{path}" }`. Launch failure cleans up before rejecting. |
| `oauth_callback_wait(id)` | Consumes the matching attempt's result once. Resolves with `{ "parameters": [["name", "value"], …] }`, retaining decoded order and duplicates. Valid provider errors resolve with their parameters; transport failure or cancellation rejects with a generic message; a timeout rejects with `TIMED_OUT`, which the app shows as a sign-in to finish rather than a failure. |
| `oauth_callback_cancel(id)` | Closes and removes the matching attempt. Safe to repeat; a stale ID does not cancel another attempt. |
| `oauth_callback_complete(id)` | After the caller verifies the account, makes a best-effort native focus return for the matching valid callback. Waits for the callback's short reading delay, then consumes its return permission once. When macOS focus return is armed, this call waits until roughly three seconds after the callback; cancellation retires focus permission immediately, but the pending completion call waits out that delay. Unknown, canceled and replaced attempts do nothing. Invoke before final cancellation. |

The authorization URL must use HTTPS, with no embedded credentials or fragment.
The callback path must be a canonical absolute path without a query or fragment.
Native code preserves other authorization parameters, including duplicates, while
adding the generated callback URL under `redirect_uri`. Caller-supplied
`state` or `redirect_uri` parameters are rejected. The attempt ID is a lifecycle
handle, separate from state; it is not included in the callback URL.
`callbackUrl` is the exact value inserted in
the authorization request. Plugins using standard OAuth must retain it and send
it unchanged as `redirect_uri` during token exchange, as required by
[RFC 6749 §4.1.3](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.3).
Returning it does not transfer browser startup or state verification to the plugin.

Only one listener can be pending at a time. Callers must serialize their complete
begin/wait/cancel sequence: starting another attempt after a listener finishes
can replace its unconsumed result.

## State protection

By default, native code generates a separate cryptographically random 256-bit,
single-use state value and sends it in the authorization URL. Both success and
provider-error callbacks must contain exactly one matching state. Missing,
duplicate, or mismatched state receives a generic invalid-callback response and
leaves the legitimate attempt pending within its original timeout. Callback HTML
and error messages never expose state or other callback values.

`useState: false` omits state from the authorization URL and disables native state
validation entirely. This is an explicit custom-protocol compatibility exception,
not caller-owned state or an automatic fallback.

## Cleanup contract

Callers must await `begin` even if canceled during startup. Native startup can
already have opened the browser; once it returns, retain the ID and immediately
cancel if the caller was already aborted, without waiting for a callback. Otherwise,
cancel on abort and in final cleanup on every exit, including success and failure.
A rejected `begin` leaves no new attempt for the caller to clean up. Cancellation
is idempotent and affects only the matching ID; stale cleanup cannot close a newer
attempt.

The listener and expected state are cleared on completion, cancellation, timeout,
browser-launch failure, or the start of a main-document load. Loads in other
webviews leave the attempt intact. Listener cleanup does not close the external
browser or cancel separate host HTTP requests.

### Return focus after verification

Builderlab calls `complete` only after code exchange and `/v1/auth/me` validation.
It returns the verified credential immediately while focus return runs in the
background, then cancels the attempt after `complete` settles. Focus failure never
fails authentication. The attempt's focus permission is separate from its
already-closed listener and is retired by final cancellation,
reload, a provider error, or a newer attempt.

On macOS, native startup records the default browser only if Buzz is focused.
Completion runs on the main thread and activates Buzz only while that browser
application is foreground, Buzz remains visible and not minimized, and completion
is within ten seconds after the reading delay. Slow verification never causes a
late focus jump. This checks
applications, not browser tabs. Other platforms skip automatic focus return until
they have a reliable foreground-browser check; no desktop-control permission is
requested. Native focus return follows the verified-login policy independently
of whether browser policy permits closing the callback tab.

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
  requests. A valid callback shows the headline **Signing you in…** and a
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
  and disappears if closing is blocked, leaving manual-close guidance. The
  reading delay and native focus-return delay share one native constant. Error
  pages remain open. Restoring an unclosed tab later can still fail because the
  loopback listener is temporary.
  The headline describes sign-in in progress. Buzz still performs code exchange
  and account validation after receiving the callback, and reports any verification
  failures in the app.
  The standalone stylesheet mirrors the shared roles without loading the app;
  the app's existing Inter Latin font is embedded, with system fallbacks for other
  characters. It does not inherit
  the app's Appearance preference. `public/builderlab-mark.svg` is a standalone
  export of the 16–32px harness artwork, used here at 28px with the same rounded
  outline, soft-letter mask and inherited color. It needs no React runtime or
  dependency on the harness-picker feature. The cropped `cubes.webp` is embedded
  in the response rather than fetched from the short-lived listener. The same
  branded shell serves key-backup restore. Federated identity shares the template,
  embedded font, and account card, using `public/buzz-mark.svg` and a visible Buzz
  label inside the card. Its shell uses Buzz's dot texture and browser light/dark
  colors. See `NOTICE.md` for artwork provenance.

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
redirect registration, and provider-specific semantics remain plugin concerns.
IPv6 fallback is not implemented; request bounds and rejection of `Origin`
headers are local policies.
