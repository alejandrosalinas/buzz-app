import { useContext, useLayoutEffect, useSyncExternalStore } from "react";
import { channelIcon } from "../../features/channels/channel-icon";
import { usePublicChannelSearch } from "../../features/channels/usePublicChannelSearch";
import type {
  CompletionSuggestion,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import {
  WorkspaceCompletion,
  workspaceEdit,
} from "../../features/conversation/workspace-completion";
import { Cube3dSphereIcon } from "../../shared/design-system/icons";
import type { ChannelSummary } from "../../features/relay/contracts";
import { MatchRank, matchName } from "../../features/search/match";

const LIMIT = 20;
/** Rows kept for open channels when joined matches would fill the list. */
const OPEN_SLOTS = 5;

function referable(channel: ChannelSummary) {
  return (
    !!channel.name.trim() &&
    !/[\r\n]/.test(channel.name) &&
    !channel.huddle &&
    !channel.metadataPending &&
    !channel.archived &&
    !channel.hidden &&
    channel.channelType !== "dm" &&
    channel.channelType !== "solo"
  );
}

/** Joined channels, including ones restored from cache while the relay
 * reconfirms them: the store marks those read-only until then, but a
 * reference names a channel, it grants nothing. */
function joined(channel: ChannelSummary, viewer: string | undefined) {
  return (
    !!viewer &&
    referable(channel) &&
    (!channel.readOnly || channel.viewerRole === "guest" || !!channel.cached) &&
    !!channel.members?.includes(viewer)
  );
}

/** An open channel the viewer can preview but hasn't joined. */
function open(channel: ChannelSummary) {
  return (
    !!channel.readOnly &&
    channel.viewerRole !== "guest" &&
    !channel.private &&
    referable(channel)
  );
}

/** The channel name rule the other channel pickers use (`matchName`), without
 * its last, scattered-letter rank: Enter and Tab pick the first row while the
 * viewer is writing prose, so letters merely in order must not capture a
 * `#word`. Letter runs that each begin a word (`team-pl`, `tlp`) still
 * match, as in Command-K. A query with a space matches only from the start
 * of a name, as person names do, so ordinary prose after `#name` closes the
 * popup. */
function rank(name: string, needle: string) {
  const found = matchName(name, needle)?.rank;
  if (found === undefined || found > MatchRank.wordRuns) return undefined;
  if (/\s/u.test(needle) && found > MatchRank.prefix) return undefined;
  return found;
}

export function ChannelCompletion({
  session,
  query,
  publish,
}: ComposerCompletionProps) {
  const needle = query.query.toLowerCase();
  // A new chat's workspaces come first; choosing one leaves no link.
  const preferences = useContext(WorkspaceCompletion)?.preferences;
  const listReady = useSyncExternalStore(
    session.channels.subscribeList,
    () => session.channels.list().status === "ready",
  );
  // Open channels the viewer hasn't joined. Joined matches still complete
  // when this fails: open-channel search is best effort.
  const search = usePublicChannelSearch(session, needle, listReady);
  const { loading: searching, found: discovered, partial, error } = search;
  const retrySearch = search.retry;
  useLayoutEffect(() => {
    let withdraw: (() => void) | false | undefined;
    const update = () => {
      // Withdraw at the data boundary, not after a later React render.
      if (withdraw) withdraw();
      const list = session.channels.list();
      const places = (preferences?.snapshot().data?.sections ?? [])
        .flatMap((section) => {
          const found = rank(section.name, needle);
          return found === undefined ? [] : [{ section, rank: found }];
        })
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.section.name.localeCompare(b.section.name) ||
            a.section.id.localeCompare(b.section.id),
        )
        .slice(0, LIMIT);
      const room = LIMIT - places.length;
      const names = new Map<string, number>();
      const ranked = (channel: ChannelSummary) => {
        const name = channel.name.toLowerCase();
        names.set(name, (names.get(name) ?? 0) + 1);
        const found = rank(channel.name, needle);
        return found === undefined ? [] : [{ channel, rank: found }];
      };
      const order = (
        a: { channel: ChannelSummary; rank: number },
        b: { channel: ChannelSummary; rank: number },
      ) =>
        a.rank - b.rank ||
        a.channel.name.localeCompare(b.channel.name) ||
        a.channel.id.localeCompare(b.channel.id);
      const mine = list.channels
        .flatMap((channel) =>
          joined(channel, session.viewer) ? ranked(channel) : [],
        )
        .sort(order);
      const ids = new Set(mine.map(({ channel }) => channel.id));
      // A search result joined or removed since the lookup leaves this set.
      const others = discovered
        .flatMap((channel) => {
          const current = session.channels.get?.(channel.id);
          return current && !ids.has(current.id) && open(current)
            ? ranked(current)
            : [];
        })
        .sort(order);
      // Open channels follow joined ones, so a late search result never
      // moves the row Enter or Tab would pick. A few rows stay reserved for
      // them when joined matches alone would fill the list.
      const shownMine = mine.slice(
        0,
        Math.max(0, room - Math.min(others.length, OPEN_SLOTS)),
      );
      const shown = [
        ...shownMine.map(({ channel }) => ({ channel, member: true })),
        ...others
          .slice(0, room - shownMine.length)
          .map(({ channel }) => ({ channel, member: false })),
      ];
      const settling = list.status === "loading" || list.status === "idle";
      const item = (
        channel: ChannelSummary,
        member: boolean,
      ): CompletionSuggestion => {
        const Icon = channelIcon(channel);
        const duplicate = (names.get(channel.name.toLowerCase()) ?? 0) > 1;
        const label = `#${channel.name}`.replace(/[\\`*_[\]()#<>~&]/g, "\\$&");
        const id = encodeURIComponent(channel.id).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16)}`,
        );
        const detail = [
          channel.private ? "Private channel" : "",
          member ? "" : "Not joined",
          duplicate ? channel.id : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          id: channel.id,
          label: channel.name,
          ...(detail ? { detail } : {}),
          preview: <Icon size={22} />,
          edit: { text: `[${label}](buzz://channel/${id})` },
          canSelect: () => {
            const current = member
              ? session.channels
                  .list()
                  .channels.find((entry) => entry.id === channel.id)
              : session.channels.get?.(channel.id);
            return (
              !!current &&
              current.name === channel.name &&
              (member ? joined(current, session.viewer) : open(current))
            );
          },
        };
      };
      const status = list.error
        ? "Could not refresh channels."
        : !shown.length && settling
          ? "Loading channels…"
          : searching
            ? "Searching open channels…"
            : error
              ? "Could not search open channels."
              : mine.length + others.length > room
                ? "Keep typing to narrow the list."
                : // Prose stays silent: the note joins rows already shown.
                  partial && shown.length && !others.length
                  ? "Only the newest open channels were searched."
                  : undefined;
      const retry = list.error
        ? session.channels.refreshList &&
          (() => session.channels.refreshList?.())
        : !searching && error
          ? retrySearch
          : undefined;
      withdraw = publish({
        items: [
          ...places.map(
            ({ section }): CompletionSuggestion => ({
              id: `workspace:${section.id}`,
              label: section.name,
              detail: "Workspace",
              preview: <Cube3dSphereIcon size={22} />,
              edit: workspaceEdit(section.id),
              canSelect: () =>
                !!preferences
                  ?.snapshot()
                  .data?.sections.some((entry) => entry.id === section.id),
            }),
          ),
          ...shown.map(({ channel, member }) => item(channel, member)),
        ],
        ...(status ? { status } : {}),
        ...(retry ? { retry } : {}),
      });
    };
    const unsubscribe = session.channels.subscribeList(update);
    // Workspaces can load after `#` opens.
    const unsubscribeWorkspaces = preferences?.subscribe(update);
    update();
    return () => {
      unsubscribe();
      unsubscribeWorkspaces?.();
      if (withdraw) withdraw();
    };
  }, [
    session,
    preferences,
    needle,
    publish,
    discovered,
    searching,
    partial,
    error,
    retrySearch,
  ]);
  return null;
}
