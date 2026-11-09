// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_INSTRUCTIONS_LENGTH } from "../builderlab/agents/client";
import { bestieInstructions, promptVersion } from "./prompt";
import { BUILDERLAB_TYPE } from "./setup";
import { bestieFixture, cleanups, HOME, MODEL } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  // Native identity signs the owner's attestation on desktop.
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        options: { signal: AbortSignal },
        work: () => Promise<void>,
      ) => {
        options.signal.throwIfAborted();
        return work();
      },
    },
  });
  let next = 0;
  const randomUUID = crypto.randomUUID.bind(crypto);
  // The first UUID is Bestie's home; the rest stay random.
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    next++ === 0 ? HOME : randomUUID(),
  );
  // Builderlab doesn't support profile() yet; silence its warning.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(navigator, "platform");
});

const kinds = (h: Awaited<ReturnType<typeof bestieFixture>>, kind: number) =>
  h.events.filter((event) => event.kind === kind);

it("keeps the kernel within Builderlab's instruction limit", () => {
  const kernel = bestieInstructions("ab".repeat(32), HOME);
  expect(kernel.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
  expect(kernel).toContain(HOME);
  expect(promptVersion(kernel)).toBe(promptVersion(kernel));
  expect(promptVersion(kernel)).not.toBe(promptVersion(`${kernel} `));
});

it("creates hosted Bestie through Agents, then instructs, homes and introduces it", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: h.agent, channelId: HOME, complete: true },
  });
  // Agents made it at Builderlab and listed it as hosted for every device.
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.agents.find(h.agent)).toMatchObject({
    name: "Bestie",
    type: BUILDERLAB_TYPE,
    place: "hosted",
  });
  expect(h.agents.find(h.agent)?.unfinished).toBeUndefined();
  const listing = kinds(h, 30177);
  expect(listing).toHaveLength(1);
  expect(listing[0]?.tags).toContainEqual(["runtime", BUILDERLAB_TYPE]);
  expect(h.agents.find(h.agent)?.picture).toMatch(/^https:/);
  // Registration carries the picture, and Beekeeper publishes it at attestation.
  expect(h.rows[0]?.agent_picture_url).toMatch(/^https:/);
  expect(h.rows[0]?.agent_instructions).toBe(
    bestieInstructions(h.viewer, HOME),
  );
  // The home is a named Solo chat, with only the owner and Bestie, whom the
  // create adds; KGoose gives Bestie one session there with recent history.
  const creation = kinds(h, 9007);
  expect(creation).toHaveLength(1);
  expect(creation[0]?.tags).toContainEqual(["h", HOME]);
  expect(creation[0]?.tags).toContainEqual(["p", h.agent]);
  expect(kinds(h, 9000)).toHaveLength(0);
  expect(h.channels.get(HOME)).toEqual({
    members: [h.viewer, h.agent],
    visibility: "private",
    labels: [
      ["t", "buzz.solo"],
      ["t", "buzz.session.named"],
    ],
  });
  const intro = kinds(h, 9);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["h", HOME]);
  expect(intro[0]?.tags).toContainEqual(["p", h.agent]);
  // Instructions were set before the intro could wake Bestie.
  const order =
    h.publish.mock.invocationCallOrder[
      h.publish.mock.calls.findIndex(([event]) => event.kind === 9)
    ];
  const instructed =
    h.forwarded.mock.invocationCallOrder[
      h.forwarded.mock.calls.findIndex(([input]) =>
        input.path.endsWith("/update-agent"),
      )
    ];
  expect(instructed).toBeLessThan(order ?? 0);
  expect(kinds(h, 30620)).toHaveLength(0);
});

it("reopens a finished setup after restart without another agent, channel or intro", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const published = h.events.length;
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().message).toBe("Your Bestie is set up.");
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("update-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("offers to update a set-up Bestie whose instructions changed, and changes nothing else", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const published = h.events.length;
  // As if prompt.ts changed after this Bestie was set up.
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  if (!key) throw new Error("Missing Bestie record");
  localStorage.setItem(
    key,
    JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      promptVersion: "remote-bestie-1",
    }),
  );
  await h.restart();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    instructionsChanged: true,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.bestie.snapshot().instructionsChanged).toBeFalsy();
  const updates = h.requests("update-agent");
  expect(updates).toHaveLength(2);
  expect(JSON.parse(updates.at(-1) ?? "").agent_instructions).toBe(
    bestieInstructions(h.viewer, HOME),
  );
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("finishes an unfinished hosted Bestie on retry instead of registering another", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: "Builderlab request failed (HTTP 500).",
  });
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.requests("attest-agent")).toHaveLength(2);
  expect(h.agents.find(h.agent)?.unfinished).toBeUndefined();
  expect(kinds(h, 9007)[0]?.tags).toContainEqual(["h", HOME]);
});

it("says why Builderlab refused to set up Bestie", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 200, {
    status: "ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND",
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining(
      "Agent setup was not confirmed (ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND)",
    ),
  });
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
});

it("offers a new Bestie when the saved one left this Builderlab account", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  h.reply("attest-agent", 500, {});
  await h.bestie.setup();
  expect(h.agents.find(h.agent)?.unfinished).toBe(true);
  // Revoked outside this app, e.g. from another device.
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("isn't in this Builderlab account"),
    canCreateNew: true,
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  // Agents would resume the unfinished one, so the owner deletes it first.
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("Delete it in Agents"),
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  await h.agents.remove(h.agent);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    message: "Your Bestie is set up.",
  });
  expect(h.requests("register-agent")).toHaveLength(2);
  expect(h.bestie.snapshot().record?.agent).not.toBe(h.agent);
});

it("explains a canceled Builderlab sign-in and creates nothing until retried", async () => {
  const h = await bestieFixture(native.invoke);
  h.cancelNextSignIn();
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(h.bestie.snapshot().message).toMatch(
    /^Sign in to Builderlab to set up Bestie\./,
  );
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("ready");
});

it("explains a refused account (screening) and keeps the reserved home for the retry", async () => {
  const h = await bestieFixture(native.invoke);
  h.reply("register-agent", 403, { error: "forbidden" });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    record: { channelId: HOME },
  });
  expect(h.bestie.snapshot().message).toContain("finish your account details");
  expect(h.agents.snapshot().agents).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { channelId: HOME },
  });
});

it("lets the owner choose among several hosted Besties without registering another", async () => {
  const h = await bestieFixture(native.invoke);
  for (let index = 0; index < 2; index++)
    await h.agents.create({
      type: BUILDERLAB_TYPE,
      name: "Bestie",
      config: { instructions: "", ...MODEL, subject: "owner" },
    });
  const [, second] = h.rows;
  if (!second) throw new Error("Missing second Bestie");
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("choose-agent");
  expect(h.bestie.snapshot().candidates).toHaveLength(2);
  // Agent changes do not drop the pending choice.
  await h.agents.refresh();
  expect(h.bestie.snapshot().status).toBe("choose-agent");
  await h.bestie.setup(second.agent_pubkey);
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    record: { agent: second.agent_pubkey },
  });
  expect(h.requests("register-agent")).toHaveLength(2);
  const home = h.bestie.snapshot().record?.channelId ?? "";
  expect(second.agent_instructions).toBe(bestieInstructions(h.viewer, home));
  expect(h.rows[0]?.agent_instructions).toBe("");
});

it("adds Bestie through the agent path when the relay's create didn't", async () => {
  const h = await bestieFixture(native.invoke);
  h.ignoreCreateMembers();
  const gate = h.holdSave(9007);
  const run = h.bestie.setup();
  await vi.waitFor(() => expect(saved()?.channelOperation).toBeDefined());
  // The app's agent inventory already lists the new Bestie.
  await h.session().agentChoices.refresh();
  expect(
    h
      .session()
      .agentChoices.snapshot()
      .identities.map((agent) => agent.pubkey),
  ).toContain(h.agent);
  gate.resolve();
  await run;
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    message: "Your Bestie is set up.",
  });
  const added = kinds(h, 9000);
  expect(added).toHaveLength(1);
  expect(added[0]?.tags).toContainEqual(["p", h.agent]);
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
});

it("refuses to introduce Bestie into a home that has other members", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  h.addMember("12".repeat(32));
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message:
      "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
  });
});

it("delivers a lost intro once after restart", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  await h.restart();
  await h.bestie.setup();
  expect(h.bestie.snapshot().message).toBe("Your Bestie is set up.");
  expect(h.bestie.snapshot().status).toBe("ready");
  expect(kinds(h, 9)).toHaveLength(1);
  expect(h.sign.mock.calls.filter(([event]) => event.kind === 9)).toHaveLength(
    1,
  );
});

it("does not make a second Bestie while this community's agent list is unread", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 2,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot()).toMatchObject({
    status: "error",
    message: expect.stringContaining("isn't listed in this community yet"),
    canCreateNew: true,
  });
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
});

it("creates a new Bestie when the owner asks despite an unlisted one", async () => {
  const h = await bestieFixture(native.invoke);
  h.rows.push({
    key: "elsewhere",
    agent_id: "elsewhere",
    agent_name: "Bestie",
    agent_pubkey: "34".repeat(32),
    status: 2,
  });
  await h.bestie.setup();
  expect(h.bestie.snapshot().canCreateNew).toBe(true);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot()).toMatchObject({
    status: "ready",
    message: "Your Bestie is set up.",
  });
  expect(h.requests("register-agent")).toHaveLength(1);
});

const saved = () => {
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  return key ? JSON.parse(localStorage.getItem(key) ?? "{}") : undefined;
};
const welcomes = (h: Awaited<ReturnType<typeof bestieFixture>>, home: string) =>
  kinds(h, 9).filter((event) =>
    event.tags.some(([name, value]) => name === "h" && value === home),
  );

it("asks for Bestie's model before making it, with nothing preselected", async () => {
  const h = await bestieFixture(native.invoke);
  await h.raw.setup();
  expect(h.raw.snapshot()).toMatchObject({
    status: "choose-model",
    models: [
      {
        id: "model-a",
        displayName: "Model A",
        supportedReasoningEfforts: ["low", "high"],
      },
    ],
  });
  expect(h.requests("register-agent")).toHaveLength(0);
  expect(h.events).toHaveLength(0);
  await h.raw.chooseModel(MODEL);
  expect(h.raw.snapshot().status).toBe("ready");
  expect(h.rows).toHaveLength(1);
  expect(h.rows[0]).toMatchObject({
    model_id: "model-a",
    reasoning_effort: "high",
    agent_instructions: bestieInstructions(h.viewer, HOME),
  });
  // Finishing set the instructions with the model; no second update.
  expect(h.requests("update-agent")).toHaveLength(1);
});

it("asks for a model again when Builderlab says Bestie's choice is no longer valid", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const row = h.rows[0];
  if (!row) throw new Error("Missing Bestie");
  row.model_selection_status = 3;
  const published = h.events.length;
  await h.raw.setup();
  expect(h.raw.snapshot()).toMatchObject({
    status: "choose-model",
    message: expect.stringContaining("needs a model"),
  });
  await h.raw.chooseModel({ modelId: "model-a", reasoningEffort: "low" });
  expect(h.raw.snapshot().status).toBe("ready");
  expect(row).toMatchObject({
    model_selection_status: 1,
    reasoning_effort: "low",
  });
  expect(JSON.parse(h.requests("update-agent").at(-1) ?? "")).toEqual({
    agent_pubkey: h.agent,
    model_id: "model-a",
    reasoning_effort: "low",
  });
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.events).toHaveLength(published);
});

it("gives a replacement Bestie its own instructions and home after the first was instructed", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9007);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(saved()).toMatchObject({
    agent: h.agent,
    promptVersion: expect.any(String),
  });
  // Revoked outside this app, e.g. from another device.
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot().canCreateNew).toBe(true);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot().status).toBe("ready");
  const record = saved();
  const replacement = h.rows[1];
  expect(replacement?.agent_pubkey).toBe(record.agent);
  expect(record.channelId).not.toBe(HOME);
  expect(replacement?.agent_instructions).toBe(
    bestieInstructions(h.viewer, record.channelId),
  );
  expect(h.channels.get(record.channelId)?.members).toEqual([
    h.viewer,
    record.agent,
  ]);
  const intro = welcomes(h, record.channelId);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["p", record.agent]);
});

it("keeps the first Bestie's home and gives a replacement a new one after a failed welcome", async () => {
  const h = await bestieFixture(native.invoke);
  h.failPublication(9);
  await h.bestie.setup();
  expect(h.bestie.snapshot().status).toBe("error");
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
  for (const row of h.rows) row.status = 3;
  await h.bestie.setup();
  expect(h.bestie.snapshot().canCreateNew).toBe(true);
  await h.bestie.setup(undefined, { createNew: true });
  expect(h.bestie.snapshot().status).toBe("ready");
  const record = saved();
  expect(record.agent).not.toBe(h.agent);
  expect(record.channelId).not.toBe(HOME);
  // The old conversation is preserved rather than reused with a stranger.
  expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
  expect(h.channels.get(record.channelId)?.members).toEqual([
    h.viewer,
    record.agent,
  ]);
  expect(welcomes(h, HOME)).toHaveLength(0);
  const intro = welcomes(h, record.channelId);
  expect(intro).toHaveLength(1);
  expect(intro[0]?.tags).toContainEqual(["p", record.agent]);
});

it.each([
  ["home creation", 9007, "channelOperation"],
  ["welcome", 9, "welcomeId"],
] as const)(
  "recovers when the app ends before the %s reaches the Outbox journal",
  async (_, kind, field) => {
    const h = await bestieFixture(native.invoke);
    const gate = h.holdSave(kind);
    const first = h.bestie.setup();
    // The checkpoint is saved while the journal write is still pending.
    await vi.waitFor(() => expect(saved()?.[field]).toBeDefined());
    await h.crash();
    gate.resolve();
    await first;
    await h.bestie.setup();
    expect(h.bestie.snapshot().status).toBe("ready");
    expect(kinds(h, 9007)).toHaveLength(1);
    expect(h.channels.get(HOME)?.members).toEqual([h.viewer, h.agent]);
    const intro = kinds(h, 9);
    expect(intro).toHaveLength(1);
    expect(saved()?.welcomeId).toBe(intro[0]?.id);
  },
);
