// The bundled-only building blocks a plugin uses to move agents onto
// Automatic: ready, switchable, switch and restore, and plugin notes.
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundledOwner } from "../../plugins/provenance";
import { artifactTemplate } from "./agent-config-artifacts";
import { fields } from "./community-config";
import { checkNote, notesOf, withNote } from "./plugin-notes";
import { setRuntimeRecommendation } from "./recommended";
import { type Agent, AgentsService } from "./service";
import { fakeCommunities, fakeNative, fakeRelay } from "./service-testing";
import { memoryStorage } from "./test-fakes";

// Synthetic: one candidate for the "codex" harness.
const CANDIDATE = {
  harness: "codex",
  model: "model-a",
  effort: "low",
  label: "Model A",
};
const agent = (overrides: Partial<Agent> = {}) =>
  ({
    key: "pk-1",
    pubkey: "pk-1",
    name: "Agent A",
    type: "example/codex",
    place: "here",
    config: { model: "model-b", effort: "high", other: 1 },
    configBase: { settings: "head-1" },
    ...overrides,
  }) as unknown as Agent;

function start() {
  const ctx = new Context();
  let settled = false;
  const listeners = new Set<() => void>();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settled: () => settled,
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    fakeNative(),
    memoryStorage(),
  );
  let snapshot = { ...service.snapshot(), status: "ready" as const };
  vi.spyOn(service, "snapshot").mockImplementation(() => snapshot);
  vi.spyOn(service, "types").mockReturnValue([
    { key: "example/codex", id: "codex", recommends: async () => true },
    {
      key: "example/remote",
      id: "codex",
      remote: {},
      recommends: async () => true,
    },
    { key: "example/other", id: "other" },
  ] as never);
  // The save path under `save` and the plugin helpers.
  const save = vi
    .spyOn(service as unknown as { saveAs: AgentsService["save"] }, "saveAs")
    .mockResolvedValue();
  const bundled = ctx.extend({
    pluginOwner: bundledOwner(
      Object.freeze({ id: "org.example", revision: "bundled" }),
    ),
  }).agents;
  const installed = ctx.extend({
    pluginOwner: Object.freeze({ id: "someone.else", revision: "1" }),
  }).agents;
  return {
    bundled,
    installed,
    save,
    service,
    setAgents(agents: Agent[], running: Agent[] = []) {
      snapshot = { ...snapshot, agents, running };
    },
    settle() {
      settled = true;
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => setRuntimeRecommendation({ candidates: [CANDIDATE] }));
afterEach(() => {
  setRuntimeRecommendation(undefined);
  vi.restoreAllMocks();
});

describe("plugin agent hooks", () => {
  it("are for bundled plugins only", async () => {
    const { installed } = start();
    const a = agent();
    for (const call of [
      () => installed.isReady(),
      () => installed.whenReady(),
      () => installed.switchable(a),
      () => installed.switchableAgents(),
      () => installed.switchToAutomatic(a),
      () => installed.restoreSettings(a, {}),
      () => installed.readNote(a),
      () => installed.setNote(a, null),
    ])
      await expect(async () => call()).rejects.toThrow(/bundled plugins/);
  });

  it("is ready once plugins have started and the setup is final", async () => {
    const f = start();
    expect(f.bundled.isReady()).toBe(false);
    const ready = f.bundled.whenReady();
    f.settle();
    await ready;
    expect(f.bundled.isReady()).toBe(true);
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(f.bundled.whenReady(aborted.signal)).rejects.toThrow("stop");
  });

  it("counts only agents that could run on Automatic here", () => {
    const f = start();
    expect(f.bundled.switchable(agent())).toBe(true);
    // On another computer still counts; hosted, remote, unknown or
    // uncovered types don't.
    expect(f.bundled.switchable(agent({ place: "elsewhere" } as never))).toBe(
      true,
    );
    expect(f.bundled.switchable(agent({ place: "hosted" } as never))).toBe(
      false,
    );
    expect(f.bundled.switchable(agent({ type: "example/remote" }))).toBe(false);
    expect(
      f.bundled.switchable(
        agent({ executionBinding: { provider: "example.vm" } }),
      ),
    ).toBe(false);
    expect(f.bundled.switchable(agent({ type: "gone/codex" }))).toBe(false);
    expect(f.bundled.switchable(agent({ type: "example/other" }))).toBe(false);
    const a = agent();
    f.setAgents(
      [a, agent({ key: "pk-2", pubkey: "pk-2", type: "gone/codex" })],
      [a],
    );
    expect(f.bundled.switchableAgents()).toEqual([a]);
  });

  it("switches with the note in one save, from the copy it read, and restores", async () => {
    const f = start();
    const a = agent();
    f.setAgents([a]);
    const note = { data: { answer: "yes" }, tag: "accepted" };
    await expect(f.bundled.switchToAutomatic(a, { note })).resolves.toEqual({
      previous: { model: "model-b", effort: "high" },
    });
    expect(f.save).toHaveBeenLastCalledWith("pk-1", {
      config: {
        other: 1,
        preset: "recommended",
        pluginNotes: { "org.example": note },
      },
      base: { settings: "head-1" },
    });
    const on = agent({
      config: {
        other: 1,
        preset: "recommended",
        pluginNotes: { "org.example": note },
      },
    });
    await expect(f.bundled.switchToAutomatic(on)).rejects.toThrow(
      /can't be switched/,
    );
    expect(f.bundled.readNote(on)).toEqual(note);
    f.setAgents([on]);
    await f.bundled.restoreSettings(
      on,
      { model: "model-b", effort: "high" },
      { note: null },
    );
    expect(f.save).toHaveBeenLastCalledWith("pk-1", {
      config: { other: 1, pluginNotes: {}, model: "model-b", effort: "high" },
      base: { settings: "head-1" },
    });
  });

  it("refuses a copy that changed since it was read, and an Undo off Automatic", async () => {
    const f = start();
    // Changed by sync, and changed here.
    for (const now of [
      agent({ configBase: { settings: "head-2" } }),
      agent({ config: { model: "model-c" } }),
    ]) {
      f.setAgents([now]);
      await expect(f.bundled.switchToAutomatic(agent())).rejects.toThrow(
        /changed since it was read/,
      );
    }
    f.setAgents([agent()]);
    await expect(
      f.bundled.restoreSettings(agent(), { model: "model-b" }),
    ).rejects.toThrow(/isn't on Automatic/);
    expect(f.save).not.toHaveBeenCalled();
  });

  it("saves nothing when clearing a note that isn't there", async () => {
    const f = start();
    const a = agent({ config: { pluginNotes: { "org.other": { data: 1 } } } });
    f.setAgents([a]);
    await f.bundled.setNote(a, null);
    expect(f.save).not.toHaveBeenCalled();
  });

  it("keeps notes as they are on any other save", async () => {
    const f = start();
    const notes = { "org.example": { data: 1 } };
    f.setAgents([agent({ config: { pluginNotes: notes } })]);
    await f.service.save("pk-1", {
      config: { model: "model-c", pluginNotes: { "org.other": { data: 2 } } },
    });
    expect(f.save).toHaveBeenLastCalledWith(
      "pk-1",
      { config: { model: "model-c", pluginNotes: notes } },
      undefined,
    );
    f.setAgents([agent()]);
    await f.service.save("pk-1", {
      config: { pluginNotes: { "org.other": { data: 2 } } },
    });
    expect(f.save).toHaveBeenLastCalledWith("pk-1", { config: {} }, undefined);
  });

  it("saves only an agent set up here with its synced settings", async () => {
    const f = start();
    for (const a of [
      agent({ place: "elsewhere" } as never),
      agent({ configBase: { settings: null } }),
      agent({ configBase: {} }),
      agent({ unfinished: true } as never),
    ])
      await expect(f.bundled.setNote(a, { data: 1 })).rejects.toThrow(
        /can't be changed/,
      );
    await expect(
      f.bundled.setNote(agent(), { data: "x".repeat(2000) }),
    ).rejects.toThrow(/at most 1024 bytes/);
    expect(f.save).not.toHaveBeenCalled();
  });
});

describe("plugin notes", () => {
  it("keeps only valid notes, and checks a new one", () => {
    expect(
      notesOf({
        pluginNotes: {
          "org.example": { data: [1], tag: "ok" },
          "Bad Id": { data: 1 },
          "org.big": { data: "x".repeat(2000) },
          "org.tag": { data: 1, tag: "Not OK" },
          "org.extra": { data: 1, more: true },
        },
      }),
    ).toEqual({ "org.example": { data: [1], tag: "ok" } });
    expect(() => checkNote({ data: 1, tag: "a".repeat(65) })).toThrow();
    expect(() => checkNote({ data: undefined as never })).toThrow();
    expect(() => checkNote(null)).not.toThrow();
    expect(
      withNote({ pluginNotes: { a: { data: 1 }, b: { data: 2 } } }, "a", null),
    ).toEqual({
      pluginNotes: { b: { data: 2 } },
    });
  });

  it("tags each settings revision from its notes, never from carried tags", () => {
    const content = JSON.stringify({
      version: 1,
      settings: {},
      preset: "recommended",
      pluginNotes: {
        "org.example": { data: 1, tag: "auto" },
        "org.quiet": { data: 2 },
      },
    });
    const { tags } = artifactTemplate({
      channel: "c",
      type: "buzz.agent.settings",
      d: "d",
      op: "update",
      prev: "p",
      title: "Agent settings",
      content,
      extra: [
        ["note", "org.stale", "old"],
        ["team", "t"],
      ],
    });
    expect(tags).toContainEqual(["preset", "recommended"]);
    expect(tags.filter((tag) => tag[0] === "note")).toEqual([
      ["note", "org.example", "auto"],
    ]);
    expect(tags).toContainEqual(["team", "t"]);
  });

  it("publishes a config's notes with its settings, and leaves the head's when it has none", () => {
    const configAgent = {
      pubkey: "pk",
      name: "A",
      type: "example/codex",
      schema: {},
      config: {},
    };
    const notes = { "org.example": { data: 1 } };
    expect(
      fields("settings", configAgent, { pluginNotes: notes }),
    ).toMatchObject({
      pluginNotes: notes,
    });
    expect(fields("settings", configAgent, {})).not.toHaveProperty(
      "pluginNotes",
    );
    // Clearing the last note publishes no empty map, and drops the head's.
    const cleared = fields("settings", configAgent, { pluginNotes: {} });
    expect(
      JSON.parse(JSON.stringify({ pluginNotes: notes, ...cleared })),
    ).not.toHaveProperty("pluginNotes");
  });
});
