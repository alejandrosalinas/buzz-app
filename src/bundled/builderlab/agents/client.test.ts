import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import { createAgentClient } from "./client";

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const row = {
  agent_id: "agent-1",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: "AGENT_STATUS_ACTIVE",
};
const response = (value: unknown, status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});
const viewer = "cd".repeat(32);
const bound = (pubkey_hex = viewer) => response({ identity: { pubkey_hex } });
async function fixture(subject = "user", canUseRemoteAgents = true) {
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject,
        email: "a@example.com",
        canUseRemoteAgents,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => host.request(input) },
  );
  await session.signIn();
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () =>
      response({ status: "LIST_AGENTS_STATUS_SUCCESS", agents: [row] }),
    ),
  };
  const owner = {
    key: vi.fn(async (): Promise<string | null> => viewer),
    signBinding: vi.fn(async () => ({ id: "signed-binding" })),
  };
  return {
    session,
    host,
    owner,
    client: createAgentClient(session, owner),
    retain: vi.fn(),
    signal: new AbortController().signal,
  };
}
it("refuses remote reads and creation before sending requests or retaining replay state", async () => {
  const h = await fixture("user", false);
  await expect(h.client.list(h.signal)).rejects.toThrow(
    "unavailable for this account",
  );
  await expect(h.client.register("Helper", h.signal, h.retain)).rejects.toThrow(
    "unavailable for this account",
  );
  expect(h.host.request).not.toHaveBeenCalled();
  expect(h.retain).not.toHaveBeenCalled();
});
it("reads terminal task status only for the requested task IDs", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(
    response({
      outcomes: {
        done: "completed",
        failed: "failed",
        stopped: "cancelled",
        terminated: "terminated",
      },
    }),
  );
  expect(
    await h.client.turnStatus(
      "session",
      ["done", "failed", "stopped", "terminated"],
      h.signal,
    ),
  ).toEqual(
    new Map([
      ["done", "ended"],
      ["failed", "error"],
      ["stopped", "stopped"],
      ["terminated", "error"],
    ]),
  );
  for (const outcomes of [
    { other: "completed" },
    { done: "new-status" },
    { done: null },
    [],
  ]) {
    vi.mocked(h.host.request).mockResolvedValueOnce(response({ outcomes }));
    await expect(
      h.client.turnStatus("session", ["done"], h.signal),
    ).rejects.toThrow("invalid turn status");
  }
});
it("lists the authenticated account through the configured native host", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(
    response({
      status: 1,
      agents: [{ ...row, agent_instructions: "Review carefully." }],
    }),
  );
  expect(await h.client.list(h.signal)).toEqual([
    {
      id: row.agent_id,
      name: row.agent_name,
      pubkey: row.agent_pubkey,
      status: "Active",
      instructions: "Review carefully.",
    },
  ]);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/list-agents",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ include_instructions: true }),
  });
});
it.each([{}, { agents: [] }])(
  "accepts an empty protobuf list %j",
  async (value) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, ...value }),
    );
    expect(await h.client.list(h.signal)).toEqual([]);
  },
);
it.each([
  ["AGENT_STATUS_UNATTESTED", "Unattested"],
  [1, "Unattested"],
  ["AGENT_STATUS_REVOKED", "Revoked"],
  [3, "Revoked"],
  ["FUTURE_STATUS", "Unknown"],
  [undefined, "Unknown"],
])(
  "handles agent status %j without treating unknown as active",
  async (status, expected) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ status: 1, agents: [{ ...row, status }] }),
    );
    expect((await h.client.list(h.signal))[0]?.status).toBe(expected);
  },
);
it.each([
  null,
  { status: 2 },
  { status: 1, agents: {} },
  { status: 1, agents: [null] },
  { status: 1, agents: [{ ...row, agent_pubkey: "bad" }] },
  { status: 1, agents: [{ ...row, agent_instructions: 42 }] },
])("rejects invalid responses %j", async (value) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response(value));
  await expect(h.client.list(h.signal)).rejects.toThrow(
    /invalid|did not return/,
  );
});
it.each([401, 403, 500])(
  "reports HTTP %s without disclosing the provider body",
  async (status) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(
      response({ error: "private-secret" }, status),
    );
    vi.useFakeTimers();
    let error: unknown;
    try {
      const pending = h.client.list(h.signal).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(7000);
      error = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("private-secret");
    // A 401 refuses only this call: the native session decides when it ends.
    expect(h.session.snapshot().status).toBe("signed-in");
  },
);
it.each(["sign-out", "new-login", "cancel", "dispose"])(
  "discards a held result after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    const started = deferred<void>();
    vi.mocked(h.host.request).mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const controller = new AbortController();
    const pending = h.client.list(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await started.promise;
    try {
      if (action === "cancel") controller.abort();
      else if (action === "dispose") h.session.dispose();
      else {
        h.session.signOut();
        if (action === "new-login") await h.session.signIn();
      }
    } finally {
      held.resolve(
        response(
          { status: 1, agents: [row] },
          action === "new-login" ? 401 : 200,
        ),
      );
    }
    await rejected;
    if (action === "new-login")
      expect(h.session.snapshot().status).toBe("signed-in");
  },
);
it("does not dispatch signed-out or canceled requests", async () => {
  const h = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(h.client.list(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  h.session.signOut();
  await expect(h.client.list(h.signal)).rejects.toThrow("Sign in");
  expect(h.host.request).not.toHaveBeenCalled();
});

const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
const remoteAgent = {
  id: row.agent_id,
  name: row.agent_name,
  pubkey: row.agent_pubkey,
  status: "Active",
} as const;
it("loads the standalone catalog with model-specific effort identifiers", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(
    response({
      models: [
        {
          id: "model-one",
          display_name: "Friendly Model",
          supported_reasoning_efforts: ["none", "max"],
        },
        {
          id: "model-two",
          display_name: "Fast Model",
          supported_reasoning_efforts: ["low"],
          fast: true,
        },
      ],
    }),
  );
  expect(await h.client.modelCatalog(h.signal)).toEqual({
    models: [
      {
        id: "model-one",
        displayName: "Friendly Model",
        supportedReasoningEfforts: ["none", "max"],
        fast: false,
      },
      {
        id: "model-two",
        displayName: "Fast Model",
        supportedReasoningEfforts: ["low"],
        fast: true,
      },
    ],
  });
  expect(vi.mocked(h.host.request).mock.calls[0]?.[0].url).toBe(
    "https://builderlab.example/api/goose/v3/beekeeper/get-model-catalog",
  );
});
it.each([
  [{ model_id: "model-one", reasoning_effort: "max" }, true],
  [{ model_id: "model-one", reasoning_effort: "high" }, false],
  [{ model_id: "missing", reasoning_effort: "max" }, false],
  [{ model_id: "model-one" }, false],
  ["model-one", false],
  [null, false],
])(
  "keeps only a recommendation the catalog offers: %j",
  async (recommended_selection, kept) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValueOnce(
      response({
        models: [
          {
            id: "model-one",
            display_name: "Friendly Model",
            supported_reasoning_efforts: ["none", "max"],
          },
        ],
        recommended_selection,
      }),
    );
    expect((await h.client.modelCatalog(h.signal)).recommended).toEqual(
      kept ? { modelId: "model-one", reasoningEffort: "max" } : undefined,
    );
  },
);
it.each([
  null,
  [null],
  [{ id: "model" }],
  [{ id: "model", display_name: "Model", supported_reasoning_efforts: [""] }],
])("rejects malformed catalog choices: %j", async (models) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(response({ models }));
  if (models === null)
    expect(await h.client.modelCatalog(h.signal)).toEqual({ models: [] });
  else
    await expect(h.client.modelCatalog(h.signal)).rejects.toThrow(
      "invalid model catalog",
    );
});
it.each([
  [1, "valid"],
  ["MODEL_SELECTION_STATUS_SETUP_REQUIRED", "setup-required"],
  [3, "model-unavailable"],
  ["MODEL_SELECTION_STATUS_EFFORT_UNSUPPORTED", "effort-unsupported"],
  [99, "unknown"],
])("reads the saved pair and server validity %s", async (status, expected) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(
    response({
      status: 1,
      agents: [
        {
          ...row,
          model_id: "one",
          reasoning_effort: "max",
          model_selection_status: status,
        },
      ],
    }),
  );
  expect((await h.client.list(h.signal))[0]).toMatchObject({
    modelId: "one",
    reasoningEffort: "max",
    modelSelectionStatus: expected,
  });
});
it("does not treat empty model fields as reset requests", async () => {
  const h = await fixture();
  await expect(
    h.client.updateModel(remoteAgent, "", "high", h.signal),
  ).rejects.toThrow("Choose a model");
  await expect(
    h.client.updateModel(remoteAgent, "one", "", h.signal),
  ).rejects.toThrow("Choose a model");
  expect(h.host.request).not.toHaveBeenCalled();
});
it("replaces instructions verbatim through the authenticated host", async () => {
  const h = await fixture();
  const instructions = "  Review carefully.\nPreserve formatting.\n";
  vi.mocked(h.host.request).mockResolvedValue(response({}));
  await h.client.updateInstructions(remoteAgent, instructions, h.signal);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/update-agent",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_pubkey: row.agent_pubkey,
      agent_instructions: instructions,
    }),
  });
});
it.each([
  { instructions: "", purpose: "empty clearing", accepted: true },
  {
    instructions: "x".repeat(20_000),
    purpose: "maximum length",
    accepted: true,
  },
  { instructions: "   ", purpose: "blank", accepted: false },
  { instructions: "x".repeat(20_001), purpose: "oversized", accepted: false },
])(
  "validates $purpose instructions before dispatch",
  async ({ instructions, accepted }) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(response({}));
    if (accepted) {
      await h.client.updateInstructions(remoteAgent, instructions, h.signal);
      expect(h.host.request).toHaveBeenCalledOnce();
      expect(
        JSON.parse(vi.mocked(h.host.request).mock.calls[0]?.[0].body ?? "{}")
          .agent_instructions,
      ).toBe(instructions);
    } else {
      await expect(
        h.client.updateInstructions(remoteAgent, instructions, h.signal),
      ).rejects.toThrow("Instructions must");
      expect(h.host.request).not.toHaveBeenCalled();
    }
  },
);
it("does not edit inactive agents or invalid identities", async () => {
  const h = await fixture();
  for (const agent of [
    { ...remoteAgent, status: "Unattested" as const },
    { ...remoteAgent, pubkey: "bad" },
  ])
    await expect(
      h.client.updateInstructions(agent, "Review carefully.", h.signal),
    ).rejects.toThrow("Only Active agents");
  expect(h.host.request).not.toHaveBeenCalled();
});
it("deletes through the configured authenticated host", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(
    response({ status: "DELETE_AGENT_STATUS_DELETED" }),
  );
  await h.client.delete(remoteAgent, h.signal);
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/v3/beekeeper/delete-agent",
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: row.agent_id }),
  });
});
it.each([
  [3, undefined],
  ["DELETE_AGENT_STATUS_DISABLED", "disabled"],
  [0, "not confirmed"],
])("handles deletion status %s", async (status, error) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response({ status }));
  const deleting = h.client.delete(remoteAgent, h.signal);
  if (error) await expect(deleting).rejects.toThrow(error);
  else await expect(deleting).resolves.toBeUndefined();
});
const turn = {
  community: "wss://agent.example:4443",
  channelId: "channel-1",
  threadRootId: "root-1",
};
it("asks Builderlab to cancel the agent's turn in one conversation by its community host", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response({ status: 1 }));
  await h.client.cancelTurn(remoteAgent, turn, h.signal);
  expect(h.host.request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://builderlab.example/api/goose/v3/beekeeper/cancel-agent-turn",
      method: "POST",
      body: JSON.stringify({
        agent_id: row.agent_id,
        community: "agent.example:4443",
        channel_id: "channel-1",
        thread_root_event_id: "root-1",
      }),
    }),
  );
});
it.each([
  [1, true],
  ["CANCEL_AGENT_TURN_STATUS_CANCELLING", true],
  [2, false],
  ["CANCEL_AGENT_TURN_STATUS_NOTHING_RUNNING", false],
  [3, false],
  ["CANCEL_AGENT_TURN_STATUS_NOT_FOUND", false],
])(
  "reports whether a turn was running for cancel status %s",
  async (status, running) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValue(response({ status }));
    expect(await h.client.cancelTurn(remoteAgent, turn, h.signal)).toBe(
      running,
    );
  },
);
it.each([
  [{ status: 4, message: "Provider is busy." }, "Provider is busy."],
  [{ status: "CANCEL_AGENT_TURN_STATUS_FAILED" }, "did not stop the agent"],
  [{ status: 0, message: "" }, "did not stop the agent"],
  [{}, "did not stop the agent"],
])("fails to cancel a turn for response %j", async (result, error) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValue(response(result));
  await expect(
    h.client.cancelTurn(remoteAgent, turn, h.signal),
  ).rejects.toThrow(error);
});
it("registers with a saved UUID and submits the supplied owner proof", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(
      response({
        status: "REGISTER_AGENT_STATUS_UNATTESTED",
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    )
    .mockResolvedValueOnce(bound())
    .mockResolvedValueOnce(response({ status: "ATTEST_AGENT_STATUS_ACTIVE" }));
  const agent = await h.client.register(" Helper ", h.signal, h.retain);
  expect(agent).toMatchObject({ name: "Helper", status: "Unattested" });
  const input = vi.mocked(h.host.request).mock.calls[0]?.[0];
  expect(input).toMatchObject({
    url: "https://builderlab.example/api/goose/v3/beekeeper/register-agent",
    method: "POST",
  });
  expect(JSON.parse(input?.body ?? "{}")).toEqual({
    agent_name: "Helper",
    idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  await h.client.activate(agent.pubkey, proof, undefined, h.signal);
  expect(h.host.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: expect.stringContaining("/attest-agent"),
      body: JSON.stringify({
        agent_pubkey: row.agent_pubkey,
        owner_auth_tag_json: JSON.stringify(proof),
      }),
    }),
  );
});
it("registers with a picture and replays it unchanged", async () => {
  const h = await fixture();
  const registered = response({
    status: 1,
    agent_id: row.agent_id,
    agent_pubkey: row.agent_pubkey,
  });
  vi.mocked(h.host.request)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(registered);
  await expect(
    h.client.register("Helper", h.signal, h.retain, "https://a.example/1.png"),
  ).rejects.toThrow("Retry the same name");
  const agent = await h.client.register(
    "Helper",
    h.signal,
    h.retain,
    "https://a.example/2.png",
  );
  // The caller lists the picture Beekeeper actually registered.
  expect(agent.picture).toBe("https://a.example/1.png");
  const bodies = vi
    .mocked(h.host.request)
    .mock.calls.map(([input]) => JSON.parse(input.body ?? "{}"));
  expect(bodies[0]).toEqual({
    agent_name: "Helper",
    agent_picture_url: "https://a.example/1.png",
    idempotency_key: expect.any(String),
  });
  // Beekeeper refuses a replay whose picture differs from the first request.
  expect(bodies[1]).toEqual(bodies[0]);
});
it.each([
  ["https://a.example/1.png", "https://a.example/1.png"],
  [undefined, ""],
])("updates the profile with picture %s", async (picture, sent) => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(response({}));
  await h.client.updateProfile(
    {
      pubkey: row.agent_pubkey,
      community: "wss://agent.example",
      name: " Helper ",
      ...(picture ? { picture } : {}),
    },
    h.signal,
  );
  expect(h.host.request).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: "https://builderlab.example/api/goose/v3/beekeeper/update-agent-profile",
      body: JSON.stringify({
        agent_pubkey: row.agent_pubkey,
        community_url: "wss://agent.example",
        agent_name: "Helper",
        agent_picture_url: sent,
      }),
    }),
  );
});
it("does not update the profile to an invalid name", async () => {
  const h = await fixture();
  await expect(
    h.client.updateProfile(
      { pubkey: row.agent_pubkey, community: "wss://a", name: "bad/name" },
      h.signal,
    ),
  ).rejects.toThrow("agent name");
  expect(h.host.request).not.toHaveBeenCalled();
});
it.each(["network", "server", "malformed", "cancel"])(
  "retains the registration UUID after an uncertain %s result",
  async (failure) => {
    const h = await fixture();
    const controller = new AbortController();
    vi.mocked(h.host.request).mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("private transport details");
      if (failure === "cancel") controller.abort();
      return failure === "server" ? response({}, 503) : response({});
    });
    await expect(
      h.client.register("Helper", controller.signal, h.retain),
    ).rejects.toThrow();
    vi.mocked(h.host.request).mockResolvedValueOnce(
      response({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    );
    // A fresh consumer after navigation/restart reuses the persisted intent.
    await createAgentClient(h.session).register("Helper", h.signal, h.retain);
    const bodies = vi
      .mocked(h.host.request)
      .mock.calls.map(([input]) => JSON.parse(input.body ?? "{}"));
    expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
  },
);
it("does not reuse a pending creation for another verified account with the same email", async () => {
  const first = await fixture("account-a");
  vi.mocked(first.host.request).mockRejectedValueOnce(new Error("offline"));
  await expect(
    first.client.register("Helper", first.signal, first.retain),
  ).rejects.toThrow("Retry the same name");
  first.session.signOut();
  const second = await fixture("account-b");
  vi.mocked(second.host.request).mockResolvedValueOnce(
    response({
      status: 1,
      agent_id: row.agent_id,
      agent_pubkey: row.agent_pubkey,
    }),
  );
  await second.client.register("Helper", second.signal, second.retain);
  const oldBody = JSON.parse(
    vi.mocked(first.host.request).mock.calls[0]?.[0].body ?? "{}",
  );
  const newBody = JSON.parse(
    vi.mocked(second.host.request).mock.calls[0]?.[0].body ?? "{}",
  );
  expect(newBody.idempotency_key).not.toBe(oldBody.idempotency_key);
});
it.each([2, 3, 4, 5, "REGISTER_AGENT_STATUS_TOO_MANY_AGENTS"])(
  "reports a terminal registration status %s and allows a fresh retry",
  async (status) => {
    const h = await fixture();
    vi.mocked(h.host.request).mockResolvedValueOnce(response({ status }));
    await expect(
      h.client.register("Helper", h.signal, h.retain),
    ).rejects.toThrow(/disabled|setup|limit|conflicts/);
    vi.mocked(h.host.request).mockResolvedValueOnce(
      response({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    );
    await h.client.register("Helper", h.signal, h.retain);
    const bodies = vi
      .mocked(h.host.request)
      .mock.calls.map(([input]) => JSON.parse(input.body ?? "{}"));
    expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key);
  },
);
it.each(["", "bad/name", "x".repeat(65)])(
  "does not register invalid name %s",
  async (name) => {
    const h = await fixture();
    await expect(h.client.register(name, h.signal, h.retain)).rejects.toThrow(
      "agent name",
    );
    expect(h.host.request).not.toHaveBeenCalled();
  },
);
it("blocks creation when the intent cannot be stored", async () => {
  const h = await fixture();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("full");
    },
  });
  await expect(h.client.register("Helper", h.signal, h.retain)).rejects.toThrow(
    "Could not save",
  );
  expect(h.host.request).not.toHaveBeenCalled();
});
const challenge = {
  challenge_id: "550e8400-e29b-41d4-a716-446655440000",
  nonce: "n".repeat(43),
  verification_code: "123456",
  origin: "https://builderlab.example",
  expires_at: "2999-01-01T00:00:00Z",
};
it("links an unbound Buzz key to the account before attesting", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(
      response({ error: { code: "missing_mapping", setup_needed: true } }, 404),
    )
    .mockResolvedValueOnce(response({ ...challenge, kind: 24243 }))
    .mockResolvedValueOnce(bound())
    .mockResolvedValueOnce(response({ status: "ATTEST_AGENT_STATUS_ACTIVE" }));
  await h.client.activate(row.agent_pubkey, proof, undefined, h.signal);
  const calls = vi.mocked(h.host.request).mock.calls.map(([input]) => input);
  expect(calls.map((input) => input.url)).toEqual([
    "https://builderlab.example/api/goose/v1/buzz/nostr-identities/current",
    "https://builderlab.example/api/goose/v1/buzz/nostr-identities/challenge",
    "https://builderlab.example/api/goose/v1/buzz/nostr-identities/verify",
    "https://builderlab.example/api/goose/v3/beekeeper/attest-agent",
  ]);
  expect(calls[1]?.headers).toEqual({
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://builderlab.example",
  });
  expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
    origin: "https://builderlab.example",
  });
  expect(h.owner.signBinding).toHaveBeenCalledWith(challenge);
  expect(JSON.parse(calls[2]?.body ?? "")).toEqual({
    challenge_id: challenge.challenge_id,
    nonce: challenge.nonce,
    signed_payload: JSON.stringify({ id: "signed-binding" }),
  });
});
it("skips linking when this key is already bound", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(bound(viewer.toUpperCase()))
    .mockResolvedValueOnce(response({ status: 1 }));
  await h.client.activate(row.agent_pubkey, proof, undefined, h.signal);
  expect(h.host.request).toHaveBeenCalledTimes(2);
  expect(h.owner.signBinding).not.toHaveBeenCalled();
});
it.each([
  [
    "another key is bound to the account",
    [bound("ab".repeat(32))],
    "linked to a different Buzz identity",
  ],
  [
    "the key is bound to another account",
    [
      response({ correlation_id: "c" }),
      response(challenge),
      response({ error: { code: "pubkey_already_bound" } }, 409),
    ],
    "linked to a different Builderlab account",
  ],
  [
    "the origin is refused",
    [
      response({ correlation_id: "c" }),
      response({ error: { code: "invalid_origin" } }, 403),
    ],
    "(invalid_origin)",
  ],
])("refuses to attest when %s", async (_, replies, message) => {
  const h = await fixture();
  for (const reply of replies)
    vi.mocked(h.host.request).mockResolvedValueOnce(reply);
  await expect(
    h.client.activate(row.agent_pubkey, proof, undefined, h.signal),
  ).rejects.toThrow(message);
  expect(
    vi
      .mocked(h.host.request)
      .mock.calls.some(([input]) => input.url.endsWith("/attest-agent")),
  ).toBe(false);
});
it("refuses to link without a local Buzz identity", async () => {
  const h = await fixture();
  h.owner.key.mockResolvedValueOnce(null);
  await expect(h.client.link(h.signal)).rejects.toThrow(
    "Set up your Buzz identity",
  );
  expect(h.host.request).not.toHaveBeenCalled();
});
it("refuses activation, keeping the session, when the identity check finds it expired", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(response({}, 401));
  await expect(
    h.client.activate(row.agent_pubkey, proof, undefined, h.signal),
  ).rejects.toThrow("session expired");
  expect(h.session.snapshot().status).toBe("signed-in");
  expect(h.host.request).toHaveBeenCalledTimes(1);
});
it("attests without linking when there is no native identity", async () => {
  const h = await fixture();
  vi.mocked(h.host.request).mockResolvedValueOnce(response({ status: 1 }));
  await createAgentClient(h.session, null).activate(
    row.agent_pubkey,
    proof,
    undefined,
    h.signal,
  );
  expect(h.host.request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(h.host.request).mock.calls[0]?.[0].url).toMatch(
    /\/attest-agent$/,
  );
});
it("does not verify a binding signed under a replaced session", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(response({ correlation_id: "c" }))
    .mockResolvedValueOnce(response(challenge));
  h.owner.signBinding.mockImplementationOnce(async () => {
    h.session.signOut();
    return { id: "signed-binding" };
  });
  await expect(h.client.link(h.signal)).rejects.toThrow("session changed");
  expect(h.host.request).toHaveBeenCalledTimes(2);
});
it("names the attest status when setup is not confirmed", async () => {
  const h = await fixture();
  vi.mocked(h.host.request)
    .mockResolvedValueOnce(bound())
    .mockResolvedValueOnce(
      response({ status: "ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND" }),
    );
  await expect(
    h.client.activate(row.agent_pubkey, proof, undefined, h.signal),
  ).rejects.toThrow(
    "Agent setup was not confirmed (ATTEST_AGENT_STATUS_NO_OWNER_IDENTITY_BOUND).",
  );
});
it("shares one binding attempt between overlapping links", async () => {
  const h = await fixture();
  const current = deferred<HostResponse>();
  vi.mocked(h.host.request)
    .mockImplementationOnce(() => current.promise)
    .mockResolvedValueOnce(response({ status: 1 }));
  const signIn = h.client.link(h.signal);
  const activation = h.client.activate(
    row.agent_pubkey,
    proof,
    undefined,
    h.signal,
  );
  current.resolve(bound());
  await Promise.all([signIn, activation]);
  expect(
    vi
      .mocked(h.host.request)
      .mock.calls.map(([input]) => input.url.split("/").at(-1)),
  ).toEqual(["current", "attest-agent"]);
});

it.each(["network", "429"])(
  "quietly recovers read-only Builderlab discovery after %s",
  async (failure) => {
    const h = await fixture();
    vi.useFakeTimers();
    try {
      const request = vi.mocked(h.host.request);
      if (failure === "network")
        request.mockRejectedValueOnce(new Error("offline"));
      else request.mockResolvedValueOnce(response({}, Number(failure)));
      const pending = h.client.list(h.signal);
      await vi.advanceTimersByTimeAsync(499);
      expect(request).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(501);
      expect(await pending).toHaveLength(1);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("does not replay a Builderlab mutation after a transport failure", async () => {
  const h = await fixture();
  vi.useFakeTimers();
  try {
    const request = vi
      .mocked(h.host.request)
      .mockRejectedValue(new Error("offline"));
    await expect(h.client.delete({ id: "agent-1" }, h.signal)).rejects.toThrow(
      "Could not reach Builderlab",
    );
    await vi.advanceTimersByTimeAsync(7000);
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("exhausts Builderlab reads once and cancels the same backoff on account change", async () => {
  const h = await fixture();
  vi.useFakeTimers();
  try {
    const request = vi
      .mocked(h.host.request)
      .mockResolvedValue(response({}, 503));
    const rejected = expect(h.client.list(h.signal)).rejects.toThrow(
      "HTTP 503",
    );
    await vi.advanceTimersByTimeAsync(7000);
    await rejected;
    expect(request).toHaveBeenCalledTimes(4);
    const pending = h.client.list(h.signal);
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    h.session.signOut();
    await vi.advanceTimersByTimeAsync(1000);
    await cancelled;
    expect(request).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});
