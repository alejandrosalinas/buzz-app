import { describe, expect, it, vi } from "vitest";
import type { Spawn } from "./goose";
import { fakeSpawn, flush } from "./goose-testing";
import { explainTurn, GooseSetup, keyLabel, modelFilter } from "./setup";
import manifest from "./manifest.json";

it("declares protected file reads through the bundled helper with a positional path", () => {
  expect(
    manifest.host.processes.find((process) => process.id === "read-protected"),
  ).toEqual({
    id: "read-protected",
    program: "buzz-agent-command",
    bundled: true,
    args: [
      "--shell",
      `case "$1" in "~/"*) set -- "$HOME/\${1:2}";; esac; exec /usr/bin/base64 -i "$1"`,
      "buzz-read",
    ],
  });
});

const ANTHROPIC = {
  providerId: "anthropic",
  providerName: "Anthropic",
  description: "Claude models",
  defaultModel: "claude-sonnet-5-5",
  configured: false,
  visibleInSetup: true,
  configKeys: [
    { name: "ANTHROPIC_API_KEY", required: true, secret: true },
    {
      name: "ANTHROPIC_HOST",
      required: false,
      secret: false,
      default: "https://api.anthropic.com",
    },
  ],
  setupSteps: ["Create a key at console.anthropic.com"],
  models: [
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", recommended: true },
  ],
};

const PROVIDERS = [
  ANTHROPIC,
  {
    providerId: "ollama",
    providerName: "Ollama",
    defaultModel: "qwen3",
    configured: true,
    visibleInSetup: true,
    configKeys: [{ name: "OLLAMA_HOST", required: true, secret: false }],
  },
  {
    providerId: "databricks",
    providerName: "Databricks",
    configured: false,
    visibleInSetup: true,
    configKeys: [
      { name: "DATABRICKS_HOST", required: true, secret: false },
      {
        name: "DATABRICKS_TOKEN",
        required: false,
        secret: true,
        oauthFlow: true,
      },
    ],
  },
  { providerId: "hidden", providerName: "Hidden", visibleInSetup: false },
  {
    providerId: "old",
    providerName: "Old",
    visibleInSetup: true,
    deprecated: true,
  },
  {
    providerId: "claude-acp",
    providerName: "Claude Code",
    visibleInSetup: true,
    acp: true,
  },
];

const setup = (options: Parameters<typeof fakeSpawn>[0] = {}) => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "ollama", modelId: "qwen3" },
    ...options,
  });
  return { fake, setup: new GooseSetup(fake) };
};

describe("GooseSetup", () => {
  it.each([false, true])(
    "waits for the protected review worker to exit after completion (failure: %s)",
    async (fails) => {
      const { fake, setup: goose } = setup();
      let killed!: () => void;
      const killing = new Promise<void>((resolve) => {
        killed = resolve;
      });
      const kill = vi.fn(async () => killed());
      const spawn = async (options: Parameters<typeof fake.spawn>[1]) => {
        const process = await fake.spawn("goose", options);
        return {
          ...process,
          kill,
          write: async (data: string) => {
            const request = JSON.parse(data);
            if (request.method !== "_buzz/security/review")
              return process.write(data);
            expect(request.params).toEqual({
              provider: "ollama",
              id: "qwen3",
              prompt: {
                system: `Review\n\nReply with only JSON that matches this JSON Schema, and no other text:\n${JSON.stringify({ type: "object", required: ["decision"] })}`,
                input: "Evidence",
              },
            });
            options?.onStdout?.(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                ...(fails
                  ? { error: { code: -32603, message: "Review failed" } }
                  : { result: { text: "Approved", model: { id: "qwen3" } } }),
              })}\n`,
            );
          },
        };
      };
      let settled = false;
      const model = { runtime: "buzz.goose", provider: "ollama", id: "qwen3" };
      const result = goose
        .review(
          model,
          {
            system: "Review",
            input: "Evidence",
            outputSchema: { type: "object", required: ["decision"] },
          },
          new AbortController().signal,
          spawn,
        )
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            throw error;
          },
        );
      const outcome = fails
        ? expect(result).rejects.toThrow("Review failed")
        : expect(result).resolves.toMatchObject({ text: "Approved" });
      try {
        await killing;
        await flush();
        expect(kill).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
      } finally {
        fake.geese[0]?.exit(null);
        await outcome;
      }
      expect(settled).toBe(true);
    },
  );

  it("refuses model review without a protection-plugin worker", async () => {
    const { fake, setup: goose } = setup();
    expect(() =>
      goose.review(
        { provider: "ollama", id: "qwen3" },
        { system: "Review", input: "Evidence" },
        new AbortController().signal,
      ),
    ).toThrow("Protected Goose review worker is unavailable");
    expect(fake.geese).toHaveLength(0);
  });

  /** A protected spawn whose goose answers `_buzz/security/review`, with what
   * each review asked. */
  const reviewing = (fake: ReturnType<typeof fakeSpawn>) => {
    const asked: unknown[] = [];
    const spawn = async (options: Parameters<typeof fake.spawn>[1]) => {
      const process = await fake.spawn("goose", options);
      return {
        ...process,
        write: async (data: string) => {
          const request = JSON.parse(data);
          if (request.method !== "_buzz/security/review")
            return process.write(data);
          asked.push(request.params);
          options?.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "Approved", model: {} } })}\n`,
          );
        },
      };
    };
    return { asked, spawn };
  };
  const PROMPT = { system: "Review", input: "Evidence" };

  it.each(["github_copilot", "codex", "cursor-agent"])(
    "refuses a review on %s before starting a worker",
    (provider) => {
      const { fake, setup: goose } = setup();
      expect(() =>
        goose.review(
          { provider, id: "model" },
          PROMPT,
          new AbortController().signal,
          reviewing(fake).spawn,
        ),
      ).toThrow(`Goose reviews cannot use ${provider}`);
      expect(fake.geese).toHaveLength(0);
    },
  );

  it.each([
    ["", { providerId: "ollama", modelId: "qwen3" }, "qwen3"],
    ["chosen", { providerId: "ollama", modelId: "qwen3" }, "chosen"],
  ])(
    "reviews an unnamed provider on goose's default, read in the review worker (model %j)",
    async (id, defaults, sent) => {
      const { fake, setup: goose } = setup({ defaults });
      const { asked, spawn } = reviewing(fake);
      await expect(
        goose.review({ id }, PROMPT, new AbortController().signal, spawn),
      ).resolves.toMatchObject({ text: "Approved" });
      expect(asked).toEqual([
        expect.objectContaining({ provider: "ollama", id: sent }),
      ]);
      expect(fake.geese).toHaveLength(1);
    },
  );

  it.each([
    [
      { providerId: "github_copilot", modelId: "gpt-5" },
      "cannot use github_copilot",
    ],
    [{ providerId: "ollama" }, "no default provider and model"],
    [{}, "no default provider and model"],
  ])(
    "refuses an unnamed provider when goose's default is %j",
    async (defaults, message) => {
      const { fake, setup: goose } = setup({ defaults });
      const { asked, spawn } = reviewing(fake);
      await expect(
        goose.review({ id: "" }, PROMPT, new AbortController().signal, spawn),
      ).rejects.toThrow(message);
      expect(asked).toEqual([]);
      expect(fake.geese[0]?.killed).toBe(true);
    },
  );

  it("cancels a protected review: kills the worker, waits for its exit, then rejects", async () => {
    const { fake, setup: goose } = setup({ silent: ["_buzz/security/review"] });
    const kill = vi.fn(async () => undefined);
    const spawn = async (options: Parameters<typeof fake.spawn>[1]) => ({
      ...(await fake.spawn("goose", options)),
      kill,
    });
    const controller = new AbortController();
    let settled = false;
    const result = goose
      .review(
        { provider: "ollama", id: "qwen3" },
        PROMPT,
        controller.signal,
        spawn,
      )
      .finally(() => {
        settled = true;
      });
    const outcome = expect(result).rejects.toThrow("goose exited");
    await vi.waitFor(() =>
      expect(
        fake.geese[0]?.received.some(
          (message) => message.method === "_buzz/security/review",
        ),
      ).toBe(true),
    );
    try {
      controller.abort();
      expect(kill).toHaveBeenCalled();
      await flush();
      expect(settled).toBe(false);
    } finally {
      fake.geese[0]?.exit(null);
      await outcome;
    }
    expect(settled).toBe(true);
  });

  it("stops a protected review that passes its deadline", async () => {
    vi.useFakeTimers();
    try {
      const { fake, setup: goose } = setup({
        silent: ["_buzz/security/review"],
      });
      let settled = false;
      const result = goose
        .review(
          { provider: "ollama", id: "qwen3" },
          PROMPT,
          new AbortController().signal,
          (options) => fake.spawn("goose", options),
        )
        .finally(() => {
          settled = true;
        });
      const outcome = expect(result).rejects.toThrow(
        "goose did not answer _buzz/security/review",
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fake.geese[0]?.received.some(
          (message) => message.method === "_buzz/security/review",
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(64_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(fake.geese[0]?.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists the providers set up here, by name, with goose's defaults", async () => {
    const { fake, setup: goose } = setup();
    const listed = await goose.providers();
    expect(listed.providers.map((item) => item.id)).toEqual([
      "anthropic",
      "databricks",
      "ollama",
    ]);
    expect(listed.defaults).toEqual({ provider: "ollama", model: "qwen3" });
    expect(listed.providers[0]).toMatchObject({
      name: "Anthropic",
      defaultModel: "claude-sonnet-5-5",
      signsIn: false,
      steps: ["Create a key at console.anthropic.com"],
      models: [
        { id: "claude-opus-5-5", label: "claude-opus-5-5" },
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5" },
      ],
    });
    expect(fake.geese.every((goose) => goose.killed)).toBe(true);
    await goose.providers();
    expect(fake.geese).toHaveLength(1);
  });

  it.each([
    ["providers", "_goose/unstable/providers/list"],
    ["defaults", "_goose/unstable/defaults/read"],
    ["models", "_goose/unstable/providers/supported-models/list"],
  ])(
    "gives up on a %s lookup goose never answers, and reads again next time",
    async (_, method) => {
      vi.useFakeTimers();
      try {
        const silent = [method];
        const { fake, setup: goose } = setup({ silent, supported: ["qwen3"] });
        const read = () =>
          method.includes("supported")
            ? goose.models("ollama")
            : goose.providers();
        const stuck = read();
        const failed = expect(stuck).rejects.toThrow(
          `goose did not answer ${method}`,
        );
        await vi.advanceTimersByTimeAsync(60_000);
        await failed;
        expect(fake.geese.every((goose) => goose.killed)).toBe(true);
        silent.length = 0;
        const again = read();
        await vi.advanceTimersByTimeAsync(0);
        await expect(again).resolves.toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["session/new", "session/set_config_option"])(
    "gives up on a %s level lookup goose never answers, and reads again next time",
    async (method) => {
      vi.useFakeTimers();
      try {
        const silent = [method];
        const { fake, setup: goose } = setup({
          silent,
          thinking: { "claude-haiku-5-5": { current: "off", levels: ["off"] } },
        });
        const read = () =>
          goose.efforts({ provider: "anthropic", model: "claude-haiku-5-5" });
        const failed = expect(read()).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(60_000);
        await failed;
        expect(fake.geese[0]?.killed).toBe(true);
        silent.length = 0;
        const again = read();
        await vi.advanceTimersByTimeAsync(0);
        await expect(again).resolves.toEqual({
          current: "off",
          levels: ["off"],
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps the levels it read when goose never answers their session's delete, and reads others next time", async () => {
    vi.useFakeTimers();
    try {
      const silent = ["session/delete"];
      const { fake, setup: goose } = setup({
        silent,
        thinking: {
          "claude-haiku-5-5": { current: "off", levels: ["off"] },
          "claude-opus-5-5": { current: "high", levels: ["high"] },
        },
      });
      const stuck = goose.efforts({
        provider: "anthropic",
        model: "claude-haiku-5-5",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(stuck).resolves.toEqual({ current: "off", levels: ["off"] });
      expect(fake.geese[0]?.killed).toBe(true);
      silent.length = 0;
      const again = goose.efforts({
        provider: "anthropic",
        model: "claude-opus-5-5",
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(again).resolves.toEqual({
        current: "high",
        levels: ["high"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a provider that signs in to goose", async () => {
    const { setup: goose } = setup();
    const databricks = (await goose.providers()).providers.find(
      (item) => item.id === "databricks",
    );
    expect(databricks?.signsIn).toBe(true);
    expect(databricks?.keys.map((key) => key.name)).toEqual([
      "DATABRICKS_HOST",
    ]);
  });

  it("lists a set-up provider's models from its API when goose has none", async () => {
    const { setup: goose } = setup({ supported: ["qwen3", "llama4"] });
    expect(await goose.models("ollama")).toEqual([
      { id: "qwen3", label: "qwen3" },
      { id: "llama4", label: "llama4" },
    ]);
    expect(await goose.models("hidden")).toEqual([]);
  });

  it("offers no catalog models for a provider that is not set up, and says what it needs", async () => {
    const saved = new Map<string, Set<string>>();
    const { setup: goose } = setup({
      saved,
      supported: ["databricks-gpt-6-luna"],
    });
    await expect(goose.models("databricks")).rejects.toThrow(
      "Databricks isn't set up in goose. Add Host (DATABRICKS_HOST) in Edit configuration, or run goose configure.",
    );
    // `goose configure` sets it up meanwhile; a fresh read finds its models.
    saved.set("databricks", new Set(["DATABRICKS_HOST"]));
    await goose.check();
    expect(await goose.models("databricks")).toEqual([
      { id: "databricks-gpt-6-luna", label: "databricks-gpt-6-luna" },
    ]);
  });

  it("offers no models for a provider that signs in until it has", async () => {
    const { setup: goose } = setup({
      providers: [
        {
          providerId: "copilot",
          providerName: "GitHub Copilot",
          configured: false,
          visibleInSetup: true,
          configKeys: [
            {
              name: "GITHUB_COPILOT_TOKEN",
              required: true,
              secret: true,
              deviceCodeFlow: true,
            },
          ],
          models: [{ id: "gpt-6" }, { id: "claude-opus-5-5" }],
        },
      ],
    });
    await expect(goose.models("copilot")).rejects.toThrow(
      "GitHub Copilot isn't set up in goose. Run goose configure to sign in.",
    );
    await expect(
      goose.picks({ provider: "copilot", model: "gpt-6" }),
    ).resolves.toEqual({
      current: "gpt-6",
      models: [{ id: "gpt-6", label: "gpt-6", efforts: [] }],
    });
  });

  it("offers the models of a provider that runs on its fields' defaults", async () => {
    // goose lists Ollama as not configured without `OLLAMA_HOST`, though it
    // runs on localhost's.
    const { setup: goose } = setup({
      providers: [
        {
          providerId: "ollama",
          providerName: "Ollama",
          configured: false,
          visibleInSetup: true,
          configKeys: [
            {
              name: "OLLAMA_HOST",
              required: true,
              secret: false,
              default: "localhost",
            },
          ],
          models: [{ id: "qwen3" }, { id: "llama4" }],
        },
      ],
    });
    expect((await goose.models("ollama")).map(({ id }) => id)).toEqual([
      "qwen3",
      "llama4",
    ]);
    await expect(
      goose.picks({ provider: "ollama", model: "qwen3" }),
    ).resolves.toMatchObject({
      current: "qwen3",
      models: [{ id: "qwen3" }, { id: "llama4" }],
    });
  });

  it("lists only the workspace's and goose's own Databricks endpoints", async () => {
    const { setup: goose } = setup({
      providers: PROVIDERS.map((entry) =>
        entry.providerId === "databricks"
          ? {
              ...entry,
              configured: true,
              models: [{ id: "ticket-triage-gpt-6-luna" }],
            }
          : entry,
      ),
      supported: [
        "ticket-triage-gpt-6-luna",
        "databricks-gpt-6-1-sol",
        "kgoose-gpt-6-luna",
        "databricks-gpt-6-luna",
        "goose-gpt-5-5",
      ],
    });
    expect(await goose.models("databricks")).toEqual([
      { id: "databricks-gpt-6-1-sol", label: "databricks-gpt-6-1-sol" },
      { id: "databricks-gpt-6-luna", label: "databricks-gpt-6-luna" },
      { id: "goose-gpt-5-5", label: "goose-gpt-5-5" },
    ]);
  });

  it("lists only the Databricks models goose's model filter allows", async () => {
    const v2 = {
      providerId: "databricks_v2",
      providerName: "Databricks AI Gateway",
      configured: true,
      visibleInSetup: true,
    };
    const supported = [
      "databricks-gpt-5-5",
      "goose-gpt-5-5",
      "system.ai.gpt-6-1-sol",
      "acme_models.goose.goose-gpt-6-1-sol",
    ];
    const { fake, setup: goose } = setup({
      providers: [
        v2,
        {
          providerId: "ollama",
          providerName: "Ollama",
          configured: true,
          visibleInSetup: true,
        },
      ],
      supported,
      modelFilter: "goose-*, acme_models.goose.*",
    });
    expect((await goose.models("databricks_v2")).map(({ id }) => id)).toEqual([
      "goose-gpt-5-5",
      "acme_models.goose.goose-gpt-6-1-sol",
    ]);
    // A filtered-out model an agent runs on stays its model.
    await expect(
      goose.picks({
        provider: "databricks_v2",
        model: "system.ai.gpt-6-1-sol",
      }),
    ).resolves.toMatchObject({
      current: "system.ai.gpt-6-1-sol",
      models: [
        { id: "system.ai.gpt-6-1-sol" },
        { id: "goose-gpt-5-5" },
        { id: "acme_models.goose.goose-gpt-6-1-sol" },
      ],
    });
    expect((await goose.models("ollama")).map(({ id }) => id)).toEqual(
      supported,
    );
    const reads = fake.geese
      .flatMap((process) => process.received)
      .filter((request) => request.method === "_goose/unstable/config/read");
    expect(reads.map((request) => request.params)).toEqual([
      { key: "DATABRICKS_MODEL_FILTER", isSecret: false },
    ]);

    const empty = setup({ providers: [v2], supported, modelFilter: "none-*" });
    expect(await empty.setup.models("databricks_v2")).toEqual([]);
  });

  it("discovers Databricks V2 models despite a populated catalog and refreshes on check", async () => {
    const supported = ["goose-gpt-6-1-sol", "workspace.models.gpt-6-astra"];
    const { fake, setup: goose } = setup({
      providers: [
        {
          providerId: "databricks_v2",
          providerName: "Databricks AI Gateway",
          configured: true,
          visibleInSetup: true,
          models: [{ id: "goose-gpt-5-5" }],
        },
      ],
      defaults: { providerId: "databricks_v2", modelId: "goose-gpt-5-5" },
      supported,
    });
    expect((await goose.models("databricks_v2")).map(({ id }) => id)).toEqual(
      supported,
    );
    await goose.models("databricks_v2");
    const requests = () =>
      fake.geese
        .flatMap((process) => process.received)
        .filter(
          (message) =>
            message.method ===
            "_goose/unstable/providers/supported-models/list",
        );
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.params).toEqual({ providerId: "databricks_v2" });
    supported.push("goose-gpt-6-luna");
    await goose.check();
    expect((await goose.models("databricks_v2")).map(({ id }) => id)).toEqual(
      supported,
    );
    expect(requests()).toHaveLength(2);
  });

  it("offers an agent its provider's models, or those of goose's config", async () => {
    const { setup: goose } = setup({ supported: ["qwen3", "llama4"] });
    const { setup: configured } = setup({
      saved: new Map([["anthropic", new Set(["ANTHROPIC_API_KEY"])]]),
    });
    await expect(
      configured.picks({ provider: "anthropic", model: "" }),
    ).resolves.toEqual({
      current: "claude-sonnet-5-5",
      models: [
        { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5", efforts: [] },
        { id: "claude-opus-5-5", label: "claude-opus-5-5", efforts: [] },
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5", efforts: [] },
      ],
    });
    await expect(
      configured.picks({ provider: "anthropic", model: "claude-haiku-5-5" }),
    ).resolves.toMatchObject({
      current: "claude-haiku-5-5",
      models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }],
    });
    // A provider that is not set up offers only the model the agent names.
    await expect(
      goose.picks({ provider: "anthropic", model: "claude-haiku-5-5" }),
    ).resolves.toEqual({
      current: "claude-haiku-5-5",
      models: [
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5", efforts: [] },
      ],
    });
    await expect(goose.picks({ provider: "", model: "" })).resolves.toEqual({
      current: "qwen3",
      models: [
        { id: "qwen3", label: "qwen3", efforts: [] },
        { id: "llama4", label: "llama4", efforts: [] },
      ],
    });
  });

  it("saves a provider's fields into goose and reads the list again", async () => {
    const saved = new Map<string, Set<string>>();
    const { fake, setup: goose } = setup({ saved });
    await goose.providers();
    expect(await goose.saved("anthropic")).toEqual(new Set());
    await goose.save("anthropic", { ANTHROPIC_API_KEY: "sk-test" });
    const request = fake.geese
      .flatMap((goose) => goose.received)
      .find((message) => message.method?.endsWith("config/save"));
    expect(request?.params).toEqual({
      providerId: "anthropic",
      fields: [{ key: "ANTHROPIC_API_KEY", value: "sk-test" }],
    });
    expect(await goose.saved("anthropic")).toEqual(
      new Set(["ANTHROPIC_API_KEY"]),
    );
    const before = fake.geese.length;
    await goose.providers();
    expect(fake.geese).toHaveLength(before + 1);
  });

  it("passes a test the provider answers OK, in chat mode with no tools", async () => {
    const { fake, setup: goose } = setup({ reply: "OK." });
    expect(
      await goose.test({ provider: "anthropic", model: "claude-opus-5-5" }),
    ).toEqual({ ok: true, message: "Connected" });
    const [tested] = fake.geese;
    expect(tested?.env).toMatchObject({ GOOSE_MODE: "chat" });
    expect(tested?.env).toMatchObject({
      GOOSE_PROVIDER: null,
      GOOSE_MODEL: null,
    });
    expect(tested?.opened[0]).toMatchObject({
      mcpServers: [],
      _meta: { enabledExtensions: [], provider: "anthropic" },
    });
    expect(tested?.configured).toEqual(["session-1 model=claude-opus-5-5"]);
    expect(tested?.turns.map((turn) => turn.text)).toEqual([
      "Reply with exactly: OK",
    ]);
    expect(tested?.closed).toHaveLength(1);
    // goose would otherwise keep the test as a "New Chat" session.
    expect(tested?.deleted).toEqual(tested?.closed);
    expect(tested?.killed).toBe(true);
  });

  it("fails a test with what goose replied instead", async () => {
    const { fake, setup: goose } = setup({
      reply: "Authentication failed: invalid x-api-key",
    });
    expect(await goose.test({ provider: "anthropic", model: "" })).toEqual({
      ok: false,
      message: "Authentication failed: invalid x-api-key",
    });
    // The provider's default model, whatever goose's config names.
    const [tested] = fake.geese;
    expect(tested?.opened[0]?._meta).toMatchObject({ provider: "anthropic" });
    expect(tested?.configured).toEqual([]);
  });

  it("reads the thinking levels a session on the provider and model lists, once", async () => {
    const { fake, setup: goose } = setup({
      thinking: {
        "": { current: "medium", levels: ["off", "low", "medium", "high"] },
        "claude-haiku-5-5": { current: "off", levels: ["off"] },
      },
    });
    expect(
      await goose.efforts({ provider: "anthropic", model: "claude-haiku-5-5" }),
    ).toEqual({ current: "off", levels: ["off"] });
    expect(await goose.efforts({ provider: "anthropic", model: " " })).toEqual({
      current: "medium",
      levels: ["off", "low", "medium", "high"],
    });
    await goose.efforts({ provider: "anthropic", model: "claude-haiku-5-5" });
    expect(fake.geese).toHaveLength(2);
    const [read] = fake.geese;
    expect(read?.opened[0]).toMatchObject({
      mcpServers: [],
      _meta: { enabledExtensions: [], provider: "anthropic" },
    });
    // No turn runs, and goose keeps no session for it.
    expect(read?.turns).toEqual([]);
    expect(read?.deleted).toEqual(["session-1"]);
    expect(read?.killed).toBe(true);
  });

  it("reads thinking levels goose lists inside an option group", async () => {
    const { setup: goose } = setup({
      thinking: {
        "": { current: "high", levels: ["low", "high"], grouped: true },
      },
    });
    expect(await goose.efforts({ provider: "anthropic", model: " " })).toEqual({
      current: "high",
      levels: ["low", "high"],
    });
  });

  it("offers each model's thinking levels, read in one goose, on the agent's level", async () => {
    const { fake, setup: goose } = setup({
      saved: new Map([["anthropic", new Set(["ANTHROPIC_API_KEY"])]]),
      thinking: {
        "claude-sonnet-5-5": {
          current: "medium",
          levels: ["low", "medium", "high"],
        },
        "claude-opus-5-5": { current: "high", levels: ["low", "high"] },
      },
    });
    const picks = await goose.picks({
      provider: "anthropic",
      model: "",
      effort: "low",
    });
    expect(picks).toEqual({
      current: "claude-sonnet-5-5",
      models: [
        {
          id: "claude-sonnet-5-5",
          label: "claude-sonnet-5-5",
          efforts: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          effort: "low",
        },
        {
          id: "claude-opus-5-5",
          label: "claude-opus-5-5",
          efforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          effort: "low",
        },
        // goose lists no levels for it, so it offers no slider.
        { id: "claude-haiku-5-5", label: "claude-haiku-5-5", efforts: [] },
      ],
    });
    // Without a level of its own, a model rests on goose's.
    const own = await goose.picks({ provider: "anthropic", model: "" });
    expect(own.models.map((model) => model.effort)).toEqual([
      "medium",
      "high",
      undefined,
    ]);
    const reads = fake.geese.filter((read) => read.opened.length);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.deleted).toEqual(["session-1"]);
    expect(reads[0]?.turns).toEqual([]);
  });

  it("offers a model without levels when goose cannot read them", async () => {
    const fake = fakeSpawn({
      providers: PROVIDERS,
      saved: new Map([["anthropic", new Set(["ANTHROPIC_API_KEY"])]]),
      thinking: { "claude-opus-5-5": { current: "high", levels: ["high"] } },
    });
    // goose cannot move a session to any model.
    const goose = new GooseSetup({
      ...fake,
      spawn: async (...args: Parameters<typeof fake.spawn>) => {
        const process = await fake.spawn(...args);
        for (const started of fake.geese) started.configError = "no";
        return process;
      },
    });
    await expect(
      goose.picks({ provider: "anthropic", model: "" }),
    ).resolves.toMatchObject({
      models: [{ efforts: [] }, { efforts: [] }, { efforts: [] }],
    });
  });

  it("refreshes inherited thinking choices after saving defaults and rechecking", async () => {
    const thinking = { "": { current: "low", levels: ["low"] } };
    const { setup: goose } = setup({ thinking });
    const inherited = { provider: "", model: "" };
    expect((await goose.efforts(inherited)).levels).toEqual(["low"]);
    thinking[""] = { current: "high", levels: ["high"] };
    await goose.saveDefaults({ provider: "ollama", model: "qwen3" });
    expect((await goose.efforts(inherited)).levels).toEqual(["high"]);
    thinking[""] = { current: "off", levels: ["off"] };
    await goose.check();
    expect((await goose.efforts(inherited)).levels).toEqual(["off"]);
  });

  it("reads no thinking levels from a goose that lists none", async () => {
    const { setup: goose } = setup();
    expect(await goose.efforts({ provider: "", model: "" })).toEqual({
      current: "",
      levels: [],
    });
  });

  it("says when the bundled goose-acp is missing", async () => {
    const fake = fakeSpawn();
    const spawn: Spawn = async (id, options) => {
      if (id === "goose")
        throw new Error(
          "Could not start goose-acp: No such file or directory (os error 2)",
        );
      return fake.spawn(id, options);
    };
    const goose = new GooseSetup({ ...fake, spawn });
    await expect(goose.providers()).rejects.toThrow("goose-acp is missing");
    expect(await goose.test({ provider: "", model: "" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("goose-acp is missing"),
    });
  });
});

describe("modelFilter", () => {
  it("lists every model without patterns", () => {
    for (const value of [null, undefined, "", "  ", " , "])
      expect(modelFilter(value)("anything")).toBe(true);
  });

  it("matches whole IDs case-sensitively with * and ?", () => {
    const listed = modelFilter("goose-gpt-?-5,system.ai.*");
    expect(listed("goose-gpt-5-5")).toBe(true);
    expect(listed("goose-gpt-55-5")).toBe(false);
    expect(listed("system.ai.claude-opus")).toBe(true);
    expect(listed("System.ai.claude-opus")).toBe(false);
    expect(listed("x-goose-gpt-5-5")).toBe(false);
    expect(listed("goose-gpt-5-5-x")).toBe(false);
  });

  it("treats every other character literally", () => {
    const listed = modelFilter("a.b(c)+[d]|e");
    expect(listed("a.b(c)+[d]|e")).toBe(true);
    expect(listed("aXb(c)+[d]|e")).toBe(false);
    expect(listed("e")).toBe(false);
  });
});

describe("keyLabel", () => {
  it("names a key by what follows the provider", () => {
    expect(keyLabel("ANTHROPIC_API_KEY")).toBe("API key");
    expect(keyLabel("OLLAMA_HOST")).toBe("Host");
    expect(keyLabel("AZURE_OPENAI_ENDPOINT_URL")).toBe("Openai endpoint URL");
    expect(keyLabel("TOKEN")).toBe("Token");
  });
});

describe("explainTurn", () => {
  const settings = "buzz://settings?section=agents&provider=buzz.goose%2Fgoose";
  const refused = `Goose's provider rejected its API key or sign-in. Head to [Settings](${settings}) to check its provider.`;

  // A deferred handover reports `String(error)`; a failed start, the label.
  it.each([
    "Authentication required",
    "goose could not start: Authentication required",
    "Error: Authentication required",
  ])(
    "links Settings and quotes goose for a refusal reported as %j",
    (error) => {
      expect(explainTurn(error, settings)).toBe(
        `${refused}\n\ngoose said:\n> ${error}`,
      );
    },
  );

  it("leaves a mention of authentication inside other text as goose said it", () => {
    const error =
      "Internal error: Tool failed. Authentication required by repo";
    expect(explainTurn(error, settings)).toBe(error);
  });
});

it("checks Goose config readiness and writes defaults through Goose", async () => {
  const { setup: goose, fake } = setup();
  await goose.check();
  expect(goose.snapshot().readiness).toBe("ready");
  await goose.saveDefaults({ provider: "ollama", model: "llama4" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "llama4",
  });
  expect(goose.snapshot()).toMatchObject({
    readiness: "ready",
    blocking: false,
  });
  expect(fake.geese.every((process) => process.killed)).toBe(true);
});

it("requires a configured default provider and recovers after setup", async () => {
  const { setup: goose } = setup({ defaults: {} });
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
  await goose.saveDefaults({ provider: "ollama", model: "" });
  expect(goose.snapshot().readiness).toBe("ready");
});

it("reports unavailable Goose as needing attention", async () => {
  const goose = new GooseSetup(undefined);
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
  await expect(
    goose.saveDefaults({ provider: "ollama", model: "qwen3" }),
  ).rejects.toThrow();
  expect(goose.snapshot().blocking).toBe(false);
});

it("invalidates runtime defaults only after a successful save", async () => {
  const fake = fakeSpawn({ providers: PROVIDERS });
  const changed = vi.fn();
  const goose = new GooseSetup(fake, changed);
  await goose.check();
  expect(changed).not.toHaveBeenCalled();
  await goose.saveDefaults({ provider: "ollama", model: "qwen3" });
  expect(changed).toHaveBeenCalledTimes(1);
  const unavailable = new GooseSetup(undefined, changed);
  await expect(
    unavailable.saveDefaults({ provider: "ollama", model: "" }),
  ).rejects.toThrow();
  expect(changed).toHaveBeenCalledTimes(1);
});

it("blocks dismissal throughout credential persistence and clears blocking on failure", async () => {
  const { setup: goose } = setup();
  await goose.check();
  let reject!: (reason: Error) => void;
  const gate = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const save = vi.spyOn(goose, "save").mockReturnValue(gate);
  const pending = goose.saveDefaults(
    { provider: "ollama", model: "qwen3" },
    { OLLAMA_HOST: "host" },
  );
  const result = expect(pending).rejects.toThrow("key failure");
  try {
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    expect(goose.snapshot().blocking).toBe(true);
  } finally {
    reject(new Error("key failure"));
  }
  await result;
  expect(goose.snapshot().blocking).toBe(false);
});

it("invalidates inherited sessions when a fresh check finds external defaults changes", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "ollama", modelId: "qwen3" },
  });
  const changed = vi.fn();
  const goose = new GooseSetup(fake, changed);
  await goose.check();
  await new GooseSetup(fake).saveDefaults({
    provider: "ollama",
    model: "llama4",
  });
  await goose.check();
  expect(changed).toHaveBeenCalledTimes(1);
  await goose.check();
  expect(changed).toHaveBeenCalledTimes(1);
});

it("retains the stored provider model when a defaults save omits the model", async () => {
  const { setup: goose } = setup();
  await goose.saveDefaults({ provider: "ollama", model: "llama4" });
  await goose.saveDefaults({ provider: "ollama", model: "" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "llama4",
  });
});

it("saves the catalog model when switching to a provider without a stored model", async () => {
  const { setup: goose, fake } = setup({
    providers: PROVIDERS.map((provider) => ({ ...provider, configured: true })),
  });
  await goose.saveDefaults({ provider: "anthropic", model: "" });
  expect((await goose.providers()).defaults).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .find((request) => request.method === "_goose/unstable/defaults/save")
      ?.params,
  ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
  expect(goose.snapshot().readiness).toBe("ready");
});

it("does not report ready when a configured provider has no model", async () => {
  const { setup: goose } = setup({ defaults: { providerId: "ollama" } });
  await goose.check();
  expect(goose.snapshot().readiness).toBe("attention");
});

it("rejects a provider without a default model before changing defaults", async () => {
  const { setup: goose, fake } = setup();
  await expect(
    goose.saveDefaults({ provider: "databricks", model: "" }),
  ).rejects.toThrow("Choose a default model");
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .some((request) => request.method === "_goose/unstable/defaults/save"),
  ).toBe(false);
  expect((await goose.providers()).defaults).toEqual({
    provider: "ollama",
    model: "qwen3",
  });
  expect(goose.snapshot().blocking).toBe(false);
});

it("preserves a provider's custom model when switching away and back after restart", async () => {
  const { setup: goose, fake } = setup({
    providers: PROVIDERS.map((provider) => ({ ...provider, configured: true })),
    defaults: { providerId: "ollama", modelId: "custom-model" },
  });
  await goose.saveDefaults({ provider: "anthropic", model: "" });
  const restarted = new GooseSetup(fake);
  await restarted.saveDefaults({ provider: "ollama", model: "" });
  expect((await restarted.providers()).defaults).toEqual({
    provider: "ollama",
    model: "custom-model",
  });
  expect(restarted.snapshot().readiness).toBe("ready");
  expect(
    fake.geese
      .flatMap((process) => process.received)
      .filter((request) => request.method === "_goose/unstable/config/read")
      .every(
        (request) =>
          request.params?.key === "providers" &&
          request.params?.isSecret === false,
      ),
  ).toBe(true);
});
