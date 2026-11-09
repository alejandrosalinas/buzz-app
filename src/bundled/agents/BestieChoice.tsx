import { useEffect, useRef, useState } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type { AgentPlace } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import {
  chooseDefaultAgent,
  clearDefaultAgent,
  restoreDefaultAgent,
  useSavedAgent,
} from "../../features/solo/default-agent";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

type BestieAgent = AgentChoicesSnapshot["selectable"][number];

const made = new Set<(pubkey: string) => void>();
/** Hears each agent the viewer makes Bestie on this device, once it is
 * saved. A choice synced from elsewhere isn't heard. */
export function onBestieMade(listener: (pubkey: string) => void) {
  made.add(listener);
  return () => void made.delete(listener);
}

/** What a remote agent as Bestie can't do, said before it is chosen. */
export const REMOTE_BESTIE_WARNING =
  "Some bestie features aren’t available with remote agents.";

/** Whether an agent runs somewhere other than this device. */
export const remoteAgent = (place: AgentPlace | undefined) =>
  place === "hosted" || place === "elsewhere";

/** Making an agent Bestie, wherever it is offered: `make` asks before
 * replacing an explicitly saved Bestie, and before choosing a remote agent
 * (`placeOf` says where each runs), in the dialog `view` renders. `remove`
 * asks before saving no Bestie, from any device, as it edits only the
 * account; it is absent without an account to save none to, as this device
 * would then pick another agent at once. */
export function useBestieChoice(
  session: RelaySession,
  scope: string,
  placeOf?: (pubkey: string) => AgentPlace | undefined,
) {
  // Bestie names only the explicit account-saved choice.
  const saved = useSavedAgent(session, scope);
  const choices = useAgentChoices(session, true, true);
  const [error, setError] = useState("");
  const [savingBestie, setSavingBestie] = useState(false);
  const [replacement, setReplacement] = useState<{
    current: BestieAgent;
    replacing: BestieAgent;
  }>();
  /** The remote agent asked about, with no Bestie to replace. */
  const [remote, setRemote] = useState<BestieAgent>();
  /** The Bestie asked about removing, by its name. */
  const [removing, setRemoving] = useState<{ name: string; pubkey: string }>();
  // Only the latest choice reports its failure.
  const latest = useRef(0);
  // Closing the side panel unmounts the dialog without its close handler, so
  // a failed replacement is abandoned on unmount too, and one still saving
  // abandons itself when it fails.
  const gone = useRef(false);
  const abandon = useRef<() => void>(undefined);
  useEffect(() => {
    abandon.current =
      error && replacement
        ? () =>
            restoreDefaultAgent(
              scope,
              replacement.replacing.pubkey,
              replacement.current.pubkey,
            )
        : undefined;
  }, [error, replacement, scope]);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      abandon.current?.();
    };
  }, []);
  const eligible = (pubkey: string) =>
    session.agentChoices
      .snapshot()
      .selectable.find((agent) => agent.pubkey === pubkey);
  const save = (pubkey: string, previous?: string) => {
    if (!eligible(pubkey)) return;
    const choice = ++latest.current;
    setError("");
    setSavingBestie(true);
    chooseDefaultAgent(session, scope, pubkey)
      .then(() => {
        for (const listener of made) listener(pubkey);
        if (choice !== latest.current) return;
        setReplacement(undefined);
        setRemote(undefined);
      })
      .catch((failure: Error) => {
        if (choice !== latest.current) return;
        if (gone.current && previous)
          restoreDefaultAgent(scope, pubkey, previous);
        else setError(failure.message);
      })
      .finally(() => {
        if (choice === latest.current) setSavingBestie(false);
      });
  };
  const make = (pubkey: string) => {
    const replacing = eligible(pubkey);
    if (!replacing || pubkey === saved) return;
    const previous = choices.identities.find((agent) => agent.pubkey === saved);
    if (previous) setReplacement({ current: previous, replacing });
    else if (remoteAgent(placeOf?.(pubkey))) {
      setError("");
      setRemote(replacing);
    } else save(pubkey);
  };
  const view = (
    <>
      {replacement && (
        <BestieReplacement
          {...replacement}
          remote={remoteAgent(placeOf?.(replacement.replacing.pubkey))}
          pending={savingBestie}
          error={error}
          onClose={() => {
            if (error) {
              restoreDefaultAgent(
                scope,
                replacement.replacing.pubkey,
                replacement.current.pubkey,
              );
              setError("");
            }
            setReplacement(undefined);
          }}
          onChoose={() => {
            // A choice changed elsewhere while this dialog was open wins.
            if (saved === replacement.current.pubkey)
              save(replacement.replacing.pubkey, replacement.current.pubkey);
            else setReplacement(undefined);
          }}
        />
      )}
      {remote && (
        <RemoteBestieConfirm
          name={bestieName(remote)}
          pending={savingBestie}
          error={error}
          onClose={() => {
            setRemote(undefined);
            setError("");
          }}
          onConfirm={() => save(remote.pubkey)}
        />
      )}
      {removing && (
        <RemoveBestie
          name={removing.name}
          // Its Former Bestie tab shows only where its instructions can be
          // edited.
          remote={placeOf?.(removing.pubkey) === "elsewhere"}
          remove={() =>
            // A choice changed elsewhere while this dialog was open wins.
            saved === removing.pubkey
              ? clearDefaultAgent(session, scope)
              : Promise.resolve()
          }
          onClose={() => setRemoving(undefined)}
        />
      )}
      {error && !replacement && !remote && <p role="alert">{error}</p>}
    </>
  );
  const remove = session.mainAgent
    ? (pubkey: string, name: string) => {
        if (pubkey === saved) setRemoving({ name, pubkey });
      }
    : undefined;
  return { saved, choices, make, remove, view };
}

export const bestieName = (agent: BestieAgent) =>
  agent.managedName ?? agent.name ?? "Agent";

function BestieReplacement({
  current,
  replacing,
  remote,
  pending,
  error,
  onChoose,
  onClose,
}: {
  current: BestieAgent;
  replacing: BestieAgent;
  remote: boolean;
  pending: boolean;
  error: string;
  onChoose(): void;
  onClose(): void;
}) {
  const proceed = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Make ${bestieName(replacing)} your bestie?`}
      description={`Your existing chats with ${bestieName(current)} will still be available in your DMs.${remote ? ` ${REMOTE_BESTIE_WARNING}` : ""}`}
      initialFocus={proceed}
      pending={pending}
      onClose={onClose}
      {...(error && { children: <p role="alert">{error}</p> })}
      actions={
        <>
          <Button disabled={pending} onClick={onClose}>
            Keep {bestieName(current)}
          </Button>
          <Button
            ref={proceed}
            variant="prominent"
            loading={pending}
            onClick={onChoose}
          >
            Switch to {bestieName(replacing)}
          </Button>
        </>
      }
    />
  );
}

/** Asks before a remote agent becomes Bestie, as some Bestie features need it
 * on this device. Cancel leaves the choice as it was. */
export function RemoteBestieConfirm({
  name,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  name: string;
  pending: boolean;
  error: string;
  onConfirm(): void;
  onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Use ${name} as your bestie?`}
      description={REMOTE_BESTIE_WARNING}
      initialFocus={cancel}
      pending={pending}
      onClose={onClose}
      {...(error && { children: <p role="alert">{error}</p> })}
      actions={
        <>
          <Button ref={cancel} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="prominent" loading={pending} onClick={onConfirm}>
            Use as bestie
          </Button>
        </>
      }
    />
  );
}

/** Asks before the agent stops being Bestie, then saves no Bestie. Its tab
 * goes with it; the agent then shows Former Bestie while a setting is on. */
function RemoveBestie({
  name,
  remote,
  remove,
  onClose,
}: {
  name: string;
  /** It runs on another device, where its Former Bestie tab is. */
  remote: boolean;
  remove(): Promise<void>;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Remove ${name} as your Bestie?`}
      description={`${name} stays in Agents, with your chats in your DMs. Its check-ins stop. Its memory rules and private channels stay; turn them off in its Former Bestie tab${remote ? " on the device it runs on" : ""}.`}
      initialFocus={keep}
      pending={pending}
      onClose={onClose}
      {...(error && { children: <p role="alert">{error}</p> })}
      actions={
        <>
          <Button ref={keep} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            onClick={() => {
              setPending(true);
              setError("");
              remove()
                .then(onClose)
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            Remove as Bestie
          </Button>
        </>
      }
    />
  );
}
