const MAX_URL = 2048;

/** Names that only mean something on this computer or a private network.
 * The host refuses private addresses itself; these never reach DNS. */
const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "lan",
  "home",
  "internal",
  "intranet",
  "corp",
  "arpa",
  "localdomain",
  "test",
  "invalid",
  "example",
  "onion",
  "svc",
  "consul",
  "ts.net",
];

/** Whether a link, or a hop it redirects to, may be read for a preview:
 * HTTPS on port 443 to a public-looking name, with no credentials or IP
 * literal. Checked again on every redirect. */
export function previewable(href: string): URL | null {
  if (href.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(host)) return null;
  if (/^\d+$/.test(host.split(".").pop() ?? "") || /^0x/i.test(host))
    return null;
  if (
    LOCAL_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  )
    return null;
  return url;
}

/** The link's own domain, which the card shows: a page can't name itself
 * as another site. */
export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
