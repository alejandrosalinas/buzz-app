import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { VerifiedEvent } from "nostr-tools";
import type {
  ArtifactSyncSnapshot,
  ArtifactSyncView,
} from "../relay/artifact-sync";
import { PublishRejected } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import { AgentConfigStore } from "./agent-config";
import {
  artifactD,
  artifactTemplate,
  type SnapshotRead,
} from "./agent-config-artifacts";
import { agentConfigs, type ConfigAgent, fields } from "./community-config";
import { type ConfigFeed, createConfigSync } from "./config-sync";
import { createConfigWriter } from "./config-writes";
import { memoryStorage } from "./test-fakes";
import { teamSubject } from "./config-channels";
import { SyncedTeams, teamSources } from "./team-config";

const key = generateSecretKey();
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const agent: ConfigAgent = {
  pubkey: "a".repeat(64),
  name: "Echo",
  type: "example/echo",
  config: { instructions: "local text" },
};
/** Another device's first revision of `type` in the channel. */
async function created(text: string) {
  const d = await artifactD("buzz.agent.instructions", channel);
  return sign(
    artifactTemplate({
      channel,
      type: "buzz.agent.instructions",
      d,
      op: "create",
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text }),
    }),
  );
}
const relayKey = keypair();
/** Relay-signed state of an active channel with the owner "o" in it. */
const channelState = (id: string) => [
  signed(relayKey, { kind: 39000, content: "", tags: [["d", id]] }),
  signed(relayKey, {
    kind: 39002,
    content: "",
    tags: [
      ["d", id],
      ["p", "o"],
    ],
  }),
];
const tag = (event: RelayEvent, name: string) =>
  event.tags.find(([key]) => key === name)?.[1];
const sign = (template: EventTemplate) =>
  finalizeEvent(template, key) as RelayEvent;

/** One agent's config channel on a relay that keeps a head per `d` and
 * refuses a create or update over the wrong head. */
function setup(
  options: {
    refuse?: string;
    /** Another device's state of the same relay and this device's storage,
     * so a second setup is a restart. */
    heads?: Map<string, RelayEvent>;
    storage?: ReturnType<typeof memoryStorage>;
    /** Runs before the relay decides a publish; may change the relay. */
    beforePublish?(event: RelayEvent): Promise<void> | void;
    /** The real sync owner over this relay, instead of a no-op. */
    realSync?: boolean;
    /** A team config channel's members, as the relay reports them now. */
    team?: { id: string; channel: string; head: RelayEvent; members: string[] };
  } = {},
) {
  const heads = options.heads ?? new Map<string, RelayEvent>();
  const d = (event: RelayEvent) =>
    event.tags.find(([name]) => name === "d")?.[1] ?? "";
  const room = { id: channel, archived: false, members: [] };
  const views = new Set<ArtifactSyncView & { push(): void }>();
  const read: SnapshotRead = async (filters) => {
    const filter = filters[0];
    // The real sync confirms each channel is active with the owner in it.
    if (filter?.kinds?.includes(39000))
      return channelState(filter["#d"]?.[0] ?? "");
    if (filter?.["#P"]) return [];
    const team = options.team;
    if (team && filter?.["#d"]?.[0] === tag(team.head, "d")) return [team.head];
    const head = heads.get(filter?.["#d"]?.[0] ?? "");
    return head ? [head] : [];
  };
  const storage = options.storage ?? memoryStorage();
  const store = new AgentConfigStore(storage);
  const changed = vi.fn();
  const historyChanged = vi.fn();
  const feed: ConfigFeed = {
    read,
    relayAuthor: relayKey.pubkey,
    connected: () => () => {},
    sync(filter) {
      const listeners = new Set<() => void>();
      const events = () =>
        [...heads.values()].filter((event) =>
          event.tags.some(
            ([name, value]) =>
              name === "h" && filter["#h"]?.includes(value ?? ""),
          ),
        ) as VerifiedEvent[];
      let snapshot: ArtifactSyncSnapshot = { status: "live", events: events() };
      const view = {
        snapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose: () => views.delete(view),
        push() {
          snapshot = { status: "live", events: events() };
          for (const listener of listeners) listener();
        },
      };
      views.add(view);
      return view;
    },
  };
  const archive = vi.fn(async () => {
    if (options.refuse) throw new Error(options.refuse);
    room.archived = true;
  });
  const ensure = vi.fn(async () => room);
  const bind = vi.fn(async (_bindings: readonly unknown[]) => {});
  const teams = new SyncedTeams(memoryStorage());
  const configs: ReturnType<typeof agentConfigs> = agentConfigs({
    channels: {
      ensure,
      find: async () => room,
      archive,
      addMember: async () => ({ status: "confirmed" }),
      teams: async () => {
        const team = options.team;
        return team
          ? [
              {
                id: team.channel,
                label: await teamSubject(team.id),
                archived: false,
                members: team.members,
              },
            ]
          : [];
      },
      owns: async () => true,
    } as never,
    sync: options.realSync
      ? createConfigSync(store, feed, "o", "c", {
          roster: (id) => configs.rosterChanged(id),
        })
      : { bind, unbind: () => {}, dispose: () => {} },
    writer: createConfigWriter({
      read,
      store,
      maxEventBytes: 512 * 1024,
      signal: new AbortController().signal,
      online: () => true,
      writer: {
        sign: async (template) => sign(template),
        publish: async (event) => {
          await options.beforePublish?.(event);
          if (options.refuse) throw new PublishRejected("no", options.refuse);
          const prev = event.tags.find(([name]) => name === "prev")?.[1];
          if (prev !== heads.get(d(event))?.id)
            throw new PublishRejected("conflict", "conflict: stale prev");
          heads.set(d(event), event);
          for (const view of views) view.push();
        },
      },
    }),
    teams,
    online: () => true,
    read,
    store,
    owner: "o",
    community: "c",
    signal: new AbortController().signal,
    changed,
    historyChanged,
  });
  const text = () => {
    const [head] = heads.values();
    return head && (JSON.parse(head.content) as { text: string }).text;
  };
  return {
    heads,
    storage,
    store,
    configs,
    text,
    changed,
    historyChanged,
    archive,
    room,
    ensure,
    bind,
    teams,
    /** Shows each open sync the relay's current heads. */
    push: () => {
      for (const view of views) view.push();
    },
  };
}

describe("moving local config into its channel", () => {
  it("creates the first revision from the local row, then syncs it", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    expect(f.text()).toBe("local text");
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("adopts a copy made elsewhere instead of overwriting it", async () => {
    const f = setup();
    // Another device created it first with different text.
    const d = await artifactD("buzz.agent.instructions", channel);
    f.heads.set(
      d,
      sign(
        artifactTemplate({
          channel,
          type: "buzz.agent.instructions",
          d,
          op: "create",
          title: "Agent instructions",
          content: JSON.stringify({ version: 1, text: "elsewhere" }),
        }),
      ),
    );
    await f.configs.attach([agent]);
    expect(f.text()).toBe("elsewhere");
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("stays local when the create is refused, so starts keep the local row", async () => {
    const f = setup({ refuse: "restricted: not a member" });
    await f.configs.attach([agent]);
    expect(f.heads.size).toBe(0);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("local");
  });
});

describe("migration races and restarts", () => {
  it("adopts a copy another device created between the read and this create", async () => {
    const elsewhere = await created("elsewhere");
    const f = setup({
      beforePublish: async (event) => {
        const d = event.tags.find(([name]) => name === "d")?.[1] ?? "";
        if (!f.heads.has(d)) f.heads.set(d, elsewhere);
      },
    });
    await f.configs.attach([agent]);
    expect(f.text()).toBe("elsewhere");
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("a restart after the create stays synced and never creates again", async () => {
    const first = setup();
    await first.configs.attach([agent]);
    first.configs.dispose();
    const publish = vi.fn();
    const again = setup({
      heads: first.heads,
      storage: first.storage,
      beforePublish: publish,
    });
    await again.configs.attach([
      { ...agent, config: { instructions: "edit" } },
    ]);
    expect(publish).not.toHaveBeenCalled();
    expect(again.text()).toBe("local text");
    expect(again.configs.binding(agent.pubkey)?.instructions?.mode).toBe(
      "synced",
    );
  });

  it("a restart before the create was confirmed migrates again from the local row", async () => {
    const first = setup({ refuse: "error: timed out" });
    await first.configs.attach([agent]);
    expect(first.configs.binding(agent.pubkey)?.instructions?.mode).toBe(
      "local",
    );
    first.configs.dispose();
    const again = setup({ heads: first.heads, storage: first.storage });
    await again.configs.attach([agent]);
    expect(again.text()).toBe("local text");
    expect(again.configs.binding(agent.pubkey)?.instructions?.mode).toBe(
      "synced",
    );
  });
});

describe("a newly selected channel", () => {
  it("starts from the last confirmed copy, never the stale local row", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    const other = "1f0d1c52-3b5e-4c38-9d0b-5c1f8f1f6a7e";
    // Discovery now selects another channel, which is empty; the local row
    // still holds the text synced before.
    f.room.id = other;
    await f.configs.attach([{ ...agent, config: { instructions: "stale" } }]);
    await f.configs.reconnected();
    const head = f.heads.get(await artifactD("buzz.agent.instructions", other));
    expect(JSON.parse(head?.content ?? "null")).toEqual({
      version: 1,
      text: "local text",
    });
    expect(f.configs.binding(agent.pubkey)?.instructions?.subject.channel).toBe(
      other,
    );
  });

  it("keeps settings an agent gains after its first attach synced from other devices", async () => {
    const f = setup({ realSync: true });
    await f.configs.attach([agent]);
    // Retyped to one with synced settings; the next connection moves them in.
    const typed = {
      ...agent,
      schema: { model: "string" },
      config: { instructions: "local text", model: "m1" },
    } as const;
    await f.configs.attach([typed]);
    await f.configs.reconnected();
    const side = f.configs.binding(agent.pubkey)?.settings;
    const d = await artifactD("buzz.agent.settings", channel);
    const opened = f.heads.get(d);
    if (side?.mode !== "synced" || !opened) throw new Error("No settings head");
    const remote = sign(
      artifactTemplate({
        channel,
        type: "buzz.agent.settings",
        d,
        op: "update",
        prev: opened.id,
        title: "Agent settings",
        content: JSON.stringify({
          version: 1,
          agentType: typed.type,
          settings: { model: "m2" },
        }),
      }),
    );
    f.heads.set(d, remote);
    f.push();
    await vi.waitFor(() =>
      expect(f.store.state(side.subject).head?.id).toBe(remote.id),
    );
  });

  it("moves settings in once the agent's type gains a schema, without a reconnect", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    expect(f.configs.binding(agent.pubkey)?.settings).toBeUndefined();
    // Its type's plugin registered after the first attach.
    await f.configs.attach([
      {
        ...agent,
        schema: { model: "string" },
        config: { instructions: "local text", model: "m1" },
      },
    ]);
    expect(f.configs.binding(agent.pubkey)?.settings?.mode).toBe("synced");
    const head = f.heads.get(await artifactD("buzz.agent.settings", channel));
    expect(JSON.parse(head?.content ?? "null")).toMatchObject({
      settings: { model: "m1" },
    });
  });

  it("copies the source channel through the real sync, which drops its head on unbind", async () => {
    const f = setup({ realSync: true });
    await f.configs.attach([agent]);
    const side = f.configs.binding(agent.pubkey)?.instructions;
    await vi.waitFor(() =>
      expect(side && f.store.state(side.subject).head).toBeDefined(),
    );
    const other = "1f0d1c52-3b5e-4c38-9d0b-5c1f8f1f6a7e";
    // Another device edits the source while discovery selects the new one.
    const d = await artifactD("buzz.agent.instructions", channel);
    const opened = f.heads.get(d);
    f.heads.set(
      d,
      sign(
        artifactTemplate({
          channel,
          type: "buzz.agent.instructions",
          d,
          op: "update",
          prev: opened?.id ?? "",
          title: "Agent instructions",
          content: JSON.stringify({ version: 1, text: "edited elsewhere" }),
        }),
      ),
    );
    f.room.id = other;
    await f.configs.reconnected();
    const head = f.heads.get(await artifactD("buzz.agent.instructions", other));
    expect(JSON.parse(head?.content ?? "null")).toEqual({
      version: 1,
      text: "edited elsewhere",
    });
  });

  it("binds agents attached together in one bind", async () => {
    const f = setup();
    await f.configs.attach([agent, { ...agent, pubkey: "b".repeat(64) }]);
    expect(f.bind).toHaveBeenCalledOnce();
    // Attaches reach the batch in whichever order their awaits settle.
    expect(f.bind.mock.calls[0]?.[0]).toHaveLength(2);
    expect(f.bind.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: agent.pubkey }),
        expect.objectContaining({ subject: "b".repeat(64) }),
      ]),
    );
  });

  it("a connection joins an agent's attach in flight instead of selecting again", async () => {
    const f = setup();
    await Promise.all([f.configs.attach([agent]), f.configs.reconnected()]);
    expect(f.ensure).toHaveBeenCalledOnce();
  });

  it("a connection attaches again once an attach that began before it fails", async () => {
    const f = setup();
    let fail!: (error: Error) => void;
    f.ensure.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const attached = f.configs.attach([agent]);
    await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledOnce());
    const reconnected = f.configs.reconnected();
    fail(new Error("offline"));
    await Promise.all([attached, reconnected]);
    warn.mockRestore();
    expect(f.ensure).toHaveBeenCalledTimes(2);
    expect(f.configs.binding(agent.pubkey)?.instructions?.mode).toBe("synced");
  });

  it("runs exclusive work between an agent's attaches", async () => {
    const f = setup();
    let found!: (room: typeof f.room) => void;
    f.ensure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          found = resolve;
        }),
    );
    const attached = f.configs.attach([agent]);
    await vi.waitFor(() => expect(f.ensure).toHaveBeenCalledOnce());
    let release!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const exclusive = f.configs.exclusive(agent.pubkey, work);
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    found(f.room);
    await attached;
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    const reconnected = f.configs.reconnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.ensure).toHaveBeenCalledOnce();
    release();
    await Promise.all([exclusive, reconnected]);
    expect(f.ensure).toHaveBeenCalledTimes(2);
  });

  it("stays blocked when the source can't be read", async () => {
    const f = setup({ realSync: true });
    await f.configs.attach([agent]);
    const other = "1f0d1c52-3b5e-4c38-9d0b-5c1f8f1f6a7e";
    f.heads.clear();
    f.room.id = other;
    await f.configs.reconnected();
    expect(f.heads.size).toBe(0);
    const side = f.configs.binding(agent.pubkey)?.instructions;
    expect(side?.subject.channel).toBe(other);
    expect(side && f.store.state(side.subject).head).toBeUndefined();
  });

  it("waits with no confirmed copy to start from, after a restart", async () => {
    const first = setup();
    await first.configs.attach([agent]);
    first.configs.dispose();
    const again = setup({ heads: new Map(), storage: first.storage });
    again.room.id = "1f0d1c52-3b5e-4c38-9d0b-5c1f8f1f6a7e";
    await again.configs.attach([
      { ...agent, config: { instructions: "stale" } },
    ]);
    expect(again.heads.size).toBe(0);
    const side = again.configs.binding(agent.pubkey)?.instructions;
    expect(side?.mode).toBe("synced");
    expect(side && again.store.state(side.subject).head).toBeUndefined();
  });
});

describe("an archived channel", () => {
  it("retires its confirmed copy when found archived after a restart, so the saved channel can't start", async () => {
    const first = setup({ realSync: true });
    await first.configs.attach([agent]);
    first.configs.dispose();
    const unbound = {
      owner: "o",
      community: "c",
      subject: agent.pubkey,
      channel: "",
      type: "buzz.agent.instructions",
    } as const;
    const again = setup({ heads: first.heads, storage: first.storage });
    const saved = {
      ...unbound,
      channel: again.store.boundChannel(unbound) ?? "",
    };
    expect(saved.channel).toBe(channel);
    expect(again.store.instructions(saved)).toEqual({
      ok: true,
      text: "local text",
    });
    // Another device archived it meanwhile.
    again.room.archived = true;
    await again.configs.attach([agent]);
    expect(again.configs.binding(agent.pubkey)).toBeUndefined();
    expect(again.store.instructions(saved).ok).toBe(false);
  });

  it("makes a newly selected archived channel the saved one after a restart, so the earlier confirmed channel can't start", async () => {
    const first = setup({ realSync: true });
    await first.configs.attach([agent]);
    first.configs.dispose();
    const unbound = {
      owner: "o",
      community: "c",
      subject: agent.pubkey,
      channel: "",
      type: "buzz.agent.instructions",
    } as const;
    const again = setup({ heads: first.heads, storage: first.storage });
    expect(again.store.boundChannel(unbound)).toBe(channel);
    // Lookup now selects an older channel another device archived.
    again.room.id = "1f0d1c52-3b5e-4c38-9d0b-5c1f8f1f6a7e";
    again.room.archived = true;
    await again.configs.attach([agent]);
    const saved = {
      ...unbound,
      channel: again.store.boundChannel(unbound) ?? "",
    };
    expect(saved.channel).toBe(again.room.id);
    expect(again.store.instructions(saved).ok).toBe(false);
  });
});

describe("saving and History", () => {
  it("reports each side on its own when one saves and the other fails", async () => {
    const typed = {
      ...agent,
      schema: { model: "string" },
      config: { instructions: "local text", model: "a" },
    } as const;
    const f = setup();
    await f.configs.attach([typed]);
    const subjectOf = (side: "settings" | "instructions") => {
      const subject = f.configs.binding(typed.pubkey)?.[side]?.subject;
      if (!subject) throw new Error(`No ${side} binding`);
      return subject;
    };
    const base = Object.fromEntries(
      (["settings", "instructions"] as const).map((side) => [
        side,
        f.store.state(subjectOf(side)).head?.id ?? null,
      ]),
    );
    // Another device moves settings on first, so this save's base is stale.
    const settingsSubject = subjectOf("settings");
    const settingsD = await artifactD("buzz.agent.settings", channel);
    const opened = f.heads.get(settingsD);
    if (!opened) throw new Error("No settings head");
    f.heads.set(
      settingsD,
      sign(
        artifactTemplate({
          channel,
          type: "buzz.agent.settings",
          d: settingsD,
          op: "update",
          prev: opened.id,
          title: "Agent settings",
          content: JSON.stringify({
            version: 1,
            agentType: typed.type,
            settings: { model: "b" },
          }),
        }),
      ),
    );
    const saved = await f.configs.save(
      typed,
      { instructions: "edited", model: "c" },
      base,
    );
    expect(saved.instructions?.status).toBe("saved");
    expect(saved.settings?.status).toBe("conflict");
    // The refused side shows the other device's head, never this edit.
    expect(f.store.state(settingsSubject).head?.id).toBe(
      f.heads.get(settingsD)?.id,
    );
    expect(f.heads.get(settingsD)?.content).toContain('"model":"b"');
    expect(
      JSON.parse(
        f.heads.get(await artifactD("buzz.agent.instructions", channel))
          ?.content ?? "null",
      ).text,
    ).toBe("edited");
  });

  it("saves only a changed side, on the head the editor opened", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    const opened = [...f.heads.values()][0]?.id ?? null;
    expect(
      await f.configs.save(agent, agent.config, { instructions: opened }),
    ).toEqual({});
    const saved = await f.configs.save(
      agent,
      { instructions: "edited" },
      { instructions: opened },
    );
    expect(saved.instructions?.status).toBe("saved");
    expect(f.text()).toBe("edited");
  });

  it("reverts through History on the head the revert names", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    const first = [...f.heads.values()][0];
    await f.configs.save(
      agent,
      { instructions: "edited" },
      { instructions: first?.id ?? null },
    );
    const [side] = f.configs.history(agent.pubkey);
    const head = side?.head;
    if (!side || !head || !first) throw new Error("no history");
    const revert = artifactTemplate({
      ...side.expected,
      op: "update",
      prev: head.id,
      title: "Agent instructions",
      content: first.content,
    });
    expect(
      (await f.configs.revise(agent.pubkey, "instructions", revert)).status,
    ).toBe("saved");
    expect(f.text()).toBe("local text");
  });
});

describe("a team roster changed elsewhere", () => {
  it("drops the team from an agent removed on another device at the next connection", async () => {
    const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
    const teamChannel = "2c8e7a1d-5b4f-4e3a-9d2c-7f6e5d4c3b2a";
    const head = sign(
      artifactTemplate({
        channel: teamChannel,
        type: "buzz.team",
        d: await artifactD("buzz.team", teamChannel),
        op: "create",
        title: "Team",
        content: JSON.stringify({ version: 1, name: "Crew", instructions: "" }),
      }),
    );
    head.tags.push(["team", id]);
    const team = {
      id,
      channel: teamChannel,
      head,
      members: ["o", agent.pubkey],
    };
    const f = setup({ realSync: true, team });
    await f.configs.reconnected();
    expect(teamSources(f.teams, "o", agent.pubkey)).toHaveLength(1);
    // Only the roster changes: no new team text.
    team.members = ["o"];
    await f.configs.reconnected();
    await vi.waitFor(() =>
      expect(teamSources(f.teams, "o", agent.pubkey)).toEqual([]),
    );
  });
});

describe("team history", () => {
  it("lists a discovered team's instructions and reverts them online", async () => {
    const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
    const teamChannel = "2c8e7a1d-5b4f-4e3a-9d2c-7f6e5d4c3b2a";
    const d = await artifactD("buzz.team", teamChannel);
    const head = sign(
      artifactTemplate({
        channel: teamChannel,
        type: "buzz.team",
        d,
        op: "create",
        title: "Team",
        content: JSON.stringify({ version: 1, name: "Crew", instructions: "" }),
      }),
    );
    head.tags.push(["team", id]);
    const team = {
      id,
      channel: teamChannel,
      head,
      members: ["o", agent.pubkey],
    };
    const f = setup({
      realSync: true,
      team,
      beforePublish: (event) => {
        team.head = event;
      },
    });
    expect(f.configs.teamHistory(id)).toBeUndefined();
    await f.configs.reconnected();
    await vi.waitFor(() =>
      expect(f.configs.teamHistory(id)).toMatchObject({
        side: "instructions",
        expected: { channel: teamChannel, type: "buzz.team", d, team: id },
        head: { id: head.id },
      }),
    );
    expect(f.configs.teamHistory("another")).toBeUndefined();
    const revert = artifactTemplate({
      channel: teamChannel,
      type: "buzz.team",
      d,
      op: "update",
      prev: head.id,
      title: "Team",
      content: JSON.stringify({
        version: 1,
        name: "Crew",
        instructions: "old",
      }),
    });
    revert.tags.push(["team", id]);
    f.heads.set(d, head);
    expect((await f.configs.reviseTeam(id, revert)).status).toBe("saved");
    expect(f.heads.get(d)?.content).toContain('"instructions":"old"');
  });

  it("keeps history when the team selects another channel, and reports history-only changes", async () => {
    const id = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
    const headIn = async (channel: string) => {
      const event = sign(
        artifactTemplate({
          channel,
          type: "buzz.team",
          d: await artifactD("buzz.team", channel),
          op: "create",
          title: "Team",
          content: JSON.stringify({
            version: 1,
            name: "Crew",
            instructions: "",
          }),
        }),
      );
      event.tags.push(["team", id]);
      return event;
    };
    const first = "2c8e7a1d-5b4f-4e3a-9d2c-7f6e5d4c3b2a";
    const second = "3d9f8b2e-6c5a-4f4b-8e3d-8a7f6e5d4c3b";
    const team = {
      id,
      channel: first,
      head: await headIn(first),
      members: ["o", agent.pubkey],
    };
    const f = setup({ realSync: true, team });
    await f.configs.reconnected();
    await vi.waitFor(() =>
      expect(f.configs.teamHistory(id)?.expected.channel).toBe(first),
    );
    team.channel = second;
    team.head = await headIn(second);
    await f.configs.reconnected();
    await vi.waitFor(() =>
      expect(f.configs.teamHistory(id)?.expected.channel).toBe(second),
    );
    // An older revision's redaction leaves the head as it was.
    const side = f.configs.teamHistory(id);
    if (!side) throw new Error("no history");
    f.historyChanged.mockClear();
    f.configs.historyChanged(second, side.expected.d);
    expect(f.historyChanged).toHaveBeenCalledTimes(1);
    expect(f.configs.teamHistory(id)).toMatchObject({
      head: { id: side.head?.id },
      version: side.version + 1,
    });
  });
});

describe("another device's agent", () => {
  it("reads its synced instructions without creating or binding anything", async () => {
    const f = setup();
    expect(await f.configs.readInstructions(agent.pubkey)).toBeUndefined();
    const head = await created("elsewhere text");
    f.heads.set(tag(head, "d") ?? "", head);
    expect(await f.configs.readInstructions(agent.pubkey)).toEqual({
      instructions: "elsewhere text",
      revision: head.id,
    });
    expect(f.ensure).not.toHaveBeenCalled();
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
  });
});

describe("deleting an agent", () => {
  it("archives its config channel and stops syncing it", async () => {
    const f = setup();
    await f.configs.attach([agent]);
    await f.configs.remove(agent.pubkey, new AbortController().signal);
    expect(f.archive).toHaveBeenCalledWith(channel, expect.anything());
    expect(f.configs.binding(agent.pubkey)).toBeUndefined();
  });

  it("throws when the archive fails, so the Delete stays unfinished", async () => {
    const f = setup({ refuse: "offline" });
    await expect(
      f.configs.remove(agent.pubkey, new AbortController().signal),
    ).rejects.toThrow("offline");
  });
});

describe("settings fields", () => {
  const typed = { ...agent, schema: { model: "string" } } as const;
  const head = (agentType?: string) =>
    sign({
      kind: 45010,
      created_at: 1,
      content: JSON.stringify({
        version: 1,
        agentType,
        settings: { model: "m1", effort: "high" },
      }),
      tags: [],
    });

  it("keeps the settings its type doesn't know, but not another type's", () => {
    const config = { model: "m2" };
    for (const own of [head("example/echo"), head()])
      expect(fields("settings", typed, config, own)).toEqual({
        version: 1,
        agentType: "example/echo",
        settings: { model: "m2", effort: "high" },
      });
    expect(fields("settings", typed, config, head("other/relay"))).toEqual({
      version: 1,
      agentType: "example/echo",
      settings: { model: "m2" },
    });
  });
});
