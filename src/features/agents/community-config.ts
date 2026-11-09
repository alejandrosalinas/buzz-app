// Wires config channels into one bound community: the relay's support check,
// then for each agent its config channel, live sync, and online saves.
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import {
  type AgentConfigStore,
  pickSettings,
  type SettingsSchema,
  type Subject,
} from "./agent-config";
import {
  type ArtifactType,
  artifactD,
  artifactOp,
  type artifactTemplate,
  checkedHead,
  readHead,
  type SnapshotRead,
} from "./agent-config-artifacts";
import type { Mode } from "./agent-start";
import {
  agentSubject,
  type ConfigChannels,
  configSupport,
  createConfigChannels,
} from "./config-channels";
import {
  type ConfigFeed,
  type ConfigBinding,
  type ConfigSync,
  createConfigSync,
} from "./config-sync";
import {
  type ConfigWriter,
  createConfigWriter,
  headFields,
  type Saved,
  type WriteSide,
} from "./config-writes";
import { discoverTeams, type SyncedTeams } from "./team-config";
import { type TeamEdit, teamOps } from "./team-ops";

/** One agent this device runs. Hosted agents never get a config channel. */
export type ConfigAgent = Readonly<{
  pubkey: string;
  name: string;
  type: string;
  config: object;
  /** The type's synced settings allowlist; without it settings stay local. */
  schema?: SettingsSchema | undefined;
}>;

export type Side = "settings" | "instructions";
export const SIDES: readonly Side[] = ["settings", "instructions"];
export const SIDE_TYPE: Record<Side, ArtifactType> = {
  settings: "buzz.agent.settings",
  instructions: "buzz.agent.instructions",
};
const TITLE: Record<Side, string> = {
  settings: "Agent settings",
  instructions: "Agent instructions",
};

/** The fields a side publishes from a config. Settings this client doesn't
 * know stay as the head had them (NIP-AP "Editing"). */
export function fields(
  side: Side,
  agent: ConfigAgent,
  config: object,
  head?: RelayEvent,
): Record<string, unknown> {
  if (side === "instructions") {
    const text = (config as { instructions?: unknown }).instructions;
    return { version: 1, text: typeof text === "string" ? text : "" };
  }
  const schema = agent.schema ?? {};
  const { settings, agentType } = headFields(head);
  // Another type's settings are not this one's to keep; a head naming no
  // type is this one's (NIP-AP).
  const kept =
    settings &&
    typeof settings === "object" &&
    (agentType === undefined || agentType === agent.type)
      ? Object.fromEntries(
          Object.entries(settings).filter(([name]) => !(name in schema)),
        )
      : {};
  return {
    version: 1,
    agentType: agent.type,
    settings: { ...kept, ...pickSettings(schema, config) },
  };
}

/** Whether saving `config` would change the side's head. */
export function changes(
  side: Side,
  agent: ConfigAgent,
  config: object,
  head?: RelayEvent,
) {
  const next = fields(side, agent, config, head);
  return JSON.stringify({ ...headFields(head), ...next }) !== head?.content;
}

export type AgentBinding = Partial<
  Record<Side, Readonly<{ mode: Mode; subject: Subject }>>
>;

/** The head id each synced side's editor opened; `null`: it opened none. */
export type ConfigBase = Partial<Record<Side, string | null>>;

export type CommunityConfigInput = Readonly<{
  session: RelaySession;
  owner: string;
  community: string;
  store: AgentConfigStore;
  /** The synced teams discovery found, kept on this device. */
  teams: SyncedTeams;
  /** The relay's NIP-11 document. */
  info(signal: AbortSignal): Promise<unknown>;
  /** Reports each binding change, so starts and the UI re-resolve. */
  changed(): void;
  /** Reports a history change, which may leave every head as it was. */
  historyChanged(): void;
}>;

/** Config sync's view of a relay session. */
export function sessionFeed(
  session: RelaySession,
  read: ConfigFeed["read"],
  relayAuthor: string,
): ConfigFeed {
  return {
    read,
    relayAuthor,
    sync: (filter) => session.artifacts.sync(filter),
    follow: (channels, listener, revoked) =>
      session.artifacts.follow(channels, listener, revoked),
    connected(listener) {
      let was = session.live.snapshot().status === "connected";
      return session.live.subscribe(() => {
        const now = session.live.snapshot().status === "connected";
        if (now && !was) listener();
        was = now;
      });
    },
  };
}

/** Null when this session can't hold config sync or the relay lacks
 * support: then config stays local and no channel is created. */
export async function communityConfig(
  input: CommunityConfigInput,
  signal: AbortSignal,
) {
  const { session, owner, community, store } = input;
  const writer = session.configArtifactWriter;
  const read = session.snapshotRead;
  const relayAuthor = session.relayAuthor;
  if (!writer || !read || !relayAuthor) return null;
  // A failed fetch rejects: it is checked again, unlike a relay without them.
  const support = configSupport(await input.info(signal));
  if (!support.supported || signal.aborted) return null;
  const feed = sessionFeed(session, read, relayAuthor);
  let configs: CommunityConfig | undefined;
  const sync = createConfigSync(store, feed, owner, community, {
    discovery: (metadata) => configs?.discovered(metadata),
    problem: () => input.changed(),
    history: (channel, d) => configs?.historyChanged(channel, d),
    roster: (channel) => configs?.rosterChanged(channel),
  });
  // Only a new connection binds every agent again, not each complete set.
  const stopReconnected = feed.connected(() => void configs?.reconnected());
  const online = () => session.live.snapshot().status === "connected";
  configs = agentConfigs({
    channels: createConfigChannels(session, owner, feed),
    sync,
    writer: createConfigWriter({
      read: feed.read,
      writer,
      store,
      maxEventBytes: support.maxEventBytes,
      signal,
      online,
    }),
    read: feed.read,
    store,
    teams: input.teams,
    online,
    owner,
    community,
    signal,
    changed: input.changed,
    historyChanged: input.historyChanged,
    dispose: stopReconnected,
  });
  return configs;
}

/** Per-agent config channels over one community's sync and writer. */
export function agentConfigs(
  input: Readonly<{
    channels: Pick<
      ConfigChannels,
      | "ensure"
      | "addMember"
      | "removeMember"
      | "find"
      | "archive"
      | "archived"
      | "teams"
      | "owns"
    >;
    sync: Pick<ConfigSync, "bind" | "unbind" | "dispose">;
    writer: ConfigWriter;
    read: SnapshotRead;
    store: AgentConfigStore;
    teams: SyncedTeams;
    online(): boolean;
    owner: string;
    community: string;
    signal: AbortSignal;
    changed(): void;
    historyChanged?(): void;
    dispose?(): void;
  }>,
) {
  const { channels, sync, writer, store, owner, community, signal } = input;
  const agents = new Map<string, ConfigAgent>();
  const bindings = new Map<string, AgentBinding>();
  /** Each agent's selected channel and its sides there. */
  const sidesOf = new Map<string, ReadonlyMap<Side, WriteSide>>();
  /** Each agent's attach in flight; attaches chain, so two never race. */
  const running = new Map<string, Promise<void>>();
  /** Agents whose queued attach hasn't begun. */
  const queued = new Set<string>();
  /** History changes without a new head, by `channel d`, so History reloads
   * after a redaction. */
  const versions = new Map<string, number>();
  let disposed = false;
  const ops = teamOps({ ...input, signal });
  /** Each discovered team's History side, by team id. */
  const teamSides = new Map<string, WriteSide>();
  /** The discovery running, and whether another is due after it. */
  let discovering: Promise<void> | undefined;
  let again = false;
  function refreshTeams(): Promise<void> {
    if (discovering) {
      again = true;
      return discovering;
    }
    const known = () => input.teams.get(owner, community);
    discovering = (async () => {
      do {
        again = false;
        const found = await discoverTeams({ ...input, signal }, known()).catch(
          (error: unknown) => {
            // Keeps what was found before: unreadable is not deleted.
            console.warn("Synced teams were not discovered", error);
            return undefined;
          },
        );
        if (disposed) return;
        if (found) {
          input.teams.set(owner, community, found);
          input.changed();
          // Then History's side for each team's selected channel, made again
          // when it selects another: its `d` is async.
          const stale = found.filter(
            (team) =>
              !team.archived &&
              !team.unproven &&
              teamSides.get(team.id)?.expected.channel !== team.channel,
          );
          await Promise.all(
            stale.map(async (team) => {
              // No title: History only revises, and a revert's template
              // carries its own; a discovered team has no name here.
              const side = await ops.side(team.id, team.channel, "");
              if (!disposed) teamSides.set(team.id, side);
            }),
          );
          if (disposed) return;
          if (stale.length) input.historyChanged?.();
        }
      } while (again);
    })().finally(() => {
      discovering = undefined;
    });
    return discovering;
  }
  void refreshTeams();

  async function sidesIn(agent: ConfigAgent, channel: string) {
    const which = agent.schema ? SIDES : (["instructions"] as const);
    return new Map(
      await Promise.all(
        which.map(async (side): Promise<[Side, WriteSide]> => {
          const type = SIDE_TYPE[side];
          return [
            side,
            {
              subject: {
                owner,
                community,
                subject: agent.pubkey,
                channel,
                type,
              },
              expected: { channel, type, d: await artifactD(type, channel) },
              title: TITLE[side],
            },
          ];
        }),
      ),
    );
  }

  /** Attaches started together bind together: each bind otherwise reopens
   * the whole sync. Each of `size` attaches binds or leaves exactly once. */
  function together(size: number) {
    const batch: ConfigBinding[] = [];
    let left = size;
    let release!: () => void;
    const sent = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => (batch.length ? sync.bind(batch) : undefined));
    const arrive = () => {
      if (--left === 0) release();
    };
    return {
      bind(binding: ConfigBinding) {
        batch.push(binding);
        arrive();
        return sent;
      },
      leave: arrive,
    };
  }
  type Group = ReturnType<typeof together>;

  async function attach(
    agent: ConfigAgent,
    bind: (binding: ConfigBinding) => Promise<void>,
  ) {
    const channel = await channels.ensure(
      "agent-config",
      agentSubject(agent.pubkey),
      `${agent.name} config`,
      signal,
    );
    if (disposed) return;
    const before = sidesOf.get(agent.pubkey)?.values().next().value;
    const moved = before && before.expected.channel !== channel.id;
    const previous = moved ? sidesOf.get(agent.pubkey) : undefined;
    if (moved) {
      // An older channel is selected now: sync follows it.
      sync.unbind(before.expected.channel);
      bindings.delete(agent.pubkey);
    }
    if (channel.archived) {
      // Its confirmed copy is retired too, even if this coordinator never
      // bound it, and it becomes the saved channel, so a start from the
      // saved channel blocks even if another channel was confirmed (NIP-AP).
      for (const { subject } of (await sidesIn(agent, channel.id)).values()) {
        store.rebind(subject);
        store.markBound(subject);
      }
      bindings.delete(agent.pubkey);
      input.changed();
      return;
    }
    // The agent reads its own config (NIP-AP), so it is a member first.
    const member = await channels.addMember(channel.id, agent.pubkey, signal);
    if (member.status !== "confirmed")
      throw new Error(member.error ?? "The agent's membership is unconfirmed");
    const sides = await sidesIn(agent, channel.id);
    await bind({
      family: "agent-config",
      subject: agent.pubkey,
      channel: channel.id,
    });
    if (disposed) return;
    sidesOf.set(agent.pubkey, sides);
    const binding: AgentBinding = {};
    const moving: [Side, WriteSide][] = [];
    for (const [side, local] of sides) {
      const synced =
        store.state(local.subject).head || store.hadVersion(local.subject);
      store.markBound(local.subject);
      binding[side] = {
        mode: synced ? "synced" : "migrating",
        subject: local.subject,
      };
      if (!synced) moving.push([side, local]);
    }
    bindings.set(agent.pubkey, binding);
    input.changed();
    for (const [side, local] of moving) await migrate(agent, side, local);
    for (const [side, local] of sides) {
      const source = previous?.get(side);
      if (source) await reseed(local, source);
    }
  }

  /** A newly selected channel starts from a fresh strong read of the one it
   * replaces, never from local fields a synced side no longer uses
   * (NIP-AP). The create is refused where it already has a revision. With no
   * confirmed copy there, the side waits: starts stay blocked. */
  async function reseed(local: WriteSide, source: WriteSide) {
    if (disposed || store.state(local.subject).head) return;
    // Sync dropped the old channel's head on unbind, so read it fresh.
    const head = await readHead(
      input.read,
      source.expected.channel,
      source.expected.d,
      signal,
    ).catch(() => undefined);
    if (disposed || !head || "problem" in checkedHead(head, source.expected))
      return;
    await writer.save(local, JSON.parse(head.content), null);
  }

  /** Moves a side's local config into its empty channel as the first
   * revision. The create is refused at an address that already has one, so
   * a copy made elsewhere is adopted, never overwritten. Anything else
   * leaves the side local until the next connection or discovery. */
  async function migrate(agent: ConfigAgent, side: Side, local: WriteSide) {
    const saved = await writer.save(
      local,
      fields(side, agent, agent.config),
      null,
    );
    const adopted =
      saved.status === "saved" ||
      saved.status === "superseded" ||
      (saved.status === "conflict" && !!saved.head);
    const binding = bindings.get(agent.pubkey);
    if (disposed || binding?.[side]?.subject !== local.subject) return;
    bindings.set(agent.pubkey, {
      ...binding,
      [side]: { mode: adopted ? "synced" : "local", subject: local.subject },
    });
    input.changed();
  }

  function start(pubkey: string, group?: Group) {
    let bound = false;
    const bind = (binding: ConfigBinding) => {
      bound = true;
      return group ? group.bind(binding) : sync.bind([binding]);
    };
    queued.add(pubkey);
    const work: Promise<void> = (running.get(pubkey) ?? Promise.resolve())
      .then(() => {
        queued.delete(pubkey);
        const agent = agents.get(pubkey);
        return agent && attach(agent, bind);
      })
      .catch((error: unknown) => {
        // Stays as it was: retried on the next connection or discovery.
        console.warn("Agent config channel was not attached", error);
      })
      .finally(() => {
        if (!bound) group?.leave();
        if (running.get(pubkey) === work) running.delete(pubkey);
      });
    running.set(pubkey, work);
    return work;
  }

  /** The synced side, or a refusal: a side still local or unbound has no
   * relay copy to revise. */
  function synced(pubkey: string, side: Side) {
    const local = sidesOf.get(pubkey)?.get(side);
    if (!local || bindings.get(pubkey)?.[side]?.mode !== "synced")
      throw new Error("This config isn't synced here");
    return local;
  }

  return {
    /** Binds each agent not yet bound; reconnects bind every agent again. */
    attach(list: readonly ConfigAgent[]) {
      const added = list.filter((agent) => !agents.has(agent.pubkey));
      // Its type's settings schema arrived since it attached (its plugin
      // registered later, or a retype): its settings move in too.
      const gained = list.filter(
        (agent) =>
          agent.schema &&
          !added.includes(agent) &&
          !agents.get(agent.pubkey)?.schema &&
          !queued.has(agent.pubkey),
      );
      for (const agent of list) agents.set(agent.pubkey, agent);
      const group = together(added.length);
      return Promise.all(
        list.map((agent) =>
          added.includes(agent)
            ? start(agent.pubkey, group)
            : gained.includes(agent)
              ? start(agent.pubkey)
              : running.get(agent.pubkey),
        ),
      );
    },
    binding: (pubkey: string) => bindings.get(pubkey),
    /** Runs `work` once the agent's attach in flight settles; an attach
     * started meanwhile begins after it. */
    exclusive<T>(pubkey: string, work: () => Promise<T>): Promise<T> {
      const result = (running.get(pubkey) ?? Promise.resolve()).then(work);
      const done: Promise<void> = result
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (running.get(pubkey) === done) running.delete(pubkey);
        });
      running.set(pubkey, done);
      return result;
    },
    /** Discovery saw an agent config channel sync doesn't hold, or a bound
     * one archived: that agent's channel is selected and bound again. */
    discovered(metadata: RelayEvent) {
      const labels = metadata.tags.flatMap(([name, value]) =>
        name === "t" && value ? [value] : [],
      );
      if (labels.includes("team-config")) void refreshTeams();
      if (!labels.includes("agent-config")) return;
      for (const pubkey of labels)
        if (agents.has(pubkey) && !running.has(pubkey)) void start(pubkey);
    },
    /** Each connection selects and binds every agent's channel again. */
    async reconnected() {
      const idle = [...agents.keys()].filter((pubkey) => !running.has(pubkey));
      const group = together(idle.length);
      await Promise.all([
        // An attach that began may have read before this connection or fail
        // after it: one more begins once it settles.
        ...[...running.keys()].map((pubkey) =>
          queued.has(pubkey) ? running.get(pubkey) : start(pubkey),
        ),
        ...idle.map((pubkey) => start(pubkey, group)),
        refreshTeams(),
      ]);
    },
    /** A bound team channel's members changed. */
    rosterChanged(channel: string) {
      if (input.teams.get(owner, community)?.some((t) => t.channel === channel))
        void refreshTeams();
    },
    /** Creates, edits or imports a team here, its home, online, then shows
     * what the relay has. */
    async saveTeam(edit: TeamEdit) {
      try {
        return await ops.change(edit);
      } finally {
        await refreshTeams();
      }
    },
    /** Deletes a team by archiving its config channel, online. */
    async removeTeam(id: string) {
      const channel = await ops.archive(id);
      sync.unbind(channel);
      await refreshTeams();
    },
    historyChanged(channel: string, d: string) {
      const key = `${channel} ${d}`;
      versions.set(key, (versions.get(key) ?? 0) + 1);
      input.changed();
      input.historyChanged?.();
    },
    /** Each synced side's artifact, for History. */
    history(pubkey: string) {
      return SIDES.flatMap((side) => {
        const local = sidesOf.get(pubkey)?.get(side);
        if (bindings.get(pubkey)?.[side]?.mode !== "synced" || !local)
          return [];
        const { expected, subject } = local;
        return [
          {
            side,
            expected,
            head: store.state(subject).head,
            version: versions.get(`${expected.channel} ${expected.d}`) ?? 0,
          },
        ];
      });
    },
    /** The team's synced instructions, for History; undefined while it
     * isn't a listed team here. */
    teamHistory(id: string) {
      const team = input.teams
        .get(owner, community)
        ?.find((entry) => entry.id === id && !entry.archived);
      const local = teamSides.get(id);
      if (!team || team.unproven || local?.expected.channel !== team.channel)
        return undefined;
      const { expected, subject } = local;
      return {
        side: "instructions" as const,
        expected,
        head: store.state(subject).head,
        version: versions.get(`${expected.channel} ${expected.d}`) ?? 0,
      };
    },
    /** Saves a team History revert, online, then shows what the relay has. */
    async reviseTeam(
      id: string,
      template: ReturnType<typeof artifactTemplate>,
    ) {
      const local = teamSides.get(id);
      const prev = template.tags.find(([name]) => name === "prev")?.[1];
      if (!local || !prev) throw new Error("This team isn't synced here");
      try {
        return await ops.revise(id, local, template, prev);
      } finally {
        await refreshTeams();
      }
    },
    /** Reads history pages from the config channel. */
    read: input.read,
    /** Saves a History revert or restore of `side`, on the head its `prev`
     * names. */
    revise(
      pubkey: string,
      side: Side,
      template: ReturnType<typeof artifactTemplate>,
    ) {
      const prev = template.tags.find(([name]) => name === "prev")?.[1];
      if (!prev) throw new Error("A revert names the revision it replaces");
      return writer.revise(synced(pubkey, side), template, prev);
    },
    /** Saves each synced side the edit changed, as the next revision of the
     * head its editor opened. Sides are independent: one can save while the
     * other fails, and each reports its own result. */
    async save(agent: ConfigAgent, config: object, base: ConfigBase) {
      const results: Partial<Record<Side, Saved>> = {};
      for (const side of SIDES) {
        if (bindings.get(agent.pubkey)?.[side]?.mode !== "synced") continue;
        const local = synced(agent.pubkey, side);
        const opened = side in base ? (base[side] ?? null) : undefined;
        if (opened === undefined) continue;
        const head = store.state(local.subject).head;
        if (head?.id === opened && !changes(side, agent, config, head))
          continue;
        results[side] = await writer.save(
          local,
          fields(side, agent, config, head),
          opened,
        );
      }
      return results;
    },
    /** Another device's agent's synced instructions, read without creating
     * or binding anything; undefined when there are none to read. */
    async readInstructions(pubkey: string) {
      const channel = await channels.find(
        "agent-config",
        agentSubject(pubkey),
        signal,
      );
      if (!channel || channel.archived) return undefined;
      const type = "buzz.agent.instructions";
      const expected = {
        channel: channel.id,
        type,
        d: await artifactD(type, channel.id),
      } as const;
      const head = await readHead(input.read, channel.id, expected.d, signal);
      if (
        !head ||
        artifactOp(head) === "delete" ||
        "problem" in checkedHead(head, expected)
      )
        return undefined;
      return {
        instructions: (JSON.parse(head.content) as { text: string }).text,
        revision: head.id,
      };
    },
    /** Archives the agent's config channel as its Delete's last relay step
     * (NIP-AP "Deleting an agent"). Online only: a failure throws, and the
     * Delete stays unfinished until run again. */
    async remove(pubkey: string, signal: AbortSignal) {
      await running.get(pubkey);
      const channel = await channels.find(
        "agent-config",
        agentSubject(pubkey),
        signal,
      );
      if (channel && !channel.archived)
        await channels.archive(channel.id, signal);
      if (channel) sync.unbind(channel.id);
      agents.delete(pubkey);
      bindings.delete(pubkey);
      sidesOf.delete(pubkey);
      input.changed();
    },
    dispose() {
      disposed = true;
      sync.dispose();
      input.dispose?.();
    },
  };
}

export type CommunityConfig = ReturnType<typeof agentConfigs>;
