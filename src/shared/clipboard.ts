import { invoke, isTauri } from "@tauri-apps/api/core";

/** Copies plain text. The macOS app has the host write it: WebKit rejects a
 * `navigator.clipboard` write without transient user activation, and every
 * host script evaluation (how Tauri delivers events and channel messages)
 * clears that activation, so a click racing host traffic would fail to copy. */
export function writeClipboardText(text: string): Promise<void> {
  return isTauri() && /Mac/.test(navigator.platform)
    ? invoke("clipboard_write_text", { text })
    : navigator.clipboard.writeText(text);
}

/** How long a copied secret stays on the clipboard before Buzz clears it. */
export const SECRET_CLIPBOARD_SECONDS = 60;

/** Copies a secret such as a private key. In the app, the host writes it and
 * clears the clipboard after `SECRET_CLIPBOARD_SECONDS` if it still holds it;
 * a browser build can't read the clipboard back, so it only copies. */
export function writeClipboardSecret(text: string): Promise<void> {
  return isTauri()
    ? invoke("clipboard_write_text", {
        text,
        clearAfterSecs: SECRET_CLIPBOARD_SECONDS,
      })
    : navigator.clipboard.writeText(text);
}
