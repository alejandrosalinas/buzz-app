import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import type { ActivityFilter, SenderFilter } from "./InboxFilters";

/** Activity's page address; the route contract below applies only to it. */
export const inboxTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
} as const;

/** Filters an open asks the Activity page to show; omitted choices stay as saved. */
export type InboxRoute = {
  attention?: "all" | "unread";
  activity?: ActivityFilter;
  sender?: SenderFilter;
};
type Filters = Required<InboxRoute>;
// Keyed by each union so a value added to one fails to compile until listed here.
const filters: {
  readonly [K in keyof Filters]: Readonly<Record<Filters[K], true>>;
} = {
  attention: { all: true, unread: true },
  activity: { all: true, threads: true, mentions: true, dms: true },
  sender: { everyone: true, humans: true, agents: true },
};
// Links made while the page had Archived and Drafts views still open it:
// `show` is accepted and ignored, and `drafts` alone opens the saved filters.
const retiredShow: Readonly<Record<string, true>> = {
  inbox: true,
  archived: true,
};

function inboxRoute(params: JsonValue | undefined): InboxRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  const keys = Object.keys(value);
  // buzz:// plugin links carry every route value as a string.
  if (keys.includes("drafts"))
    return keys.length === 1 &&
      (value.drafts === true || value.drafts === "true")
      ? {}
      : undefined;
  if (
    keys.some((key) => {
      const choice = value[key];
      if (typeof choice !== "string") return true;
      if (key === "show") return !Object.hasOwn(retiredShow, choice);
      return (
        !Object.hasOwn(filters, key) ||
        !Object.hasOwn(filters[key as keyof Filters], choice)
      );
    })
  )
    return;
  return Object.fromEntries(
    keys.filter((key) => key !== "show").map((key) => [key, value[key]]),
  ) as InboxRoute;
}

export const isInboxRoute = (params: JsonValue) => !!inboxRoute(params);

/** The route a visit carries, if any; a plain Activity open has none. */
export function routeOf(target: OpenTarget | undefined) {
  if (target?.kind !== "page" || target.route?.version !== 1) return;
  return inboxRoute(target.route.params);
}

/** An open that shows the Activity page with these filters applied. */
export const inboxRouteTarget = (params: InboxRoute): OpenTarget => ({
  ...inboxTarget,
  route: { version: 1, params },
});
