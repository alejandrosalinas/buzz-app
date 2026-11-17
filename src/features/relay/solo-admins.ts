import { getEventHash } from "nostr-tools";
import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof, type RelayEvent } from "./events";
import type { ProfileQueries } from "./profile-directory";
import { memberAdministrationTemplate } from "../channel-members/administration-protocol";
import type { OutboxRecovery, OutgoingEvent } from "./outbox";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";

export const soloAdminKey = (channel: string) =>
  `solo-initial-admins:${channel}`;

/** A verified head is authority only while it remains the directory's head. */
export async function soloAgentOwnership(
  profiles: Pick<ProfileQueries, "event"> | undefined,
  viewer: string | undefined,
  key: string,
): Promise<() => boolean> {
  const head = profiles?.event?.(key);
  const owned = !!(
    viewer &&
    head &&
    hasEventProof(head) &&
    head.kind === 0 &&
    head.pubkey === key &&
    (await attestedOwner(head)) === viewer
  );
  return () => owned && profiles?.event?.(key) === head;
}

/** Library inclusion is discovery, never authority to grant chat Admin. */
export async function ownedSoloAgents(
  profiles: Pick<ProfileQueries, "ensure" | "event"> | undefined,
  viewer: string | undefined,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  const owned = new Set<string>();
  if (!profiles || !viewer || !keys.length) return owned;
  const unique = [...new Set(keys)];
  await profiles.ensure(unique);
  await Promise.all(
    unique.map(async (key) => {
      if ((await soloAgentOwnership(profiles, viewer, key))()) owned.add(key);
    }),
  );
  return new Set(unique.filter((key) => owned.has(key)));
}

/** Local recovery only; the relay still receives an ordinary channel create. */
export function soloAdminRecovery(
  channel: string,
  members: readonly string[],
  admins: readonly string[] = [],
): OutboxRecovery | undefined {
  if (!admins.length) return;
  const unique = [...new Set(admins)];
  if (
    unique.length > 32 ||
    unique.some((key) => !/^[0-9a-f]{64}$/.test(key) || !members.includes(key))
  )
    throw new Error("Opening admins must be initial chat agents.");
  return { key: soloAdminKey(channel), value: JSON.stringify(unique) };
}

/** Recognize a saved setup independently of its delivery state. */
export function soloAdminSetup(item: OutgoingEvent) {
  try {
    return readSoloAdminSetup(item);
  } catch {
    return;
  }
}

function readSoloAdminSetup(item: OutgoingEvent) {
  const create = item.event;
  const channel = create.tags.find(([tag]) => tag === "h")?.[1];
  if (
    create.kind !== 9007 ||
    !channel ||
    item.recovery?.key !== soloAdminKey(channel)
  )
    return;
  const admins: unknown = JSON.parse(item.recovery.value);
  if (
    Array.isArray(admins) &&
    admins.length > 0 &&
    admins.every(
      (key): key is string => typeof key === "string" && key !== create.pubkey,
    ) &&
    soloAdminRecovery(
      channel,
      create.tags.flatMap(([tag, key]) => (tag === "p" && key ? [key] : [])),
      admins,
    )?.value === item.recovery.value
  )
    return { channel, admins, recovery: item.recovery };
}

/** Reconstruct the exact same promotions after interruption. Their timestamp
 * and channel come from the saved create, so retries never invent a new grant
 * that could undo a later demotion or removal. */
export async function promoteSoloAdmins(
  creation: OutgoingEvent,
  writer: Omit<RelayWriter, "publish"> & {
    publish(
      event: RelayEvent,
      signal: AbortSignal,
      checkOwnership: () => void,
    ): Promise<unknown>;
  },
  reader: RelayReader,
  relayAuthor: string,
  signal: AbortSignal,
  owned?: (key: string, targets: readonly string[]) => Promise<() => boolean>,
) {
  const create = creation.event;
  const setup = readSoloAdminSetup(creation);
  if (!setup) throw new Error("The saved chat admin setup is invalid.");
  const { channel, admins } = setup;
  const read = (filters: Parameters<RelayReader["read"]>[0]) =>
    reader.read(filters, { signal, fresh: true, priority: "foreground" });
  for (const admin of admins) {
    signal.throwIfAborted();
    const template = {
      ...memberAdministrationTemplate(channel, create.pubkey, {
        pubkey: admin,
        expectedRole: "member",
        role: "admin",
      }),
      created_at: create.created_at,
    };
    const id = getEventHash({ ...template, pubkey: create.pubkey });
    const recorded = async () =>
      (
        await read([
          {
            kinds: [9000],
            ids: [id],
            authors: [create.pubkey],
            limit: 1,
            consistency: "strong",
          },
        ])
      ).some((event) => event.id === id && event.pubkey === create.pubkey);
    // A recorded grant remains complete even when its recipient was demoted.
    if (await recorded()) continue;
    if (Date.now() / 1000 - create.created_at >= 15 * 60)
      throw new Error(
        "Chat admin setup expired. Abandon setup in Outbox to continue with current roles, or start a new chat.",
      );
    const ownership = await owned?.(admin, admins);
    const checkOwnership = () => {
      if (!ownership?.())
        throw new Error(
          "An opening agent is not verified as owned by the chat creator. Retry this message or choose Abandon admin setup in Outbox to continue with current roles.",
        );
    };
    checkOwnership();
    const rosters = await read([
      {
        kinds: [39002],
        authors: [relayAuthor],
        "#d": [channel],
        limit: 1,
        consistency: "strong",
      },
    ]);
    const roster = rosters.find(
      (event) =>
        event.kind === 39002 &&
        event.pubkey === relayAuthor &&
        event.tags.some(([tag, value]) => tag === "d" && value === channel),
    );
    const role = roster?.tags.find(
      ([tag, key]) => tag === "p" && key === admin,
    )?.[3];
    if (!role || !["member", "bot", "admin"].includes(role))
      throw new Error(
        "An opening agent's access changed. Choose Abandon admin setup in Outbox to continue with current roles.",
      );
    checkOwnership();
    const signed = await writer.sign(template, signal);
    signal.throwIfAborted();
    if (signed.id !== id || signed.pubkey !== create.pubkey)
      throw new Error("The signer changed the chat admin command.");
    try {
      checkOwnership();
      await writer.publish(signed, signal, checkOwnership);
    } catch (error) {
      if (!(await recorded())) throw error;
    }
    // An OK alone is not proof of the requested role change.
    if (!(await recorded()))
      throw new Error(
        "Chat admin setup is unconfirmed. Retry the opening message.",
      );
  }
}
