import { artifactTemplate } from "./agent-config-artifacts";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../relay/events";
import {
  AgentConfigStore,
  settingsProblem,
  syncedSettings,
  type Subject,
} from "./agent-config";
import { fields } from "./community-config";
import { edited } from "./config-writes";
import { onRecommended } from "./recommended";
import { resolveStart, type Mode, type StartInput } from "./agent-start";
import {
  syncedSettingsSchema,
  withSyncedSettings,
} from "../../bundled/claude-code/settings";
import type { Config } from "../../bundled/claude-code/runtime";
import * as codex from "../../bundled/codex/settings";
import * as goose from "../../bundled/goose/settings";
import { memoryStorage } from "./test-fakes";

const key = generateSecretKey();
const base = {
  owner: "a".repeat(64),
  community: "c",
  subject: "b".repeat(64),
  channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
};
const settings: Subject = { ...base, type: "buzz.agent.settings" };
const instructions: Subject = { ...base, type: "buzz.agent.instructions" };
const team: Subject = {
  ...base,
  subject: "team-1",
  channel: "0c1d7a39-5b0f-4b49-8a59-7d0b0a7ee0aa",
  type: "buzz.team",
};
const local = {
  model: "local-model",
  effort: "low",
  workspace: "/this/device",
  instructions: "local text",
  scope: "thread",
} as unknown as Config;

const revision = (body: object | null, op = "create") =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: body === null ? "" : JSON.stringify({ version: 1, ...body }),
      tags: [["op", op]],
    },
    key,
  ) as RelayEvent;

function install(
  store: AgentConfigStore,
  subject: Subject,
  event: RelayEvent | "empty",
  problem?: string,
) {
  store.applyRead(
    subject,
    store.capture(subject),
    event === "empty"
      ? { kind: "empty" }
      : problem
        ? { kind: "head", event, problem }
        : { kind: "head", event },
  );
}

const plugin = {
  schema: syncedSettingsSchema,
  withSynced: withSyncedSettings,
};

function input(
  store: AgentConfigStore,
  mode: Mode = "synced",
  extra: Partial<StartInput<Config>> = {},
): StartInput<Config> {
  return {
    store,
    local,
    agentType: "claude-code",
    settings: { mode, subject: settings, ...plugin },
    instructions: { mode, subject: instructions },
    ...extra,
  };
}

function seeded() {
  const store = new AgentConfigStore(memoryStorage());
  const s = revision({
    agentType: "claude-code",
    settings: { model: "synced-model", scope: "channel" },
  });
  const i = revision({ text: "synced text" });
  install(store, settings, s);
  install(store, instructions, i);
  return { store, s, i };
}

describe("start resolution", () => {
  it("gives a field the synced copy leaves out its default, never this device's value, in every runtime", () => {
    const own = { ...local, provider: "local-provider" } as unknown as Config;
    for (const [agentType, merge] of [
      ["claude-code", plugin],
      [
        "codex",
        {
          schema: codex.syncedSettingsSchema,
          withSynced: codex.withSyncedSettings,
        },
      ],
      [
        "goose",
        {
          schema: goose.syncedSettingsSchema,
          withSynced: goose.withSyncedSettings,
        },
      ],
    ] as const)
      for (const synced of [{}, { scope: "channel" }] as Record<
        string,
        string
      >[]) {
        const store = new AgentConfigStore(memoryStorage());
        install(store, settings, revision({ agentType, settings: synced }));
        const start = resolveStart({
          store,
          local: own,
          agentType,
          settings: {
            mode: "synced",
            subject: settings,
            schema: merge.schema,
            withSynced: merge.withSynced as typeof plugin.withSynced,
          },
        });
        if (!start.ok) throw new Error(start.reason);
        expect(start.config).toMatchObject({
          model: "",
          effort: "",
          scope: synced.scope ?? "thread",
          workspace: "/this/device",
        });
        if (agentType === "goose")
          expect(start.config).toMatchObject({ provider: "" });
        expect(start.synced).toEqual(synced);
      }
  });

  it("starts local and migrating types from the local row, unchanged", () => {
    const store = new AgentConfigStore(memoryStorage());
    for (const mode of ["local", "migrating"] as const)
      expect(resolveStart(input(store, mode))).toEqual({
        ok: true,
        config: local,
        revisions: [],
      });
  });

  it("starts a synced agent from its present heads, keeping this device's workspace", () => {
    const { store, s, i } = seeded();
    expect(resolveStart(input(store))).toEqual({
      ok: true,
      config: {
        ...local,
        model: "synced-model",
        effort: "",
        scope: "channel",
        instructions: "synced text",
      },
      revisions: [s.id, i.id],
      synced: { model: "synced-model", scope: "channel" },
    });
  });

  it("blocks on unavailable with no local fallback, even with local text", () => {
    const store = new AgentConfigStore(memoryStorage());
    install(store, settings, "empty");
    expect(resolveStart(input(store))).toEqual({
      ok: false,
      state: "unavailable",
      reason: "Waiting for this agent's config to sync",
    });
  });

  it("blocks on an invalid head with its reason, and on a deletion", () => {
    const { store, i } = seeded();
    install(
      store,
      instructions,
      revision({ text: 1 }),
      "Instructions text missing",
    );
    expect(resolveStart(input(store))).toMatchObject({
      ok: false,
      state: "invalid",
      reason: "Instructions can't be used: Instructions text missing",
    });
    install(store, instructions, i);
    install(store, instructions, revision(null, "delete"));
    expect(resolveStart(input(store))).toMatchObject({
      ok: false,
      state: "deleted",
      reason: "Instructions were deleted — restore from History",
    });
  });

  it("refuses settings for another agent type, or holding workspace or an unknown value", () => {
    for (const body of [
      { agentType: "codex", settings: { model: "m" } },
      { agentType: "claude-code", settings: { workspace: "/elsewhere" } },
      { agentType: "claude-code", settings: { scope: "galaxy" } },
    ]) {
      const { store } = seeded();
      install(store, settings, revision(body));
      expect(resolveStart(input(store))).toMatchObject({
        ok: false,
        state: "invalid",
      });
    }
  });

  it("keeps serving a confirmed head while the relay is unreachable, but not after lost access", () => {
    const { store, i } = seeded();
    // Offline: every read fails, which changes no state.
    store.applyRead(instructions, store.capture(instructions), {
      kind: "failed",
    });
    store.applyRead(settings, store.capture(settings), { kind: "failed" });
    expect(resolveStart(input(store))).toMatchObject({ ok: true });
    expect(resolveStart(input(store)).ok && i.id).toBe(i.id);
    // Lost access or reselection retires the binding: no stale copy starts.
    store.rebind(instructions);
    expect(resolveStart(input(store))).toMatchObject({
      ok: false,
      state: "unavailable",
    });
  });

  it("never returns to local text once this device had a revision, even in migrating", () => {
    const { store } = seeded();
    store.rebind(instructions);
    store.rebind(settings);
    expect(store.hadVersion(instructions)).toBe(true);
    expect(resolveStart(input(store, "migrating"))).toMatchObject({
      ok: false,
      state: "unavailable",
    });
    // A blocking head recorded before any install sets it too.
    const fresh = new AgentConfigStore(memoryStorage());
    fresh.markHadVersion(instructions);
    expect(
      resolveStart(
        input(fresh, "migrating", {
          settings: { mode: "local", subject: settings, ...plugin },
        }),
      ),
    ).toMatchObject({ ok: false, state: "unavailable" });
  });
});

describe("team sections", () => {
  const member = (lifecycle: "active" | "archived" | "unreadable") => ({
    id: "team-1",
    lifecycle,
    subject: team,
    members: [base.subject],
  });

  it("gives one section per present team and drops an archived team", () => {
    const { store, s, i } = seeded();
    const t = revision({ name: "Crew", instructions: "Ship it" });
    install(store, team, t);
    expect(
      resolveStart(input(store, "synced", { teams: [member("active")] })),
    ).toEqual({
      ok: true,
      config: expect.anything(),
      teams: [
        {
          id: "team-1",
          name: "Crew",
          instructions: "Ship it",
          members: [base.subject],
        },
      ],
      revisions: [s.id, i.id, t.id],
      synced: expect.any(Object),
    });
    expect(
      resolveStart(input(store, "synced", { teams: [member("archived")] })),
    ).toMatchObject({ ok: true, teams: [] });
  });

  it("blocks, naming the team, when its channel is unreadable or its artifact isn't present", () => {
    const { store } = seeded();
    install(store, team, revision({ name: "Crew", instructions: "" }));
    expect(
      resolveStart(input(store, "synced", { teams: [member("unreadable")] })),
    ).toMatchObject({
      ok: false,
      state: "unavailable",
      reason: expect.stringContaining('"Crew"'),
    });
    store.rebind(team);
    expect(
      resolveStart(input(store, "synced", { teams: [member("active")] })),
    ).toMatchObject({
      ok: false,
      state: "unavailable",
      reason: expect.stringContaining('"team-1"'),
    });
  });
});

describe("the synced Recommended mark", () => {
  // Synthetic: an agent on Recommended has blank model settings.
  const pointer = {
    ...local,
    model: "",
    effort: "",
    preset: "recommended",
  } as unknown as Config;
  const agent = {
    pubkey: "c".repeat(64),
    name: "Agent A",
    type: "claude-code",
    schema: syncedSettingsSchema,
  };
  const published = (config: object, head?: RelayEvent) =>
    revision(
      JSON.parse(
        edited(head, fields("settings", { ...agent, config }, config, head)),
      ),
    );
  const start = (head: RelayEvent, own: Config = local) => {
    const store = new AgentConfigStore(memoryStorage());
    install(store, settings, head);
    // Only settings sync here; instructions stay this device's.
    const { instructions: _, ...rest } = input(store);
    const resolved = resolveStart({ ...rest, local: own });
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.config;
  };

  it("round-trips beside the settings, where an older strict check never sees it", () => {
    const head = published(pointer);
    const body = JSON.parse(head.content);
    expect(body.preset).toBe("recommended");
    // What older versions check: only `settings`, strictly. It passes.
    expect(
      settingsProblem(syncedSettingsSchema, body.settings),
    ).toBeUndefined();
    expect(
      syncedSettings(head.content, "claude-code", syncedSettingsSchema),
    ).toMatchObject({ recommended: true });
    // An agent off Recommended publishes exactly what it did before.
    expect(JSON.parse(published(local).content)).not.toHaveProperty("preset");
  });

  it("tags the revision it saves, so Automatic can be counted from tags", () => {
    const save = (config: object) =>
      artifactTemplate({
        channel: "c",
        type: "buzz.agent.settings",
        d: "d",
        op: "create",
        title: "Agent settings",
        content: edited(
          undefined,
          fields("settings", { ...agent, config }, config),
        ),
      }).tags.filter(([name]) => name === "preset");
    expect(save(pointer)).toEqual([["preset", "recommended"]]);
    expect(save(local)).toEqual([]);
  });

  it("shows Automatic on a second device that never had the mark", () => {
    const config = start(published(pointer), local);
    expect(onRecommended(config)).toBe(true);
  });

  it("is cleared by a synced manual model choice, with no flip-back after a blank one", () => {
    const first = published(pointer);
    const named = published(
      { ...pointer, model: "model-a", preset: undefined },
      first,
    );
    expect(JSON.parse(named.content)).not.toHaveProperty("preset");
    expect(onRecommended(start(named, pointer))).toBe(false);
    // Back to the harness default from another device: still Custom, even
    // though this device once had the mark.
    const blank = published({ ...local, model: "", effort: "" }, named);
    const config = start(blank, pointer);
    expect(config).not.toHaveProperty("preset");
    expect(onRecommended(config)).toBe(false);
  });

  it("stays Custom when an older version names a model and keeps the mark it doesn't know", () => {
    // Older writers keep unknown fields (NIP-AP "Editing") but set a model.
    const head = revision({
      agentType: "claude-code",
      settings: { model: "model-a", effort: "", scope: "thread" },
      preset: "recommended",
    });
    expect(onRecommended(start(head, local))).toBe(false);
  });
});
