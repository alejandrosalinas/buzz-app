// Evaluated only in the trusted main webview by the macOS Close/Close All Tabs menus.
// Native code binds `tabEvent` to the requested close action.
// An unhandled Close request lets native code close the window; Close All Tabs never does.
(() => {
  if (document.querySelector('dialog[open], [aria-modal="true"]'))
    return "handled";
  const target =
    typeof browserSessionId === "string"
      ? document.querySelector(
          `[data-browser-session="${CSS.escape(browserSessionId)}"]`,
        )
      : window;
  // A retired guest can retain native focus while its async detach completes.
  // Consume its request so it cannot close a different tab or the window.
  if (!target) return "handled";
  const request = new Event(tabEvent, { cancelable: true, bubbles: true });
  target.dispatchEvent(request);
  return request.defaultPrevented ? "handled" : "unhandled";
})();
