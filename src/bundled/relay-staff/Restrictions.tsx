import { useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import type {
  RestrictionDto,
  StaffRequest,
} from "../../features/relay-staff/contract";
import { describe, usePages, useSession, useWrite } from "./session";
import { NamesSource, Person, PeopleScope, usePeople } from "./people";
import { Failure, Loading, UNSUPPORTED_BROWSING, useRetry } from "./ui";

type Lift = { pubkey: string; kind: "ban" | "timeout" };
type LiftRequest = Extract<StaffRequest, { route: "liftRestriction" }>;

function active(row: RestrictionDto, now = new Date()) {
  return {
    banned:
      row.banned &&
      (row.banExpiresAt === null || new Date(row.banExpiresAt) > now),
    timedOut: row.mutedUntil !== null && new Date(row.mutedUntil) > now,
  };
}

export function Restrictions({ communityHost }: { communityHost: string }) {
  const { context, canMutate } = useSession();
  const pages = usePages(
    (cursor) => ({
      route: "listRestrictions",
      communityHost,
      ...(cursor ? { cursor } : {}),
    }),
    [context, communityHost],
  );
  // A failed later page retries that page; a failed first load starts over.
  const retry = useRetry(
    pages.failure,
    pages.settled,
    pages.next ? pages.more : pages.restart,
  );
  const [lifting, setLifting] = useState<Lift | null>(null);
  const proceed = useRef<HTMLButtonElement>(null);
  const keys = pages.items.map((row) => row.pubkey);
  const names = usePeople(keys);
  const [error, setError] = useState("");
  const write = useWrite<LiftRequest>(`lift ${communityHost}`, (outcome) => {
    // A conflict means someone else already changed it: show the current list.
    if (outcome.ok || outcome.failure.status === 409) pages.restart();
    else setError(describe(outcome.failure));
  });
  const working = write.busy ? (write.frozen?.pubkey ?? null) : null;

  const lift = ({ pubkey, kind }: Lift) => {
    setLifting(null);
    setError("");
    write.run({ route: "liftRestriction", communityHost, kind, pubkey });
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption font-medium text-secondary">
        Active restrictions
      </p>
      {retry.failure && (
        <Failure
          failure={retry.failure}
          unsupportedText={UNSUPPORTED_BROWSING}
          onRetry={retry.retry}
          retrying={retry.retrying}
        />
      )}
      {error && (
        <p className="text-body-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!pages.loading && !pages.failure && pages.items.length === 0 && (
        <p className="text-body-sm text-secondary">
          No active bans or timeouts.
        </p>
      )}
      <PeopleScope people={names}>
        {pages.items.length > 0 && <NamesSource />}
        <ul className="flex flex-col gap-1">
          {pages.items.map((row) => {
            const { banned, timedOut } = active(row);
            return (
              <li
                key={row.pubkey}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-body-sm"
              >
                <span className="min-w-0 flex-1">
                  <Person pubkey={row.pubkey} />
                </span>
                {banned && (
                  <span className="text-caption text-danger">banned</span>
                )}
                {timedOut && (
                  <span className="text-caption text-secondary">timeout</span>
                )}
                {banned && (
                  <Button
                    size="sm"
                    disabled={!canMutate || write.busy}
                    loading={working === row.pubkey}
                    onClick={() =>
                      setLifting({ pubkey: row.pubkey, kind: "ban" })
                    }
                  >
                    Lift ban
                  </Button>
                )}
                {timedOut && (
                  <Button
                    size="sm"
                    disabled={!canMutate || write.busy}
                    loading={working === row.pubkey}
                    onClick={() =>
                      setLifting({ pubkey: row.pubkey, kind: "timeout" })
                    }
                  >
                    Clear timeout
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </PeopleScope>
      {pages.loading && !retry.retrying && <Loading />}
      {pages.next && !pages.loading && (
        <Button size="sm" onClick={pages.more}>
          Load more
        </Button>
      )}
      {lifting && (
        <AlertDialog
          title={lifting.kind === "ban" ? "Lift ban?" : "Clear timeout?"}
          description={`${names.text(lifting.pubkey)} will be able to post in ${communityHost} again.`}
          initialFocus={proceed}
          onClose={() => setLifting(null)}
          actions={
            <>
              <Button onClick={() => setLifting(null)}>Cancel</Button>
              <Button
                ref={proceed}
                variant="prominent"
                onClick={() => lift(lifting)}
              >
                {lifting.kind === "ban" ? "Lift ban" : "Clear timeout"}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
