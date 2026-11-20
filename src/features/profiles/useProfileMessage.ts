import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { canMessageAgent } from "../agents/choices";
import { messagePersonLink } from "../direct-messages/message-person";
import type { RelaySession } from "../relay/session";

const noSubscribe = () => () => {};

/** Shared profile action: respect community agent readiness and retire stale opens. */
export function useProfileMessage({
  session,
  pubkey,
  viewer,
  agent,
  enabled,
  onOpened,
}: {
  session: RelaySession | undefined;
  pubkey: string;
  viewer: string | undefined;
  agent: boolean;
  enabled: boolean;
  /** Receives your DM's link, or a New message draft's before the first send. */
  onOpened(link: string): void;
}) {
  const attempt = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const messageable = () =>
    enabled &&
    (!agent ||
      !!session?.agentChoices
        .snapshot()
        .identities.some(
          (choice) => canMessageAgent(choice) && choice.pubkey === pubkey,
        ));
  const ready = useSyncExternalStore(
    enabled && agent
      ? (session?.agentChoices.subscribe ?? noSubscribe)
      : noSubscribe,
    messageable,
    messageable,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Session, identity, and preview visibility retire the pending action.
  useEffect(() => {
    setOpening(false);
    setError("");
    return () => {
      attempt.current?.abort();
      attempt.current = null;
    };
  }, [session, pubkey, viewer, enabled]);
  const available =
    enabled &&
    !!session?.directMessages.available &&
    !!viewer &&
    viewer !== pubkey &&
    ready;
  async function open() {
    if (!available || !session || attempt.current || !messageable()) return;
    const controller = new AbortController();
    attempt.current = controller;
    setOpening(true);
    setError("");
    try {
      const link = await messagePersonLink(session, pubkey, controller.signal);
      if (!controller.signal.aborted) onOpened(link);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      if (attempt.current === controller) attempt.current = null;
      if (!controller.signal.aborted) setOpening(false);
    }
  }
  return { available, opening, error, open };
}
