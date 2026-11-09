import { useProfileGeneration } from "../../features/relay/react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useHeaderChannel } from "../../features/relay/listed-channel";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { UsersIcon, RobotIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { PROFILE_CACHE_BASE } from "../../features/relay/budget";

const noMembers: readonly string[] = [];

/** Preview people in channels/DMs and participating agents in Solo chats. */
export function ChannelMemberAvatars({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const members =
    useHeaderChannel(
      session.channels,
      channelId,
      (channel) => channel?.members,
    ) ?? noMembers;
  // Separate selections of stable primitives avoid a memoized members/solo tuple.
  const solo = useHeaderChannel(
    session.channels,
    channelId,
    (channel) => channel?.channelType === "solo",
  );
  const memberKey = useMemo(() => members.join(":"), [members]);
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    // Three avatars need no more than the base cache. An open channel reserves
    // room for its whole roster, but only the mention menu reads all of it.
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":").slice(0, PROFILE_CACHE_BASE), "background")
        .catch(() => {});
  }, [session, memberKey, profileGeneration]);
  const agents = useMemo(
    () => new Map(choices.identities.map((agent) => [agent.pubkey, agent])),
    [choices],
  );
  const preview = useMemo(
    () =>
      members
        .filter((id) =>
          solo
            ? agents.has(id) || profiles.get(id)?.isAgent
            : !agents.has(id) && !profiles.get(id)?.isAgent,
        )
        // Prefer recognizable photos over key-only placeholders.
        .sort(
          (a, b) =>
            Number(!!profiles.get(b)?.picture) -
            Number(!!profiles.get(a)?.picture),
        ),
    [members, solo, agents, profiles],
  );
  if (!preview.length) {
    const Icon = solo ? RobotIcon : UsersIcon;
    return (
      <Avatar
        size="small"
        shape="circle"
        alt=""
        fallback={solo ? "Agents" : "Members"}
        fallbackContent={<Icon size="1rem" aria-hidden="true" />}
      />
    );
  }
  const shown = 3;
  return (
    <AvatarStack
      size="small"
      max={shown}
      items={preview.map((id, index) =>
        // Members past the shown ones only count.
        index < shown
          ? {
              id,
              name: resolveName(
                id,
                profiles.get(id)?.name ??
                  agents.get(id)?.name ??
                  formatPublicKey(id) ??
                  "Member",
              ),
              src: avatarMedia(
                profiles.get(id)?.picture ?? agents.get(id)?.avatar,
                session.media,
              ),
              shape: solo ? "squircle" : "circle",
            }
          : { id, name: "", shape: solo ? "squircle" : "circle" },
      )}
    />
  );
}
