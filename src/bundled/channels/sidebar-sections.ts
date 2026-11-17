import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";

export function isChannelSectionKey(key: string) {
  return key === "channels" || key.startsWith("group:");
}

export type SidebarRowKind = "channel" | "dm";

const anyRow: readonly SidebarRowKind[] = ["channel", "dm"];
const channelRows: readonly SidebarRowKind[] = ["channel"];
const dmRows: readonly SidebarRowKind[] = ["dm"];
const noRows: readonly SidebarRowKind[] = [];

/**
 * Rows a pointer drop may place in a section. Starred and saved groups take
 * channels and DMs; Channels and Direct messages each take back only their own.
 */
export function sidebarDropRowKinds(key: string) {
  if (key === "starred" || key.startsWith("group:")) return anyRow;
  if (key === "channels") return channelRows;
  if (key === "dms") return dmRows;
  return noRows;
}

export function contributedSidebarSectionKey(key: string) {
  return `plugin:${key}`;
}

export function orderContributedSidebarSections<T extends { key: string }>(
  sections: readonly T[],
  order: readonly string[],
) {
  const position = new Map(order.map((key, index) => [key, index]));
  return sections
    .map((section, index) => ({ section, index }))
    .sort(
      (a, b) =>
        (position.get(a.section.key) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.section.key) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ section }) => section);
}

function compareName(a: ChannelSummary, b: ChannelSummary) {
  return a.name.toLowerCase() < b.name.toLowerCase()
    ? -1
    : a.name.toLowerCase() > b.name.toLowerCase()
      ? 1
      : a.id.localeCompare(b.id);
}

/** The sidebar's "recent" order: newest activity first, channels without known
 * activity after, then by name. */
export function compareRecent(a: ChannelSummary, b: ChannelSummary) {
  if (
    a.lastActivityAt !== undefined &&
    b.lastActivityAt !== undefined &&
    a.lastActivityAt !== b.lastActivityAt
  )
    return b.lastActivityAt - a.lastActivityAt;
  if (a.lastActivityAt !== undefined && b.lastActivityAt === undefined)
    return -1;
  if (a.lastActivityAt === undefined && b.lastActivityAt !== undefined)
    return 1;
  return compareName(a, b);
}

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections<T extends ChannelSummary>(
  channels: readonly T[],
  preferences?: SidebarPreferences,
  hiddenDms: ReadonlySet<string> = new Set(),
) {
  const active = channels.filter(
    (channel) =>
      !channel.archived && (!channel.hidden || channel.channelType === "dm"),
  );
  const streams = active.filter(
    (channel) =>
      channel.channelType !== "dm" && channel.channelType !== "forum",
  );
  const dms = active.filter(
    (channel) => channel.channelType === "dm" && !hiddenDms.has(channel.id),
  );
  const movable = [...streams, ...dms];
  const stars = new Set(preferences?.starred);
  const groups = preferences?.sections ?? [];
  const ids = new Set(groups.map((group) => group.id));
  const assignment = (id: string) => preferences?.assignments[id];
  const sort = (rows: readonly ChannelSummary[], key: string) =>
    [...rows].sort(
      preferences?.sort?.[key] === "recent" ? compareRecent : compareName,
    );
  return [
    {
      key: "starred",
      title: "Starred",
      icon: undefined,
      rows: sort(
        movable.filter((channel) => stars.has(channel.id)),
        "starred",
      ),
    },
    ...groups.map((group) => ({
      key: `group:${group.id}`,
      title: group.name,
      icon: group.icon,
      rows: sort(
        movable.filter(
          (channel) =>
            !stars.has(channel.id) && assignment(channel.id) === group.id,
        ),
        `section:${group.id}`,
      ),
    })),
    {
      key: "channels",
      title: "Channels",
      icon: undefined,
      rows: sort(
        streams.filter(
          (channel) =>
            !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
        ),
        "channels",
      ),
    },
    {
      key: "forums",
      title: "Forums",
      icon: undefined,
      rows: sort(
        active.filter((channel) => channel.channelType === "forum"),
        "forums",
      ),
    },
    {
      key: "dms",
      title: "Direct messages",
      icon: undefined,
      rows: sort(
        dms.filter(
          (channel) =>
            !stars.has(channel.id) && !ids.has(assignment(channel.id) ?? ""),
        ),
        "dms",
      ),
    },
  ].filter(
    (section) =>
      isChannelSectionKey(section.key) ||
      section.key === "dms" ||
      section.rows.length,
  );
}
