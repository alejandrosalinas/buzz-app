/**
 * Native's community routing, for the front end: `matches_relay` and
 * `is_built_in_builderlab` in src-tauri/src/federated_identity/config.rs.
 * Both sides run community-hosts.fixtures.json, so the rules cannot drift.
 */
/** The `host[:port]` native routes a relay by, or undefined where
 * `canonical_relay` refuses it. */
function relayAuthority(relay: string) {
  const authority = /^(?:wss|https):\/\/(.*)$/i.exec(relay)?.[1];
  if (
    authority === undefined ||
    relay.length > 2048 ||
    /[\s\\%@?#]/.test(relay) ||
    relay.split("/").some((segment) => segment === "." || segment === "..")
  )
    return undefined;
  let url: URL;
  try {
    url = new URL(`https://${authority}`);
  } catch {
    return undefined;
  }
  if (url.pathname !== "/" || url.port === "80" || url.hostname.endsWith("."))
    return undefined;
  return url;
}

/** Whether a server's `communityHosts` cover a community: an exact
 * authority, or one label under a wildcard on the default port. */
export function coversCommunity(hosts: readonly string[], relay: string) {
  const url = relayAuthority(relay);
  if (!url) return false;
  return hosts.some((entry) => {
    if (!entry.startsWith("*.")) return entry === url.host;
    const label = url.hostname.endsWith(`.${entry.slice(2)}`)
      ? url.hostname.slice(0, -entry.length + 1)
      : "";
    return url.port === "" && label !== "" && !label.includes(".");
  });
}

/** Whether a Builderlab build URL names the built-in server's deployment. */
export function isBuiltInBuilderlab(raw: string) {
  try {
    const url = new URL(raw);
    return (
      url.origin === "https://app.builderlab.xyz" &&
      url.pathname.replace(/\/+$/, "") === "" &&
      !raw.includes("?") &&
      !raw.includes("#")
    );
  } catch {
    return false;
  }
}
