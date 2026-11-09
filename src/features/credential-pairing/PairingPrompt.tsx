import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  answerPairing,
  onPairingEvents,
  setPairingCommunities,
  setPairingPrompt,
  type PairRequest,
} from "./service";

/** Asks the person to approve a command-line tool acting as them. Native
 * code declines a community not saved here without asking. */
export function PairingPrompt({
  communities,
}: {
  communities: readonly string[];
}) {
  const [request, setRequest] = useState<PairRequest | null>(null);
  const [left, setLeft] = useState(0);
  const deny = useRef<HTMLButtonElement>(null);
  const saved = communities.join("\n");
  useEffect(() => {
    void setPairingCommunities(saved ? saved.split("\n") : []);
  }, [saved]);
  // Native asks only while a prompt listens. This one is mounted only in the
  // app shell, so behind sign-in, setup or restoring screens native refuses.
  useEffect(() => {
    let stopped = false;
    let mounted = false;
    const stop = onPairingEvents({
      request(next) {
        // Heard after its cleanup ran: nobody can show it.
        if (stopped) {
          void answerPairing(next.id, false);
          return;
        }
        setRequest(next);
        setLeft(next.expiresIn);
      },
      closed(id) {
        setRequest((current) => (current?.id === id ? null : current));
      },
      ready() {
        // Stopped first, as by a development remount: it never counted.
        if (stopped) return;
        mounted = true;
        void setPairingPrompt(true);
      },
    });
    return () => {
      stopped = true;
      stop();
      if (mounted) void setPairingPrompt(false);
    };
  }, []);
  // Leaving the page declines what it was asked.
  const open = useRef<string | null>(null);
  open.current = request?.id ?? null;
  useEffect(
    () => () => {
      if (open.current) void answerPairing(open.current, false);
    },
    [],
  );
  useEffect(() => {
    if (!request) return;
    const timer = window.setInterval(
      () => setLeft((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [request]);
  // Native refuses it by now too; the prompt just closes.
  useEffect(() => {
    if (left === 0) setRequest(null);
  }, [left]);
  if (!request) return null;
  const answer = (approve: boolean) => {
    void answerPairing(request.id, approve);
    setRequest(null);
  };
  return (
    <AlertDialog
      title={
        <>
          <strong>{request.client}</strong> wants to use Buzz as you on{" "}
          <strong>{request.relay}</strong>
        </>
      }
      description="It can post and read as you. It can’t change your profile, contacts or memberships."
      initialFocus={deny}
      onClose={() => answer(false)}
      actions={
        <>
          <Button ref={deny} onClick={() => answer(false)}>
            Deny
          </Button>
          <Button variant="prominent" onClick={() => answer(true)}>
            Allow
          </Button>
        </>
      }
    >
      <div className="min-w-0 space-y-2 text-body-sm">
        <p className="text-muted">
          {request.process
            ? `Requested by ${request.process}`
            : "Requested by an unknown process"}
        </p>
        <p className="text-muted" role="timer" aria-live="off">
          Expires in {left} s
        </p>
      </div>
    </AlertDialog>
  );
}
