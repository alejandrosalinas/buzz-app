// One agent's sessions in an ACP harness: one ACP session per conversation (a
// thread, a whole DM, or a channel), in the process its source gives. A quiet
// conversation's session is closed; its next message opens a new one, shown
// the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, in one pool every ACP plugin's agents share, and the
// least recently used idle session closes to make room, whichever plugin's.
// Sessions live as long as the app does; only when each conversation last used
// one is saved, so its sessions stay listed after they close.
import { absoluteWorkspace } from "../../../bundled/codex/config";
import type { SessionAction } from "../../agents/service";
import type { AcpProcess } from "./process";
import type { AcpSession } from "./session";
import { codeOf } from "./steps";
import type {
  ActivityReceipt,
  Choice,
  ResolveDirectory,
  Settled,
  ToolServer,
} from "./types";

/** A conversation's session closes after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** The most MCP servers the pool's sessions hold at once, below the host's 64
 * for every plugin, so plugins not on this client keep room. */
export const POOL_LIMIT = 48;

/** The most session ids a conversation keeps: each reopening starts one. */
export const SAVED_SESSIONS = 10;

/** What is saved for one conversation: when its session last took in a
 * message or ended a turn, and the ids of its sessions, newest first. */
export type SavedConversation = Readonly<{
  at: number;
  sessions?: readonly string[];
}>;
/** The longest session id kept; longer ones are taken as damaged. */
const SESSION_ID_LIMIT = 256;

/** Whether a saved time is one a Date can hold: finite alone lets 1e20
 * through, which throws when shown. */
export const validTime = (at: unknown): at is number =>
  typeof at === "number" && !Number.isNaN(new Date(at).getTime());

/** A saved conversation as read back from storage, or undefined when it is
 * damaged: a time a Date can hold, and its session ids de-duplicated, capped and kept
 * only when each is a short string. One saved before ids were has none. */
export function savedConversation(
  value: unknown,
): SavedConversation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { at, sessions } = value as { at?: unknown; sessions?: unknown };
  if (!validTime(at)) return undefined;
  if (sessions === undefined) return { at };
  if (!Array.isArray(sessions)) return undefined;
  const ids = sessions.filter(
    (id): id is string =>
      typeof id === "string" && id.length > 0 && id.length <= SESSION_ID_LIMIT,
  );
  return { at, sessions: [...new Set(ids)].slice(0, SAVED_SESSIONS) };
}
export type SessionStore = {
  get(key: string): SavedConversation | undefined;
  set(key: string, saved: SavedConversation): void;
};

/** A session's hold on one MCP server in the pool. */
export type Slot = {
  /** Whether it can be closed to make room: no turn runs in it. */
  idle(): boolean;
  /** Closes the session, and resolves once its server has stopped. */
  evict(): Promise<unknown>;
};

/** The MCP servers agents' sessions hold, least recently used first. */
export class ServerPool {
  private readonly slots = new Set<Slot>();
  constructor(private readonly limit = POOL_LIMIT) {}

  get size() {
    return this.slots.size;
  }
  /** Holds a server for `slot`, first closing idle sessions to keep below the
   * limit. Busy ones are never closed, so it can go over. Resolves once the
   * closed sessions' servers have stopped: the host counts them until then. */
  take(slot: Slot) {
    const evicted: Promise<unknown>[] = [];
    while (this.slots.size >= this.limit) {
      const stopped = this.evict();
      if (!stopped) break;
      evicted.push(stopped);
    }
    this.slots.add(slot);
    return Promise.all(evicted);
  }
  /** Marks `slot` as used now. */
  touch(slot: Slot) {
    if (this.slots.delete(slot)) this.slots.add(slot);
  }
  release(slot: Slot) {
    this.slots.delete(slot);
  }
  /** Closes the least recently used idle session, and resolves once its
   * server has stopped; undefined when every session is busy. */
  evict() {
    for (const slot of this.slots)
      if (slot.idle()) {
        this.slots.delete(slot);
        return slot.evict();
      }
    return undefined;
  }
}

/** The pool every ACP plugin's sessions share. */
export const SHARED_POOL = new ServerPool();

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  systemPrompt: string;
}>;

export type SessionsOptions = Readonly<{
  /** Names the harness in errors. */
  label: string;
  /** The host's, for the workspace's absolute path. */
  resolveDirectory: ResolveDirectory;
  /** Answers the agent's Buzz tools. */
  tools: ToolServer;
  /** The process its sessions open in, started when needed. */
  process: Readonly<{ get(): Promise<AcpProcess> }>;
  /** The servers its sessions hold: the shared pool unless given. */
  pool?: ServerPool;
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** The agent's provider, model and thinking level now, which each new
   * turn runs on. */
  choice(): Choice;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  /** Where each conversation's last use is saved. */
  store?: SessionStore;
  /** Told of each session opened, with the prompt and title it was opened
   * with, and the conversation it opened for: none for a one-off turn. */
  started?(
    sessionId: string,
    systemPrompt: string,
    title?: string,
    conversation?: string,
  ): void;
  /** The tags a session opens with, for the conversation it opens for:
   * none for a one-off turn. */
  tags?(conversation?: string): Readonly<Record<string, string>>;
  /** Called when a conversation's session opens, is sent a message, or
   * closes. */
  onChange?(): void;
}>;

type Live = {
  session: AcpSession;
  process: AcpProcess;
  fingerprint: string;
  slot: Slot;
  /** When it last took in a message or ended a turn. */
  at: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class AgentSessions {
  /** The latest process its sessions opened in, whose exit drops them. */
  private process: AcpProcess | undefined;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  /** Sessions opening, which `shutdown` waits for. */
  private readonly opens = new Set<Promise<Live>>();
  /** Sessions closed or closing, until a close of each is acknowledged. */
  private readonly closing = new Set<Live>();
  /** Conversations whose session is opening, and the turn it opened for. */
  private readonly opening = new Map<
    string,
    Promise<{ settled?: Promise<Settled> }>
  >();
  /** created_at of the newest event each conversation's session was shown. */
  private readonly shown = new Map<string, number>();
  /** Conversations that have had a session, whose next new one may have been
   * prompted for the old one. */
  private readonly had = new Set<string>();
  private disposed = false;

  private readonly stopped: Settled;
  private readonly late: Settled;

  constructor(private readonly options: SessionsOptions) {
    this.stopped = { ok: false, error: `${options.label} was stopped` };
    this.late = {
      ok: false,
      error: `${options.label} did not start in time`,
      undelivered: true,
    };
  }

  /** What this conversation's session has been shown. */
  seen(key: string) {
    return this.shown.get(key) ?? 0;
  }
  active(key: string) {
    return this.opening.has(key) || !!this.live.get(key)?.session.working;
  }
  /** Whether the work conversation or one-off turn `key`'s session runs now
   * still runs, unstopped and in that session, when asked later. */
  current(key: string): () => boolean {
    const serving = () => (this.live.get(key) ?? this.once.get(key))?.session;
    const session = serving();
    const current = session?.current();
    return () => !!current?.() && serving() === session;
  }
  /** The harness session serving a conversation or one-off turn, and the
   * process it lives in. */
  serving(key: string) {
    const live = this.live.get(key) ?? this.once.get(key);
    return live && { sessionId: live.session.id, process: live.process };
  }
  /** Conversations with a session, whether each is working, and when each
   * last took in a message or ended a turn. */
  snapshot(): {
    key: string;
    busy: boolean;
    sessionId?: string;
    at?: number;
  }[] {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.session.busy,
        sessionId: live.session.id,
        at: live.at,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again when the session it was built for was closed;
   * `title` names a session opened for it, except that the conversation's
   * first one is left for the harness to name, if it names sessions, when `named`
   * takes that name;
   * `model`, one of the agent's
   * provider's, and `effort`, one of its thinking levels, are what its turn
   * runs on, and `kept`, a synced level, one it must run on. Once `signal` aborts, it stops
   * waiting for a session to open, which is then kept for the next message,
   * and sends nothing. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      current,
      fresh,
      title,
      named,
      signal,
      model,
      effort,
      kept,
      ...activity
    }: Readonly<{
      steer?: string;
      current?: () => boolean;
      fresh?: () => Promise<string>;
      title?: string;
      named?: (title: string) => void;
      signal?: AbortSignal;
      model?: string;
      effort?: string;
      kept?: string;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    for (;;) {
      if (current && !current()) return { ok: true, undelivered: true };
      if (this.disposed) return { ...this.stopped, undelivered: true };
      // A message that arrives while its conversation's session opens uses it.
      const opening = this.opening.get(key);
      if (opening) {
        // The session stays shared; only this message gives up on it.
        try {
          await abortable(
            opening.catch(() => undefined),
            signal,
          );
        } catch {
          return this.late;
        }
        continue;
      }
      const live = this.live.get(key);
      if (!live) break;
      if (
        !live.session.open ||
        (!live.session.busy && (this.stale(live) || this.leveled(live, effort)))
      ) {
        this.drop(key, live);
        break;
      }
      return this.answer(
        key,
        live,
        seen,
        live.session.busy ? steer : text,
        { ...activity, ...(current ? { current } : {}) },
        model,
        effort,
        kept,
      );
    }
    // Reserved before anything is awaited, so a message that comes meanwhile
    // waits for this session instead of opening another.
    const starting = (async () => {
      const first = !this.had.has(key);
      // Perhaps built for a session closed since, which had been shown the rest.
      if (!first && fresh) text = await fresh();
      // Naming costs a model call: the harness names only the conversation's start.
      const naming = first ? named : undefined;
      const live = await this.open(
        key,
        title,
        (live) => this.disposed || this.adopt(key, live),
        naming,
      );
      if (this.disposed) throw new Error(`${this.options.label} was stopped`);
      if (signal?.aborted) return {};
      if (current && !current())
        return {
          settled: Promise.resolve({ ok: true, undelivered: true } as Settled),
        };
      const refresh = activity.refresh;
      return {
        settled: this.answer(
          key,
          live,
          seen,
          text,
          {
            ...activity,
            ...(current ? { current } : {}),
            ...(refresh
              ? {
                  refresh: () => refresh(!first),
                }
              : {}),
          },
          model,
          effort,
          kept,
        ),
      };
    })();
    this.opening.set(key, starting);
    const opened = () => {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    };
    starting.then(opened, opened);
    // Every failure here comes before a turn takes the message in.
    let started: Awaited<typeof starting>;
    try {
      started = await abortable(starting, signal);
    } catch (error) {
      if (this.disposed) return { ...this.stopped, undelivered: true };
      if (signal?.aborted) return this.late;
      console.warn(`${this.options.label} could not start`, error);
      const code = codeOf(error);
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
        ...(code === undefined ? {} : { code }),
        undelivered: true,
      };
    }
    return started.settled ?? this.late;
  }

  /** Stops the turn running in conversation `key`, if any, once a session
   * opening for it has taken its message. */
  async interrupt(key: string) {
    await this.opening.get(key)?.catch(() => undefined);
    this.live.get(key)?.session.interrupt();
  }
  /** Includes the model call after a final send has answered the turn. */
  async idle(key: string) {
    await this.opening.get(key)?.catch(() => undefined);
    await this.live.get(key)?.session.idle();
  }
  /** Waits for the conversation's session to finish its work, then compacts
   * it or closes it, so the message opens a new one. Without an open session
   * there is nothing to do. */
  async reset(key: string, action: SessionAction): Promise<Settled> {
    const live = this.live.get(key);
    if (!live?.session.open) return { ok: true };
    await live.session.idle();
    if (this.disposed) return this.stopped;
    if (this.live.get(key) !== live || !live.session.open) return { ok: true };
    if (action === "new") {
      this.drop(key, live);
      return { ok: true };
    }
    const result = await this.answer(
      key,
      live,
      this.seen(key),
      "/compact",
      {},
      undefined,
    );
    // goose ends the turn either way, and says which in its text.
    if (!result.ok || result.text === "Compaction complete") return result;
    return {
      ok: false,
      error:
        result.text || `${this.options.label} could not compact the session`,
    };
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, once `signal` aborts.
   * `prompt` is asked for the turn's text once the session is open, so a turn
   * that should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    {
      signal,
      title,
      current,
      kept,
    }: Readonly<{
      signal?: AbortSignal;
      current?: () => boolean;
      title?: string;
      kept?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return this.stopped;
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    const opening = this.open(
      key,
      title,
      (live) => this.once.has(key) && this.once.set(key, live),
    );
    let live: Live | undefined;
    try {
      live = await abortable(opening, signal);
      if (this.disposed) return this.stopped;
      const text = await abortable(Promise.resolve(prompt()), signal);
      if (text === undefined || this.disposed) return { ok: true };
      return await abortable(
        live.session.send(
          text,
          { ...(current ? { current } : {}) },
          undefined,
          undefined,
          kept,
        ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      console.warn(
        `${this.options.label} could not start a one-off session`,
        error,
      );
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
      };
    } finally {
      this.once.delete(key);
      // One that opens after the turn was given up is closed once it has.
      if (live) await this.close(live);
      else void opening.then((late) => this.close(late)).catch(() => undefined);
      this.options.onChange?.();
    }
  }

  /** Closes idle sessions opened with old settings; busy ones close when they
   * next fall idle. */
  reconfigure() {
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
  }

  /** Like `dispose()`, then resolves once every session it opened, or was
   * opening, is closed or its process has exited; rejects if one cannot be. */
  async shutdown() {
    this.dispose();
    await Promise.allSettled(this.opens);
    const closed = await Promise.allSettled(
      [...this.closing].map((live) => this.strict(live)),
    );
    this.options.onChange?.();
    const failed = closed.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  /** Closes its sessions, ending their turns; the process keeps serving other
   * agents. */
  dispose() {
    this.disposed = true;
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) if (live) void this.close(live);
  }

  private get pool() {
    return this.options.pool ?? SHARED_POOL;
  }

  /** Opened with old settings, which only a new session runs on. */
  private stale(live: Live) {
    return live.fingerprint !== this.options.fingerprint();
  }
  /** On a thinking level, when a turn with neither a pick nor a saved level
   * wants the harness's own. goose names no value for its own, so only a new
   * session runs on it; checked as that turn comes, so a session put on a
   * picked level keeps its conversation until then. */
  private leveled(live: Live, effort?: string) {
    return Boolean(
      live.session.effort && !effort && !this.options.choice().effort,
    );
  }

  /** Opens a session for `key` in the agent's workspace, which `use` records
   * as its user's. */
  private open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
    named?: (title: string) => void,
  ) {
    const opening = this.start(key, title, use, named);
    this.opens.add(opening);
    const done = () => this.opens.delete(opening);
    opening.then(done, done);
    return opening;
  }
  private async start(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
    named?: (title: string) => void,
  ): Promise<Live> {
    const { resolveDirectory } = this.options;
    const { pool } = this;
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = this.options.fingerprint();
    const launch = await this.options.launch();
    // Removed meanwhile: a process started now would outlive it.
    if (this.disposed) throw new Error(`${this.options.label} was stopped`);
    const [process, cwd] = await Promise.all([
      this.options.process.get(),
      absolute(resolveDirectory, launch.workspace),
    ]);
    if (process !== this.process) {
      this.process = process;
      void process.exited.then(() => {
        for (const [key, live] of this.live)
          if (live.process === process) this.drop(key, live);
      });
    }
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    let opened: AcpSession | undefined;
    const tags = this.options.tags?.(this.once.has(key) ? undefined : key);
    const start = () =>
      process.open({
        ...(tags ? { tags } : {}),
        onSession: (session) => (opened = session),
        cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
        ...(named ? { named } : {}),
        tools: this.options.tools,
        choice: this.options.choice,
      });
    let session: AcpSession;
    try {
      await room;
      session = await start().catch(async (error: unknown) => {
        // Other plugins hold servers too: make room once, and try again.
        const room = /too many mcp servers/i.test(message(error))
          ? pool.evict()
          : undefined;
        if (!room) throw error;
        await room;
        return start();
      });
    } catch (error) {
      pool.release(slot);
      // Opened but not set up: its close is retired like any other.
      if (opened)
        void this.close({
          session: opened,
          process,
          fingerprint,
          slot,
          at: Date.now(),
        });
      throw error;
    }
    const released = () => pool.release(slot);
    void (session.server?.closed ?? Promise.resolve()).then(released, released);
    session.conversation = key;
    const live = { session, process, fingerprint, slot, at: Date.now() };
    if (fingerprint !== this.options.fingerprint() && !this.disposed) {
      // Settings saved while it opened: it would work with the old ones.
      void this.close(live);
      return this.open(key, title, use, named);
    }
    this.options.started?.(
      session.id,
      launch.systemPrompt,
      title,
      this.once.has(key) ? undefined : key,
    );
    // Removed meanwhile: the callers are gone, and `shutdown` waits for this.
    if (this.disposed) void this.close(live);
    use(live);
    return live;
  }

  private adopt(key: string, live: Live) {
    this.had.add(key);
    this.live.set(key, live);
    // Not idle while the message it opened for is still on its way to it.
    live.slot.idle = () =>
      !live.session.busy &&
      this.live.get(key) === live &&
      !this.opening.has(key);
    live.slot.evict = async () => {
      this.drop(key, live);
      await live.session.server?.closed;
    };
    // Not saved until a message is handed to it: its own may have given up.
    this.countdown(key, live);
    this.options.onChange?.();
  }
  private async answer(
    key: string,
    live: Live,
    seen: number,
    text: string,
    activity: ActivityReceipt,
    model: string | undefined,
    effort?: string,
    kept?: string,
  ) {
    const sent = live.session.send(
      text,
      {
        ...activity,
        delivered: () => {
          if (this.live.get(key) === live) this.touch(key, live, seen);
          activity.delivered?.();
        },
      },
      model,
      effort,
      kept,
    );
    // A final Buzz send can answer before the harness finishes its model work.
    void live.session.idle().then(() => {
      if (this.live.get(key) === live) this.options.onChange?.();
    });
    // Sending made it busy; a snapshot read when it opened is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
    }
    return settled;
  }
  /** Notes that the session took in a message or ended a turn, and what it
   * has been shown, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.at = Date.now();
    const { store } = this.options;
    if (store) {
      const { id } = live.session;
      const sessions = savedConversation(store.get(key))?.sessions ?? [];
      store.set(key, {
        at: live.at,
        sessions: [id, ...sessions.filter((kept) => kept !== id)].slice(
          0,
          SAVED_SESSIONS,
        ),
      });
    }
    this.countdown(key, live);
    if (seen !== undefined)
      this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
  }
  /** Closes the session after IDLE_MS, or waits again while it is busy: a
   * long turn is not new use. */
  private countdown(key: string, live: Live) {
    this.pool.touch(live.slot);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.session.busy) this.countdown(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.shown.delete(key);
      this.options.onChange?.();
    }
    void this.close(live);
  }
  /** Closes the session, failing only for a caller that needs the harness to
   * have acknowledged it. */
  private strict(live: Live) {
    this.closing.add(live);
    return live.process
      .close(live.session, true)
      .then(() => void this.closing.delete(live));
  }
  private close(live: Live) {
    return this.strict(live).catch(() => undefined);
  }
}

/** `workspace` as an absolute path, which ACP sessions need. One already
 * absolute stays as written, as the sessions started in it recorded it. */
export async function absolute(
  resolveDirectory: ResolveDirectory,
  workspace: string,
) {
  return absoluteWorkspace(workspace) ? workspace : resolveDirectory(workspace);
}

/** `work`, or a rejection with `signal`'s reason once it aborts. */
export function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
