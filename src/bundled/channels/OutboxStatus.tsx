import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { isWorkflowOperation } from "../../features/workflows/protocol";
import { useRef, useState, useSyncExternalStore } from "react";
import type { RelayProfiler } from "../../features/relay/profiling";
import { RelayTimings } from "./RelayTimings";
import { PRODUCT_FEEDBACK_KIND } from "../../features/relay/product-feedback";
import {
  HELD_RETRY_REFUSED,
  type Outbox,
  type OutboxRecovery,
} from "../../features/relay/outbox";
import type { RelaySession } from "../../features/relay/session";
import { isBatchAddition } from "../../features/channel-members/members";
import { soloAdminSetup } from "../../features/relay/solo-admins";

/** A batch names everyone its Retry re-adds. */
function additionLabel(tags: readonly (readonly string[])[]) {
  const people = tags.filter(([tag]) => tag === "p");
  return people.length > 1
    ? `Add ${people.length} people`
    : `Add agent ${people[0]?.[1]?.slice(0, 12) ?? ""}`;
}

/** Delivery belongs to the session, including messages from other pages or a previous launch. */
export function OutboxStatus({
  outbox,
  profiling,
  memberAdditions,
}: {
  outbox: Outbox;
  profiling: RelayProfiler;
  memberAdditions: Pick<RelaySession["memberAdditions"], "add">;
}) {
  const operations = useSyncExternalStore(
    outbox.subscribe,
    outbox.snapshot,
    outbox.snapshot,
  )
    .filter((item) => item.event.kind !== PRODUCT_FEEDBACK_KIND)
    .map((item) => {
      const setup = soloAdminSetup(item);
      const abandonSetup =
        item.delivery === "accepted" || item.delivery === "seen"
          ? setup?.recovery
          : undefined;
      return { ...item, setup, abandonSetup };
    });
  const [error, setError] = useState<string>();
  const [abandon, setAbandon] = useState<{
    id: string;
    recovery: OutboxRecovery;
  }>();
  const [abandoning, setAbandoning] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const abandonButton = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const closeAbandon = () => {
    setError(undefined);
    setAbandon(undefined);
  };

  return (
    <details>
      <summary ref={summary}>Outbox · {operations.length} items</summary>
      <p>Removing an item from the outbox does not delete a sent message.</p>
      <ul
        style={{
          maxHeight: "10rem",
          overflow: "auto",
          paddingInlineStart: "1.2rem",
        }}
      >
        {operations.map((item) => (
          <li key={item.event.id}>
            <span>
              {item.setup
                ? "Opening agent admin setup"
                : item.event.kind === 9000
                  ? additionLabel(item.event.tags)
                  : item.event.content.slice(0, 100)}{" "}
              ·{" "}
              {
                {
                  sending: "Sending",
                  accepted: "Sent",
                  unknown: "Unconfirmed",
                  failed: "Not sent",
                  seen: "Sent",
                }[item.delivery]
              }
            </span>{" "}
            {!isWorkflowOperation(item.event) &&
              !item.guarded &&
              !item.held &&
              (item.delivery === "failed" ||
                item.delivery === "unknown" ||
                // A kept batch still names someone unsettled.
                (isBatchAddition(item) && item.delivery !== "sending")) && (
                <Button
                  type="button"
                  onClick={async () => {
                    try {
                      if (
                        item.event.kind === 9000 &&
                        (item.recovery?.key.startsWith("member-add:") ||
                          !item.event.tags.some(([tag]) => tag === "role"))
                      ) {
                        const channelId = item.event.tags.find(
                          ([tag]) => tag === "h",
                        )?.[1];
                        const pubkeys = item.event.tags.flatMap(
                          ([tag, value]) =>
                            tag === "p" && value ? [value] : [],
                        );
                        if (!channelId || !pubkeys.length)
                          throw new Error(
                            "Reopen Members to check this addition.",
                          );
                        // A stale explicit role must never overwrite a newer
                        // admission, so each person is checked again. A guest
                        // addition is retried as one, so it never sends a
                        // writing role. A single addition finishes only its own
                        // receipt. A batch is never resumed, so each person it
                        // names is added again; it clears once all are settled.
                        const guest = item.event.tags.some(
                          ([tag, value]) => tag === "role" && value === "guest",
                        );
                        const batch = isBatchAddition(item);
                        const results = await Promise.allSettled(
                          pubkeys.map((pubkey) =>
                            memberAdditions.add(channelId, pubkey, {
                              ...(guest ? { role: "guest" as const } : {}),
                              ...(batch ? {} : { retry: true as const }),
                            }),
                          ),
                        );
                        const failed = results.find(
                          (result) => result.status === "rejected",
                        );
                        if (failed) throw failed.reason;
                      } else outbox.retry(item.event.id);
                      setError(undefined);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                >
                  Retry
                </Button>
              )}{" "}
            {item.guarded &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <span>
                  Retry from the channel or agent profile after checking
                  membership.
                </span>
              )}{" "}
            {item.held &&
              (item.delivery === "failed" || item.delivery === "unknown") && (
                <span>{HELD_RETRY_REFUSED}</span>
              )}{" "}
            {(!item.setup || item.abandonSetup || item.delivery === "failed") &&
              item.delivery !== "sending" && (
                <Button
                  type="button"
                  onClick={async (event) => {
                    try {
                      if (item.abandonSetup) {
                        abandonButton.current = event.currentTarget;
                        setError(undefined);
                        setAbandon({
                          id: item.event.id,
                          recovery: item.abandonSetup,
                        });
                        return;
                      }
                      const shareReceipt =
                        item.event.kind === 9 &&
                        // Share receipts, including those of earlier flows.
                        /^(snapshot-share:(agent|team)|solo-share-link:[^:]+|agent-share:[^:]+):.+$/.test(
                          item.recovery?.key ?? "",
                        ) &&
                        (item.delivery === "accepted" ||
                          item.delivery === "seen");
                      if (shareReceipt) await outbox.acknowledge(item.event.id);
                      await outbox.dismiss(item.event.id);
                      setError(undefined);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                >
                  {item.abandonSetup
                    ? "Abandon admin setup"
                    : "Remove from outbox"}
                </Button>
              )}
          </li>
        ))}
      </ul>
      {abandon && (
        <AlertDialog
          title="Abandon admin setup?"
          description="The chat keeps its current roles. Retry your opening message to continue, or send a new message if it expired."
          initialFocus={cancel}
          finalFocus={() =>
            abandonButton.current?.isConnected
              ? abandonButton.current
              : summary.current
          }
          pending={abandoning}
          onClose={closeAbandon}
          actions={
            <>
              <Button ref={cancel} disabled={abandoning} onClick={closeAbandon}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                disabled={abandoning}
                onClick={async () => {
                  setAbandoning(true);
                  setError(undefined);
                  try {
                    await outbox.dismiss(abandon.id, abandon.recovery);
                    closeAbandon();
                  } catch (reason) {
                    setError(String(reason));
                  } finally {
                    setAbandoning(false);
                  }
                }}
              >
                Abandon admin setup
              </Button>
            </>
          }
        >
          {error && <p role="alert">{error}</p>}
        </AlertDialog>
      )}
      {!abandon && error && <p role="alert">{error}</p>}
      <RelayTimings profiling={profiling} />
    </details>
  );
}
