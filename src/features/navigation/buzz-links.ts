import {
  entityTarget,
  parseEntityLink,
  type EntityRoute,
} from "../repos/routes";
import {
  parseGitPluginSource,
  parseUrlPluginSource,
  parseOpenTarget,
  type PluginLinkSource,
  type NavigationScope,
} from "./targets";

/** A published agent card's id: one path segment on the avatars CDN, such as
 * `tinker` or `av_…`. */
export const AGENT_CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

type BuzzLink =
  | { format: "plugin-install"; source: PluginLinkSource }
  | { format: "settings"; section?: string; provider?: string }
  | { format: "agent-card"; card: string }
  | { format: "removed" }
  | { format: "entity"; route: EntityRoute }
  | {
      format: "plugin";
      pluginId: string;
      pageId?: string;
      params?: Readonly<Record<string, string>>;
    }
  | {
      format: "legacy";
      channelId: string;
      messageId?: string;
      threadRootId?: string;
    };

/** True for any `buzz:` scheme link, regardless of case. Classification must
 * match `parseBuzzLink`, which normalizes the scheme via `URL`; a lowercase-only
 * `startsWith` check would misroute `BUZZ://…` to external handling. */
export function isBuzzLink(href: string): boolean {
  try {
    return new URL(href).protocol === "buzz:";
  } catch {
    return false;
  }
}

/** `buzz://plugin?id=<plugin>[&page=<page>][&route.<key>=<value>...]`. Ids and route
 * data pass the same bounds as the navigation target they become. */
function parsePluginLink(url: URL, href: string): BuzzLink | null {
  // Windows can supply an explicit root path before the query; URL normalizes
  // non-root paths such as /extra/.. to /, so check the raw form too.
  if (
    url.pathname !== "" &&
    (url.pathname !== "/" || !/^buzz:\/\/plugin\/\?/i.test(href))
  )
    return null;
  if (["id", "page"].some((key) => url.searchParams.getAll(key).length > 1))
    return null;
  const id = url.searchParams.get("id");
  const page = url.searchParams.get("page");
  const params = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (!name.startsWith("route.")) continue;
    const key = name.slice("route.".length);
    if (params.has(key)) return null;
    params.set(key, value);
  }
  try {
    const target = parseOpenTarget({
      version: 1,
      kind: "plugin",
      pluginId: id ?? "",
      ...(page !== null ? { pageId: page } : {}),
      ...(params.size ? { params: Object.fromEntries(params) } : {}),
    });
    if (target.kind !== "plugin") return null;
    const { version: _version, kind: _kind, scope: _scope, ...link } = target;
    return { format: "plugin", ...link };
  } catch {
    return null;
  }
}

/** `buzz://settings[?section=<section>][&provider=<agent type>]`, such as
 * an agent type's setup in Agent setup. Presentation only, like the Settings
 * target it becomes: opening one changes nothing. */
function parseSettingsLink(url: URL, href: string): BuzzLink | null {
  if (
    url.pathname !== "" &&
    (url.pathname !== "/" || !/^buzz:\/\/settings\/\?/i.test(href))
  )
    return null;
  if (
    ["section", "provider"].some(
      (key) => url.searchParams.getAll(key).length > 1,
    )
  )
    return null;
  const section = url.searchParams.get("section");
  const provider = url.searchParams.get("provider");
  try {
    const target = parseOpenTarget({
      version: 1,
      kind: "settings",
      ...(section !== null ? { section } : {}),
      ...(provider !== null ? { provider } : {}),
    });
    if (target.kind !== "settings") return null;
    return {
      format: "settings",
      ...(target.section !== undefined && { section: target.section }),
      ...(target.provider !== undefined && { provider: target.provider }),
    };
  } catch {
    return null;
  }
}

/** The Agents page, starting an agent from card `card` in `scope`. */
export const agentCardTarget = (card: string, scope: NavigationScope) =>
  ({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope,
    route: { version: 1, params: { card } },
  }) as const;

/** Legacy links are relative to the receiving conversation's community, never an access grant. */
export function parseBuzzLink(href: string): BuzzLink | null {
  try {
    if (href.length > 32768) return null;
    const url = new URL(href);
    if (
      url.protocol !== "buzz:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    if (url.hostname === "plugin-install") {
      if (
        (url.pathname !== "" &&
          (url.pathname !== "/" ||
            !/^buzz:\/\/plugin-install\/\?/i.test(href))) ||
        ["repository", "ref", "path", "commit", "url", "sha256", "id"].some(
          (key) => url.searchParams.getAll(key).length > 1,
        )
      )
        return null;
      const artifact = url.searchParams.has("url");
      if (
        (artifact
          ? ["repository", "ref", "path", "commit"]
          : ["sha256", "id"]
        ).some((key) => url.searchParams.has(key))
      )
        return null;
      if (artifact)
        return {
          format: "plugin-install",
          source: parseUrlPluginSource({
            id: url.searchParams.get("id") ?? "",
            url: url.searchParams.get("url") ?? "",
            sha256: url.searchParams.get("sha256") ?? "",
          }),
        };
      return {
        format: "plugin-install",
        source: parseGitPluginSource({
          repository: url.searchParams.get("repository") ?? "",
          reference: url.searchParams.get("ref") ?? "",
          ...(url.searchParams.has("path")
            ? { path: url.searchParams.get("path") }
            : {}),
          ...(url.searchParams.has("commit")
            ? { commit: url.searchParams.get("commit") }
            : {}),
        }),
      };
    }
    // `buzz://agent/new?card=<id>`, as Buzz mobile reads it.
    if (url.hostname === "agent") {
      const cards = url.searchParams.getAll("card");
      const card = cards[0] ?? "";
      return url.pathname === "/new" &&
        cards.length === 1 &&
        AGENT_CARD_ID.test(card)
        ? { format: "agent-card", card }
        : null;
    }
    if (
      url.hostname === "project" &&
      (url.pathname === "" || url.pathname === "/")
    )
      return { format: "removed" };
    const entity = parseEntityLink(url);
    if (entity) return { format: "entity", route: entity };
    if (url.hostname === "plugin") return parsePluginLink(url, href);
    if (url.hostname === "settings") return parseSettingsLink(url, href);
    const channelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
    const eventPattern = /^[a-f0-9]{64}$/i;
    // Query parameters outside a form's grammar are ignored, values and repeats
    // included, as the original Buzz desktop client does. The channel forms carry
    // everything in the path, so any query is ignored there.
    if (url.hostname === "channel") {
      const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const [channelId = "", messageId] = parts;
      if (
        parts.length > 2 ||
        !channelPattern.test(channelId) ||
        (messageId !== undefined && !eventPattern.test(messageId))
      )
        return null;
      return {
        format: "legacy",
        channelId,
        ...(messageId ? { messageId: messageId.toLowerCase() } : {}),
      };
    }
    // Windows can supply an explicit root path before the query. Check its raw
    // form too: URL normalizes non-root paths such as /extra/.. to /.
    if (
      url.hostname !== "message" ||
      (url.pathname !== "" &&
        (url.pathname !== "/" || !/^buzz:\/\/message\/\?/i.test(href)))
    )
      return null;
    // A duplicated known key is ambiguous and still rejects.
    if (
      ["channel", "id", "thread"].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      return null;
    const channelId = url.searchParams.get("channel") ?? "";
    const messageId = url.searchParams.get("id") ?? "";
    const threadRootId = url.searchParams.get("thread");
    if (
      !channelPattern.test(channelId) ||
      !eventPattern.test(messageId) ||
      (threadRootId !== null && !eventPattern.test(threadRootId))
    )
      return null;
    return {
      format: "legacy",
      channelId,
      messageId: messageId.toLowerCase(),
      ...(threadRootId ? { threadRootId: threadRootId.toLowerCase() } : {}),
    };
  } catch {
    return null;
  }
}

/** A settings link's target; it has no community scope. */
export const settingsTarget = ({
  section,
  provider,
}: Readonly<{ section?: string; provider?: string }>) =>
  ({
    version: 1,
    kind: "settings",
    ...(section !== undefined && { section }),
    ...(provider !== undefined && { provider }),
  }) as const;

export function buzzLinkKind(href: string) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format !== "legacy") return "buzz";
  return link.threadRootId ? "thread" : link.messageId ? "message" : "channel";
}

export function buzzLinkTarget(href: string, scope: NavigationScope) {
  const link = parseBuzzLink(href);
  if (!link) return null;
  if (link.format === "plugin-install")
    return parseOpenTarget({
      version: 1,
      kind: "settings",
      section: "plugins",
      pluginImport: link.source,
    });
  if (link.format === "settings") return settingsTarget(link);
  if (link.format === "entity") return entityTarget(link.route, scope);
  if (link.format === "agent-card") return agentCardTarget(link.card, scope);
  if (link.format === "removed")
    return {
      version: 1,
      kind: "page",
      pluginId: "buzz.repos",
      pageId: "repos",
      scope,
    } as const;
  const { format: _format, ...destination } = link;
  // The link was size-checked without its scope, which can push it past the target limit.
  try {
    return parseOpenTarget({
      version: 1,
      kind: link.format === "plugin" ? "plugin" : "conversation",
      scope,
      ...destination,
    });
  } catch {
    return null;
  }
}
