import {
  entityTarget,
  parseEntityLink,
  type EntityRoute,
} from "../repos/routes";
import {
  CHANNEL_ID,
  parseGitPluginSource,
  parseOpenTarget,
  type GitPluginSource,
  type NavigationScope,
} from "./targets";

type BuzzLink =
  | { format: "plugin-install"; source: GitPluginSource }
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
        ["repository", "ref", "path", "commit"].some(
          (key) => url.searchParams.getAll(key).length > 1,
        )
      )
        return null;
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
    if (
      url.hostname === "project" &&
      (url.pathname === "" || url.pathname === "/")
    )
      return { format: "removed" };
    const entity = parseEntityLink(url);
    if (entity) return { format: "entity", route: entity };
    if (url.hostname === "plugin") return parsePluginLink(url, href);
    const eventPattern = /^[a-f0-9]{64}$/i;
    // Query parameters outside a form's grammar are ignored, values and repeats
    // included, as the original Buzz desktop client does. The channel forms carry
    // everything in the path, so any query is ignored there.
    if (url.hostname === "channel") {
      const parts = url.pathname.slice(1).split("/").map(decodeURIComponent);
      const [channelId = "", messageId] = parts;
      if (
        parts.length > 2 ||
        !CHANNEL_ID.test(channelId) ||
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
      !CHANNEL_ID.test(channelId) ||
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
  if (link.format === "entity") return entityTarget(link.route, scope);
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
