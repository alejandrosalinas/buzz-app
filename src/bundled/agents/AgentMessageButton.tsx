import { useEffect, useRef, useState } from "react";
import { canMessageAgent } from "../../features/agents/choices";
import { newMessageTarget } from "../../features/channel-navigation/routes";
import {
  directMessageWith,
  messagePerson,
} from "../../features/direct-messages/message-person";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";

/** Open your DM with the agent, or a draft to them, without sending a message. */
export function AgentMessageButton({
  pubkey,
  relay,
  navigator,
  navigation,
  variant = "subtle",
}: {
  variant?: "glass" | "subtle";
  pubkey: string;
  relay: RelayData;
  navigator: Navigation | undefined;
  navigation: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const attempt = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Changing identity or session retires the outstanding open attempt.
  useEffect(() => {
    setOpening(false);
    setError("");
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [pubkey, connection.session, connection.generation, navigation?.signal]);
  const available =
    connection.status === "ready" &&
    connection.session.directMessages.available &&
    !!navigator &&
    !!connection.viewer &&
    !!connection.origin &&
    connection.viewer !== pubkey;
  const open = async (refresh = false) => {
    const { viewer, origin } = connection;
    if (
      !available ||
      !viewer ||
      !origin ||
      !navigator ||
      attempt.current ||
      navigation?.signal.aborted
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    const abort = () => controller.abort();
    navigation?.signal.addEventListener("abort", abort, { once: true });
    setOpening(true);
    setError("");
    try {
      const session = connection.session;
      if (refresh) await session.agentChoices.refresh();
      controller.signal.throwIfAborted();
      if (relay.snapshot().session !== session) return;
      const existing = directMessageWith(
        session.channels.list().channels,
        pubkey,
      );
      const choices = session.agentChoices.snapshot();
      if (
        !existing &&
        !choices.identities.some(
          (agent) => canMessageAgent(agent) && agent.pubkey === pubkey,
        )
      )
        throw new Error(
          choices.error ??
            (choices.pending
              ? "Agent details are still loading. Try again."
              : "This agent is unavailable in this community. Refresh its details and try again."),
        );
      const destination = await messagePerson(
        session,
        pubkey,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        relay.snapshot().session !== connection.session ||
        // An open that finishes behind the Settings modal must not navigate
        // away from Settings, which would discard its unsaved edits.
        navigator.snapshot().entry.target.kind === "settings"
      )
        return;
      const scope = { viewer, communityOrigin: origin };
      await navigator.open(
        "channelId" in destination
          ? {
              version: 1,
              kind: "conversation",
              channelId: destination.channelId,
              scope,
            }
          : newMessageTarget(scope, destination.draftTo),
      );
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      navigation?.signal.removeEventListener("abort", abort);
      if (attempt.current === controller) attempt.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  return (
    <>
      <Button
        size="sm"
        shape="control"
        variant={variant}
        disabled={!available || opening}
        loading={opening}
        onClick={() => void open()}
      >
        Message
      </Button>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}{" "}
          <Button
            size="inline"
            variant="link"
            disabled={!available || opening}
            onClick={() => void open(true)}
          >
            Retry
          </Button>
        </p>
      )}
    </>
  );
}
