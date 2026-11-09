// Create agent, filled in from a published agent card (`buzz://agent/new`).
import { useEffect, useState } from "react";
import {
  fetchAgentCard,
  type AgentCardDraft,
} from "../../features/agents/agent-card";
import type {
  Agent,
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { AgentCreateDialog } from "./AgentCreateDialog";

type Loaded =
  | Readonly<{ card: string; draft: AgentCardDraft }>
  | Readonly<{ card: string; error: string }>;

/** Loads card `card`, then opens Create agent with it. Nothing is created
 * until the owner reviews it and selects Create agent. */
export function AgentCardCreate({
  card,
  agents,
  types,
  community,
  onClose,
  onCreated,
}: {
  card: string;
  agents: Agents;
  types: readonly RegisteredAgentType[];
  community?: string | undefined;
  onClose(): void;
  onCreated(agent: Agent): void;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the same card.
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(undefined);
    fetchAgentCard(card, controller.signal).then(
      (draft) => setLoaded({ card, draft }),
      (reason) => {
        if (!controller.signal.aborted)
          setLoaded({
            card,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      },
    );
    return () => controller.abort();
  }, [card, attempt]);
  const current = loaded?.card === card ? loaded : undefined;
  if (current && "draft" in current)
    return (
      <AgentCreateDialog
        key={card}
        agents={agents}
        types={types}
        community={community}
        draft={current.draft}
        onClose={onClose}
        onCreated={onCreated}
      />
    );
  return (
    <Dialog
      open
      title="Agent card"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      actions={
        current && (
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        )
      }
    >
      {current ? (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {current.error}
        </p>
      ) : (
        <p role="status" className="m-0 text-body-sm text-secondary">
          Loading agent card…
        </p>
      )}
    </Dialog>
  );
}
