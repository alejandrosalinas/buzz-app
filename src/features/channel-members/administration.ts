import { getEventHash } from "nostr-tools";
import type { RelayReader } from "../relay/reader";
import { retryRead } from "../relay/read-retry";
import type { ReadTransport } from "../relay/transport";
import { newer, type RelayEvent } from "../relay/events";
import { attestedOwner } from "../agents/owner-attestation";
import { foldProfiles } from "../relay/profiles";
import { PublishRejected } from "../relay/outbox";
import { lifecycleChannelId } from "../relay/channel-lifecycle-protocol";
import {
  authorizeMemberChange,
  canRemoveMember,
  canSetMemberRole,
  isEditableMemberRole,
  memberAdministrationTemplate,
  memberAuthority,
  memberChangeConfirmed,
  transferRefusal,
  validateMemberAdministrationTemplate,
  type MemberAuthority,
  type MemberChange,
  type MemberRole,
} from "./administration-protocol";

export type MemberAdministrationState = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  authority: MemberAuthority;
  operation?: Readonly<{
    change: MemberChange;
    status: "pending" | "uncertain" | "confirmed" | "failed";
  }>;
  error?: string | undefined;
}>;
const empty: MemberAdministrationState = Object.freeze({
  status: "idle",
  authority: Object.freeze({
    roles: Object.freeze({}),
    canManage: false,
    canManageSolo: false,
    canRemove: false,
    canRemoveOwnedAgent: false,
    system: false,
  }),
});
const uncertain =
  "This request may have taken effect. Refresh members and roles to check its result; it will not be sent again.";

/** Session-owned intent survives dialog closure, never replays privileged writes. */
export function createMemberAdministration({
  reader,
  writer,
  viewer,
  relayAuthor,
  canAccess,
  acceptDiscovery,
}: {
  reader?: RelayReader | undefined;
  writer?: ReadTransport["memberAdministration"];
  viewer: string;
  relayAuthor: string;
  canAccess(id: string): boolean;
  acceptDiscovery(events: readonly RelayEvent[]): void;
}) {
  let closed = false;
  let epoch = 0;
  const states = new Map<string, MemberAdministrationState>();
  const active = new Map<string, AbortController>();
  const publishing = new Set<string>();
  const listeners = new Set<() => void>();
  const snapshot = (id: string) => states.get(id) ?? empty;
  const emit = (id: string, state: MemberAdministrationState) => {
    states.set(id, Object.freeze(state));
    for (const listener of listeners) listener();
  };
  function assertAccess(id: string) {
    if (closed) throw new DOMException("Relay session closed", "AbortError");
    if (!canAccess(id))
      throw new Error("Channel access unavailable; refresh membership.");
  }
  async function read(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    assertAccess(id);
    if (!reader)
      throw new Error("Member roles are unavailable on this connection.");
    const events = await reader.read(
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong" as const,
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      { signal, fresh: true, priority: "foreground" },
    );
    signal.throwIfAborted();
    assertAccess(id);
    return {
      events,
      authority: memberAuthority(
        events,
        id,
        viewer,
        relayAuthor,
        writer?.soloMemberRoleUpdates === true,
      ),
    };
  }
  async function perform(
    id: string,
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    assertAccess(id);
    lifecycleChannelId(id);
    if (active.has(id))
      throw new Error("A member operation is still in progress.");
    const controller = new AbortController();
    const started = epoch;
    active.set(id, controller);
    try {
      await work(
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        () => !closed && started === epoch,
      );
    } finally {
      if (active.get(id) === controller) active.delete(id);
    }
  }
  const capability = Object.freeze({
    available: !!reader && !!writer,
    snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(id: string) {
      if (active.has(id)) return;
      const started = epoch;
      await perform(id, async (signal, current) => {
        const previous = snapshot(id);
        emit(id, { ...previous, status: "loading" });
        try {
          const result = await retryRead(() => read(id, signal), signal);
          const operation = previous.operation;
          const unresolved = operation?.status === "uncertain";
          const confirmed =
            unresolved &&
            memberChangeConfirmed(result.authority, viewer, operation.change);
          acceptDiscovery(result.events);
          signal.throwIfAborted();
          if (!current()) return;
          emit(id, {
            status: "ready",
            authority: result.authority,
            ...(operation
              ? {
                  operation: confirmed
                    ? { ...operation, status: "confirmed" }
                    : operation,
                }
              : {}),
            ...(unresolved && !confirmed ? { error: uncertain } : {}),
          });
        } catch (error) {
          if (current())
            emit(id, {
              ...previous,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
        }
      }).catch((error: unknown) => {
        // Preflight can fail before work starts. Settle the read without
        // reviving a cleared/closed session or leaving consumers waiting on idle.
        if (!closed && started === epoch)
          emit(id, {
            ...snapshot(id),
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      });
    },
    /** `active` is checked synchronously right before publishing; false publishes nothing. */
    async run(
      id: string,
      intent: MemberChange,
      caller?: AbortSignal,
      active?: () => boolean,
    ) {
      if (!reader || !writer)
        throw new Error(
          "Member administration is unavailable on this connection.",
        );
      if (snapshot(id).operation?.status === "uncertain")
        throw new Error(uncertain);
      const change = Object.freeze({ ...intent });
      await perform(id, async (owned, current) => {
        const signal = caller ? AbortSignal.any([owned, caller]) : owned;
        const previous = snapshot(id);
        let publicationStarted = false;
        emit(id, {
          ...previous,
          operation: { change, status: "pending" },
          error: undefined,
        });
        try {
          let owner: string | undefined;
          let agent: boolean | undefined;
          // Verify provenance once per attempt, never from display/inventory hints.
          // Every preflight reads fresh membership; the relay owns the final ACL.
          const profile = async () => {
            const profiles = await reader.read(
              [
                {
                  kinds: [0],
                  authors: [change.pubkey],
                  limit: 1,
                  consistency: "strong",
                },
              ],
              { signal, fresh: true, priority: "foreground" },
            );
            signal.throwIfAborted();
            assertAccess(id);
            if (
              profiles.some(
                (event) => event.kind !== 0 || event.pubkey !== change.pubkey,
              )
            )
              throw new Error("Unexpected profile response");
            return profiles.reduce<RelayEvent | undefined>(newer, undefined);
          };
          const authorize = async () => {
            const { authority } = await read(id, signal);
            if (
              change.role === "remove" &&
              owner === undefined &&
              !canRemoveMember(authority, viewer, change.pubkey) &&
              canRemoveMember(authority, viewer, change.pubkey, viewer)
            ) {
              const event = await profile();
              if (event) owner = await attestedOwner(event);
              signal.throwIfAborted();
              assertAccess(id);
            }
            if (change.role === "owner" && agent === undefined) {
              // Without a profile, nothing shows the heir isn't an agent.
              const event = await profile();
              agent =
                !event || !!foldProfiles([event]).get(change.pubkey)?.isAgent;
              if (agent) throw new Error(transferRefusal);
            }
            const soloRoleUpdate =
              authority.canManageSolo && isEditableMemberRole(change.role);
            let targetOwner = owner;
            if (
              soloRoleUpdate &&
              !canSetMemberRole(
                authority,
                viewer,
                change.pubkey,
                change.role,
              ) &&
              canSetMemberRole(
                authority,
                viewer,
                change.pubkey,
                change.role,
                viewer,
              )
            ) {
              // Promotions require fresh ownership proof on both preflights.
              const event = await profile();
              targetOwner = event && (await attestedOwner(event));
              signal.throwIfAborted();
              assertAccess(id);
            }
            authorizeMemberChange(
              authority,
              viewer,
              change,
              targetOwner,
              agent,
            );
            return soloRoleUpdate;
          };
          const soloRoleUpdate = await authorize();
          const template = memberAdministrationTemplate(
            id,
            viewer,
            change,
            soloRoleUpdate,
          );
          validateMemberAdministrationTemplate(template, viewer);
          const signed = await writer.sign(structuredClone(template), signal);
          signal.throwIfAborted();
          if (
            signed.pubkey !== viewer ||
            signed.kind !== template.kind ||
            signed.created_at !== template.created_at ||
            signed.content !== template.content ||
            JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
            getEventHash(signed) !== signed.id
          )
            throw new Error("Signer changed the member administration command");
          if ((await authorize()) !== soloRoleUpdate)
            throw new Error(
              "Chat type changed. Refresh members and roles before trying again.",
            );
          signal.throwIfAborted();
          if (active?.() === false)
            throw new DOMException("Member change cancelled", "AbortError");
          publicationStarted = true;
          publishing.add(id);
          await writer.publish(signed, signal);
          // Acceptance is not proof; delayed side effects use explicit readback,
          // not a privileged outbox or an automatic retry loop.
          const result = await read(id, signal);
          if (!memberChangeConfirmed(result.authority, viewer, change))
            throw new Error(uncertain);
          acceptDiscovery(result.events);
          signal.throwIfAborted();
          if (!current()) return;
          emit(id, {
            status: "ready",
            authority: result.authority,
            operation: { change, status: "confirmed" },
          });
        } catch (error) {
          if (current())
            emit(id, {
              ...previous,
              status: "error",
              operation: {
                change,
                status:
                  publicationStarted && !(error instanceof PublishRejected)
                    ? "uncertain"
                    : "failed",
              },
              error:
                publicationStarted && !(error instanceof PublishRejected)
                  ? uncertain
                  : error instanceof Error
                    ? error.message
                    : String(error),
            });
        } finally {
          if (current()) publishing.delete(id);
        }
      });
    },
  });
  function clear() {
    epoch++;
    for (const controller of active.values()) controller.abort();
    active.clear();
    for (const [id, state] of states) {
      const operation = state.operation;
      // Aborting cannot retract a publication. Drop role authority, not the
      // readback-only fence, and never let an old completion settle a new epoch.
      if (
        !closed &&
        operation &&
        (operation.status === "uncertain" ||
          (operation.status === "pending" && publishing.has(id)))
      ) {
        states.set(
          id,
          Object.freeze<MemberAdministrationState>({
            ...empty,
            operation: { ...operation, status: "uncertain" },
            error: uncertain,
          }),
        );
      } else states.delete(id);
    }
    publishing.clear();
    for (const listener of listeners) listener();
  }
  return {
    capability,
    clear,
    dispose() {
      closed = true;
      clear();
      listeners.clear();
    },
  };
}

type MemberAdministration = ReturnType<
  typeof createMemberAdministration
>["capability"];

/** A member change's outcome. `uncertain`: published, but readback could not
 * confirm it; it is not sent again. */
export type MemberResult = Readonly<{
  status: "confirmed" | "failed" | "uncertain";
  error?: string;
}>;

/** One member change through `admin`, decided from a fresh roster read:
 * `decide` gets the key's verified role and returns the change, or nothing
 * when the roster already shows the result. `unavailable` is the error when
 * the roster can't be read and says no more. */
export async function administerMember(
  admin: Pick<MemberAdministration, "refresh" | "snapshot" | "run">,
  channel: string,
  pubkey: string,
  decide: (
    role: MemberRole | undefined,
  ) => Omit<MemberChange, "pubkey"> | undefined,
  unavailable = "Roles unavailable",
): Promise<MemberResult> {
  await admin.refresh(channel);
  const read = admin.snapshot(channel);
  if (read.status !== "ready")
    return { status: "failed", error: read.error ?? unavailable };
  const intent = decide(read.authority.roles[pubkey]);
  if (!intent) return { status: "confirmed" };
  const change = { pubkey, ...intent };
  try {
    await admin.run(channel, change);
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const { operation, error } = admin.snapshot(channel);
  if (
    operation?.change.pubkey !== pubkey ||
    operation.change.role !== change.role ||
    operation.status === "pending"
  )
    return { status: "uncertain" };
  return operation.status === "confirmed"
    ? { status: "confirmed" }
    : { status: operation.status, ...(error ? { error } : {}) };
}
