import { useMemo, useState } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { matchName } from "../../features/search/match";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import { channelIcon } from "../../features/channels/channel-icon";
import { useChannelLabels } from "../channels/useChannelLabels";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import type { IdentityNameView } from "../../features/identity-names/service";

export function WorkflowChannelPicker({
  channels,
  profiles,
  names,
  onSelect,
}: {
  channels: readonly ChannelSummary[];
  profiles: ProfileQueries;
  names?: IdentityNameView;
  onSelect: (id: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const nameCandidates = useMemo(
    () =>
      [
        ...new Set(
          channels.flatMap((channel) =>
            channel.channelType === "dm" ? (channel.participants ?? []) : [],
          ),
        ),
      ].sort(),
    [channels],
  );
  const labelled = useChannelLabels(
    channels,
    profiles,
    names,
    nameCandidates,
  ).channels;
  // useChannelLabels owns DM naming, but its visibility rules are for channel
  // lists; keep the workflow picker's existing eligible set unchanged.
  const choices = useMemo(() => {
    const labels = new Map(
      labelled.map((channel) => [channel.id, channel.name]),
    );
    return channels.map((channel) => {
      const name = labels.get(channel.id);
      return name === undefined || name === channel.name
        ? channel
        : { ...channel, name };
    });
  }, [channels, labelled]);
  // Order matches as the other pickers do, so Enter on the highlighted first
  // row picks an exact name before a longer one that contains it.
  const matches = useMemo(() => {
    const needle = typed.trim().toLowerCase();
    if (!needle) return choices;
    return choices
      .flatMap((channel) => {
        const rank = matchName(channel.name, needle)?.rank;
        return rank === undefined ? [] : [{ channel, rank }];
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ channel }) => channel);
  }, [choices, typed]);
  return (
    <div className="workflow-channel-picker">
      <Combobox.Root
        items={choices}
        filteredItems={matches}
        onInputValueChange={setTyped}
        itemToStringLabel={(channel: ChannelSummary) => channel.name}
        itemToStringValue={(channel: ChannelSummary) => channel.id}
        onValueChange={(channel) => {
          if (channel) onSelect(channel.id);
        }}
        defaultOpen
        // Typed text highlights the first match, so Enter picks it.
        autoHighlight
      >
        <Combobox.Control
          label="Choose a channel"
          triggerLabel="Browse channels"
          placeholder="Search channels…"
          autoFocus
        />
        <Combobox.Popup empty="No matching channels.">
          <Combobox.List>
            {(channel: ChannelSummary) => {
              const Icon = channelIcon(channel);
              return (
                <Combobox.Item key={channel.id} value={channel}>
                  <span className="workflow-channel-label">
                    <Icon size={18} aria-hidden="true" />
                    {channel.name}
                  </span>
                </Combobox.Item>
              );
            }}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Root>
    </div>
  );
}
