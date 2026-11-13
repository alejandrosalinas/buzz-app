import { useIdentityNames } from "../../features/identity-names/react";
import type { IdentityNameView } from "../../features/identity-names/service";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { selectProfiles } from "../../features/relay/profile-selection";
import { sortParticipantNames } from "../../features/identity-names/participant-order";

/** Share bounded profiles, not per-row fetches; pickers may widen the name scope. */
export function useChannelLabels(
  roster: readonly ChannelSummary[],
  queries: ProfileQueries,
  names?: IdentityNameView,
  nameCandidates?: readonly string[],
) {
  const resolveName = useIdentityNames(names);
  const channels = useMemo(
    () =>
      roster.filter(
        (channel) =>
          !channel.archived &&
          (!channel.hidden || channel.channelType === "dm"),
      ),
    [roster],
  );
  const key = useMemo(
    () =>
      [...new Set(channels.flatMap((channel) => channel.participants ?? []))]
        .sort()
        .slice(0, 1024)
        .join(":"),
    [channels],
  );
  const ids = useMemo(() => (key ? key.split(":") : []), [key]);
  const selection = useMemo(() => selectProfiles(queries, ids), [queries, ids]);
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  // A name read can come back empty or fail (offline), and a full cache clear
  // empties the directory, without changing DM participants. Retry missing
  // names when channel membership changes, not for message previews/renders;
  // keep enrichment in the background, which skips names a read on this
  // connection found absent.
  const membership = useMemo(
    () =>
      roster
        .map((channel) => channel.id)
        .sort()
        .join(":"),
    [roster],
  );
  const missing = ids.filter((id) => !profiles.has(id)).join(":");
  useEffect(() => {
    if (membership && missing)
      void queries.ensure(missing.split(":"), "background").catch(() => {});
  }, [queries, missing, membership]);
  const labelled = useRef(
    new WeakMap<
      ChannelSummary,
      {
        name: string;
        channel: ChannelSummary;
        profiles: typeof profiles;
        resolveName: typeof resolveName;
        nameCandidates: typeof nameCandidates;
      }
    >(),
  );
  const labelledChannels = useMemo(
    () =>
      channels.map((channel) => {
        if (channel.channelType !== "dm" || !channel.participants)
          return channel;
        // Roster changes keep unchanged channels; their names need no lookup.
        const previous = labelled.current.get(channel);
        if (
          previous?.profiles === profiles &&
          previous.resolveName === resolveName &&
          previous.nameCandidates === nameCandidates
        )
          return previous.channel;
        const name = channel.participants.length
          ? sortParticipantNames(
              channel.participants.map((id) =>
                resolveName(
                  id,
                  profiles.get(id)?.name ?? id.slice(0, 10),
                  nameCandidates ?? channel.participants,
                ),
              ),
            ).join(", ")
          : "Notes to self";
        const result =
          previous?.name === name ? previous.channel : { ...channel, name };
        labelled.current.set(channel, {
          name,
          channel: result,
          profiles,
          resolveName,
          nameCandidates,
        });
        return result;
      }),
    [channels, profiles, resolveName, nameCandidates],
  );
  return { channels: labelledChannels, profiles };
}
