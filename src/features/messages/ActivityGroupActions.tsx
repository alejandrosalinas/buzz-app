import { useChannelIdentityNames } from "../identity-names/react";
import type { MessageLinkOrigin } from "./MessageRow";
import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon, StopIcon, XIcon } from "../../shared/design-system/icons";
import { AgentsContext, useAgentsSnapshot } from "../agents/react";
import { requestWork } from "../agents/request-work";
import { workStop } from "../agents/work-stop";
import { useWorkStops } from "../agents/use-work-stops";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../profiles/target";
import type { RelaySession } from "../relay/session";
import type { Profile } from "../relay/contracts";
import {
  useChannelActivitySnapshot,
  type ActivityPresentation,
} from "./activity-presentation";

const noSubscribe = () => () => {};

/** The visible history owns navigation and controls for its exact request. */
export function ActivityGroupActions({
  session,
  group,
  profiles,
  open,
  canOpen,
  returnFocus,
  active,
}: {
  returnFocus: RefObject<HTMLButtonElement | null>;
  /** False while the history is collapsed; a pending stop keeps tracking. */
  active: boolean;
  session: RelaySession;
  group: ActivityPresentation;
  profiles: ReadonlyMap<string, Profile>;
  open?: ((target: string, origin?: MessageLinkOrigin) => boolean) | undefined;
  canOpen?: ((target: string) => boolean) | undefined;
}) {
  // Ref cleanup runs before a retired button detaches, while it still owns focus.
  const stopRef = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return;
      return () => {
        const document = node.ownerDocument;
        if (document.activeElement !== node) return;
        queueMicrotask(() => {
          const target = returnFocus.current;
          if (
            !node.isConnected &&
            target?.isConnected &&
            document.activeElement === document.body
          ) {
            target.focus({ preventScroll: true });
          }
        });
      };
    },
    [returnFocus],
  );
  // Collapsed controls are hidden; follow live work only while shown or
  // while a stop awaits its evidence, so its pending state still resolves.
  const stopping = useRef(false);
  const tracking = active || stopping.current;
  const channelId = group.latest.channelId;
  const channels = useMemo(() => new Set([channelId]), [channelId]);
  const snapshot = useChannelActivitySnapshot(
    tracking ? session.agentActivity : undefined,
    channels,
  );
  const choices = useSyncExternalStore(
    tracking ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, group.latest.channelId);
  const named = (agent: string) =>
    resolveName(
      agent,
      profiles.get(agent)?.name ??
        choices.identities.find((row) => row.pubkey === agent)?.name ??
        agent.slice(0, 10),
    );
  const notify = useToastNotification();
  const agents = useContext(AgentsContext);
  useAgentsSnapshot(tracking ? agents : undefined);
  const { requestId, latest, participants } = group;
  const work =
    snapshot && requestId
      ? requestWork(snapshot, latest.channelId, requestId)
      : [];
  const controls = work.flatMap((entry) => {
    if (!requestId || !group.liveParticipants.includes(entry.agent)) return [];
    const control = workStop(
      entry,
      {
        channelId: latest.channelId,
        messageId: requestId,
        threadRootId: latest.threadRootId ?? requestId,
      },
      session.agentActivity,
      agents,
    );
    return control ? [{ control, agent: entry.agent }] : [];
  });
  const { pending, stop } = useWorkStops(controls.map((row) => row.control));
  stopping.current = pending.size > 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {participants.map((agent) => {
        const name = named(agent);
        const target = profileActivityViewTarget(agent);
        return target && open && canOpen?.(target) ? (
          <IconButton
            key={agent}
            size="sm"
            variant="subtle"
            aria-label={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            title={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            icon={<InfoIcon aria-hidden="true" />}
            onClick={() =>
              openProfileTranscript(target, (next) =>
                open(
                  next,
                  latest.threadRootId
                    ? { rootId: latest.threadRootId }
                    : undefined,
                ),
              )
            }
          />
        ) : null;
      })}
      {work
        .filter(
          (entry) =>
            entry.lifecycle &&
            entry.state === "error" &&
            !entry.dismissed &&
            group.liveParticipants.includes(entry.agent),
        )
        .map((entry) => (
          <span key={entry.agent} className="inline-flex items-center gap-1">
            {entry.retryable && (
              <Button
                size="sm"
                variant="subtle"
                aria-label={`Retry ${named(entry.agent)}`}
                onClick={() => {
                  if (!requestId) return;
                  try {
                    session.agentActivity.retry(
                      entry.agent,
                      channelId,
                      requestId,
                    );
                    returnFocus.current?.focus({ preventScroll: true });
                  } catch (error) {
                    notify(
                      `Couldn’t retry ${named(entry.agent)}. ${error instanceof Error ? error.message : String(error)}`,
                      "error",
                    );
                  }
                }}
              >
                Retry
              </Button>
            )}
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={`Dismiss error from ${named(entry.agent)}`}
              icon={<XIcon aria-hidden="true" />}
              onClick={() => {
                if (requestId)
                  session.agentActivity.dismissError?.(
                    entry.agent,
                    channelId,
                    requestId,
                  );
                returnFocus.current?.focus({ preventScroll: true });
              }}
            />
          </span>
        ))}
      {controls.map(({ control, agent }) => {
        const name = named(agent);
        return (
          <IconButton
            key={control.key}
            ref={stopRef}
            size="sm"
            variant="subtle"
            aria-label={`Stop ${name}`}
            title={`Stop ${name}`}
            icon={<StopIcon aria-hidden="true" />}
            loading={pending.has(control.key)}
            onClick={() => void stop(control, name)}
          />
        );
      })}
    </div>
  );
}
