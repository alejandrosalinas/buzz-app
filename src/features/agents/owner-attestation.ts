import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "nostr-tools/utils";
import { communityDestination } from "../communities/destination";
import type { ProfileQueries } from "../relay/profile-directory";
import { hasEventProof, type EventData } from "../relay/events";
import { workflowMentionOwner } from "../relay/workflow-attribution";
import type { AgentReads } from "./reads";

const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;

/** NIP-OA owner of a signature-verified event, or undefined. Provenance only:
 * the event stays authored by `event.pubkey`; the owner is never an author. */
export async function attestedOwner(
  event: Pick<EventData, "pubkey" | "kind" | "created_at"> &
    Readonly<{ tags: readonly (readonly string[])[] }>,
): Promise<string | undefined> {
  const [tag, ...extra] = event.tags.filter((tag) => tag[0] === "auth");
  if (!tag || extra.length || !satisfied(tag[2] ?? "", event)) return undefined;
  return authTagOwner(event.pubkey, tag);
}

/** NIP-IA ownership: exact tag shape, clause syntax, target binding and signature.
 * Clauses are not evaluated here; archive requests check time bounds separately. */
export async function authTagOwner(
  target: string,
  tag: readonly string[],
): Promise<string | undefined> {
  const [name, owner, conditions, sig] = tag;
  if (
    name !== "auth" ||
    tag.length !== 4 ||
    !owner ||
    conditions === undefined ||
    !sig ||
    !KEY.test(owner) ||
    !SIG.test(sig) ||
    owner === target ||
    !validConditions(conditions)
  )
    return undefined;
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${target}:${conditions}`),
    );
    return schnorr.verify(
      hexToBytes(sig),
      new Uint8Array(digest),
      hexToBytes(owner),
    )
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}

/** NIP-IA request bounds: only created_at clauses apply to the request time. */
export function withinTimeBounds(conditions: string, createdAt: number) {
  return satisfied(conditions, { kind: -1, created_at: createdAt }, true);
}

function validConditions(conditions: string) {
  return (
    conditions === "" ||
    conditions.split("&").every((clause) => {
      const [, name, digits] = CLAUSE.exec(clause) ?? [];
      if (!name || !digits) return false;
      return Number(digits) <= (name === "kind=" ? 65535 : 4294967295);
    })
  );
}

function satisfied(
  conditions: string,
  event: Pick<EventData, "kind" | "created_at">,
  ignoreKind = false,
) {
  if (!validConditions(conditions)) return false;
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause) ?? [];
    const value = Number(digits);
    if (name === "kind=") return ignoreKind || event.kind === value;
    return name === "created_at<"
      ? event.created_at < value
      : event.created_at > value;
  });
}

/** Whether this build keeps workflow messages from authorizing local agent
 * requests in `community`. The build flag lists exact canonical origins; with
 * any listed, an unknown or unreadable community is restricted too. */
export function workflowRequestsRestricted(community: string | undefined) {
  const restricted = (
    import.meta.env.VITE_BUZZ_WORKFLOW_RESTRICTED_COMMUNITIES ?? ""
  )
    .split(" ")
    .filter(Boolean);
  if (!restricted.length) return false;
  if (!community) return true;
  try {
    return restricted.includes(communityDestination(community).url);
  } catch {
    return true;
  }
}

/** How a mention from a relay workflow is checked: the agent's community, the
 * community's workflow key, and its creators' profiles. */
export type WorkflowCheck = {
  community?: string | undefined;
  authority: string | undefined;
  agent: string;
  profiles?: Pick<ProfileQueries, "ensure" | "event"> | undefined;
};

/** The workflow check of an agent's community reads, if they can be read. */
export function workflowOf(
  reads: AgentReads | undefined,
  agent: string,
): WorkflowCheck {
  return {
    agent,
    community: reads?.origin,
    authority: reads?.workflowAuthority(),
    profiles: reads && {
      ensure: async (ids) => {
        await reads.profiles(ids);
      },
      event: (pubkey) => reads.profile(pubkey),
    },
  };
}

/** Owner prompts, attested siblings, and verified relay workflow mentions
 * delegated by the owner or a profile-verified sibling to this particular agent.
 * Where the build restricts workflow requests, no workflow-marked message
 * authorizes one: its rendered text is not bound to the owner's template. */
export async function fromOwner(
  event: EventData,
  owner: string,
  workflow?: WorkflowCheck,
) {
  const restricted = workflowRequestsRestricted(workflow?.community);
  if (restricted && event.tags.some(([name]) => name === "buzz:workflow"))
    return false;
  if (event.pubkey === owner || (await attestedOwner(event)) === owner)
    return true;
  const creator =
    !restricted &&
    workflow &&
    workflowMentionOwner(event, workflow.authority, workflow.agent);
  if (!creator) return false;
  if (creator === owner) return true;
  const profiles = workflow?.profiles;
  if (!profiles?.event) return false;
  try {
    await profiles.ensure([creator]);
    const profile = profiles.event(creator);
    return (
      !!profile &&
      hasEventProof(profile) &&
      profile.kind === 0 &&
      profile.pubkey === creator &&
      (await attestedOwner(profile)) === owner &&
      profiles.event(creator) === profile
    );
  } catch {
    // Missing or failed profile reads are not ownership verdicts; a later
    // mention can retry through the session's existing profile directory.
    return false;
  }
}
