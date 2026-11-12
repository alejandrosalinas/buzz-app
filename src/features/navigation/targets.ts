import { relayOrigin } from "../communities/destination";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type NavigationScope = Readonly<{
  viewer: string;
  communityOrigin: string;
}>;
export type GitPluginSource = Readonly<{
  repository: string;
  reference: string;
  path?: string;
  commit?: string;
}>;
/** A single plugin artifact over HTTPS, accepted only at `sha256` and as plugin `id`. */
export type UrlPluginSource = Readonly<{
  id: string;
  url: string;
  sha256: string;
}>;
export type PluginLinkSource = GitPluginSource | UrlPluginSource;
export type OpenTarget =
  | Readonly<{ version: 1; kind: "home" }>
  | Readonly<{
      version: 1;
      kind: "settings";
      section?: string;
      /** Plugin-owned presentation data for a contributed Settings card. */
      route?: Readonly<{ version: number; params: JsonValue }>;
      /** Nested provider controls within Agent setup; presentation only. */
      provider?: string;
      scope?: NavigationScope | null;
      pluginImport?: PluginLinkSource;
      pluginId?: string;
    }>
  | Readonly<{
      version: 1;
      kind: "page";
      pluginId: string;
      pageId: string;
      /** null explicitly restores Personal space; omission leaves community selection alone. */
      scope?: NavigationScope | null;
      route?: Readonly<{ version: number; params: JsonValue }>;
    }>
  | Readonly<{
      version: 1;
      kind: "plugin";
      pluginId: string;
      /** Omitted: the plugin's primary page, else its first. */
      pageId?: string;
      /** String route data from a link. The resolved page's own validator
       * decides whether it applies; the page opens without it otherwise. */
      params?: Readonly<Record<string, string>>;
      scope?: NavigationScope | null;
    }>
  | Readonly<{
      version: 1;
      kind: "conversation";
      scope: NavigationScope;
      channelId: string;
      messageId?: string;
      /** Hint only. Resolve the actual root from verified message evidence. */
      threadRootId?: string;
      /** With threadRootId: the thread opens beside that root, revealed in the
       * channel timeline even beyond its newest page, as Open in channel asks. */
      context?: "channel";
      /** Presentation within this conversation; never mutation or confirmation state. */
      panel?: "members";
      /** Message selected for the forwarding dialog; never submission state. */
      forward?: string;
      /** Read-only content selected beside this conversation; never an action. */
      detail?: Readonly<{ target: string; rootId?: string }>;
    }>;

const MAX_BYTES = 8192;
const token = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// Built-in section, or a grouped plugin card's contribution key (`plugin/card`).
const section = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127})?$/;
const provider = /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._-]{0,127}$/;
const hex = /^[a-f0-9]{64}$/i;
const paramKey = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const gitCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MAX_PARAMS = 16;
const MAX_PARAM_LENGTH = 1024;
const invalid = () => new Error("Invalid or unsupported navigation target");
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  if (Object.getOwnPropertySymbols(value).length) throw invalid();
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!("value" in descriptor) || !descriptor.enumerable) throw invalid();
  }
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}
function text(value: unknown, pattern = token): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid();
  return value;
}
function pluginFolder(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[\p{Cc}\\]/u.test(value)
  )
    throw invalid();
  if (value === "" || value === ".") return ".";
  if (value.split("/").some((part) => !part || part === "." || part === ".."))
    throw invalid();
  return value;
}
export function parseGitPluginSource(input: unknown): GitPluginSource {
  const value = record(input);
  fields(value, ["repository", "reference", "path", "commit"]);
  if (
    typeof value.repository !== "string" ||
    value.repository.length > 2048 ||
    typeof value.reference !== "string" ||
    value.reference.length > 256
  )
    throw invalid();
  if (
    /\s/.test(value.repository) ||
    [...(value.repository + value.reference)].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw invalid();
  const repositoryText = value.repository;
  const scp = /^([^/@:]+@[^/:]+):(.+)$/.exec(repositoryText);
  const expanded =
    !repositoryText.includes("://") && scp
      ? `ssh://${scp[1]}/${scp[2]}`
      : repositoryText.startsWith("github.com/")
        ? `https://${repositoryText}`
        : !repositoryText.includes(":") &&
            repositoryText.split("/").length === 2
          ? `https://github.com/${repositoryText}`
          : repositoryText;
  const repository = new URL(expanded);
  if (
    !["https:", "ssh:"].includes(repository.protocol) ||
    !repository.hostname ||
    repository.hostname.startsWith("-") ||
    repository.username.startsWith("-") ||
    !repository.pathname.replaceAll("/", "") ||
    repository.password ||
    (repository.protocol === "https:" && repository.username) ||
    repository.search ||
    repository.hash
  )
    throw invalid();
  if (
    value.commit !== undefined &&
    (typeof value.commit !== "string" || !gitCommit.test(value.commit))
  )
    throw invalid();
  return Object.freeze({
    repository: repository.href,
    reference: value.reference,
    ...(value.path !== undefined ? { path: pluginFolder(value.path) } : {}),
    ...(value.commit !== undefined
      ? { commit: value.commit.toLowerCase() }
      : {}),
  });
}
export function parseUrlPluginSource(input: unknown): UrlPluginSource {
  const value = record(input);
  fields(value, ["id", "url", "sha256"]);
  if (
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    /[\s\p{Cc}\p{Cf}\P{ASCII}]/u.test(value.url) ||
    typeof value.sha256 !== "string" ||
    !hex.test(value.sha256)
  )
    throw invalid();
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.hostname.startsWith("-") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.replaceAll("/", "")
  )
    throw invalid();
  return Object.freeze({
    id: text(value.id),
    url: url.href,
    sha256: value.sha256.toLowerCase(),
  });
}
export function parsePluginLinkSource(input: unknown): PluginLinkSource {
  return input && typeof input === "object" && "url" in input
    ? parseUrlPluginSource(input)
    : parseGitPluginSource(input);
}
function boundScope(input: unknown): NavigationScope {
  const value = record(input);
  fields(value, ["viewer", "communityOrigin"]);
  if (typeof value.communityOrigin !== "string") throw invalid();
  return Object.freeze({
    viewer: text(value.viewer, hex).toLowerCase(),
    communityOrigin: relayOrigin(value.communityOrigin),
  });
}

function stringParams(input: unknown): Readonly<Record<string, string>> {
  const value = record(input);
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_PARAMS) throw invalid();
  const result: Record<string, string> = Object.create(null);
  for (const key of keys) {
    const item = value[key];
    if (typeof item !== "string" || item.length > MAX_PARAM_LENGTH)
      throw invalid();
    result[text(key, paramKey)] = item;
  }
  return Object.freeze(result);
}

/** Copy, bound and sort JSON before retaining plugin-supplied state. No references survive. */
function json(input: unknown, depth = 0, budget = { nodes: 1024 }): JsonValue {
  if (depth > 8 || --budget.nodes < 0) throw invalid();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input.length > MAX_BYTES) throw invalid();
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input)) {
    if (input.length > 256) throw invalid();
    const result: JsonValue[] = [];
    for (let index = 0; index < input.length; index++) {
      // JSON arrays are dense. Reject holes instead of changing them to null in links.
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !("value" in descriptor)) throw invalid();
      result.push(json(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  const value = record(input);
  const keys = Object.keys(value);
  if (keys.length > 128) throw invalid();
  keys.sort();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of keys) {
    if (key.length > 128) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw invalid();
    result[key] = json(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}

function parseRoute(input: unknown) {
  const raw = record(input);
  fields(raw, ["version", "params"]);
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1)
    throw invalid();
  return Object.freeze({
    version: raw.version as number,
    params: json(raw.params),
  });
}

/** All bound ingresses use this parser. A valid address is not authorization. */
export function parseOpenTarget(input: unknown): OpenTarget {
  try {
    const value = record(input);
    if (value.version !== 1) throw invalid();
    let target: OpenTarget;
    switch (value.kind) {
      case "home":
        fields(value, ["version", "kind"]);
        target = { version: 1, kind: "home" };
        break;
      case "settings":
        fields(value, [
          "version",
          "kind",
          "section",
          "route",
          "provider",
          "scope",
          "pluginImport",
          "pluginId",
        ]);
        if (value.provider !== undefined && value.section !== "agents")
          throw invalid();
        if (value.pluginImport !== undefined && value.section !== "plugins")
          throw invalid();
        if (value.pluginId !== undefined && value.section !== "plugins")
          throw invalid();
        if (value.pluginId !== undefined && value.pluginImport !== undefined)
          throw invalid();
        target = {
          version: 1,
          kind: "settings",
          ...(value.section !== undefined
            ? { section: text(value.section, section) }
            : {}),
          ...(value.route !== undefined
            ? { route: parseRoute(value.route) }
            : {}),
          ...(value.provider !== undefined
            ? { provider: text(value.provider, provider) }
            : {}),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : boundScope(value.scope) }
            : {}),
          ...(value.pluginImport !== undefined
            ? { pluginImport: parsePluginLinkSource(value.pluginImport) }
            : {}),
          ...(value.pluginId !== undefined
            ? { pluginId: text(value.pluginId) }
            : {}),
        };
        break;
      case "page": {
        fields(value, [
          "version",
          "kind",
          "pluginId",
          "pageId",
          "scope",
          "route",
        ]);
        target = {
          version: 1,
          kind: "page",
          pluginId: text(value.pluginId),
          pageId: text(value.pageId),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : boundScope(value.scope) }
            : {}),
          ...(value.route !== undefined
            ? { route: parseRoute(value.route) }
            : {}),
        };
        break;
      }
      case "plugin":
        fields(value, [
          "version",
          "kind",
          "pluginId",
          "pageId",
          "params",
          "scope",
        ]);
        target = {
          version: 1,
          kind: "plugin",
          pluginId: text(value.pluginId),
          ...(value.pageId !== undefined ? { pageId: text(value.pageId) } : {}),
          ...(value.params !== undefined
            ? { params: stringParams(value.params) }
            : {}),
          ...(value.scope !== undefined
            ? { scope: value.scope === null ? null : boundScope(value.scope) }
            : {}),
        };
        break;
      case "conversation": {
        fields(value, [
          "version",
          "kind",
          "scope",
          "channelId",
          "messageId",
          "threadRootId",
          "context",
          "panel",
          "forward",
          "detail",
        ]);
        if (value.threadRootId !== undefined && value.messageId === undefined)
          throw invalid();
        if (
          value.context !== undefined &&
          (value.context !== "channel" || value.threadRootId === undefined)
        )
          throw invalid();
        if (
          value.panel !== undefined &&
          value.panel !== "members" &&
          // Retired Shared sessions tab: saved targets still open the conversation.
          value.panel !== "shared-sessions"
        )
          throw invalid();
        let detail: { target: string; rootId?: string } | undefined;
        if (value.detail !== undefined) {
          const input = record(value.detail);
          fields(input, ["target", "rootId"]);
          detail = Object.freeze({
            target: text(input.target, /^[!-~]{1,4096}$/),
            ...(input.rootId !== undefined
              ? { rootId: text(input.rootId, hex).toLowerCase() }
              : {}),
          });
        }
        target = {
          version: 1,
          kind: "conversation",
          scope: boundScope(value.scope),
          channelId: text(
            value.channelId,
            /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/,
          ),
          ...(value.messageId !== undefined
            ? { messageId: text(value.messageId, hex).toLowerCase() }
            : {}),
          ...(value.threadRootId !== undefined
            ? { threadRootId: text(value.threadRootId, hex).toLowerCase() }
            : {}),
          ...(value.context === "channel" ? { context: value.context } : {}),
          ...(value.panel === "members" ? { panel: value.panel } : {}),
          ...(value.forward !== undefined
            ? { forward: text(value.forward, hex).toLowerCase() }
            : {}),
          ...(detail ? { detail } : {}),
        };
        break;
      }
      default:
        throw invalid();
    }
    if (new TextEncoder().encode(JSON.stringify(target)).length > MAX_BYTES)
      throw invalid();
    return Object.freeze(target);
  } catch {
    // Never echo arbitrary input, URL credentials, plugin route data or accessor errors.
    throw invalid();
  }
}

export function targetKey(target: OpenTarget): string {
  return JSON.stringify(parseOpenTarget(target));
}
