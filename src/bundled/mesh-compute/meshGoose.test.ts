// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { meshGooseEnv, MeshGoose } from "./meshGoose";
import { fakeSpawn } from "../goose/goose-testing";
import type { InlineTurn } from "./meshAgent";

it("does not count an empty Goose completion as a Buzz answer", async () => {
  const fake = fakeSpawn();
  const mesh = new MeshGoose({
    spawn: fake.spawn,
    resolveDirectory: async () => "/home/test",
    serve: fake.serve,
    current: async () => true,
  });
  try {
    await expect(
      mesh.run({
        delivery: {
          agent: { key: "a".repeat(64), pubkey: "a".repeat(64) },
          signal: new AbortController().signal,
        },
        inference: {
          baseUrl: "http://127.0.0.1:4111/lease/v1",
          model: "mesh",
          lease: "lease",
        },
        cwd: "/work",
        context: { channel: "chan" },
        sessionKey: "one",
        system: "Be brief",
        prompt: "Hello",
      } as InlineTurn),
    ).resolves.toEqual({ text: "", answered: false });
  } finally {
    mesh.dispose();
  }
});

describe("meshGooseEnv", () => {
  it("points goose's OpenAI provider at the leased loopback route", () => {
    expect(
      meshGooseEnv(
        "http://127.0.0.1:4111/lease-1/v1",
        "/home/me/.buzz/.mesh-goose",
      ),
    ).toEqual({
      GOOSE_PATH_ROOT: "/home/me/.buzz/.mesh-goose",
      GOOSE_DISABLE_KEYRING: "1",
      OPENAI_HOST: "http://127.0.0.1:4111",
      OPENAI_BASE_PATH: "lease-1/v1/chat/completions",
      OPENAI_API_KEY: "mesh-local",
      GOOSE_TOOL_DEFERRAL: null,
      GOOSE_TOOL_DEFERRAL_ALWAYS_LOAD: null,
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function turn(signal: AbortSignal): InlineTurn {
  return {
    delivery: {
      agent: { key: "member@community-b", pubkey: "a".repeat(64) },
      signal,
    },
    inference: {
      baseUrl: "http://127.0.0.1:4111/lease/v1",
      model: "mesh",
      lease: "lease",
    },
    cwd: "/work",
    context: { channel: "chan" },
    sessionKey: "one",
    system: "Be brief",
    prompt: "Hello",
  } as InlineTurn;
}

it.each([
  "initialize",
  "session/new",
  "_goose/unstable/session/system-prompt/set",
])(
  "kills a cancelled process during %s without starting a turn",
  async (method) => {
    const fake = fakeSpawn();
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const mesh = new MeshGoose({
      spawn: async (id, options) => {
        const process = await fake.spawn(id, options);
        return {
          ...process,
          write: async (data) => {
            if (JSON.parse(data).method === method) {
              entered.resolve();
              await release.promise;
            }
            return process.write(data);
          },
        };
      },
      resolveDirectory: async () => "/home/test",
      serve: fake.serve,
      current: async () => true,
    });
    const done = mesh.run(turn(controller.signal));
    const rejected = expect(done).rejects.toThrow();
    try {
      await entered.promise;
      controller.abort();
      release.resolve();
      await rejected;
      expect(fake.processes[0]?.killed).toBe(true);
      expect(fake.processes[0]?.turns).toHaveLength(0);
    } finally {
      release.resolve();
      mesh.dispose();
    }
  },
);

it("keeps transcripts private to the community membership", async () => {
  const fake = fakeSpawn();
  const mesh = new MeshGoose({
    spawn: fake.spawn,
    serve: fake.serve,
    resolveDirectory: async () => "/home/test",
    current: async () => true,
  });
  const input = turn(new AbortController().signal);
  try {
    await mesh.run(input);
    const signal = new AbortController().signal;
    const rows = await mesh.recent(input.delivery.agent.key, "/work", signal);
    expect(rows).toHaveLength(1);
    expect(
      await mesh.recent(input.delivery.agent.pubkey, "/work", signal),
    ).toEqual([]);
    const row = rows[0];
    if (!row) throw new Error("Missing transcript");
    await expect(
      mesh.transcript(input.delivery.agent.pubkey, "/work", row, signal),
    ).rejects.toThrow("no longer available");
  } finally {
    mesh.dispose();
  }
});

it.each(["abort", "retire"])(
  "rechecks a %s turn after channel startup before publishing",
  async (ending) => {
    const fake = fakeSpawn({ hold: true });
    const entered = deferred<void>();
    const release = deferred<void>();
    const published = vi.fn();
    const controller = new AbortController();
    let current = true;
    const mesh = new MeshGoose({
      spawn: fake.spawn,
      serve: fake.serve,
      resolveDirectory: async () => "/home/test",
      current: async () => true,
    });
    const input = turn(controller.signal);
    input.delivery = {
      ...input.delivery,
      current: () => current,
      agent: {
        ...input.delivery.agent,
        query: async () => [],
        publish: async (event, check) => {
          entered.resolve();
          await release.promise;
          check?.();
          published(event);
          return { ...event, id: "posted" } as never;
        },
      },
    };
    const done = mesh.run(input);
    // Cancellation kills the active process; observe the rejection immediately.
    const settled = done.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fake.processes[0]?.turns).toHaveLength(1));
      const goose = fake.processes[0];
      const active = goose?.turns[0];
      if (!goose || !active) throw new Error("Missing Goose turn");
      const sending = goose
        .mcp(active.sessionId, "tools/call", {
          name: "send",
          arguments: { text: "answer", audience: "everyone" },
        })
        .catch(() => undefined);
      await entered.promise;
      if (ending === "abort") controller.abort();
      else current = false;
      release.resolve();
      await sending;
      active.finish();
      await settled;
      expect(published).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      mesh.dispose();
      await settled;
    }
  },
);
