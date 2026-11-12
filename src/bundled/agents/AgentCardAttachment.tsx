// An agent card sent in a conversation, drawn as the agent's card from the
// Marketplace, with an explicit Add agent action beneath its name.
import { useEffect, useRef, useState } from "react";
import { MAX_PNG_BYTES, readSnapshot } from "../../features/agents/agent-share";
import { useAgents } from "../../features/agents/react";
import type { Agent, Agents } from "../../features/agents/service";
import type { AttachmentRendererProps } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { Attachment } from "../../features/relay/contracts";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { SharedAgentCardContent, SharedImportDialog } from "./AgentBrowse";
import cardStyles from "./AgentCard.module.css";
import styles from "./AgentCardAttachment.module.css";
import { agentTarget } from "./routes";

const CARD = /\.agent\.png$/i;

/** Share names agent cards `<name>.agent.png`. */
export const isAgentCard = (attachment: Attachment) =>
  attachment.kind === "image" && CARD.test(attachment.name ?? "");

type Definition = Awaited<ReturnType<typeof readSnapshot>>;

/** What a card holds no agent in, as opposed to a read that failed. */
class NotACard extends Error {}

/** The card's bytes, refused past the card limit as they arrive: a message
 * shows its card unasked, so its sender can't make it read more. */
async function cardBytes(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_PNG_BYTES) {
    await response.body?.cancel();
    throw new NotACard();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No body");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks, { type: "image/png" });
    size += value.byteLength;
    if (size > MAX_PNG_BYTES) {
      await reader.cancel();
      throw new NotACard();
    }
    chunks.push(value);
  }
}

export function AgentCardAttachment({
  attachment,
  source,
  agents,
  relay,
  navigator,
}: AttachmentRendererProps & {
  agents: Agents;
  relay: RelayData;
  /** Opens an agent of yours on the Agents page; absent, nothing offers to. */
  navigator?: Navigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { types } = useAgents(agents);
  // `undefined` while the card is read; `null` when it holds no agent.
  const [shared, setShared] = useState<Definition | null>();
  // A read that failed, such as offline, is tried again when chosen.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const [adding, setAdding] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  const opener = (agent: Agent) =>
    navigator && (() => void navigator.open(agentTarget(agent.pubkey)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: Choosing a card whose read failed reads it again.
  useEffect(() => {
    const controller = new AbortController();
    setShared(undefined);
    setFailed(false);
    fetch(source, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return cardBytes(response);
      })
      .then((bytes) =>
        readSnapshot(bytes).catch(() => {
          throw new NotACard();
        }),
      )
      .then(
        (definition) => {
          setShared(definition);
          // It was chosen while it could not be read.
          if (retried.current) setAdding(true);
          retried.current = false;
        },
        (reason) => {
          if (controller.signal.aborted) return;
          retried.current = false;
          if (reason instanceof NotACard) setShared(null);
          else setFailed(true);
        },
      );
    return () => controller.abort();
  }, [source, attempt]);
  const name = (attachment.name ?? "").replace(CARD, "") || "Agent";
  // Not a card after all: show the picture it is.
  if (shared === null)
    return <img className={styles.picture} src={source} alt={name} />;
  const runnable = types.filter((type) => !type.remote);
  return (
    <div className={styles.frame}>
      <div className={`${cardStyles.card} ${cardStyles.agentCard}`}>
        <SharedAgentCardContent
          agent={shared ?? { name, model: "" }}
          action={
            <Button
              ref={trigger}
              variant="prominent"
              size="sm"
              aria-label={`${failed ? "Try again" : "Add agent"}: ${shared?.name ?? name}`}
              aria-haspopup="dialog"
              disabled={!shared && !failed}
              onClick={() => {
                if (!failed) return setAdding(true);
                retried.current = true;
                setAttempt((value) => value + 1);
              }}
            >
              {failed ? "Couldn’t load. Try again" : "Add agent"}
            </Button>
          }
          community={
            connection.status === "ready" ? connection.origin : undefined
          }
        />
      </div>
      {adding && shared && (
        <SharedImportDialog
          shared={shared}
          agents={agents}
          types={runnable}
          onImported={(agent) => {
            setAdding(false);
            const show = opener(agent);
            notify(
              `Added ${agent.name} to your agents.`,
              "success",
              show && { label: "Open", onClick: show },
            );
          }}
          {...(navigator && {
            onOpen: (agent: Agent) => {
              setAdding(false);
              opener(agent)?.();
            },
          })}
          onClose={() => setAdding(false)}
          finalFocus={trigger}
        />
      )}
    </div>
  );
}
