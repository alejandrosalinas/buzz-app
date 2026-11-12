# Browser capability

The Browser capability lets plugins display HTTP(S) websites inside Buzz's existing side panel. The page and its address field, Back, Forward and Reload controls appear beside the conversation. Website rendering, navigation controls and native permissions belong to the host; plugins register the panels and choose which links they handle.

## Author contract

```ts
import type { Context } from "@buzz/author";

export const inject = ["react", "panels", "browser"];

export function apply(ctx: Context) {
  ctx.panels.register({
    id: "documentation",
    title: "Documentation",
    matches: (target) =>
      ctx.browser.available && target.startsWith("https://example.org/"),
    // Catch-all band: a panel specific to one site on this host wins by default.
    order: 100,
    component: ({ target }) =>
      ctx.react.createElement(ctx.browser.View, { url: target }),
  });
}
```

`browser.View` is a host-provided React component accepting `{ url: string; storage?: string }`. It owns the controls, website viewport and native session for its mounted lifetime. It needs a flex container with available height, as supplied by Buzz's panel card. Plugins do not import internal host modules or invoke native commands directly. This preview API is not a stable compatibility contract.

`browser.available` is currently true only in the macOS desktop application. Web, Windows and Linux builds leave existing link handling unchanged. The Windows native positioning path is unverified; Linux needs a different embedding implementation. URLs must use HTTP(S), contain no credentials, and fit the 2,048-byte limit after URL normalization. Native validation also rejects Buzz's own application and development origins. Invalid addresses leave the existing page visible and show an error.

The example only matches links when the capability is available. It declares the catch-all `order: 100`, so a default-band panel such as GitHub handles the links it recognises regardless of which plugin activated first; see [resolution order](plugin-architecture.md#resolution-order). Modifier-key clicks retain the host's existing behavior. This does not replace every external-link call site or the operating system's default browser.

Each mounted view has its own native website session, which keeps its page while hidden in a background tab or on a pane still sliding into place. Up to four sessions are open at once; past that, the least recently shown hidden one closes, and its view reopens its last page in a new session when shown. Back/Forward retain history while a session lasts. There are no saved history or bookmarks. Temporarily hiding the website for an application dialog does not end its session or stop its network activity.

Closing or replacing the panel, changing community, or disabling the plugin unmounts the view and discards its session and website storage, unless the view names a `storage`. `storage` names a website storage kept between opens and restarts: 1-64 lowercase letters, digits, `-`, `_` or `.`. Views naming the same storage share cookies and site data, so a website sign-in survives closing the panel. Native code derives a dedicated data store from the name, apart from Buzz's own. It requires macOS 14; earlier macOS and other platforms keep the private session. Plugin JavaScript is trusted, so this separates storages by name, not by plugin.

A view with a `storage` also keeps its session for ten minutes after it unmounts, hidden. A view mounted with the same `url` and `storage` in that time, such as the same tab after visiting another channel, takes that session over as it was, mid-sign-in included.

Reloading Buzz's main document ends the website session. An attachment queued before that reload cannot replace a session opened by the new document.

Builderlab's bundled app panel passes a `builderlab` viewer lifetime instead of a
shared website sign-in. The browser host names the native NIP-FI session (in live
development, the broker) only for a native request to the build's Builderlab
API, then installs the restricted
HttpOnly/Secure viewer cookie on the tenant's fixed Apps domain with the server's
absolute expiry. This is the same cookie as browser login, so login/consent repair
replaces it instead of creating a conflicting second cookie.
If the native exchange is unconfigured or its endpoint returns 404, the same
account-isolated guest opens through browser login. Other errors stay closed.
A 401 from the exchange also asks the sign-in adapter's session route once, as
other granted calls do. Only when the adapter confirms the session ended does the
shared NIP-FI session move to reauthentication required, so Settings matches.
When the exchange refuses the viewer (403), the panel shows **You can’t open this
app** with **Try again** in place of the website instead of the error bar. It
gives no reason for the refusal. When the exchange cannot be reached, fails on
its side or answers malformed, the panel shows **Buzz couldn’t load this app**
with **Try again** and **Open in browser**, which opens the app in the system
browser through its own login.
The guest stays blank until installation or this fallback finishes and its account lifetime is checked. No
credential or generic cookie/header capability is exposed to the guest. Each
account selects its own storage, kept across sign-ins and restarts so a browser
login made through this fallback persists. Each sign-in is a separate lifetime;
aborting it closes its live and parked guests, including a guest whose attach
finishes after cancellation.
Normal website views retain the storage behavior above.

## Native ownership

The controls are ordinary trusted React UI in Buzz's main webview. Website content is a separate raw Wry child view positioned over the panel's website viewport, created without a Tauri IPC handler, custom protocols or host initialization scripts. It uses a nonpersistent data store, or the named persistent store described above. The main window's content-security policy is unchanged.

The mounted view reports its viewport bounds and visibility to native code. Native code validates and clips bounds to the main webview. Resizing, scrolling, hiding the document and opening application overlays update guest placement or visibility. Session identifiers prevent delayed callbacks or cleanup from controlling a replacement view.

This distinction is required by the locked Tauri implementation: its built-in channel-data fetch command bypasses ordinary command ACL checks. Empty Tauri capabilities alone would not establish a guest with no native IPC. The raw guest has no Tauri bridge to invoke that command.

The generated app-command manifest makes native permissions explicit. Only the main webview receives attachment, positioning, navigation, action, status and detachment commands. Capabilities target its webview label, not the containing window; Tauri combines window and webview matches with OR. A sibling guest must not inherit the main webview's commands.

URLs submitted through the API/address field and navigation requests surfaced by the native engine pass the URL policy. Back/Forward use native history. Popups and downloads are unsupported. A Builderlab app's navigation to its own portal approval or connections page is cancelled, and the page, rebuilt with only its known parameters, opens in the system browser instead. The first after a user action in the toolbar (Reload, Back, Forward or a typed address) opens at once. A later approval waits for Reload, and a later connections page waits for **Open in browser**, which opens it; loading another page drops it. When the main window is focused again after a handoff, the guest returns once to the page that started it; this is not a user action. Camera/microphone requests are denied natively; permission behavior requires native acceptance checks on each supported platform. This is not a claim that websites cannot make network requests or that trusted plugin JavaScript is sandboxed.

Changes to the locked Tauri/Wry versions require native navigation, resize, teardown and permission checks on supported desktop platforms. Browser tests in Chromium/WebKit do not establish those native guarantees.

The macOS webview currently lacks detailed network-failure reporting through the shared Wry callbacks. A failed TLS/network navigation can leave a blank page; the address field and Reload remain available. The toolbar reads native loading state rather than leaving its loading indicator pending indefinitely. File upload is unavailable on macOS. Rejected website navigation may originate in a subframe, so it is blocked without attributing a top-level page error; an invalid address submitted through Buzz's controls still reports its validation error.

## Verification

Host tests cover view ownership, browser controls and generated native permissions. Native acceptance must additionally exercise link opening inside the main window, navigation, panel/window resize, overlay visibility, close/reopen, guest IPC absence and rejected navigation against the actual application. PR evidence records the platform and exact checked commit; untested platforms remain unverified.

## Try the capability with a local plugin

Start the macOS desktop app from a checkout containing this capability with `bin/just desktop`. Create a local folder containing these two files. This JavaScript example needs no build step or additional repository.

`manifest.json`:

```json
{
  "id": "example.browser-preview",
  "name": "Browser example",
  "apiVersion": 1
}
```

`plugin.js`:

```js
export const inject = ["react", "panels", "browser"];

export function apply(ctx) {
  ctx.panels.register({
    id: "example-site",
    title: "Example site",
    matches: (target) =>
      ctx.browser.available && target.startsWith("https://example.org/"),
    order: 100,
    component: ({ target }) =>
      ctx.react.createElement(ctx.browser.View, { url: target }),
  });
}
```

In Settings → Plugins → Manage plugins → Load from folder, select that folder and enable **Browser example**. Click `https://example.org/` in a message. The website and navigation controls should appear beside the conversation; a default-band panel that also matches the link, such as GitHub for a GitHub URL, wins instead. Other links keep their existing behavior.

Check address entry, Back/Forward/Reload, resizing, opening an account menu, closing/reopening the panel, and disabling the plugin. Web, Windows and Linux keep their existing link handling. The example requires a host that provides `browser`; older hosts cannot activate it.
