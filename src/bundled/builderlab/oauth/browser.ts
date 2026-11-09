import { isTauri } from "@tauri-apps/api/core";

export const browserLoginAvailable = () => isTauri();

/** The configured HTTPS origin is granted to this plugin at build time. */
export function oauthTarget(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Builderlab sign-in is not configured for this Buzz build.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "This Buzz build does not support the configured Builderlab sign-in address.",
    );
  return `${url.href.replace(/\/$/, "")}/api/goose`;
}
