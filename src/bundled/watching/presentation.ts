import { relativeTimestamp } from "../../shared/relative-timestamp";
import {
  ChatCircleIcon,
  LockIcon,
  HashIcon,
} from "../../shared/design-system/icons";
import type { Watch } from "./model";
export const title = (id: string) =>
  id
    .replace(/^interest\//, "")
    .replace(
      /-(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32,64})$/i,
      "",
    )
    .replace(/[-_]+/g, " ");
export const recentMessages = (output: string) =>
  output.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) · ([^\n]+)\n/gm,
    (_header, timestamp: string, author: string) =>
      `${relativeTimestamp(Date.parse(timestamp) / 1000)}${/^[a-f0-9]{64}$/i.test(author) ? "" : ` · ${author}`}\n`,
  );
export function heading(value: string) {
  return {
    text: value
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#+\s*/, "")
      .replace(/\*\*|__|`/g, "")
      .trim(),
    url: /\]\((https:\/\/[^)\s]+)\)/.exec(value)?.[1],
  };
}
export function describe(
  watch: Watch,
  now = Date.now() / 1000,
  usedOccurrences?: number,
) {
  if (watch.type === "timer") {
    const used =
      usedOccurrences ??
      Math.max(0, Math.floor((now - watch.armed_at) / watch.interval_secs));
    const nextAt = watch.armed_at + watch.interval_secs;
    const next = new Date(nextAt * 1000);
    const date = next.toLocaleDateString();
    const day =
      date === new Date(now * 1000).toLocaleDateString() ? "today" : date;
    const time = next.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    const minutes = Math.ceil(Math.abs(nextAt - now) / 60);
    const relative = nextAt > now ? `in ${minutes}m` : `${minutes}m ago`;
    const interval =
      watch.interval_secs % 3600 === 0
        ? `${watch.interval_secs / 3600}h`
        : watch.interval_secs % 60 === 0
          ? `${watch.interval_secs / 60}m`
          : `${watch.interval_secs}s`;
    const runs =
      watch.max_occurrences === null ? "" : ` · ${watch.max_occurrences} runs`;
    const schedule =
      watch.max_occurrences === 1
        ? `Once · ${day} ${time} (${relative})`
        : `Every ${interval}${runs}`;
    return {
      title: schedule,
      spent:
        (watch.max_occurrences !== null && used >= watch.max_occurrences) ||
        (watch.expires_at !== null && now >= watch.expires_at),
    };
  }
  if (watch.type === "source")
    return {
      title: watch.name || watch.provider,
    };
  return {
    title: watch.name || "Messages",
  };
}
export type Channel = {
  id: string;
  name: string;
  channelType?: string;
  private?: true;
};
/** Matches the sidebar: chats and DMs, private channels, then ordinary channels. */
export const channelIcon = (channel?: Channel) =>
  channel?.channelType === "solo" || channel?.channelType === "dm"
    ? ChatCircleIcon
    : channel?.private
      ? LockIcon
      : HashIcon;
