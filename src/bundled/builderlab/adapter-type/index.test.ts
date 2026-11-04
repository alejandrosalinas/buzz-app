import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import type { RelayData } from "../../../features/relay/service";
import { createOAuthSession } from "../oauth/session";
import { builderlabType } from "./index";

const pubkey = "ab".repeat(32);
const relay = {
  snapshot: () => ({ status: "disconnected", generation: 0 }),
  subscribe: () => () => {},
} as unknown as RelayData;
const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
const config = {
  instructions: "",
  modelId: "one",
  reasoningEffort: "high",
  subject: "account-a",
};
const response = (value: unknown): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(value),
});
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

async function fixture(subject = "account-a") {
  const session = createOAuthSession(
    async () => ({
      value: "credential",
      account: {
        subject,
        email: "a@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => host.request(input) },
  );
  await session.signIn();
  const request = vi.fn<Host["request"]>();
  const host: Host = {
    runCommand: vi.fn(),
    request: async (input) =>
      input.url.endsWith("/get-model-catalog")
        ? response({
            models: [
              {
                id: "one",
                display_name: "One",
                supported_reasoning_efforts: ["high"],
              },
            ],
          })
        : request(input),
  };
  const client = createAgentClient(session);
  const type = builderlabType(client, session, relay);
  if (!type.remote) throw new Error("Missing hosted adapter");
  return {
    request,
    session,
    client,
    type,
    remote: type.remote,
    bodies: () =>
      request.mock.calls.map(([input]) => JSON.parse(input.body ?? "{}")),
  };
}
const provision = {
  name: "Helper",
  community: "wss://agent.example",
  config,
  signal: new AbortController().signal,
};
const registration = {
  status: 1,
  agent_id: "provider-id",
  agent_pubkey: pubkey,
};
const removal = {
  pubkey,
  community: provision.community,
  signal: provision.signal,
};

it("replays deletion across restart and releases unfinished provisioning only after confirmed removal", async () => {
  const first = await fixture();
  first.request.mockResolvedValueOnce(response(registration));
  await first.remote.provision(provision);
  const firstKey = first.bodies()[0]?.idempotency_key;
  first.session.dispose();

  const restarted = await fixture();
  restarted.request.mockRejectedValueOnce(new Error("offline"));
  await expect(restarted.remote.remove(removal)).rejects.toThrow(
    "Could not reach",
  );
  restarted.request.mockResolvedValueOnce(response(registration));
  await restarted.remote.provision(provision);
  expect(restarted.bodies()[1]?.idempotency_key).toBe(firstKey);
  restarted.request.mockResolvedValue(response({ status: 3 }));
  await restarted.remote.remove(removal);
  await restarted.remote.remove(removal);
  const deletes = restarted.request.mock.calls.slice(2);
  expect(deletes).toHaveLength(2);
  for (const [input] of deletes)
    expect(JSON.parse(input.body ?? "{}")).toEqual({ agent_id: "provider-id" });
  restarted.request.mockResolvedValueOnce(response(registration));
  await restarted.remote.provision(provision);
  expect(restarted.bodies().at(-1)?.idempotency_key).not.toBe(firstKey);
});

it("rejects missing, unsupported, and different-account creation settings before registering", async () => {
  const h = await fixture();
  for (const selection of [
    undefined,
    { ...config, reasoningEffort: "low" },
    { ...config, subject: "other" },
  ])
    await expect(
      h.remote.provision({ ...provision, config: selection }),
    ).rejects.toThrow();
  expect(h.request).not.toHaveBeenCalled();
});

it("saves all creation settings only after attestation and propagates a failed save", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response(registration));
  await h.remote.provision(provision);
  h.request.mockResolvedValueOnce(response({ status: 1 }));
  h.request.mockRejectedValueOnce(new Error("offline"));
  await expect(
    h.remote.activate({ ...provision, pubkey, auth: proof }),
  ).rejects.toThrow("Could not reach");
  expect(
    h.request.mock.calls.map(([input]) => input.url.split("/").at(-1)),
  ).toEqual(["register-agent", "attest-agent", "update-agent"]);
  expect(h.bodies().at(-1)).toEqual({
    agent_pubkey: pubkey,
    agent_instructions: "",
    model_id: "one",
    reasoning_effort: "high",
  });
  h.request.mockResolvedValueOnce(response({ status: 2 }));
  await expect(
    h.remote.activate({ ...provision, pubkey, auth: proof }),
  ).rejects.toThrow("setup was not confirmed");
  expect(
    h.request.mock.calls.filter(([input]) =>
      input.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(1);
});

it.each(["account", "server"])(
  "refuses activation and deletion through a different %s",
  async (changed) => {
    const first = await fixture();
    first.request.mockResolvedValueOnce(response(registration));
    await first.remote.provision(provision);
    first.session.dispose();
    if (changed === "server")
      vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://other.example");
    const other = await fixture(
      changed === "account" ? "account-b" : "account-a",
    );
    await expect(
      other.remote.activate({ ...provision, pubkey, auth: proof }),
    ).rejects.toThrow("account that created");
    other.session.signOut();
    await expect(other.remote.remove(removal)).rejects.toThrow(
      "account that created",
    );
    expect(other.request).not.toHaveBeenCalled();
  },
);

it("looks up an agent from another device and retains its ID before a failed deletion", async () => {
  const h = await fixture();
  h.request
    .mockResolvedValueOnce(
      response({
        status: 1,
        agents: [
          {
            agent_id: "provider-id",
            agent_pubkey: pubkey,
            agent_name: "Helper",
            status: 2,
          },
        ],
      }),
    )
    .mockRejectedValueOnce(new Error("connection lost"));
  await expect(h.remote.remove(removal)).rejects.toThrow("Could not reach");
  const again = builderlabType(h.client, h.session, relay).remote;
  if (!again) throw new Error("Missing hosted adapter");
  h.request.mockResolvedValueOnce(response({ status: 3 }));
  await again.remove(removal);
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      body: JSON.stringify({ agent_id: "provider-id" }),
    }),
  );
});

it("does not infer provider deletion from absence in an unrecognized account", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response({ status: 1, agents: [] }));
  await expect(h.remote.remove(removal)).rejects.toThrow(
    "not found in this Builderlab account",
  );
  expect(h.request).toHaveBeenCalledOnce();
});

const place = {
  community: "wss://agent.example",
  channelId: "channel-1",
  threadRootId: "root-1",
};
const interruption = { pubkey, ...place, signal: provision.signal };
const listing = response({
  status: 1,
  agents: [
    {
      agent_id: "provider-id",
      agent_pubkey: pubkey,
      agent_name: "Helper",
      status: 2,
    },
  ],
});

it("stops a turn with the agent ID saved when it was provisioned", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response(registration));
  await h.remote.provision(provision);
  h.request.mockResolvedValueOnce(response({ status: 1 }));
  expect(await h.remote.interrupt?.(interruption)).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: expect.stringContaining("/cancel-agent-turn"),
      body: JSON.stringify({
        agent_id: "provider-id",
        community: "agent.example",
        channel_id: "channel-1",
        thread_root_event_id: "root-1",
      }),
    }),
  );
});

it("looks up an agent from another device to stop its turn", async () => {
  const h = await fixture();
  h.request
    .mockResolvedValueOnce(listing)
    .mockResolvedValueOnce(response({ status: 2 }));
  expect(await h.remote.interrupt?.(interruption)).toBe(false);
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.bodies()[1]).toMatchObject({ agent_id: "provider-id" });
  // The ID is remembered, so a second stop needs no lookup.
  h.request.mockResolvedValueOnce(response({ status: 1 }));
  expect(await h.remote.interrupt?.(interruption)).toBe(true);
  expect(h.request).toHaveBeenCalledTimes(3);
});

it("does not stop a turn for an agent outside the signed-in account", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response({ status: 1, agents: [] }));
  await expect(h.remote.interrupt?.(interruption)).rejects.toThrow(
    "not found in this Builderlab account",
  );
  expect(h.request).toHaveBeenCalledOnce();
});

it("rejects a stop at once when signed out, without signing in or reaching Builderlab", async () => {
  const acquire = vi.fn(async () => ({
    value: "credential",
    account: {
      subject: "account-a",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const session = createOAuthSession(acquire, undefined, {
    request: (input) => request(input),
  });
  const request = vi.fn<Host["request"]>();
  const client = createAgentClient(session);
  const remote = builderlabType(client, session, relay).remote;
  if (!remote?.interrupt) throw new Error("Missing hosted adapter");
  await expect(remote.interrupt(interruption)).rejects.toThrow(
    "Sign in to Builderlab first.",
  );
  expect(acquire).not.toHaveBeenCalled();
  expect(session.snapshot().status).toBe("signed-out");
  expect(request).not.toHaveBeenCalled();
});

it.each([config, undefined])(
  "signs in to finish setup after a restart signed it out (config %o)",
  async (saved) => {
    const first = await fixture();
    first.request.mockResolvedValueOnce(response(registration));
    await first.remote.provision(provision);
    first.session.signOut();
    first.request.mockResolvedValue(response({ status: 1 }));
    await first.remote.activate({
      ...provision,
      config: saved,
      pubkey,
      auth: proof,
    });
    expect(first.session.snapshot().status).toBe("signed-in");
    expect(first.bodies()[1]).toMatchObject({ agent_pubkey: pubkey });
  },
);

it("supplies the Settings and Activity tabs", async () => {
  const { type } = await fixture();
  expect(type.tabs?.map(({ title, role }) => [title, role])).toEqual([
    ["Settings", "settings"],
    ["Activity", "activity"],
  ]);
});

it("sends the picture when provisioning and publishes profile changes through Beekeeper", async () => {
  const h = await fixture();
  const picture = "https://example.test/sky.png";
  h.request
    .mockResolvedValueOnce(response(registration))
    .mockResolvedValueOnce(response({}));
  await expect(h.remote.provision({ ...provision, picture })).resolves.toEqual({
    pubkey,
    picture,
  });
  expect(h.bodies()[0]).toMatchObject({ agent_picture_url: picture });
  await h.remote.profile({
    pubkey,
    community: provision.community,
    name: "Sea",
    signal: provision.signal,
  });
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: expect.stringContaining("/update-agent-profile"),
      body: JSON.stringify({
        agent_pubkey: pubkey,
        community_url: provision.community,
        agent_name: "Sea",
        agent_picture_url: "",
      }),
    }),
  );
});

const withInstructions = (instructions: string, status = 2) =>
  response({
    status: 1,
    agents: [
      {
        agent_id: "provider-id",
        agent_pubkey: pubkey,
        agent_name: "Helper",
        status,
        agent_instructions: instructions,
      },
    ],
  });
const edit = {
  pubkey,
  community: provision.community,
  signal: provision.signal,
};

it("reads a hosted agent's instructions from the account's listing", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(withInstructions("Be brief."));
  expect(await h.remote.instructions?.get(edit)).toBe("Be brief.");
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({ url: expect.stringContaining("/list-agents") }),
  );
  h.request.mockResolvedValueOnce(listing);
  expect(await h.remote.instructions?.get(edit)).toBe("");
});

it("replaces a hosted agent's instructions with the provider's update", async () => {
  const h = await fixture();
  h.request
    .mockResolvedValueOnce(withInstructions("Be brief."))
    .mockResolvedValueOnce(response({ status: 1 }));
  await h.remote.instructions?.set({ ...edit, instructions: "Be kind." });
  expect(h.bodies()[1]).toEqual({
    agent_pubkey: pubkey,
    agent_instructions: "Be kind.",
  });
  expect(h.request).toHaveBeenLastCalledWith(
    expect.objectContaining({ url: expect.stringContaining("/update-agent") }),
  );
});

it("never starts browser login to read or replace a hosted agent's instructions", async () => {
  const h = await fixture();
  h.session.signOut();
  const acquire = vi.spyOn(h.session, "ensureSignedIn");
  await expect(h.remote.instructions?.get(edit)).rejects.toThrow(
    "Sign in to Builderlab first.",
  );
  await expect(
    h.remote.instructions?.set({ ...edit, instructions: "Be kind." }),
  ).rejects.toThrow("Sign in to Builderlab first.");
  expect(acquire).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
});

it("refuses instructions the provider cannot take, and an agent it does not list", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(withInstructions("Be brief."));
  await expect(
    h.remote.instructions?.set({ ...edit, instructions: "x".repeat(20_001) }),
  ).rejects.toThrow("up to 20000 characters");
  // Only Active agents take an edit, as in Builderlab's own settings.
  h.request.mockResolvedValueOnce(withInstructions("Be brief.", 1));
  await expect(
    h.remote.instructions?.set({ ...edit, instructions: "Be kind." }),
  ).rejects.toThrow("Only Active agents");
  h.request.mockResolvedValueOnce(response({ status: 1 }));
  await expect(h.remote.instructions?.get(edit)).rejects.toThrow(
    "Agent not found in this Builderlab account.",
  );
});
