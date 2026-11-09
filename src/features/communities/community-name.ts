/**
 * Match the web invite: preserve custom names, and show an unnamed
 * `<name>.communities.<domain>` host as `<name>`. Any other host shows in full.
 */
export function communityName(name: unknown, host: string): string {
  if (
    typeof name === "string" &&
    name.trim() &&
    name !== "Buzz Relay" &&
    name !== host
  )
    return name;
  const [label, second, ...domain] = host.split(".");
  return label && second === "communities" && domain.length ? label : host;
}
