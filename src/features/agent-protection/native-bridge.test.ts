import { expect, it, vi } from "vitest";
import type { McpHandler } from "../host/service";
import { nativeProtectionBridge } from "./native-bridge";
import { ProtectionDenied, type AgentProtection } from "./service";

async function fixture(
  check: AgentProtection["check"],
  extra: Partial<AgentProtection> = {},
) {
  let handler!: McpHandler, closed!: () => void;
  const close = vi.fn(async () => closed());
  const bridge = await nativeProtectionBridge(
    async (call) => {
      handler = call;
      return {
        url: "http://127.0.0.1:1234/mcp",
        headers: [{ name: "Authorization", value: "Bearer native-owned" }],
        close,
        closed: new Promise<void>((r) => {
          closed = r;
        }),
      };
    },
    {
      key: "policy",
      stateKey: "revision",
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      spawn: async () => {
        throw new Error("Unused protected runtime");
      },
      assertAvailable() {},
      check,
      checkEvidence: async (action, evidence, signal) => {
        let content = "";
        for await (const part of evidence.read()) content += part;
        await check({ ...action, content: JSON.parse(content) }, signal);
      },
      ...extra,
    },
  );
  const send = async (call: {
    id: string;
    params: Record<string, unknown>;
  }) => {
    const { content, ...metadata } = call.params;
    const opened = (await handler(evidenceCall("begin", metadata))) as {
      result: { id: string };
    };
    const id = opened.result.id;
    const data = new TextEncoder().encode(JSON.stringify(content));
    await handler(
      evidenceCall("chunk", {
        id,
        sequence: 0,
        data: btoa(String.fromCharCode(...data)),
      }),
    );
    const result = (await handler(
      evidenceCall("finish", { id, sequence: 1, bytes: data.length }),
    )) as { result: unknown };
    return { jsonrpc: "2.0", id: call.id, result: result.result };
  };
  return { bridge, handler, send, close, closed };
}
const call = {
  id: "native-1",
  params: {
    kind: "tool",
    session: "native-session",
    content: { command: "write", conversation: ["authorized task"] },
  },
};

it("uses native transport authority and preserves the exact evidence", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const f = await fixture(check);
  expect(f.bridge.env).toEqual({
    BUZZ_SECURITY_CONTEXT: "1",
    BUZZ_SECURITY_TOOL: "1",
    BUZZ_SECURITY_TOOL_RESULT: "1",
    BUZZ_SECURITY_URL: "http://127.0.0.1:1234/mcp",
    BUZZ_SECURITY_TOKEN: "native-owned",
  });
  expect(await f.send(call)).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: true },
  });
  expect(check.mock.calls[0]?.[0]).toEqual(call.params);
  await expect(
    f.send({ ...call, params: { ...call.params, policy: {} } }),
  ).rejects.toThrow("Invalid evidence admission");
  await f.bridge.close();
});

it("denies checker failures and cancels held approvals when the server closes", async () => {
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(async (_action, signal) => {
    entered();
    await new Promise<void>((_r, reject) =>
      signal.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      }),
    );
  });
  const pending = f.send(call);
  await started;
  await f.bridge.close();
  expect(await pending).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: false },
  });
});

it("preserves optional command evidence and rejects invalid or extra fields", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const f = await fixture(check);
  const params = {
    ...call.params,
    content: { ...call.params.content, command: "echo approved" },
  };
  try {
    expect(await f.send({ ...call, params })).toMatchObject({
      result: { allowed: true },
    });
    expect(check.mock.calls[0]?.[0]).toEqual(params);
    for (const invalid of [
      { ...params, command: null },
      { ...params, command: 42 },
      { ...params, command: {} },
      { ...params, policy: {} },
      { ...params, agent: "another-agent" },
    ]) {
      await expect(f.send({ ...call, params: invalid })).rejects.toThrow(
        "Invalid evidence admission",
      );
    }
    expect(check).toHaveBeenCalledTimes(1);
  } finally {
    await f.bridge.close();
  }
});

it("rejects saturation instead of admitting unchecked native actions", async () => {
  const f = await fixture(async (_action, signal) => {
    await new Promise<void>((_r, reject) =>
      signal.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      }),
    );
  });
  for (let i = 0; i < 16; i++)
    await f.handler(
      evidenceCall("begin", { kind: "tool", session: String(i) }),
    );
  await expect(
    f.handler(evidenceCall("begin", { kind: "tool", session: "overflow" })),
  ).rejects.toThrow("Invalid evidence admission");
  await f.bridge.close();
});

it("keeps an explained model-input denial for Buzz, never for the runtime", async () => {
  const check = vi.fn<AgentProtection["check"]>();
  const f = await fixture(check);
  const ask = (kind: string, session = "native-session") =>
    f.send({ ...call, params: { ...call.params, kind, session } });
  const deny = (reason?: string) =>
    check.mockRejectedValueOnce(new ProtectionDenied(reason));
  const turn = f.bridge.explainer("native-session");
  deny("It asks to reveal keys.");
  expect(await ask("context")).toEqual({
    jsonrpc: "2.0",
    id: "native-1",
    result: { allowed: false },
  });
  // A refused tool call or result does not end the turn, so needs no reason.
  deny("A refused tool call.");
  await ask("tool");
  deny("A refused tool result.");
  await ask("tool-result");
  // Nor does a concurrent source that passed, or was refused unexplained.
  check.mockResolvedValueOnce();
  await ask("context");
  deny();
  await ask("context");
  check.mockRejectedValueOnce(new Error("offline"));
  await ask("context");
  expect(turn()).toBe("It asks to reveal keys.");
  expect(turn()).toBeUndefined();
  // Explanations nobody takes age out, oldest first.
  const turns = Array.from({ length: 17 }, (_, index) =>
    f.bridge.explainer(`session-${index}`),
  );
  for (let index = 0; index <= 16; index++) {
    deny(`Session ${index}.`);
    await ask("context", `session-${index}`);
  }
  expect(turns[0]?.()).toBeUndefined();
  expect(turns[1]?.()).toBe("Session 1.");
  expect(turns[16]?.()).toBe("Session 16.");
});

it("explains a turn only by a refusal of a check that turn started", async () => {
  const check = vi.fn<AgentProtection["check"]>();
  const f = await fixture(check);
  const ask = () =>
    f.send({ ...call, params: { ...call.params, kind: "context" } });
  // A check from an interrupted turn is still with its reviewer.
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    check.mockImplementationOnce(async () => {
      await held;
      throw new ProtectionDenied("An earlier turn's refusal.");
    });
    return release;
  };
  let release = hold();
  const earlier = ask();
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
  const turn = f.bridge.explainer("native-session");
  check.mockRejectedValueOnce(new ProtectionDenied("This turn's refusal."));
  await ask();
  // Settling after this turn's refusal, it does not replace it.
  release();
  await earlier;
  expect(turn()).toBe("This turn's refusal.");
  // Nor does it explain a turn that ends for another reason.
  release = hold();
  const stale = ask();
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
  const next = f.bridge.explainer("native-session");
  release();
  await stale;
  expect(next()).toBeUndefined();
});

const evidenceCall = (operation: string, params: object) => ({
  id: crypto.randomUUID(),
  method: `buzz/security/evidence/${operation}`,
  params,
});
it("streams complete evidence beyond old budgets and keeps authority outside uploaded JSON", async () => {
  let observed = 0;
  const text = JSON.stringify({
    policy: { disabled: true },
    agent: { name: "forged" },
    text: "😀".repeat(300000),
  });
  const f = await fixture(async () => {}, {
    checkEvidence: async (action, source) => {
      expect(action).toEqual({ kind: "context", session: "s" });
      for await (const piece of source.read())
        observed += new TextEncoder().encode(piece).length;
    },
  });
  try {
    await expect(
      f.handler(
        evidenceCall("begin", { kind: "context", session: "s", policy: {} }),
      ),
    ).rejects.toThrow();
    const begin = (await f.handler(
      evidenceCall("begin", { kind: "context", session: "s" }),
    )) as { result: { id: string; chunkBytes: number } };
    const bytes = new TextEncoder().encode(text);
    let sequence = 0;
    for (let at = 0; at < bytes.length; at += begin.result.chunkBytes) {
      const data = btoa(
        String.fromCharCode(...bytes.slice(at, at + begin.result.chunkBytes)),
      );
      expect(
        await f.handler(
          evidenceCall("chunk", {
            id: begin.result.id,
            sequence: sequence++,
            data,
          }),
        ),
      ).toMatchObject({ result: { accepted: true } });
    }
    expect(
      await f.handler(
        evidenceCall("finish", {
          id: begin.result.id,
          sequence,
          bytes: bytes.length,
        }),
      ),
    ).toMatchObject({ result: { allowed: true } });
    expect(observed).toBe(bytes.length);
    await expect(
      f.handler(
        evidenceCall("finish", {
          id: begin.result.id,
          sequence,
          bytes: bytes.length,
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await f.bridge.close();
  }
});
it("rejects out-of-order and incomplete transfers and cancels readers on close", async () => {
  let failures = 0;
  const f = await fixture(async () => {}, {
    checkEvidence: async (_action, source) => {
      try {
        for await (const _ of source.read()) {
          /* consume */
        }
      } catch (error) {
        failures++;
        throw error;
      }
    },
  });
  const begin = async () =>
    (
      (await f.handler(
        evidenceCall("begin", { kind: "tool", session: "s" }),
      )) as { result: { id: string } }
    ).result.id;
  const first = await begin();
  await expect(
    f.handler(
      evidenceCall("chunk", { id: first, sequence: 1, data: btoa("{}") }),
    ),
  ).rejects.toThrow();
  const second = await begin();
  await f.handler(
    evidenceCall("chunk", { id: second, sequence: 0, data: btoa("{}") }),
  );
  await expect(
    f.handler(evidenceCall("finish", { id: second, sequence: 1, bytes: 3 })),
  ).rejects.toThrow();
  const third = await begin();
  await f.bridge.close();
  await expect(
    f.handler(
      evidenceCall("chunk", { id: third, sequence: 0, data: btoa("{}") }),
    ),
  ).rejects.toThrow();
  await vi.waitFor(() => expect(failures).toBe(3));
});

it("refuses chunks after a settled check, expires idle transfers, and checks provider lifetime at completion", async () => {
  const early = await fixture(async () => {}, {
    checkEvidence: async () => {},
  });
  const id = (
    (await early.handler(
      evidenceCall("begin", { kind: "context", session: "s" }),
    )) as { result: { id: string } }
  ).result.id;
  await expect(
    early.handler(evidenceCall("chunk", { id, sequence: 0, data: btoa("{}") })),
  ).rejects.toThrow("ended");
  await early.bridge.close();
  vi.useFakeTimers();
  const expired = await fixture(async () => {}, {
    checkEvidence: async (_action, source) => {
      for await (const _ of source.read()) {
      }
    },
  });
  const stale = (
    (await expired.handler(
      evidenceCall("begin", { kind: "context", session: "s" }),
    )) as { result: { id: string } }
  ).result.id;
  await vi.advanceTimersByTimeAsync(310001);
  await expect(
    expired.handler(
      evidenceCall("finish", { id: stale, sequence: 0, bytes: 0 }),
    ),
  ).rejects.toThrow("expired");
  await expired.bridge.close();
  vi.useRealTimers();
  let live = true;
  const revoked = await fixture(async () => {}, {
    assertAvailable() {
      if (!live) throw new Error("provider removed");
    },
    checkEvidence: async (_action, source) => {
      for await (const _ of source.read()) {
      }
      live = false;
    },
  });
  const gone = (
    (await revoked.handler(
      evidenceCall("begin", { kind: "tool", session: "s" }),
    )) as { result: { id: string } }
  ).result.id;
  await revoked.handler(
    evidenceCall("chunk", { id: gone, sequence: 0, data: btoa("{}") }),
  );
  await expect(
    revoked.handler(
      evidenceCall("finish", { id: gone, sequence: 1, bytes: 2 }),
    ),
  ).rejects.toThrow("provider removed");
  await revoked.bridge.close();
});

it("cancels a caller-owned admission and fails its reader", async () => {
  let failed!: (error: unknown) => void;
  const reader = new Promise<unknown>((resolve) => {
    failed = resolve;
  });
  const f = await fixture(async () => {}, {
    checkEvidence: async (_action, source) => {
      try {
        for await (const _ of source.read()) {
        }
      } catch (error) {
        failed(error);
        throw error;
      }
    },
  });
  try {
    const id = crypto.randomUUID();
    expect(
      await f.handler(
        evidenceCall("begin", { id, kind: "context", session: "s" }),
      ),
    ).toMatchObject({ result: { id } });
    expect(await f.handler(evidenceCall("cancel", { id }))).toMatchObject({
      result: { allowed: false },
    });
    expect(String(await reader)).toContain("cancelled");
    await expect(
      f.handler(evidenceCall("chunk", { id, sequence: 0, data: btoa("{}") })),
    ).rejects.toThrow("Unknown");
  } finally {
    await f.bridge.close();
  }
});
