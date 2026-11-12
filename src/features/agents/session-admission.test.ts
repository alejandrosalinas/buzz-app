import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { SessionControls } from "../agent-harness/session-control";
import type { AgentKey } from "./membership";
import {
  createSessionAdmissions,
  type AgentSessionAdmission,
  type AgentSessionRouter,
} from "./session-admission";
import { memoryStorage } from "./test-fakes";

const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
});
const agent = "a".repeat(64) as AgentKey;
const source = { channelId: "channel", root: "b".repeat(64) };
const signal = new AbortController().signal;
const request = (invocationId: string) => ({
  agent,
  owner: "c".repeat(64),
  harness: "example/native",
  source,
  conversation: source,
  invocationId,
  resumed: false,
  signal,
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  callbacks: Partial<AgentSessionRouter> = {},
  storage = memoryStorage(),
) {
  const root = new Context();
  roots.push(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const admissions = createSessionAdmissions(root, storage);
  const prepare = vi.fn(async (input: AgentSessionAdmission) => ({
    association: input.association ?? { task: input.sessionKey },
    context: "Session context",
  }));
  await root
    .extend({ pluginOwner: { id: "example", revision: "one" } })
    .plugin((ctx) =>
      admissions.register(ctx, {
        id: "tasks",
        ready: async () => {},
        matches: () => true,
        prepare,
        ...callbacks,
      }),
    )
    .await();
  return { admissions, prepare, storage };
}

it("keeps the native association and context across follow-up and restore", async () => {
  const f = await setup();
  const first = await f.admissions.prepare(request("first"));
  expect(first?.context).toBe("Session context");
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
    source,
    conversation: source,
    intent: "existing",
    adopted: true,
  });
  first?.acknowledged();
  const restored = await setup({}, f.storage);
  const next = await restored.admissions.prepare(request("follow-up"));
  expect(next?.session).toEqual(first?.session);
  expect(next?.context).toBeUndefined();
  expect(restored.prepare.mock.calls[0]?.[0]).toMatchObject({
    intent: "existing",
    association: first?.session.association,
  });
});

it("adopts a default lifetime and waits only for router readiness", async () => {
  const ready = gate();
  const matched = vi.fn(() => true);
  const f = await setup({ ready: () => ready.promise, matches: matched });
  const resolving = f.admissions.prepare({
    ...request("first"),
    conversation: { channelId: "channel" },
  });
  expect(matched).not.toHaveBeenCalled();
  ready.resolve();
  await resolving;
  expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
    intent: "existing",
    adopted: true,
    source,
  });
});

it("leaves declined native sessions unchanged and preserves an accepted association", async () => {
  const prepare = vi
    .fn<AgentSessionRouter["prepare"]>()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ association: { task: "one" } })
    .mockResolvedValueOnce(undefined);
  const f = await setup({ prepare });
  expect(await f.admissions.prepare(request("first"))).toBeUndefined();
  const next = await f.admissions.prepare(request("second"));
  expect(next?.session.association).toEqual({
    task: "one",
  });
  await expect(f.admissions.prepare(request("third"))).rejects.toThrow(
    "cannot restore",
  );
});

it("defers admission during New and rejects replay from the retired lifetime", async () => {
  const matches = vi.fn(() => true);
  const f = await setup({ matches });
  const first = await f.admissions.prepare(request("first"));
  const controls = new SessionControls(() => {});
  const nativeReset = gate();
  const resetStarted = gate();
  const reset = controls.run("session", "new", () =>
    f.admissions.reset(agent, "example/native", source, async () => {
      resetStarted.resolve();
      await nativeReset.promise;
    }),
  );
  await resetStarted.promise;
  const handoff = controls.deliver("session", async (deferred) => {
    expect(deferred).toBe(true);
    const next = await f.admissions.prepare(request("during-new"));
    expect(next?.session.sessionKey).not.toBe(first?.session.sessionKey);
  });
  expect(handoff.deferred).toBe(true);
  expect(f.prepare).toHaveBeenCalledOnce();
  nativeReset.resolve();
  await reset;
  await handoff.done;
  await f.admissions.reset(agent, "example/native", source, async () => {});
  matches.mockReturnValue(false);
  await expect(f.admissions.prepare(request("first"))).rejects.toThrow(
    "earlier session",
  );
});

it("blocks admission after a failed reset until New completes", async () => {
  const matches = vi.fn(() => true);
  const f = await setup({ matches });
  await f.admissions.prepare(request("first"));
  await expect(
    f.admissions.reset(agent, "example/native", source, async () => {
      throw new Error("Reset cancelled");
    }),
  ).rejects.toThrow("Reset cancelled");
  matches.mockReturnValue(false);
  await expect(f.admissions.prepare(request("after-failure"))).rejects.toThrow(
    "reset is incomplete",
  );
  await f.admissions.reset(agent, "example/native", source, async () => {});
  matches.mockReturnValue(true);
  const next = await f.admissions.prepare(request("after-recovery"));
  expect(next?.session.sessionKey).toBeTruthy();
});
