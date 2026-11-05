import { useCallback, useState, useSyncExternalStore } from "react";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { LinkBreakIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { ChannelLauncherProps } from "../../features/panels/service";
import { useRelayConnection } from "../../features/relay/react";
import type { ChatIconProps } from "../../features/conversation/service";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { ownSolo } from "../../features/solo/labels";
import { writeLink, type SoloPulls } from "./solo-pull";
import { describePull, pullTone, stateIcons } from "./pull-state-view";
import styles from "./GitHub.module.css";
import { useOpenGitHubLinksInBuzz } from "./link-preference";

/** A Solo chat's linked pull request in place of its chat icon. */
export function SoloPullIcon({
  pulls,
  channelId,
  fallback,
}: Pick<ChatIconProps, "channelId" | "fallback"> & { pulls: SoloPulls }) {
  const pull = useSoloPull(pulls, channelId);
  if (!pull) return fallback;
  const Icon = stateIcons[pull.state?.state ?? "open"];
  return (
    <span className={styles.soloPull} data-tone={pullTone(pull)}>
      <Icon size={16} aria-hidden="true" />
      <span className="sr-only">{describePull(pull)}: </span>
    </span>
  );
}

/** Reuses the sidebar's linked state and the conversation host's panel opener. */
export function SoloPullLauncher({
  relay,
  pullsFor,
  context,
  open,
  canOpen,
}: ChannelLauncherProps & {
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
}) {
  const connection = useRelayConnection(relay);
  const list = useChannelList(connection.session.channels);
  if (
    list.channels.find((channel) => channel.id === context.channelId)
      ?.channelType !== "solo" ||
    connection.scope !== context.scope ||
    connection.viewer !== context.viewer
  )
    return null;
  return (
    <SessionPullLauncher
      pulls={pullsFor(connection.session)}
      channelId={context.channelId}
      open={open}
      canOpen={canOpen}
    />
  );
}

export function SessionPullLauncher({
  pulls,
  channelId,
  open,
  canOpen,
}: {
  pulls: SoloPulls;
  channelId: string;
  open(target: string): boolean;
  canOpen(target: string): boolean;
}) {
  const inBuzz = useOpenGitHubLinksInBuzz();
  const pull = useSoloPull(pulls, channelId);
  if (!pull) return null;
  const label = `Open linked ${describePull(pull).toLowerCase()}`;
  const Icon = stateIcons[pull.state?.state ?? "open"];
  return (
    <IconButton
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={inBuzz && !canOpen(pull.url)}
      icon={<Icon size="1rem" aria-hidden="true" />}
      {...(inBuzz
        ? { onClick: () => open(pull.url) }
        : {
            nativeButton: false,
            role: "link",
            render: (props) => (
              <a
                {...props}
                href={pull.url}
                target="_blank"
                rel="noopener noreferrer"
              />
            ),
          })}
    />
  );
}

function useSoloPull(pulls: SoloPulls, channelId: string) {
  const subscribe = useCallback(
    (listener: () => void) => pulls.watch(channelId, listener),
    [pulls, channelId],
  );
  return useSyncExternalStore(subscribe, () => pulls.get(channelId));
}

/** Links the pull request in the panel to the Solo chat it was opened from,
 * where the person's app can write the link. */
export function SoloPullLink({
  relay,
  pullsFor,
  channelId,
  url,
}: {
  relay: RelayData;
  pullsFor(session: RelaySession): SoloPulls;
  channelId: string;
  url: string;
}) {
  const state = useSyncExternalStore(relay.subscribe, relay.snapshot);
  return state.status === "ready" && state.session.configArtifactWriter ? (
    <SessionPullLink
      key={state.generation}
      session={state.session}
      pulls={pullsFor(state.session)}
      channelId={channelId}
      url={url}
    />
  ) : null;
}

function SessionPullLink({
  session,
  pulls,
  channelId,
  url,
}: {
  session: RelaySession;
  pulls: SoloPulls;
  channelId: string;
  url: string;
}) {
  const list = useChannelList(session.channels);
  const linked = useSoloPull(pulls, channelId)?.url === url;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const channel = list.channels.find((item) => item.id === channelId);
  if (!ownSolo(channel, session.viewer)) return null;
  const change = async (next: string | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await writeLink(session, channelId, next);
      pulls.linked(channelId, next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.soloLink}>
      <span className={styles.pullActionNote}>
        {linked
          ? "Shown in the sidebar for this chat."
          : "Show this pull request’s state in the sidebar for this chat."}
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={() => void change(linked ? null : url)}
      >
        {linked ? "Unlink" : "Link to this chat"}
      </Button>
      {error && (
        <p role="alert" className={styles.pullActionError}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SoloPullMenu({
  session,
  pulls,
  channelId,
}: {
  session: RelaySession;
  pulls: SoloPulls;
  channelId: string;
}) {
  const pull = useSoloPull(pulls, channelId);
  const list = useChannelList(session.channels);
  const [busy, setBusy] = useState(false);
  const notify = useToastNotification();
  const channel = list.channels.find((item) => item.id === channelId);
  if (
    !pull ||
    !ownSolo(channel, session.viewer) ||
    channel?.archived ||
    channel?.readOnly
  )
    return null;
  return (
    <MenuItem
      disabled={busy || !session.configArtifactWriter || !session.snapshotRead}
      title={
        !session.configArtifactWriter || !session.snapshotRead
          ? "Unlinking needs a native desktop relay connection."
          : undefined
      }
      closeOnClick={false}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await writeLink(session, channelId, null);
          pulls.linked(channelId, null);
          notify("Pull request unlinked", "success");
        } catch (error) {
          notify(
            error instanceof Error
              ? error.message
              : "Couldn’t unlink pull request. Try again.",
            "error",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <MenuIcon>
        <LinkBreakIcon size={16} />
      </MenuIcon>
      {busy ? "Unlinking pull request…" : "Unlink pull request"}
    </MenuItem>
  );
}
