import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import {
  DECISION_BACKEND_KEY,
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
  type DecisionProvider,
  type DecisionProviderStatus,
  type DecisionRequest,
} from "./service";

const request: DecisionRequest = {
  state: "The build is broken on main.",
  questions: {
    urgent: { type: "yes_no", instructions: "It needs attention now." },
  },
};
const reply = {
  outcome: "answered" as const,
  model: "jev-1.13.0",
  answers: { urgent: { type: "yes_no" as const, probability: 0.8 } },
};
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
/** A root whose plugins are all active, and its decisions service. */
function setup(storage: Storage = memory(), active = () => true) {
  const root = new Context();
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const timers: { run(): void; ms: number }[] = [];
  const service = new DecisionsService(root, storage, (run, ms) => {
    const timer = { run, ms };
    timers.push(timer);
    return () => void timers.splice(timers.indexOf(timer), 1);
  });
  /** Registers `provider` from a plugin `id`; resolves to its fiber. */
  const plugin = async (id: string, provider: Partial<DecisionProvider>) => {
    const fiber = root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.decisions.registerProvider(fake(provider)));
    await fiber.await();
    await flush();
    return fiber;
  };
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return { root, service, plugin, timers, changed };
}
function fake(provider: Partial<DecisionProvider>): DecisionProvider {
  return {
    id: "main",
    label: "Fake",
    description: "A test provider.",
    status: () => "ready",
    subscribe: () => () => {},
    decide: async () => reply,
    ...provider,
  };
}
/** A provider whose status the test sets. */
function settable(status: DecisionProviderStatus) {
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: DecisionProviderStatus) {
      status = next;
      for (const listener of listeners) listener();
    },
  };
}

it("is unavailable with no provider, and never rejects", async () => {
  const { service } = setup();
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  await expect(service.decide(request)).resolves.toEqual({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  });
});

it("asks the provider plugins register, through the injected ctx.decisions", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  const fiber = await plugin("buzz.typesafe", { id: "typesafe", decide });
  expect(service.providers().map((provider) => provider.key)).toEqual([
    "buzz.typesafe/typesafe",
  ]);
  expect(service.backend()).toBe("buzz.typesafe/typesafe");
  await expect(service.decide(request)).resolves.toEqual({
    ...reply,
    backend: "buzz.typesafe/typesafe",
  });
  // The deadline is filled in, and the provider is told when to stop.
  expect(decide).toHaveBeenCalledWith(
    { ...request, timeoutMs: 30_000 },
    { signal: expect.any(AbortSignal) },
  );
  // Disabling the plugin removes its provider.
  await fiber.dispose();
  expect(service.providers()).toEqual([]);
  expect(service.status()).toBe("unavailable");
});

it("lists only providers of active plugin revisions", async () => {
  let active = false;
  const { service, plugin, changed } = setup(memory(), () => active);
  await plugin("buzz.typesafe", {});
  expect(service.providers()).toEqual([]);
  active = true;
  changed();
  expect(service.providers()).toHaveLength(1);
});

it("uses TypeSafe until the user chooses, even when another provider is ready first", async () => {
  const storage = memory();
  const { service, plugin } = setup(storage);
  const typesafe = settable("needs-setup");
  // Sorts ahead of TypeSafe, by order and by key, and is ready.
  await plugin("acme.helper", { id: "p", order: -1 });
  await plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status()).toBe("needs-setup");
  const listener = vi.fn();
  // Unbound, as React's useSyncExternalStore calls it.
  const { subscribe } = service;
  subscribe(listener);
  typesafe.set("ready");
  expect(service.status()).toBe("ready");
  expect(listener).toHaveBeenCalled();
  await expect(service.decide(request)).resolves.toMatchObject({
    backend: DEFAULT_DECISION_PROVIDER,
  });
  // Only an explicit choice moves decisions to another provider.
  service.setBackend("acme.helper/p");
  expect(service.backend()).toBe("acme.helper/p");
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe("acme.helper/p");
  // A choice that is not a registered provider changes nothing.
  listener.mockClear();
  service.setBackend("other/main");
  expect(service.backend()).toBe("acme.helper/p");
  expect(listener).not.toHaveBeenCalled();
});

it("never sends decisions elsewhere while the chosen provider is missing", async () => {
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  // The user chose TypeSafe, and its plugin is off or not registered yet.
  const { service, plugin } = setup(
    memory({ [DECISION_BACKEND_KEY]: DEFAULT_DECISION_PROVIDER }),
  );
  await plugin("zzz.other", { id: "p", decide });
  expect(service.backend()).toBeUndefined();
  expect(service.status()).toBe("unavailable");
  await expect(service.decide(request)).resolves.toEqual({
    outcome: "failed",
    backend: undefined,
    reason: "unavailable",
  });
  // With no choice, TypeSafe is the choice, so the same holds.
  const fresh = setup();
  await fresh.plugin("zzz.other", { id: "p", decide });
  expect(fresh.service.status()).toBe("unavailable");
  await expect(fresh.service.decide(request)).resolves.toMatchObject({
    reason: "unavailable",
  });
  expect(decide).not.toHaveBeenCalled();
});

it("uses Builderlab while it is registered, unless the user chose another", async () => {
  const storage = memory();
  const { service, plugin } = setup(storage);
  const typesafe = await plugin("buzz.typesafe", { id: "typesafe" });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // Builderlab registers only for a signed-in account it allows.
  let builderlab = await plugin("block.builderlab", { id: "builderlab" });
  expect(service.backend()).toBe("block.builderlab/builderlab");
  await builderlab.dispose();
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // A choice of Builderlab falls back to TypeSafe while it is missing.
  builderlab = await plugin("block.builderlab", { id: "builderlab" });
  service.setBackend("block.builderlab/builderlab");
  await builderlab.dispose();
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  // A choice of TypeSafe stays when Builderlab registers again, and falls
  // back to Builderlab while TypeSafe is off.
  service.setBackend(DEFAULT_DECISION_PROVIDER);
  builderlab = await plugin("block.builderlab", { id: "builderlab" });
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  await typesafe.dispose();
  expect(service.backend()).toBe("block.builderlab/builderlab");
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe(
    DEFAULT_DECISION_PROVIDER,
  );
});

it("routes to the first default that can answer, else TypeSafe", async () => {
  const { service, plugin } = setup();
  const builderlab = settable("needs-setup");
  const typesafe = settable("needs-setup");
  await plugin("buzz.typesafe", { id: "typesafe", ...typesafe });
  await plugin("block.builderlab", { id: "builderlab", ...builderlab });
  // When no default can answer, TypeSafe shows: the user can set it up.
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status()).toBe("needs-setup");
  // A default still checking makes the routing checking, not the backend.
  builderlab.set("checking");
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status()).toBe("checking");
  typesafe.set("ready");
  // One that can answer is not held up by one that is checking.
  expect(service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  expect(service.status()).toBe("ready");
  builderlab.set("ready");
  expect(service.backend()).toBe("block.builderlab/builderlab");
  // A choice is kept even while it needs setup.
  builderlab.set("needs-setup");
  service.setBackend("block.builderlab/builderlab");
  expect(service.backend()).toBe("block.builderlab/builderlab");
  expect(service.status()).toBe("needs-setup");
});

it("routes a request once a checking default knows whether it can answer", async () => {
  const { service, plugin, timers } = setup();
  const builderlab = settable("checking");
  const fromBuilderlab = vi.fn(async () => reply);
  const fromTypesafe = vi.fn(async () => reply);
  await plugin("buzz.typesafe", {
    id: "typesafe",
    ...settable("needs-setup"),
    decide: fromTypesafe,
  });
  await plugin("block.builderlab", {
    id: "builderlab",
    ...builderlab,
    decide: fromBuilderlab,
  });
  const refused = service.decide(request);
  await flush();
  expect(fromBuilderlab).not.toHaveBeenCalled();
  expect(fromTypesafe).not.toHaveBeenCalled();
  builderlab.set("needs-setup");
  await expect(refused).resolves.toMatchObject({
    outcome: "answered",
    backend: DEFAULT_DECISION_PROVIDER,
  });
  builderlab.set("checking");
  const granted = service.decide(request);
  await flush();
  builderlab.set("ready");
  await expect(granted).resolves.toMatchObject({
    backend: "block.builderlab/builderlab",
  });
  expect(fromBuilderlab).toHaveBeenCalledOnce();
  // The wait counts against the request's deadline.
  builderlab.set("checking");
  const late = service.decide(request);
  await flush();
  timers[0]?.run();
  await expect(late).resolves.toMatchObject({ reason: "timeout" });
  expect(fromBuilderlab).toHaveBeenCalledOnce();
});

it("does not hold a request for a checking default when another can answer", async () => {
  const { service, plugin } = setup();
  const fromBuilderlab = vi.fn(async () => reply);
  const fromTypesafe = vi.fn(async () => reply);
  await plugin("buzz.typesafe", { id: "typesafe", decide: fromTypesafe });
  await plugin("block.builderlab", {
    id: "builderlab",
    ...settable("checking"),
    decide: fromBuilderlab,
  });
  await expect(service.decide(request)).resolves.toMatchObject({
    outcome: "answered",
    backend: DEFAULT_DECISION_PROVIDER,
  });
  expect(fromBuilderlab).not.toHaveBeenCalled();
});

it("removes a provider when the plugin asks, before its scope ends", async () => {
  const { root, service } = setup();
  let remove = () => {};
  const fiber = root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin((ctx) => {
      remove = ctx.decisions.registerProvider(fake({ id: "typesafe" }));
    });
  await fiber.await();
  await flush();
  expect(service.providers()).toHaveLength(1);
  remove();
  expect(service.providers()).toEqual([]);
  // Ending the scope afterwards is harmless.
  remove();
  await fiber.dispose();
  expect(service.providers()).toEqual([]);
});

it("restores a saved choice once its provider registers, and survives unreadable storage", async () => {
  const { service, plugin } = setup(
    memory({ [DECISION_BACKEND_KEY]: "b/main" }),
  );
  await plugin("buzz.typesafe", { id: "typesafe", order: 0 });
  // Not registered yet: unavailable, not TypeSafe.
  expect(service.backend()).toBeUndefined();
  await plugin("b", { order: 1, status: () => "needs-setup" });
  expect(service.backend()).toBe("b/main");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const other = setup(broken);
  await other.plugin("buzz.typesafe", { id: "typesafe" });
  await other.plugin("b", { order: 1 });
  expect(other.service.backend()).toBe(DEFAULT_DECISION_PROVIDER);
  other.service.setBackend("b/main");
  expect(other.service.backend()).toBe("b/main");
});

it("checks requests before any provider sees them", async () => {
  const { service, plugin } = setup();
  const decide = vi.fn<DecisionProvider["decide"]>(async () => reply);
  await plugin("buzz.typesafe", { id: "typesafe", decide });
  for (const bad of [
    { ...request, state: " " },
    { ...request, questions: {} },
    {
      ...request,
      questions: { pick: { type: "choice", instructions: "x", options: {} } },
    },
    {
      ...request,
      questions: { rate: { type: "score", instructions: "x", levels: ["a"] } },
    },
    { ...request, questions: { ["x".repeat(65)]: request.questions.urgent } },
    { ...request, community: " " },
    { ...request, community: 1 },
  ] as unknown as DecisionRequest[])
    await expect(service.decide(bad)).resolves.toMatchObject({
      reason: "invalid_request",
    });
  await expect(
    service.decide({ ...request, state: "x".repeat(128 * 1024) }),
  ).resolves.toMatchObject({ reason: "input_limit" });
  expect(decide).not.toHaveBeenCalled();
});

it("checks answers against the questions", async () => {
  const questions: DecisionRequest["questions"] = {
    urgent: { type: "yes_no", instructions: "Urgent." },
    pick: {
      type: "choice",
      instructions: "Which.",
      options: { a: "A", b: "B" },
    },
    rate: { type: "score", instructions: "How.", levels: ["low", "high"] },
  };
  const good = {
    urgent: { type: "yes_no", probability: 1 },
    pick: {
      type: "choice",
      choice: "b",
      confidence: 0.5,
      probabilities: { a: 0.5, b: 0.5 },
    },
    rate: { type: "score", score: 0.5, confidence: 0.9 },
    extra: { type: "yes_no", probability: 0.1 },
  };
  let answers: unknown = good;
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: async () => ({ outcome: "answered", model: "m", answers }) as never,
  });
  const result = await service.decide({ ...request, questions });
  expect(result).toEqual({
    outcome: "answered",
    backend: "buzz.typesafe/typesafe",
    model: "m",
    answers: {
      urgent: good.urgent,
      pick: good.pick,
      // Missing probabilities are none; answers not asked for are dropped.
      rate: { ...good.rate, probabilities: {} },
    },
  });
  for (const bad of [
    { ...good, urgent: { type: "yes_no", probability: 2 } },
    { ...good, urgent: { type: "choice", choice: "a", confidence: 1 } },
    { ...good, pick: { ...good.pick, choice: "toString" } },
    { ...good, pick: { ...good.pick, probabilities: { c: 0.1 } } },
    { ...good, rate: { ...good.rate, score: 2 } },
    { ...good, rate: { ...good.rate, probabilities: { "01": 0.1 } } },
    Object.assign(Object.create({ urgent: good.urgent }), {
      pick: good.pick,
      rate: good.rate,
    }),
    null,
  ]) {
    answers = bad;
    await expect(
      service.decide({ ...request, questions }),
    ).resolves.toMatchObject({ outcome: "failed", reason: "invalid_response" });
  }
});

it("keeps every question name as the answer's own key, even __proto__", async () => {
  // Parsed, so "__proto__" is an own question name, as a plugin can send.
  const questions = JSON.parse(
    '{"__proto__":{"type":"yes_no","instructions":"Odd."},"urgent":{"type":"yes_no","instructions":"Urgent."}}',
  ) as DecisionRequest["questions"];
  const answers = JSON.parse(
    '{"__proto__":{"type":"yes_no","probability":0.3},"urgent":{"type":"yes_no","probability":0.8}}',
  );
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: async () => ({ outcome: "answered", model: "m", answers }) as never,
  });
  const result = await service.decide({ ...request, questions });
  if (result.outcome !== "answered") throw new Error(result.reason);
  expect(Object.keys(result.answers)).toEqual(["__proto__", "urgent"]);
  expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);
  // An unasked name does not resolve to the __proto__ answer's fields.
  expect((result.answers as Record<string, unknown>).probability).toBe(
    undefined,
  );
  expect(JSON.parse(JSON.stringify(result.answers))).toEqual(answers);
});

it("turns provider failures, throws and wrong replies into failures", async () => {
  let decide: DecisionProvider["decide"] = async () => {
    throw new Error("down");
  };
  const { service, plugin } = setup();
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: (...args) => decide(...args),
  });
  const failed = (reason: string) => ({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason,
  });
  await expect(service.decide(request)).resolves.toEqual(
    failed("service_error"),
  );
  for (const [odd, reason] of [
    [{ outcome: "failed", reason: "unauthorized" }, "unauthorized"],
    [{ outcome: "failed", reason: "other" }, "invalid_response"],
    [{ outcome: "answered", answers: reply.answers }, "invalid_response"],
    [null, "invalid_response"],
  ] as const) {
    decide = async () => odd as never;
    await expect(service.decide(request)).resolves.toEqual(failed(reason));
  }
});

it("stops waiting at the deadline and aborts the provider", async () => {
  const { service, plugin, timers } = setup();
  let signal: AbortSignal | undefined;
  await plugin("buzz.typesafe", {
    id: "typesafe",
    decide: (_request, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const result = service.decide({ ...request, timeoutMs: 5 });
  await flush();
  // Held to at least a second.
  expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
  timers[0]?.run();
  await expect(result).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason: "timeout",
  });
  expect(signal?.aborted).toBe(true);
  expect(timers).toEqual([]);
});
