import type { BuilderlabViewerSession } from "./api";
import { invoke, isTauri } from "@tauri-apps/api/core";
const MAX_URL_BYTES = 2048;
const encoder = new TextEncoder();

export type UrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function validateBrowsableUrl(url: string): UrlValidation {
  if (typeof url !== "string" || !url)
    return { ok: false, reason: "A URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Malformed URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "Only http and https URLs are supported" };
  if (parsed.username || parsed.password)
    return {
      ok: false,
      reason: "URLs with embedded credentials are not supported",
    };
  const normalized = parsed.toString();
  if (encoder.encode(normalized).length > MAX_URL_BYTES)
    return { ok: false, reason: `URL exceeds ${MAX_URL_BYTES} bytes` };
  return { ok: true, url: normalized };
}

// A colon followed by a digit is a port ("localhost:3000"), not a scheme.
const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:(?!\d)/i;

/** Address-bar input without a scheme loads over https and falls back to
 * http if that load fails, as Chrome does. */
export function addressInputUrl(input: string): {
  url: string;
  fallbackToHttp: boolean;
} {
  const trimmed = input.trim();
  if (!trimmed || EXPLICIT_SCHEME.test(trimmed))
    return { url: trimmed, fallbackToHttp: false };
  return { url: `https://${trimmed}`, fallbackToHttp: true };
}

export type BrowserBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type BrowserStatus = Readonly<{
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  /** A step to take elsewhere, such as approving an app in the web browser. */
  notice?: string | null;
  /** The page asked to open a page in the web browser, which `open` opens. */
  held?: boolean;
}>;

export type BrowserAction = "back" | "forward" | "reload" | "open";

export interface BrowserPlatform {
  readonly available: boolean;
  attach(
    url: string,
    bounds: BrowserBounds,
    storage?: string,
    builderlab?: BuilderlabViewerSession,
  ): Promise<string>;
  setBounds(
    sessionId: string,
    bounds: BrowserBounds,
    visible: boolean,
  ): Promise<void>;
  /** Holds the page's media, Web Audio included, until resumed. A hidden page
   * keeps running, so a page no view shows would otherwise stay audible. */
  setMediaSuspended(sessionId: string, suspended: boolean): Promise<void>;
  /** With `fallbackToHttp`, an https load that fails to connect retries over http. */
  navigate(
    sessionId: string,
    url: string,
    fallbackToHttp?: boolean,
  ): Promise<void>;
  action(sessionId: string, action: BrowserAction): Promise<void>;
  status(sessionId: string): Promise<BrowserStatus>;
  detach(sessionId: string): Promise<void>;
  /** Opens `url` in the system browser, outside Buzz. */
  openExternal(url: string): Promise<void>;
}

/** A page the browser view shows in place of the website when attach fails. */
export type BrowserViewerPage = "denied" | "unavailable";

/** An attach failure. `page` names a panel page to show instead of the error bar. */
export class BrowserAttachError extends Error {
  constructor(
    message: string,
    readonly page?: BrowserViewerPage,
  ) {
    super(message);
    this.name = "BrowserAttachError";
  }
}

const VIEWER_PAGES: readonly string[] = ["denied", "unavailable"];

// Native attach rejects with `{ message, page? }`; older paths reject with a string.
function attachError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || error instanceof Error)
    return error;
  const { message, page } = error as { message?: unknown; page?: unknown };
  if (typeof message !== "string") return error;
  return new BrowserAttachError(
    message,
    typeof page === "string" && VIEWER_PAGES.includes(page)
      ? (page as BrowserViewerPage)
      : undefined,
  );
}

function normalizedUrl(url: string): string {
  const validation = validateBrowsableUrl(url);
  if (!validation.ok) throw new Error(validation.reason);
  return validation.url;
}

export function createBrowserPlatform(): BrowserPlatform {
  const available =
    isTauri() &&
    typeof navigator !== "undefined" &&
    /Mac/i.test(navigator.platform);
  return {
    available,
    attach: async (url, bounds, storage, builderlab) => {
      const target = normalizedUrl(url);
      builderlab?.signal.throwIfAborted();
      // Authenticated attach installs the viewer cookie but leaves the guest blank.
      // Check the account lifetime before the separate first navigation.
      const sessionId = await invoke<string>("browser_attach", {
        url: target,
        bounds,
        storage: storage ?? null,
        builderlab: builderlab
          ? "broker" in builderlab
            ? { broker: builderlab.broker }
            : { federated: builderlab.federated }
          : null,
      }).catch((error: unknown) => {
        throw attachError(error);
      });
      if (builderlab) {
        const close = () => {
          void invoke("browser_detach", { sessionId });
        };
        builderlab.signal.addEventListener("abort", close, { once: true });
        try {
          builderlab.signal.throwIfAborted();
          await invoke("browser_navigate", {
            sessionId,
            url: target,
            fallbackToHttp: false,
          });
          builderlab.signal.throwIfAborted();
        } catch (error) {
          await invoke("browser_detach", { sessionId });
          throw error;
        } finally {
          builderlab.signal.removeEventListener("abort", close);
        }
      }
      return sessionId;
    },
    setBounds: (sessionId, bounds, visible) =>
      invoke("browser_set_bounds", { sessionId, bounds, visible }),
    setMediaSuspended: (sessionId, suspended) =>
      invoke("browser_set_media_suspended", { sessionId, suspended }),
    navigate: async (sessionId, url, fallbackToHttp = false) =>
      invoke("browser_navigate", {
        sessionId,
        url: normalizedUrl(url),
        fallbackToHttp,
      }),
    action: (sessionId, action) =>
      invoke("browser_action", { sessionId, action }),
    status: (sessionId) =>
      invoke<BrowserStatus>("browser_status", { sessionId }),
    detach: (sessionId) => invoke("browser_detach", { sessionId }),
    openExternal: async (url) =>
      invoke("plugin:opener|open_url", { url: normalizedUrl(url) }),
  };
}
