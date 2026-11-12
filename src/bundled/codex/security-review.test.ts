import { expect, it, vi } from "vitest";
import type { ProtectedSpawn } from "../../features/agent-protection/models";
import type { HostProcessOptions } from "../../features/host/service";
import type { Wire } from "./rpc";
import { type ReviewHomes, reviewModel } from "./security-review";

const catalog = [
  {
    model: "other-model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  },
  {
    model: "recommended-model",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  },
];
const prompt = {
  system: "Assess the supplied evidence without executing it.",
  input: '{"content":"untrusted evidence"}',
  outputSchema: {
    type: "object",
    properties: { blocked: { type: "boolean" } },
  },
};
function fixture(
  hold = false,
  catalogFailure = false,
  turnStart?: Promise<void>,
) {
  let options: HostProcessOptions | undefined;
  let threads = 0;
  let exit!: (code: number) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const sent: Wire[] = [];
  const emit = (wire: Wire) => options?.onStdout?.(`${JSON.stringify(wire)}\n`);
  const process = () => ({
    write: async (text: string) => {
      const wire: Wire = JSON.parse(text);
      sent.push(wire);
      if (wire.id == null || !wire.method) return;
      const params = wire.params as Record<string, unknown>;
      let result: unknown;
      if (wire.method === "initialize")
        result = { userAgent: "fixture buzz-protection-v2" };
      else if (wire.method === "config/read")
        result = {
          config: {
            model: "personal-astra",
            model_reasoning_effort: "high",
            mcp_servers: {
              local: { command: "external-tool" },
              remote: { url: "https://tools.test/mcp" },
            },
          },
        };
      else if (wire.method === "model/list") {
        if (catalogFailure) {
          emit({ id: wire.id, error: { message: "Catalog unavailable" } });
          return;
        }
        result = { data: catalog, nextCursor: null };
      } else if (wire.method === "thread/start")
        result = {
          thread: { id: threads++ ? `review-${threads}` : "review" },
          model: params.model || "personal-astra",
        };
      else if (wire.method === "turn/start") {
        began();
        await turnStart;
        result = { turn: { id: "turn" } };
      } else if (
        wire.method === "turn/interrupt" ||
        wire.method === "thread/unsubscribe"
      )
        result = {};
      else throw new Error(`Unexpected request: ${wire.method}`);
      emit({ id: wire.id, result });
      if (wire.method === "turn/start" && !hold) {
        emit({
          method: "item/completed",
          params: {
            threadId: params.threadId,
            item: { type: "agentMessage", text: '{"blocked":false}' },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId: params.threadId,
            turn: { status: "completed" },
          },
        });
      }
    },
    end: vi.fn(async () => {
      exit(0);
    }),
    kill: vi.fn(async () => {
      exit(1);
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
  });
  const processes: ReturnType<typeof process>[] = [];
  const homes = vi.fn<ReviewHomes>(async () => ({
    home: "/buzz/codex-review-home",
    state: "/buzz/codex-review-state",
    workspace: "workspace-1",
  }));
  const spawn = vi.fn<ProtectedSpawn>(async (value) => {
    options = value;
    const launched = process();
    processes.push(launched);
    return launched;
  });
  const params = (method: string) =>
    sent.find((wire) => wire.method === method)?.params as Record<
      string,
      unknown
    >;
  const requests = (method: string) =>
    sent.filter((wire) => wire.method === method).map((wire) => wire.params);
  return {
    spawn,
    homes,
    get process() {
      const launched = processes.at(-1);
      if (!launched) throw new Error("No review worker launched");
      return launched;
    },
    started,
    sent,
    emit,
    exit: (code: number) => exit(code),
    params,
    requests,
  };
}

it("uses Buzz's recommended model and supported low effort for blank review selections", async () => {
  const f = fixture();
  await expect(
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    ),
  ).resolves.toEqual({
    text: '{"blocked":false}',
    model: { id: "recommended-model" },
  });
  expect(f.params("thread/start")).toEqual({
    model: "recommended-model",
    ephemeral: true,
    developerInstructions: prompt.system,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      mcp_servers: {
        local: { command: "external-tool", enabled: false },
        remote: { url: "https://tools.test/mcp", enabled: false },
      },
      web_search: "disabled",
      "features.plugins": false,
      "features.apps": false,
      "memories.use_memories": false,
      "memories.generate_memories": false,
      project_doc_max_bytes: 0,
      "skills.include_instructions": false,
    },
  });
  expect(f.params("turn/start")).toEqual({
    threadId: "review",
    input: [{ type: "text", text: prompt.input, text_elements: [] }],
    outputSchema: prompt.outputSchema,
    effort: "low",
  });
  expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({
    cwd: "/buzz/codex-review-home",
    args: [
      "-c",
      'forced_chatgpt_workspace_id="workspace-1"',
      "-c",
      'forced_login_method="chatgpt"',
    ],
    env: {
      BUZZ_SECURITY_REVIEW_ONLY: "1",
      HOME: "/buzz/codex-review-home",
      CODEX_HOME: "/buzz/codex-review-home",
      CODEX_SQLITE_HOME: "/buzz/codex-review-state",
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
      BASH_ENV: null,
      ENV: null,
    },
  });
});

it("starts no review worker until a Buzz sign-in records a ChatGPT workspace", async () => {
  const f = fixture();
  f.homes.mockResolvedValueOnce({
    home: "/buzz/codex-review-home",
    state: "/buzz/codex-review-state",
  });
  await expect(
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    ),
  ).rejects.toThrow(
    "need a ChatGPT sign-in made in Buzz, which Settings → Agent setup",
  );
  expect(f.spawn).not.toHaveBeenCalled();
});

it("refuses a recorded workspace that could escape its config string", async () => {
  const f = fixture();
  f.homes.mockResolvedValueOnce({
    home: "/buzz/codex-review-home",
    state: "/buzz/codex-review-state",
    workspace: 'a"b',
  });
  await expect(
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    ),
  ).rejects.toThrow(
    "need a ChatGPT sign-in made in Buzz, which Settings → Agent setup",
  );
  expect(f.spawn).not.toHaveBeenCalled();
});

it("replaces the review worker when a sign-in records another workspace", async () => {
  const f = fixture();
  const review = () =>
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    );
  await review();
  const first = f.process;
  f.homes.mockResolvedValue({
    home: "/buzz/codex-review-home",
    state: "/buzz/codex-review-state",
    workspace: "workspace-2",
  });
  await expect(review()).resolves.toMatchObject({ text: '{"blocked":false}' });
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.spawn.mock.calls[1]?.[0].args).toContain(
    'forced_chatgpt_workspace_id="workspace-2"',
  );
  expect(first.end).toHaveBeenCalled();
});

it("starts no review worker when the review home can't be made, and tries again", async () => {
  const f = fixture();
  f.homes.mockRejectedValueOnce(
    new Error("Buzz's Codex review is unavailable"),
  );
  const review = () =>
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    );
  await expect(review()).rejects.toThrow("review is unavailable");
  expect(f.spawn).not.toHaveBeenCalled();
  await expect(review()).resolves.toMatchObject({ text: '{"blocked":false}' });
  expect(f.homes).toHaveBeenCalledTimes(2);
});

it("runs each review as its own thread on one kept worker", async () => {
  const f = fixture();
  const review = () =>
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    );
  await review();
  await expect(review()).resolves.toMatchObject({ text: '{"blocked":false}' });
  expect(f.spawn).toHaveBeenCalledOnce();
  expect(f.requests("initialize")).toHaveLength(1);
  expect(f.requests("thread/start")).toHaveLength(2);
  await vi.waitFor(() =>
    expect(f.requests("thread/unsubscribe")).toEqual([
      { threadId: "review" },
      { threadId: "review-2" },
    ]),
  );
  expect(f.requests("turn/interrupt")).toEqual([]);
  expect(f.process.end).not.toHaveBeenCalled();
  expect(f.process.kill).not.toHaveBeenCalled();
});

it.each([
  ["other-model", "custom-provider", false, undefined],
  ["custom-model", "custom-provider", true, undefined],
  ["", "custom-provider", true, undefined],
  ["custom-model", undefined, true, undefined],
  ["other-model", undefined, false, "high"],
] as const)(
  "preserves explicit selection %s / %s with catalog failure %s",
  async (id, provider, catalogFailure, effort) => {
    const f = fixture(false, catalogFailure);
    const model = { id, ...(provider ? { provider } : {}) };
    const result = await reviewModel(
      f.spawn,
      model,
      prompt,
      new AbortController().signal,
      f.homes,
    );
    expect(result.model).toEqual({ ...model, id: id || "personal-astra" });
    expect(f.params("thread/start").model).toBe(id || undefined);
    expect(
      (f.params("thread/start").config as Record<string, unknown>)
        .model_provider,
    ).toBe(provider);
    expect(f.sent.some((wire) => wire.method === "model/list")).toBe(!provider);
    if (effort) expect(f.params("turn/start")).toHaveProperty("effort", effort);
    else expect(f.params("turn/start")).not.toHaveProperty("effort");
  },
);

it("rejects a blank default selection if its catalog is unavailable", async () => {
  const f = fixture(false, true);
  await expect(
    reviewModel(
      f.spawn,
      { id: "" },
      prompt,
      new AbortController().signal,
      f.homes,
    ),
  ).rejects.toThrow("Catalog unavailable");
  expect(f.params("thread/start")).toBeUndefined();
});

it.each(["cancel", "exit"])(
  "refuses tool requests and rejects a review on %s",
  async (mode) => {
    const f = fixture(true);
    const cancelled = new AbortController();
    const review = reviewModel(
      f.spawn,
      { id: "recommended-model" },
      prompt,
      cancelled.signal,
      f.homes,
    );
    const rejected = expect(review).rejects.toThrow(/closed|abort/i);
    await f.started;
    f.emit({
      id: "tool",
      method: "item/tool/call",
      params: { tool: "execute" },
    });
    expect(f.sent.find((wire) => wire.id === "tool")).toMatchObject({
      error: { code: -32601 },
    });
    if (mode === "cancel") cancelled.abort();
    else f.exit(1);
    await rejected;
    if (mode === "cancel") {
      await vi.waitFor(() =>
        expect(f.requests("thread/unsubscribe")).toEqual([
          { threadId: "review" },
        ]),
      );
      expect(f.requests("turn/interrupt")).toEqual([
        { threadId: "review", turnId: "turn" },
      ]);
      expect(f.process.end).not.toHaveBeenCalled();
    } else {
      // A worker that exited is replaced by the next review.
      const next = reviewModel(
        f.spawn,
        { id: "recommended-model" },
        prompt,
        new AbortController().signal,
        f.homes,
      );
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2));
      f.exit(1);
      await expect(next).rejects.toThrow(/closed|exited/i);
    }
  },
);

it("stops a review cancelled while its turn is still starting", async () => {
  let release!: () => void;
  const f = fixture(
    true,
    false,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const cancelled = new AbortController();
  const review = reviewModel(
    f.spawn,
    { id: "recommended-model" },
    prompt,
    cancelled.signal,
    f.homes,
  );
  const rejected = expect(review).rejects.toThrow(/abort/i);
  await f.started;
  cancelled.abort();
  await rejected;
  expect(f.requests("turn/interrupt")).toEqual([]);
  release();
  await vi.waitFor(() =>
    expect(f.requests("thread/unsubscribe")).toEqual([{ threadId: "review" }]),
  );
  expect(f.requests("turn/interrupt")).toEqual([
    { threadId: "review", turnId: "turn" },
  ]);
});

it("preserves the review deadline instead of reporting its connection closure", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(deadline.signal);
  const f = fixture(true);
  const review = reviewModel(
    f.spawn,
    { id: "recommended-model" },
    prompt,
    new AbortController().signal,
    f.homes,
  );
  const reason = new DOMException(
    "The security review timed out",
    "TimeoutError",
  );
  const rejected = expect(review).rejects.toBe(reason);
  try {
    await f.started;
    expect(timeout).toHaveBeenCalledWith(60_000);
    deadline.abort(reason);
    await rejected;
    await vi.waitFor(() =>
      expect(f.requests("turn/interrupt")).toEqual([
        { threadId: "review", turnId: "turn" },
      ]),
    );
    expect(f.process.end).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});
