import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import {
  listInvites,
  pastedInviteCode,
  revokeInvite,
  type InviteSummary,
} from "./api";
import styles from "./CommunityAdmin.module.css";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
// Exact relay revoke refusal codes, forwarded unchanged by the broker.
const REVOKE_REFUSALS: Record<string, string> = {
  invite_not_found: "No invite link in this community matches that link.",
  invite_not_revocable:
    "This link can’t be revoked. It stops working when it expires or reaches its use limit.",
  invite_restricted:
    "You can’t revoke invite links while you’re restricted in this community.",
};
const revokeMessage = (reason: unknown) => {
  const text = message(reason);
  return Object.hasOwn(REVOKE_REFUSALS, text) ? REVOKE_REFUSALS[text] : text;
};
const STATUS: Record<InviteSummary["status"], string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  exhausted: "Used up",
};

/** How a link's expiry reads wherever it is shown. */
export function inviteExpiry(expiresAt: number | null) {
  if (expiresAt === null) return "Never expires";
  const date = new Date(expiresAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return expiresAt * 1000 <= Date.now() ? `Expired ${date}` : `Expires ${date}`;
}

const created = (at: number) =>
  new Date(at * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const uses = (invite: InviteSummary) =>
  invite.max_uses === null
    ? `${invite.use_count} ${invite.use_count === 1 ? "use" : "uses"}`
    : `${invite.use_count} of ${invite.max_uses} uses`;

/** The community's invite links, with revoking by row or by pasted link. */
export function InviteLinks({
  community,
  name,
  locked,
  active,
  visible,
}: {
  community: string;
  name(pubkey: string): string;
  locked: boolean;
  active(): boolean;
  /** Hidden while another tab shows; the list stays mounted so a revoke in flight lands here. */
  visible: boolean;
}) {
  const [list, setList] = useState<{
    invites: InviteSummary[];
    next: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pasted, setPasted] = useState("");
  const [pending, setPending] = useState<
    { id: string; label: string } | { code: string; label: string } | null
  >(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState("");
  // Confirmed revocations by id; they win over any list read that raced them.
  const [revoked, setRevoked] = useState<Record<string, number>>({});
  const reads = useRef(0);
  // Pages on screen, so a refresh re-reads the same range.
  const loaded = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  // A revoked row loses its Revoke button, so focus moves to the list instead.
  const [focusList, setFocusList] = useState(0);
  useEffect(() => {
    if (focusList) listRef.current?.focus();
  }, [focusList]);

  const load = useCallback(
    async (before?: string) => {
      const read = ++reads.current;
      setLoading(true);
      setError("");
      try {
        // Show more appends one page; a refresh re-reads every page already
        // loaded along the relay's cursors, and replaces the list only once all succeed.
        const pages = before ? 1 : Math.max(1, loaded.current);
        const rows: InviteSummary[] = [];
        let cursor = before;
        let next: string | null = null;
        let fetched = 0;
        do {
          const page = await listInvites(community, cursor);
          if (read !== reads.current) return;
          rows.push(...page.invites);
          next = page.next_before;
          cursor = next ?? undefined;
        } while (++fetched < pages && next);
        loaded.current = (before ? loaded.current : 0) + fetched;
        setList((shown) => {
          const invites = before ? [...(shown?.invites ?? []), ...rows] : rows;
          // One row per id, even if a link moved across a page boundary.
          const byId = new Map(invites.map((invite) => [invite.id, invite]));
          return { invites: [...byId.values()], next };
        });
      } catch (reason) {
        if (read === reads.current) setError(message(reason));
      } finally {
        if (read === reads.current) setLoading(false);
      }
    },
    [community],
  );
  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);
  useEffect(
    () => () => {
      ++reads.current;
    },
    [],
  );
  // Leaving the tab drops an unsent confirmation, as Members does; a sent
  // attempt stays, so its failure shows on return.
  useEffect(() => {
    if (!visible && !revoking && !revokeError) setPending(null);
  }, [visible, revoking, revokeError]);

  const pastedCode = pasted.trim() ? pastedInviteCode(community, pasted) : null;
  const pastedError =
    pastedCode && "error" in pastedCode ? pastedCode.error : "";

  function close() {
    setPending(null);
    setRevokeError("");
  }

  async function revoke() {
    if (!pending || !active() || locked || revoking) return;
    setRevoking(true);
    setRevokeError("");
    setNotice("");
    try {
      const receipt = await revokeInvite(
        community,
        "id" in pending ? { id: pending.id } : { code: pending.code },
      );
      setRevoked((shown) => ({ ...shown, [receipt.id]: receipt.revoked_at }));
      if ("code" in pending) setPasted("");
      else setFocusList((n) => n + 1);
      setPending(null);
      setNotice("Invite link revoked. People who already joined stay in.");
    } catch (reason) {
      // The outcome may be unknown after a timeout; Refresh shows what the relay holds.
      setRevokeError(revokeMessage(reason) ?? "");
    } finally {
      setRevoking(false);
    }
  }

  const shown = list?.invites.map((invite) =>
    revoked[invite.id] === undefined
      ? invite
      : {
          ...invite,
          revoked_at: revoked[invite.id] ?? null,
          status: "revoked" as const,
        },
  );

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (pastedCode && "code" in pastedCode)
            setPending({ code: pastedCode.code, label: "this link" });
        }}
      >
        <label htmlFor="invite-revoke-link" className="text-body-sm">
          Revoke a link
        </label>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <InputGroup>
              <Input
                id="invite-revoke-link"
                aria-invalid={pastedError ? true : undefined}
                aria-describedby={
                  pastedError ? "invite-revoke-link-error" : undefined
                }
                placeholder="Paste an invite link"
                value={pasted}
                onChange={(event) => setPasted(event.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={revoking}
              />
            </InputGroup>
            {pastedError && (
              <p
                id="invite-revoke-link-error"
                role="alert"
                className="mt-2 mb-0 text-body-sm"
              >
                {pastedError}
              </p>
            )}
          </div>
          <Button
            type="submit"
            variant="destructive"
            disabled={
              locked || revoking || !pastedCode || !("code" in pastedCode)
            }
          >
            Revoke
          </Button>
        </div>
      </form>
      <div>
        <div className="flex items-center justify-between gap-3 pb-2">
          <h3 className="m-0 text-caption text-subtle">Invite links</h3>
          <Button
            size="sm"
            variant="subtle"
            loading={loading}
            disabled={loading}
            onClick={() => void load()}
          >
            {error ? "Retry" : "Refresh"}
          </Button>
        </div>
        {shown === undefined ? (
          !error && <p role="status">Loading invite links…</p>
        ) : shown.length === 0 ? (
          <p role="status" className="text-body-sm text-muted">
            No invite links yet.
          </p>
        ) : (
          <ul
            ref={listRef}
            tabIndex={-1}
            className={styles.members}
            aria-label="Invite links"
          >
            {shown.map((invite) => {
              // Creation time and a short id tell one creator's links apart.
              const label = `Link ${invite.id.slice(0, 8)} by ${name(invite.created_by)}, created ${created(invite.created_at)}`;
              return (
                <li key={invite.id} className={styles.member}>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-body-sm">{label}</p>
                    <p className="m-0 truncate text-caption text-subtle">
                      {STATUS[invite.status]} · {uses(invite)} ·{" "}
                      {inviteExpiry(invite.expires_at)}
                    </p>
                  </div>
                  {invite.status !== "revoked" && (
                    <Button
                      size="sm"
                      variant="subtle"
                      aria-label={`Revoke ${label}`}
                      disabled={locked || revoking}
                      onClick={() => setPending({ id: invite.id, label })}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {list?.next && (
          <div className="mt-2">
            <Button
              size="sm"
              loading={loading}
              disabled={loading}
              onClick={() => void load(list.next ?? undefined)}
            >
              Show more
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2 empty:hidden">
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
      </div>
      {pending && visible && (
        <AlertDialog
          title={`Revoke ${pending.label}?`}
          description="Nobody new can join with it. People who already joined stay in."
          pending={revoking}
          onClose={close}
          actions={
            <>
              <Button disabled={revoking} onClick={close}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={revoking}
                // Loading alone blocks a second submit and keeps focus here for Retry.
                disabled={locked}
                onClick={() => void revoke()}
              >
                {revokeError ? "Retry" : "Revoke"}
              </Button>
            </>
          }
        >
          {revokeError && (
            <p role="alert" className="m-0 text-body-sm">
              {revokeError}
            </p>
          )}
        </AlertDialog>
      )}
    </div>
  );
}
