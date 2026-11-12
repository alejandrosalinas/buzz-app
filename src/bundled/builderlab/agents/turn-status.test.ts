import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../../features/agents/activity";
import { requestWork } from "../../../features/agents/request-work";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import type { HostResponse } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import { createAgentClient } from "./client";
import { startTurnStatusRecovery } from "./turn-status";

const agent = "ab".repeat(32),
  request = "cd".repeat(32);
const connected = {
  status: "connected",
  routes: [{ id: "observer", status: "live", replay: "unknown" }],
} as const;
const response = (outcomes: object): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ outcomes }),
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(
  start: "turn_started" | "turn_liveness" | "resolve" = "turn_started",
) {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const result = deferred<HostResponse>();
  let finalStatuses: object | undefined;
  let pubkeys = [agent];
  const started = deferred<void>();
  const respond = async (input: { url: string; body?: string }) => {
    if (input.url.endsWith("/list-agents"))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 1,
          agents: pubkeys.map((pubkey, index) => ({
            agent_id: `agent-${index}`,
            agent_name: "Helper",
            agent_pubkey: pubkey,
            status: 2,
          })),
        }),
      };
    started.resolve();
    if (finalStatuses) {
      const requested = JSON.parse(input.body ?? "{}").task_ids;
      return response(
        Object.fromEntries(
          Object.entries(finalStatuses).filter(([id]) =>
            requested.includes(id),
          ),
        ),
      );
    }
    return result.promise;
  };
  const hostRequest = vi.fn(respond);
  let subject = "owner";
  const session = createTestSession(
    async () => ({
      revision: subject,
      account: {
        subject,
        email: "fixture@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: hostRequest },
  );
  await session.signIn();
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
  );
  const release = activity.queries.activate();
  activity.state(connected);
  let relaySession = {
    agentActivity: activity.queries,
  } as unknown as RelaySession;
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => ({
      status: "ready",
      generation: 1,
      origin: "https://primary.example",
      session: relaySession,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const stop = startTurnStatusRecovery({
    relay,
    session,
    client: createAgentClient(session, null),
  });
  const send = (
    kind: string,
    seq: number,
    payload: unknown = {},
    turnId = "task",
    pubkey = agent,
    sessionId = "session",
  ) =>
    activity.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Date.now() / 1000,
        plaintext: JSON.stringify({
          kind,
          seq,
          turnId,
          sessionId: start === "resolve" ? null : sessionId,
          channelId: "channel",
          timestamp: new Date().toISOString(),
          payload,
        }),
      },
      generation,
    );
  send(start === "turn_liveness" ? "turn_liveness" : "turn_started", 1, {
    triggeringEventIds: [request],
  });
  if (start === "resolve")
    send("session_resolved", 2, { sessionId: "session" });
  return {
    activity,
    session,
    send,
    result,
    started,
    hostRequest,
    respond,
    setStatus(outcomes: object) {
      finalStatuses = outcomes;
    },
    setAgents(next: string[]) {
      pubkeys = next;
    },
    async changeAccount() {
      session.signOut();
      subject = "other-owner";
      pubkeys = [];
      await session.signIn();
    },
    changeCommunity() {
      relaySession = {
        agentActivity: createAgentActivity(
          true,
          () => {},
          () => true,
        ).queries,
      } as unknown as RelaySession;
      for (const listener of listeners) listener();
    },
    work: () =>
      requestWork(activity.queries.snapshot(), "channel", request)[0]?.state,
    dispose() {
      stop();
      release();
      activity.dispose();
      session.dispose();
    },
  };
}

it.each([
  ["completed", "ended"],
  ["failed", "error"],
  ["cancelled", "stopped"],
])(
  "recovers missed %s terminal status through the real lifecycle",
  async (outcome, expected) => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(31000);
      await f.started.promise;
      expect(f.work()).toBe("unknown");
      f.result.resolve(response({ task: outcome }));
      await vi.waitFor(() => expect(f.work()).toBe(expected));
      expect(f.activity.queries.snapshot().records).toHaveLength(1);
      // Neither a late heartbeat nor a different request can inherit the result.
      f.send("turn_liveness", 2);
      expect(f.work()).toBe(expected);
      expect(
        requestWork(f.activity.queries.snapshot(), "channel", "ef".repeat(32)),
      ).toEqual([]);
    } finally {
      f.result.resolve(response({}));
      f.dispose();
    }
  },
);

it.each(["turn_liveness", "resolve"] as const)(
  "recovers a %s turn without inventing message attribution",
  async (start) => {
    const f = await fixture(start);
    try {
      f.result.resolve(response({ task: "failed" }));
      await vi.advanceTimersByTimeAsync(31000);
      await vi.waitFor(() =>
        expect(f.activity.queries.snapshot().turns[0]?.outcome).toBe("error"),
      );
      expect(f.work()).toBe(start === "turn_liveness" ? undefined : "error");
    } finally {
      f.dispose();
    }
  },
);

it("refreshes the owned agent inventory when another agent appears", async () => {
  const f = await fixture();
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    const newcomer = "ef".repeat(32);
    f.setAgents([agent, newcomer]);
    f.setStatus({ newTask: "failed" });
    f.send(
      "turn_started",
      1,
      { triggeringEventIds: [request] },
      "newTask",
      newcomer,
    );
    await vi.advanceTimersByTimeAsync(31000);
    await vi.waitFor(() =>
      expect(
        f.activity.queries
          .snapshot()
          .turns.find((turn) => turn.turnId === "newTask")?.outcome,
      ).toBe("error"),
    );
  } finally {
    f.dispose();
  }
});

it("batches at most 64 exact tasks per read and does not reread them on every activity tick", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 65; i++)
      f.send("turn_started", 1, { triggeringEventIds: [request] }, `task-${i}`);
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await vi.waitFor(() =>
      expect(
        f.hostRequest.mock.calls.filter(([input]) =>
          input.url.endsWith("/get-agent-turn-status"),
        ),
      ).toHaveLength(2),
    );
    const batches = f.hostRequest.mock.calls
      .filter(([input]) => input.url.endsWith("/get-agent-turn-status"))
      .map(([input]) => JSON.parse(input.body ?? "{}").task_ids);
    expect(batches.map((ids) => ids.length)).toEqual([64, 2]);
    expect(new Set(batches.flat()).size).toBe(66);
    await vi.advanceTimersByTimeAsync(10000);
    expect(
      f.hostRequest.mock.calls.filter(([input]) =>
        input.url.endsWith("/get-agent-turn-status"),
      ),
    ).toHaveLength(2);
  } finally {
    f.dispose();
  }
});
it("leaves missing status unknown and reads it again after reconnect", async () => {
  const f = await fixture();
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    expect(f.work()).toBe("unknown");
    f.setStatus({ task: "failed" });
    f.activity.state({ status: "retrying", routes: [] });
    f.activity.state(connected);
    await vi.waitFor(() => expect(f.work()).toBe("error"));
  } finally {
    f.dispose();
  }
});

it("recovers a task that finishes after an empty read without reconnecting", async () => {
  const f = await fixture();
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    expect(f.work()).toBe("unknown");
    f.setStatus({ task: "completed" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.work()).toBe("ended");
    const reads = f.hostRequest.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(f.hostRequest.mock.calls).toHaveLength(reads);
  } finally {
    f.dispose();
  }
});

it.each([
  ["list-agents", "http"],
  ["get-agent-turn-status", "http"],
  ["list-agents", "network"],
  ["get-agent-turn-status", "network"],
])(
  "continues other sessions and retries after %s exhausts its %s retries",
  async (path, failure) => {
    const f = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Math, "random").mockReturnValue(1);
    let failures = 4;
    f.hostRequest.mockImplementation(async (input) => {
      if (input.url.endsWith(`/${path}`) && failures-- > 0) {
        if (failure === "network") throw new Error("Network unavailable");
        return { status: 503, headers: {}, body: "Unavailable" };
      }
      return f.respond(input);
    });
    try {
      f.send(
        "turn_started",
        1,
        { triggeringEventIds: [request] },
        "other",
        agent,
        "other-session",
      );
      f.setStatus({ task: "completed", other: "completed" });
      await vi.advanceTimersByTimeAsync(38000);
      const work = (id: string) =>
        f.activity.queries.snapshot().turns.find((turn) => turn.turnId === id)
          ?.state;
      expect(work("other")).toBe("ended");
      expect(work("task")).toBe("unknown");
      await vi.advanceTimersByTimeAsync(30000);
      expect(work("task")).toBe("ended");
      const reads = f.hostRequest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600000);
      expect(f.hostRequest.mock.calls).toHaveLength(reads);
    } finally {
      f.dispose();
    }
  },
);

it.each([403, 404, 200])(
  "skips a session with a permanent HTTP %s or response error without blocking others",
  async (status) => {
    const f = await fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    f.hostRequest.mockImplementation(async (input) => {
      if (
        input.url.endsWith("/get-agent-turn-status") &&
        JSON.parse(input.body ?? "{}").session_id === "session"
      )
        return { status, headers: {}, body: "{}" };
      return f.respond(input);
    });
    try {
      f.send(
        "turn_started",
        1,
        { triggeringEventIds: [request] },
        "other",
        agent,
        "other-session",
      );
      f.setStatus({ task: "completed", other: "completed" });
      await vi.advanceTimersByTimeAsync(31000);
      expect(f.work()).toBe("unknown");
      expect(
        f.activity.queries
          .snapshot()
          .turns.find((turn) => turn.turnId === "other")?.state,
      ).toBe("ended");
      const reads = f.hostRequest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600000);
      expect(f.hostRequest.mock.calls).toHaveLength(reads);
    } finally {
      f.dispose();
    }
  },
);

it("backs off missing results to a five-minute ceiling without overlapping reads", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const f = await fixture();
  const reads = () =>
    f.hostRequest.mock.calls.filter(([input]) =>
      input.url.endsWith("/get-agent-turn-status"),
    ).length;
  try {
    f.result.resolve(response({}));
    await vi.advanceTimersByTimeAsync(31000);
    expect(reads()).toBe(1);
    for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
      const before = reads();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(reads()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads()).toBe(before + 1);
    }
    const pending = deferred<HostResponse>();
    f.hostRequest.mockImplementationOnce(async () => pending.promise);
    const before = reads();
    await vi.advanceTimersByTimeAsync(300000);
    await vi.advanceTimersByTimeAsync(600000);
    expect(reads()).toBe(before);
    pending.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ status: 1, agents: [] }),
    });
    await vi.advanceTimersByTimeAsync(1);
  } finally {
    f.dispose();
  }
});

it.each(["sign-out", "account-change", "community-change", "clear", "dispose"])(
  "cancels a queued recovery retry after %s",
  async (change) => {
    const f = await fixture();
    try {
      f.result.resolve(response({}));
      await vi.advanceTimersByTimeAsync(31000);
      await f.started.promise;
      if (change === "sign-out") f.session.signOut();
      else if (change === "account-change") await f.changeAccount();
      else if (change === "community-change") f.changeCommunity();
      else if (change === "clear") f.activity.clear();
      else f.activity.dispose();
      const before = f.hostRequest.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600000);
      expect(f.hostRequest.mock.calls).toHaveLength(before);
    } finally {
      f.dispose();
    }
  },
);

it("does not overwrite a live terminal with a delayed readback", async () => {
  const f = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(31000);
    await f.started.promise;
    f.send("turn_completed", 2, { outcome: "completed" });
    f.result.resolve(response({ task: "failed" }));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.work()).toBe("ended");
  } finally {
    f.result.resolve(response({}));
    f.dispose();
  }
});

it.each(["sign-out", "account-change", "community-change", "clear", "dispose"])(
  "ignores a delayed readback after %s",
  async (change) => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(31000);
      await f.started.promise;
      if (change === "sign-out") f.session.signOut();
      else if (change === "account-change") await f.changeAccount();
      else if (change === "community-change") f.changeCommunity();
      else if (change === "clear") f.activity.clear();
      else f.activity.dispose();
      f.result.resolve(response({ task: "failed" }));
      await vi.advanceTimersByTimeAsync(1);
      expect(f.work()).toBe(
        ["sign-out", "account-change", "community-change"].includes(change)
          ? "unknown"
          : undefined,
      );
    } finally {
      f.result.resolve(response({}));
      f.dispose();
    }
  },
);
