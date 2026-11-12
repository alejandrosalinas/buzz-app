import { ownerCanvas } from "../../features/agent-harness/project";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import {
  type ChangedFile,
  type Checkout,
  type Git,
  Unreadable,
  changedFiles,
  checkoutsOf,
  filePatch,
  nest,
  snapshot,
  startingTree,
} from "./git";
import { projectFolders } from "./paths";

export type TurnCheckout = Checkout & {
  before: string;
  after?: string;
  files?: number;
  /** Another local agent was working here at the same time, so these changes
   * may not all be this turn's. */
  shared?: true;
  /** The first snapshot was slow, so the agent's first edits may be missing. */
  late?: true;
};

/** One local agent turn in a chat with project folders: each checkout as it
 * was when the turn started and when it ended. */
export type Turn = {
  id: string;
  agent: string;
  channelId: string;
  /** Who recorded it, and in which community: only they see its card. */
  viewer: string;
  origin: string;
  thread?: string;
  start: number;
  end?: number;
  checkouts: TurnCheckout[];
  /** The agent's last message in the turn, which shows the card. */
  message?: { id: string; at: number };
  /** Messages the run published, as its activity names them. */
  published?: string[];
};

export const TURNS_KEY = "buzz-changesets-turns.v1";
export const KEEP = 300;
/** Messages this long after a turn ends still count as its reply. */
const GRACE_MS = 15_000;
const KEEP_SUMMARIES = 50;
const LATE_MS = 1_500;
const NEW_WORKTREES = 5;
const KEEP_PUBLISHED = 20;
const NONE: readonly Turn[] = [];

type Identity = { viewer: string; origin: string };
type Work = NonNullable<
  ReturnType<RelaySession["agentActivity"]["snapshot"]>["local"]
>[number];

const workKey = (work: Work) =>
  `${work.scope}:${work.agent}:${work.messageId}:${work.startedAt}`;
const sessionOf = (work: Work) =>
  `${work.agent}:${work.channelId}:${work.thread ? work.threadRootId : ""}`;

/** An agent Buzz runs here, not on another machine or a remote target. Only
 * such a turn works in the folders on this computer. */
const runsHere = (session: RelaySession, agent: string) =>
  session.agentChoices
    .snapshot()
    .identities.some(
      (choice) => choice.pubkey === agent && choice.execution === "local",
    );

export function createTurns(git: Git, storage: Storage = localStorage) {
  let turns = load();
  let identity: Identity | undefined;
  let version = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const mine = (turn: Turn) =>
    !!identity &&
    turn.viewer === identity.viewer &&
    turn.origin === identity.origin;
  const changed = (turn: Turn) =>
    turn.checkouts.some((checkout) => checkout.files);

  let byChat = new Map<string, Turn[]>();
  let byMessage = new Map<string, Turn[]>();
  const chatOf = (agent: string, channelId: string) => `${agent}:${channelId}`;
  const reindex = () => {
    byChat = new Map();
    byMessage = new Map();
    for (const turn of turns) {
      if (turn.end && turn.message && changed(turn))
        byMessage.set(turn.message.id, [
          ...(byMessage.get(turn.message.id) ?? []),
          turn,
        ]);
      const key = chatOf(turn.agent, turn.channelId);
      byChat.set(key, [...(byChat.get(key) ?? []), turn]);
    }
    for (const list of byChat.values()) list.sort((a, b) => a.start - b.start);
  };
  reindex();

  let saving: ReturnType<typeof setTimeout> | undefined;
  const store = () => {
    saving = undefined;
    try {
      storage.setItem(
        TURNS_KEY,
        JSON.stringify(turns.filter((t) => t.end && changed(t)).slice(-KEEP)),
      );
    } catch {
      // Storage full or off: the cards last until Buzz restarts.
    }
  };
  const save = () => {
    // Turns that changed nothing stay in memory as the boundary between the
    // turns either side, but aren't stored.
    if (turns.length > KEEP * 2) turns = turns.slice(-KEEP * 2);
    reindex();
    saving ??= setTimeout(store, 1000);
    notify();
  };

  const summaries = new Map<string, Promise<ChangedFile[]>>();
  const find = (id: string, index: number) => {
    const turn = turns.find((candidate) => candidate.id === id);
    const checkout = turn && mine(turn) ? turn.checkouts[index] : undefined;
    return turn && checkout?.after
      ? { turn, checkout, after: checkout.after }
      : undefined;
  };
  const recorded = (id: string, index: number) => {
    const found = find(id, index);
    if (!found)
      throw new Unreadable("This changeset was recorded in another Buzz.");
    return found;
  };
  const remember = (key: string, files: Promise<ChangedFile[]>) => {
    summaries.set(key, files);
    files.catch(() => summaries.delete(key));
    while (summaries.size > KEEP_SUMMARIES)
      summaries.delete(summaries.keys().next().value as string);
  };

  const active = new Set<Turn>();

  async function begin(
    session: RelaySession,
    signedIn: Identity | undefined,
    agent: string,
    channelId: string,
    thread: string | undefined,
  ) {
    if (!signedIn) return undefined;
    const start = Date.now();
    // Recorded at once, so a message early in this turn never counts as the
    // reply to the agent's last turn while the snapshots still run.
    const record: Turn = {
      id: start.toString(36) + Math.random().toString(36).slice(2, 8),
      agent,
      channelId,
      ...signedIn,
      ...(thread ? { thread } : {}),
      start,
      checkouts: [],
    };
    turns.push(record);
    reindex();
    try {
      const canvas = await ownerCanvas(
        session.canvas,
        signedIn.viewer,
        channelId,
      );
      const found = (
        await Promise.all(
          projectFolders(canvas).map((folder) =>
            checkoutsOf(git, folder).catch(() => []),
          ),
        )
      ).flat();
      const unique = found.filter(
        (checkout, index) =>
          found.findIndex(
            (other) =>
              other.dir === checkout.dir && other.prefix === checkout.prefix,
          ) === index,
      );
      const taken = await Promise.all(
        unique.map(async (checkout) => {
          const before = await snapshot(git, checkout).catch(() => undefined);
          return before
            ? {
                ...checkout,
                before,
                ...(Date.now() - start > LATE_MS
                  ? { late: true as const }
                  : {}),
              }
            : undefined;
        }),
      );
      record.checkouts = taken.filter((checkout) => !!checkout);
    } catch {
      record.checkouts = [];
    }
    if (record.checkouts.length) {
      for (const other of active)
        for (const ours of record.checkouts)
          for (const theirs of other.checkouts)
            if (ours.dir === theirs.dir) ours.shared = theirs.shared = true;
      active.add(record);
      return record;
    }
    turns = turns.filter((turn) => turn !== record);
    reindex();
    return undefined;
  }

  async function addedWorktrees(record: Turn) {
    const key = (checkout: Checkout) => `${checkout.dir}\0${checkout.prefix}`;
    const known = new Set(record.checkouts.map(key));
    const origins = record.checkouts.slice(0, 10);
    const found = (
      await Promise.all(
        origins.map((origin) =>
          checkoutsOf(git, origin.dir).then(
            (list) =>
              list.map((checkout) => ({ ...checkout, prefix: origin.prefix })),
            () => [],
          ),
        ),
      )
    ).flat();
    const added: TurnCheckout[] = [];
    for (const checkout of found) {
      if (known.has(key(checkout)) || added.length >= NEW_WORKTREES) continue;
      known.add(key(checkout));
      const before = await startingTree(git, checkout.dir).catch(
        () => undefined,
      );
      if (before) added.push({ ...checkout, before });
    }
    if (added.length) record.checkouts = nest([...record.checkouts, ...added]);
  }

  async function finish(record: Turn) {
    await addedWorktrees(record).catch(() => {});
    await Promise.all(
      record.checkouts.map(async (checkout, index) => {
        const after = await snapshot(git, checkout).catch(() => undefined);
        checkout.files = 0;
        if (!after) return;
        checkout.after = after;
        const files = changedFiles(git, checkout, checkout.before, after);
        remember(`${record.id}:${index}`, files);
        checkout.files = await files.then(
          (list) => list.length,
          () => 0,
        );
      }),
    );
    active.delete(record);
    record.end = Date.now();
    save();
  }

  const started = new Map<string, Promise<Turn | undefined>>();
  const ended = new Set<string>();
  const known = new Set<string>();
  // A request folded into a running turn hands its snapshots to the next.
  const handed = new Map<string, Promise<Turn | undefined>>();

  function retire(record: Turn) {
    active.delete(record);
    turns = turns.filter((turn) => turn !== record);
    reindex();
  }
  function forget(key: string) {
    const turn = started.get(key);
    started.delete(key);
    ended.delete(key);
    void turn?.then((record) => record && !record.end && retire(record));
  }

  function publish(record: Turn, ids: readonly string[]) {
    const next = ids.slice(-KEEP_PUBLISHED);
    if (record.published?.join() === next.join()) return;
    record.published = next;
    for (const other of turns)
      if (other !== record && other.message && next.includes(other.message.id))
        delete other.message;
    save();
  }

  function watch(session: RelaySession, origin: string | undefined) {
    const signedIn =
      session.viewer && origin ? { viewer: session.viewer, origin } : undefined;
    if (
      signedIn?.viewer !== identity?.viewer ||
      signedIn?.origin !== identity?.origin
    ) {
      identity = signedIn;
      for (const key of [...started.keys()]) forget(key);
      known.clear();
      handed.clear();
      notify();
    }
    const activity = session.agentActivity;
    const release = activity.activate();
    // Work already going when the plugin started is only partly visible, and
    // a turn this plugin followed under an earlier binding carries on.
    const rows = activity.snapshot().local ?? [];
    const present = new Set(rows.map(workKey));
    for (const key of [...started.keys()]) if (!present.has(key)) forget(key);
    for (const key of present) if (!started.has(key)) known.add(key);
    const scan = () => {
      for (const work of activity.snapshot().local ?? []) {
        const key = workKey(work);
        const turn = started.get(key);
        if (turn && work.publishedMessageIds?.length) {
          const ids = work.publishedMessageIds;
          void turn.then((record) => record && publish(record, ids));
        }
        if (work.state === "waiting" || work.state === "working") {
          if (known.has(key) || turn) continue;
          if (!runsHere(session, work.agent)) {
            known.add(key);
            continue;
          }
          const place = sessionOf(work);
          const inherited = handed.get(place);
          handed.delete(place);
          const opened =
            inherited ??
            begin(
              session,
              signedIn,
              work.agent,
              work.channelId,
              work.thread ? work.threadRootId : undefined,
            ).catch(() => undefined);
          started.set(key, opened);
        } else if (turn && !ended.has(key)) {
          ended.add(key);
          if (work.state === "superseded") handed.set(sessionOf(work), turn);
          else void turn.then((record) => record && finish(record));
        }
      }
    };
    const stop = activity.subscribe(scan);
    scan();
    return () => {
      stop();
      release();
    };
  }

  function load(): Turn[] {
    try {
      const value: unknown = JSON.parse(storage.getItem(TURNS_KEY) ?? "[]");
      return Array.isArray(value) ? value.filter(isTurn) : [];
    } catch {
      return [];
    }
  }

  return {
    watch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
    flush() {
      if (saving === undefined) return;
      clearTimeout(saving);
      store();
    },
    /** Finds the turn `message` replies to: a later message from the same
     * agent in the same turn takes over its card. */
    claim(
      message: Pick<
        ChannelMessage,
        "id" | "authorId" | "channelId" | "createdAt" | "threadRootId"
      > & { createdAtMs?: number },
    ) {
      const at = message.createdAtMs ?? message.createdAt * 1000;
      const owner = turns.find(
        (turn) => mine(turn) && turn.published?.includes(message.id),
      );
      const all = byChat.get(chatOf(message.authorId, message.channelId));
      if (!owner && !all) return;
      const chat = (owner ? [owner] : (all ?? [])).filter(
        (turn) =>
          mine(turn) &&
          (owner ||
            (message.threadRootId
              ? turn.thread === message.threadRootId
              : !turn.thread)),
      );
      let claimed = false;
      chat.forEach((turn, index) => {
        if (!owner) {
          if (at < turn.start - 1000) return;
          if (turn.end && at > turn.end + GRACE_MS) return;
          const next = chat[index + 1];
          if (next && at >= next.start - 1000) return;
        }
        if (
          !turn.message ||
          turn.message.at < at ||
          (turn.message.at === at && turn.message.id < message.id)
        ) {
          turn.message = { id: message.id, at };
          claimed = true;
        }
      });
      if (claimed) save();
    },
    /** The finished turns whose card `messageId` shows. */
    cardsFor: (messageId: string) =>
      byMessage.get(messageId)?.filter(mine) ?? NONE,
    summary(id: string, index: number): Promise<ChangedFile[]> {
      const key = `${id}:${index}`;
      const known = summaries.get(key);
      if (known) return known;
      try {
        const { checkout, after } = recorded(id, index);
        const files = changedFiles(git, checkout, checkout.before, after);
        remember(key, files);
        return files;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    patch(id: string, index: number, file: ChangedFile) {
      const { checkout, after } = recorded(id, index);
      return filePatch(git, checkout, checkout.before, after, file);
    },
    /** The turn and checkout a panel link names, if this Buzz recorded it. */
    find,
  };
}
export type Turns = ReturnType<typeof createTurns>;

const strings = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTurn = (value: unknown): value is Turn =>
  record(value) &&
  typeof value.id === "string" &&
  typeof value.agent === "string" &&
  typeof value.channelId === "string" &&
  typeof value.viewer === "string" &&
  typeof value.origin === "string" &&
  (value.thread === undefined || typeof value.thread === "string") &&
  typeof value.start === "number" &&
  strings(value.published) &&
  Array.isArray(value.checkouts) &&
  value.checkouts.every(
    (checkout) =>
      record(checkout) &&
      typeof checkout.dir === "string" &&
      typeof checkout.prefix === "string" &&
      typeof checkout.label === "string" &&
      strings(checkout.skip) &&
      typeof checkout.before === "string",
  );
