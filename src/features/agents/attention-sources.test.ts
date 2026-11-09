import { expect, it, vi } from "vitest";
import { AttentionSources, type AttentionProducer } from "./attention-sources";
import type { Agent } from "./service";
import {
  validateObject,
  type AttentionObject,
  type SourceWatch,
} from "./attention";

const source: SourceWatch = {
  type: "source",
  provider: "example/command",
  interest_id: "release",
  enabled: true,
  channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  config: { command: ["check-pr"] },
};
const object = (): AttentionObject & { value: SourceWatch } => ({
  slug: "watch/pr",
  value: source,
  modifiedAt: 1,
});
function agent(
  watch: ReturnType<typeof object>,
  enabled = true,
  paused = false,
): Agent {
  return {
    key: "a",
    pubkey: "a",
    name: "Test",
    type: "test/agent",
    owner: "owner",
    relay: "https://example.test",
    place: "here",
    timers: {},
    skipped: {},
    config: {},
    attentionEnabled: enabled,
    attention: {
      [watch.slug]: watch,
      "interest/release": {
        slug: "interest/release",
        value: { type: "interest", instructions: "Report changes", paused },
        modifiedAt: 1,
      },
    },
  } as Agent;
}
function harness() {
  const emit = vi.fn(),
    finish = vi.fn(async () => {}),
    completed = vi.fn(() => false);
  const manager = new AttentionSources({ emit, finish, completed });
  const inputs: Parameters<AttentionProducer["run"]>[0][] = [];
  const endings: (() => void)[] = [];
  const provider: AttentionProducer = {
    id: "command",
    run: vi.fn(async (input) => {
      inputs.push(input);
      await new Promise<void>((resolve) => {
        endings.push(resolve);
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  };
  return { manager, provider, emit, finish, completed, inputs, endings };
}
it("validates provider, destination and deterministic configuration", () => {
  expect(validateObject("watch/pr", source)).toBeUndefined();
  expect(
    validateObject("watch/pr", { ...source, provider: "command" }),
  ).toMatch(/provider/);
  expect(validateObject("watch/pr", { ...source, config: [] })).toMatch(
    /config/,
  );
  expect(validateObject("watch/pr", { ...source, root: "bad" })).toMatch(
    /root/,
  );
  expect(validateObject("watch/pr", { ...source, channel: "bad" })).toMatch(
    /channel/,
  );
});
it("starts once, spends no turn on empty output, and emits into the registered watch", async () => {
  const h = harness(),
    watch = object(),
    agents = [agent(watch)];
  h.manager.reconcile("example/command", h.provider, agents);
  await Promise.resolve();
  h.manager.reconcile("example/command", h.provider, agents);
  expect(h.provider.run).toHaveBeenCalledTimes(1);
  h.inputs[0]?.emit(" ");
  expect(h.emit).not.toHaveBeenCalled();
  h.inputs[0]?.emit("CI failed");
  expect(h.emit).toHaveBeenCalledWith(
    "a",
    watch,
    "CI failed",
    expect.any(Function),
  );
  h.manager.stop();
});
it("runs one agent's watch separately in each of its communities", async () => {
  const h = harness(),
    home = object(),
    joined = object();
  h.manager.reconcile("example/command", h.provider, [
    agent(home),
    { ...agent(joined), key: "a@other.test" },
  ]);
  await Promise.resolve();
  expect(h.inputs.map((input) => input.agent)).toEqual(["a", "a@other.test"]);
  h.inputs[1]?.emit("CI failed");
  expect(h.emit).toHaveBeenCalledWith(
    "a@other.test",
    joined,
    "CI failed",
    expect.any(Function),
  );
  h.manager.reconcile("example/command", h.provider, [agent(home)]);
  expect(h.inputs[0]?.signal.aborted).toBe(false);
  expect(h.inputs[1]?.signal.aborted).toBe(true);
  h.manager.stop();
});
it.each(["off", "removed", "edited", "unloaded", "interest paused"])(
  "cancels on %s and refuses late output",
  async (reason) => {
    const h = harness(),
      watch = object();
    h.manager.reconcile("example/command", h.provider, [agent(watch)]);
    await Promise.resolve();
    if (reason === "unloaded") h.manager.stop();
    else
      h.manager.reconcile(
        "example/command",
        h.provider,
        reason === "removed"
          ? []
          : [
              agent(
                reason === "edited" ? object() : watch,
                reason !== "off",
                reason === "interest paused",
              ),
            ],
      );
    expect(h.inputs[0]?.signal.aborted).toBe(true);
    expect(() => h.inputs[0]?.emit("late")).toThrow(/no longer/);
    await Promise.all(
      vi.mocked(h.provider.run).mock.results.map((result) => result.value),
    );
    await Promise.resolve();
    expect(h.finish).not.toHaveBeenCalled();
    h.manager.stop();
  },
);
it("records natural completion once and does not restart a completed registration", async () => {
  const h = harness(),
    watch = object(),
    agents = [agent(watch)];
  h.manager.reconcile("example/command", h.provider, agents);
  await Promise.resolve();
  h.endings[0]?.();
  await vi.waitFor(() => expect(h.finish).toHaveBeenCalledWith("a", watch));
  h.manager.reconcile("example/command", h.provider, agents);
  expect(h.provider.run).toHaveBeenCalledTimes(1);
  h.manager.stop();
  h.completed.mockReturnValue(true);
  h.manager.reconcile("example/command", h.provider, agents);
  expect(h.provider.run).toHaveBeenCalledTimes(1);
});
it("does not start an orphan source or a source belonging to another provider", async () => {
  const h = harness(),
    watch = object(),
    orphan = { ...agent(watch), attention: { [watch.slug]: watch } };
  h.manager.reconcile("example/command", h.provider, [orphan]);
  h.manager.reconcile("another/command", h.provider, [agent(watch)]);
  await Promise.resolve();
  expect(h.provider.run).not.toHaveBeenCalled();
});

it("waits for an aborted producer to exit before starting its replacement", async () => {
  const emit = vi.fn(),
    finish = vi.fn(async () => {});
  const manager = new AttentionSources({
    emit,
    finish,
    completed: () => false,
  });
  const inputs: Parameters<AttentionProducer["run"]>[0][] = [];
  let release = () => {};
  const provider: AttentionProducer = {
    id: "command",
    run: async (input) => {
      inputs.push(input);
      if (inputs.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      else
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
    },
  };
  manager.reconcile("example/command", provider, [agent(object())]);
  await Promise.resolve();
  manager.reconcile("example/command", provider, [agent(object())]);
  await Promise.resolve();
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.signal.aborted).toBe(true);
  release();
  await vi.waitFor(() => expect(inputs).toHaveLength(2));
  manager.stop();
});

it("does not persist a rejected producer as completed and can retry after restart", async () => {
  const h = harness(),
    watch = object(),
    agents = [agent(watch)];
  vi.mocked(h.provider.run).mockRejectedValueOnce(new Error("spawn failed"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    h.manager.reconcile("example/command", h.provider, agents);
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(h.finish).not.toHaveBeenCalled();
    h.manager.stop();
    h.manager.reconcile("example/command", h.provider, agents);
    await vi.waitFor(() => expect(h.provider.run).toHaveBeenCalledTimes(2));
  } finally {
    h.manager.stop();
    warning.mockRestore();
  }
});

it("waits for completion persistence before reactivating a provider", async () => {
  const tails = new Map<string, Promise<void>>();
  let saved = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = {
    emit: vi.fn(),
    completed: () => saved,
    finish: vi.fn(async () => {
      await pending;
      saved = true;
    }),
  };
  const provider = { id: "command", run: vi.fn(async () => {}) };
  const agents = [agent(object())];
  const first = new AttentionSources(host, tails);
  const replacement = new AttentionSources(host, tails);
  try {
    first.reconcile("example/command", provider, agents);
    await vi.waitFor(() => expect(host.finish).toHaveBeenCalledTimes(1));
    first.stop();
    replacement.reconcile("example/command", provider, agents);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.run).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(saved).toBe(true));
    await Promise.all(tails.values());
    expect(provider.run).toHaveBeenCalledTimes(1);
    expect(host.finish).toHaveBeenCalledTimes(1);
  } finally {
    release();
    first.stop();
    replacement.stop();
  }
});
