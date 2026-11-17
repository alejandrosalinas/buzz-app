import {
  fullSession,
  type ComposerSession,
} from "../../features/messages/composer-session";
import {
  allowsOutsideMentions,
  mentionChannel,
  outsideMentionReferences,
} from "../../features/messages/mention-admission";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import type { MentionRoster } from "../../features/messages/draft-mention-roster";
import type { Agent } from "../../features/agents/service";
import { mentionCandidates } from "./mention-candidates";
import { continuingNames } from "./mention-ranking";
import { namedCandidates, spaceMention } from "./use-mention-choices";
import { teamBlocksSpace } from "./use-team-mentions";
import { MENTION_RESOLVE_TIMEOUT_MS } from "../../features/conversation/completion";
import { searchable } from "../../shared/search-debounce";
import {
  PROFILE_CACHE_BASE,
  profileRosterRoom,
} from "../../features/relay/budget";
import {
  fetchMentionDirectoryPage,
  type MentionDirectoryPage,
} from "./useMentionDirectory";

/** What the chooser knew about its destination when Space was typed. */
export type SpaceMentionScope = {
  channelId: string;
  inviteAgents?: boolean | undefined;
  roster?: MentionRoster | undefined;
  /** Recipients already in the draft take part in naming. */
  selected: readonly MentionRecipient[];
  /** Current saved names, also read after asynchronous directory resolution. */
  teamNames?: (() => readonly string[]) | undefined;
  /** The owner's agents in their other communities, as the chooser offers them. */
  elsewhere?: readonly Pick<Agent, "pubkey" | "name" | "relay">[] | undefined;
};

/**
 * What Space would have done with `name` had the chooser's evidence been
 * complete (README section 5): the recipient it selects; null to return the
 * text to prose; or, when only longer known names continue the name over the
 * complete choice set, those names, each resolvable under the same rule
 * (`continued`). The words typed after the chip may complete one of them, and
 * the host asks that one. A truncated page, a namesake, a team block, a DM
 * outsider, any failure, the caller's abort or the timeout is null.
 */
export type SpaceMentionResolution =
  | MentionRecipient
  | { continued: readonly ContinuedSpaceMention[] }
  | null;
export type ContinuedSpaceMention = {
  name: string;
  resolve(signal: AbortSignal): Promise<SpaceMentionResolution>;
};

/**
 * Headless: the chooser that published the pending name unmounted when the
 * chip replaced the typed text.
 */
export async function resolveSpaceMention(
  session: ComposerSession,
  scope: SpaceMentionScope,
  name: string,
  signal: AbortSignal,
): Promise<SpaceMentionResolution> {
  if (signal.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, MENTION_RESOLVE_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    // The bound holds even over a read that ignores its signal.
    return await Promise.race([
      resolve(session, scope, name, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(), {
          once: true,
        });
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function resolve(
  session: ComposerSession,
  {
    channelId,
    inviteAgents,
    roster: draft,
    selected,
    elsewhere,
    teamNames,
  }: SpaceMentionScope,
  name: string,
  signal: AbortSignal,
): Promise<SpaceMentionResolution> {
  // A roster's owner says when its agents have loaded, as the inventory
  // wait below does for a channel.
  const roster = draft?.pending ? await draft.pending : draft?.recipients;
  const invite = !roster && !!inviteAgents;
  if (!roster) {
    session.channels.ensureList();
    await settled(
      session.channels.subscribeList,
      session.channels.list,
      (list) => list.status === "ready" || list.status === "error",
      signal,
    );
  }
  const channel = mentionChannel(session, channelId);
  const members = roster?.map((p) => p.pubkey) ?? channel?.members ?? [];
  // A member a completed read finds no profile for is known unnamed; a failed
  // read leaves its name missing, which only keeps the local step off.
  if (!roster && members.length)
    await session.profiles
      .ensure(
        members.slice(
          0,
          profileRosterRoom(session.profiles.limit?.() ?? PROFILE_CACHE_BASE),
        ),
        "background",
      )
      .catch(() => {});
  if (invite) {
    const release = session.agentChoices.retain();
    try {
      session.agentChoices.ensure(true);
      await settled(
        session.agentChoices.subscribe,
        session.agentChoices.snapshot,
        (agents) => !agents.pending || agents.status === "ready",
        signal,
      );
    } finally {
      release();
    }
  }
  const kit = fullSession(session)?.channelKit;
  if (teamBlocksSpace(kit?.snapshot() ?? { entries: [] }, name, teamNames?.()))
    return null;
  const local = new Set(
    mentionCandidates(
      session,
      channelId,
      inviteAgents,
      roster,
      undefined,
      elsewhere,
    ).map((c) => c.recipient.pubkey),
  );
  const profiles = session.profiles.snapshot();
  const unnamed = session.profiles.unnamed?.();
  const missingNames = channel?.members?.some(
    (key) => !profiles.has(key) && !unnamed?.has(key),
  );
  const decide = (
    people: MentionDirectoryPage["people"],
    complete: boolean,
    query: string,
  ): SpaceMentionResolution => {
    if (
      teamBlocksSpace(kit?.snapshot() ?? { entries: [] }, query, teamNames?.())
    )
      return null;
    const choices = namedCandidates(
      session,
      channelId,
      inviteAgents,
      roster,
      selected,
      people,
      elsewhere,
    );
    const pubkey = spaceMention(choices, local, query, {
      pending: false,
      missingNames,
      complete,
    });
    const choice = choices.find((c) => c.recipient.pubkey === pubkey);
    if (choice) {
      // A DM adds nobody and a Solo chat only the viewer's agents, and the
      // chooser row that says "Will not be notified" was never shown: a chip
      // must not promise a notification.
      if (
        !members.includes(choice.recipient.pubkey) &&
        outsideMentionReferences(
          channel,
          session.agentChoices.snapshot().identities,
          choice.recipient.pubkey,
        )
      )
        return null;
      return choice.recipient;
    }
    if (!complete) return null;
    // Over the complete set a longer name is the first thing the rule checks,
    // so these are what kept the name from selecting. Each resolves over the
    // same set: every name that equals or continues it also continues `query`.
    const longer = continuingNames(choices, query);
    if (!longer.length) return null;
    return {
      continued: longer.map((name) => ({
        name,
        resolve: async (signal: AbortSignal) =>
          signal.aborted ? null : decide(people, true, name),
      })),
    };
  };
  // Once every member is named, an exact local name selects without the
  // directory, as it does in the chooser.
  const direct = decide([], false, name);
  if (direct) return direct;
  // Where outside people only become references, the directory still names
  // namesakes of members, as the chooser shows them.
  const outside =
    allowsOutsideMentions(channel, roster, inviteAgents) &&
    !channel?.archived &&
    !channel?.readOnly;
  if (!outside) return decide([], true, name);
  // Like the chooser, text too short to search leaves the directory unread.
  if (!searchable(name)) return null;
  const page = await fetchMentionDirectoryPage(session, name, signal);
  // A truncated page may hide a namesake, as it does for Space in the chooser.
  if (signal.aborted || page.more) return null;
  return decide(page.people, true, name);
}

/** Resolves once `done` holds for the store's snapshot; rejects on abort. */
function settled<T>(
  subscribe: (listener: () => void) => () => void,
  snapshot: () => T,
  done: (value: T) => boolean,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const check = () => {
      if (!done(snapshot())) return;
      stop();
      resolve();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const unsubscribe = subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    if (signal.aborted) abort();
    else check();
  });
}
