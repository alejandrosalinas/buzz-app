import { describe, expect, it, vi } from "vitest";
import { inferenceBundle } from "../../features/agents/gateway/contract";
import {
  VECTOR_BINDING,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import {
  customHeaders,
  ELSEWHERE,
  FOREIGN,
  INHERITED,
  ineligible,
  MASKED,
  POLICY_HEADERS,
  PROVIDER,
  PROVIDERS,
  readSettings,
  SHARED,
  STALE,
  UNAPPLIED,
  UNREADABLE,
} from "./attribution";
import { ClaudeProcess } from "./claude";
import { fakeSpawn } from "./claude-testing";

const GATEWAY = "https://gateway.example";
const bundle = (message: string | null) => {
  const built = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
    channel_id: "33333333-3333-4333-8333-333333333333",
    message_id: message,
    thread_id: null,
  });
  if (!built.ok) throw new Error(built.message);
  return built.value;
};
const attribution = (message: string | null) => ({
  origin: GATEWAY,
  profile: VECTOR_PROFILE,
  headers: bundle(message),
});
/** A `get_settings` answer whose sources hold these envs. */
const answer = (
  sources: Record<string, Record<string, unknown>>,
  effective: Record<string, unknown> = Object.assign(
    {},
    ...Object.values(sources),
  ),
) => ({
  subtype: "success",
  response: {
    effective: { env: effective },
    sources: Object.entries(sources).map(([source, env]) => ({
      source,
      settings: { env },
    })),
  },
});

describe("readSettings", () => {
  it("reads the endpoint and selectors as in effect, and the person's own headers by rank", () => {
    expect(
      readSettings(
        answer({
          userSettings: {
            ANTHROPIC_BASE_URL: `${GATEWAY}/pass-through/anthropic`,
            ANTHROPIC_CUSTOM_HEADERS: "x-user: 1",
            ANTHROPIC_AUTH_TOKEN: "secret",
          },
          localSettings: { ANTHROPIC_CUSTOM_HEADERS: "x-local: 1" },
          flagSettings: { ANTHROPIC_CUSTOM_HEADERS: "x-buzz: 1" },
        }),
      ),
    ).toEqual({
      headers: "x-local: 1",
      endpoint: `${GATEWAY}/pass-through/anthropic`,
      provider: false,
      policy: false,
      flag: { any: true, others: false },
    });
  });

  it("sees a policy's headers and any flag env key Buzz doesn't write", () => {
    const read = readSettings(
      answer({
        policySettings: { ANTHROPIC_CUSTOM_HEADERS: "x-policy: 1" },
        flagSettings: { OTHER: "1" },
      }),
    );
    expect(read).toMatchObject({
      headers: undefined,
      policy: true,
      flag: { any: true, others: true },
    });
  });

  it("is unread for a failed or malformed answer, or a source it can't rank", () => {
    expect(readSettings({ subtype: "error" })).toBeUndefined();
    expect(
      readSettings({ subtype: "success", response: { effective: {} } }),
    ).toBeUndefined();
    expect(readSettings(answer({ sessionSettings: {} }))).toBeUndefined();
    expect(
      readSettings({
        subtype: "success",
        response: { sources: [{ source: "userSettings", settings: [] }] },
      }),
    ).toBeUndefined();
  });

  it("counts a provider selector only when it is on", () => {
    for (const name of PROVIDERS) {
      expect(
        readSettings(answer({ userSettings: { [name]: " TRUE " } }))?.provider,
      ).toBe(true);
      expect(
        readSettings(answer({ userSettings: { [name]: "0" } }))?.provider,
      ).toBe(false);
    }
  });
});

describe("ineligible", () => {
  const current = (endpoint?: string, provider = false) => ({
    headers: undefined,
    endpoint,
    provider,
    policy: false,
    flag: { any: false, others: false },
    inherited: false,
  });

  it("accepts the gateway's origin on either mode path", () => {
    for (const path of ["/pass-through/anthropic", "/ai-gateway/anthropic"])
      expect(ineligible(current(`${GATEWAY}${path}`), GATEWAY)).toBeUndefined();
    expect(
      ineligible(current("https://gateway.example:443/x"), GATEWAY),
    ).toBeUndefined();
  });

  it("refuses another origin, a missing or unparsable endpoint, or a provider", () => {
    for (const endpoint of [
      "https://gateway.example:8443/pass-through/anthropic",
      "http://gateway.example/pass-through/anthropic",
      "https://other.example/pass-through/anthropic",
      "not a url",
      undefined,
    ])
      expect(ineligible(current(endpoint), GATEWAY)).toBe(ELSEWHERE);
    expect(ineligible(current(`${GATEWAY}/a`, true), GATEWAY)).toBe(PROVIDER);
  });

  it("refuses a policy's headers, which outrank Buzz's", () => {
    const on = current(`${GATEWAY}/a`);
    expect(ineligible({ ...on, policy: true }, GATEWAY)).toBe(POLICY_HEADERS);
  });

  it("never replaces headers only the inherited env sets", () => {
    const own = { ...current(`${GATEWAY}/a`), inherited: true };
    expect(ineligible(own, GATEWAY)).toBe(INHERITED);
    expect(ineligible({ ...own, inherited: undefined }, GATEWAY)).toBe(
      UNREADABLE,
    );
    // A settings value outranks the inherited one, so it is the person's.
    expect(ineligible({ ...own, headers: "x-keep: 1" }, GATEWAY)).toBe(
      undefined,
    );
  });
});

describe("customHeaders", () => {
  it("keeps the person's headers and replaces any Buzz-reserved one", () => {
    const composed = customHeaders(
      VECTOR_PROFILE,
      "x-keep: configured\r\nX_GW_CTX_MESSAGE_ID: stale\nX-Gw-Launcher-Session: old\n\nx-other: a:b",
      bundle("c".repeat(64)),
    );
    const lines = composed.split("\n");
    expect(lines.slice(0, 2)).toEqual(["x-keep: configured", "x-other: a:b"]);
    expect(lines).toContain(`x-gw-ctx-message-id: ${"c".repeat(64)}`);
    expect(composed).not.toMatch(/stale|old/);
  });

  it("omits a null role", () => {
    expect(customHeaders(VECTOR_PROFILE, undefined, bundle(null))).not.toMatch(
      /message-id|thread-id/,
    );
  });
});

describe("ClaudeProcess.attribute", () => {
  const launch = { cwd: "~/.buzz", systemPrompt: "", sessionId: "s1" };
  const subtypes = (received: Record<string, unknown>[]) =>
    received
      .map((message) => (message.request as { subtype?: string })?.subtype)
      .filter(Boolean);

  async function started(
    env: Record<string, string>,
    check: Parameters<typeof fakeSpawn>[2] = {},
  ) {
    const { spawn, processes } = fakeSpawn(undefined, env, check);
    const claude = await ClaudeProcess.start(spawn, launch);
    const fake = processes[0];
    if (!fake) throw new Error("no process");
    return { claude, fake };
  }
  const ON_GATEWAY = {
    ANTHROPIC_BASE_URL: `${GATEWAY}/ai-gateway/anthropic`,
    ANTHROPIC_CUSTOM_HEADERS: "x-keep: configured",
  };

  /** `pending` once Claude has had longer than attribution waits. */
  async function timedOut<T>(pending: () => Promise<T>) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = pending();
      await vi.advanceTimersByTimeAsync(60_000);
      return await result;
    } finally {
      vi.useRealTimers();
    }
  }

  it("updates, keeps for a steer, and removes Buzz's headers in one process", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await expect(claude.attribute(attribution("1".repeat(64)))).resolves.toBe(
      undefined,
    );
    await claude.send("first", { effort: "low" });
    fake.hold = true;
    await claude.attribute(attribution("2".repeat(64)));
    const second = claude.send("second", { effort: "low" });
    // A steer is sent without asking for attribution: it keeps the turn's.
    const steer = claude.send("steer");
    fake.finish();
    await Promise.all([second, steer]);
    fake.hold = false;
    await claude.attribute(undefined);
    await claude.send("third");
    const [first, two, steered, third] = fake.headers;
    expect(first).toContain(`x-gw-ctx-message-id: ${"1".repeat(64)}`);
    expect(two).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(steered).toBe(two);
    expect(third).toBe("x-keep: configured");
    for (const headers of fake.headers)
      expect(headers).toMatch(/^x-keep: configured/);
    // Removal clears only the flag env; the endpoint and effort stay.
    expect(fake.flagEnv).toEqual({});
    expect(fake.env.ANTHROPIC_BASE_URL).toBe(ON_GATEWAY.ANTHROPIC_BASE_URL);
    expect(fake.efforts).toEqual(["low", "low", "low", "high"]);
  });

  it("follows a settings file Claude reloads: a new endpoint or rotated headers", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await claude.attribute(attribution("1".repeat(64)));
    await claude.send("on the gateway");
    // The person rotates their header: the next turn carries the new one.
    fake.env.ANTHROPIC_CUSTOM_HEADERS = "x-keep: rotated";
    await claude.attribute(attribution("2".repeat(64)));
    await claude.send("rotated");
    // Then moves Claude elsewhere: Buzz's headers are removed, not carried.
    fake.env.ANTHROPIC_BASE_URL = "https://other.example/v1";
    await expect(claude.attribute(attribution("3".repeat(64)))).resolves.toBe(
      ELSEWHERE,
    );
    await claude.send("elsewhere");
    const [, rotated, elsewhere] = fake.headers;
    expect(rotated).toMatch(/^x-keep: rotated\n/);
    expect(rotated).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(elsewhere).toBe("x-keep: rotated");
  });

  it("writes nothing over a policy's headers or another flag env key", async () => {
    const policy = await started(ON_GATEWAY);
    policy.fake.policyEnv = { ANTHROPIC_CUSTOM_HEADERS: "x-policy: 1" };
    await expect(policy.claude.attribute(attribution(null))).resolves.toBe(
      POLICY_HEADERS,
    );
    const foreign = await started(ON_GATEWAY);
    foreign.fake.flagEnv = { OTHER: "1" };
    await expect(foreign.claude.attribute(attribution(null))).resolves.toBe(
      FOREIGN,
    );
    // Headers a launch put in the flag layer look like Buzz's: left alone,
    // for the whole process.
    const launched = await started(ON_GATEWAY);
    launched.fake.flagEnv = { ANTHROPIC_CUSTOM_HEADERS: "x-launch: 1" };
    await expect(launched.claude.attribute(attribution(null))).resolves.toBe(
      FOREIGN,
    );
    launched.fake.flagEnv = undefined;
    await expect(launched.claude.attribute(attribution(null))).resolves.toBe(
      FOREIGN,
    );
    for (const { fake } of [policy, foreign, launched])
      expect(subtypes(fake.received)).not.toContain("apply_flag_settings");
  });

  it("never erases a flag env key Buzz didn't write, saying its headers may remain", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await claude.attribute(attribution("1".repeat(64)));
    fake.flagEnv = { ...fake.flagEnv, OTHER: "1" };
    const applied = subtypes(fake.received).length;
    await expect(claude.attribute(undefined)).resolves.toBe(SHARED);
    await expect(claude.attribute(attribution("2".repeat(64)))).resolves.toBe(
      SHARED,
    );
    expect(subtypes(fake.received).slice(applied)).not.toContain(
      "apply_flag_settings",
    );
    expect(fake.flagEnv?.OTHER).toBe("1");
    await expect(claude.send("still runs")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("restores in two steps, and says which state a partial failure leaves", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await claude.attribute(attribution("1".repeat(64)));
    // Unread: Buzz's headers may still be in effect.
    fake.withhold = "get_settings";
    await expect(timedOut(() => claude.attribute(undefined))).resolves.toBe(
      STALE,
    );
    // The person's own headers are set, but the flag env isn't cleared.
    const clearing = (request: Record<string, unknown>) =>
      request.subtype === "apply_flag_settings" &&
      JSON.stringify(request.settings) === '{"env":{}}';
    fake.withhold = clearing;
    await expect(timedOut(() => claude.attribute(undefined))).resolves.toBe(
      MASKED,
    );
    await claude.send("their own, held");
    expect(fake.headers).toEqual(["x-keep: configured"]);
    expect(fake.flagEnv).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: "x-keep: configured",
    });
    // The next boundary finishes the cleanup, so a later edit applies.
    fake.withhold = undefined;
    await expect(claude.attribute(undefined)).resolves.toBeUndefined();
    expect(fake.flagEnv).toEqual({});
    fake.env.ANTHROPIC_CUSTOM_HEADERS = "x-keep: edited";
    await claude.send("edited");
    expect(fake.headers[1]).toBe("x-keep: edited");
    // Known clean now: nothing more is written.
    const settled = fake.received.length;
    await expect(claude.attribute(undefined)).resolves.toBeUndefined();
    expect(fake.received.length).toBe(settled);
  });

  it("launches with no flag settings, so the flag env is Buzz's alone", async () => {
    const { fake } = await started(ON_GATEWAY);
    expect(fake.options.args).not.toContain("--settings");
  });

  it("does nothing for a process Buzz never attributed", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await expect(claude.attribute(undefined)).resolves.toBeUndefined();
    expect(subtypes(fake.received)).toEqual(["initialize"]);
  });

  it("leaves another endpoint or provider unattributed, with a notice", async () => {
    const elsewhere = await started({ ANTHROPIC_BASE_URL: "https://api.x" });
    await expect(elsewhere.claude.attribute(attribution(null))).resolves.toBe(
      ELSEWHERE,
    );
    const provider = await started({
      ...ON_GATEWAY,
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    await expect(provider.claude.attribute(attribution(null))).resolves.toBe(
      PROVIDER,
    );
    // A selector in Claude's process env shows only in what it resolved.
    const resolved = await started(ON_GATEWAY, { apiProvider: "bedrock" });
    await expect(resolved.claude.attribute(attribution(null))).resolves.toBe(
      PROVIDER,
    );
    for (const { fake } of [elsewhere, provider, resolved])
      expect(subtypes(fake.received)).not.toContain("apply_flag_settings");
  });

  it("leaves inherited-only headers alone, and keeps a settings value over them", async () => {
    const { ANTHROPIC_BASE_URL } = ON_GATEWAY;
    const only = await started({ ANTHROPIC_BASE_URL }, { inherited: "set" });
    await expect(only.claude.attribute(attribution(null))).resolves.toBe(
      INHERITED,
    );
    await expect(only.claude.send("still runs")).resolves.toMatchObject({
      ok: true,
    });
    await expect(only.claude.attribute(undefined)).resolves.toBeUndefined();
    expect(subtypes(only.fake.received)).not.toContain("apply_flag_settings");
    const unchecked = await started(
      { ANTHROPIC_BASE_URL },
      { inherited: "fail" },
    );
    await expect(unchecked.claude.attribute(attribution(null))).resolves.toBe(
      UNREADABLE,
    );
    // Settings headers win over inherited ones: updated, then restored.
    const both = await started(ON_GATEWAY, { inherited: "set" });
    await both.claude.attribute(attribution("1".repeat(64)));
    await both.claude.send("first");
    await both.claude.attribute(attribution("2".repeat(64)));
    await both.claude.send("second");
    await both.claude.attribute(undefined);
    await both.claude.send("third");
    const [first, second, third] = both.fake.headers;
    expect(first).toContain(`x-gw-ctx-message-id: ${"1".repeat(64)}`);
    expect(second).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(third).toBe("x-keep: configured");
  });

  it("asks again next turn when Claude doesn't report its settings", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    fake.withhold = "get_settings";
    await expect(
      timedOut(() => claude.attribute(attribution("1".repeat(64)))),
    ).resolves.toBe(UNREADABLE);
    fake.withhold = undefined;
    await expect(
      claude.attribute(attribution("2".repeat(64))),
    ).resolves.toBeUndefined();
    await claude.send("attributed");
    expect(fake.headers[0]).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
  });

  it("writes again after an unconfirmed change, and restores after", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    await claude.attribute(attribution("1".repeat(64)));
    fake.withhold = "apply_flag_settings";
    await expect(
      timedOut(() => claude.attribute(attribution("1".repeat(64)))),
    ).resolves.toBeUndefined();
    await expect(
      timedOut(() => claude.attribute(attribution("2".repeat(64)))),
    ).resolves.toBe(UNAPPLIED);
    fake.withhold = undefined;
    // The same headers again are still sent, since either may be in effect.
    await claude.attribute(attribution("2".repeat(64)));
    await claude.send("second");
    await claude.attribute(undefined);
    await claude.send("restored");
    expect(fake.headers[0]).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
    expect(fake.headers[1]).toBe("x-keep: configured");
  });

  it("drops a late answer, which never stands in for a newer change", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    fake.withhold = "apply_flag_settings";
    await expect(
      timedOut(() => claude.attribute(attribution("1".repeat(64)))),
    ).resolves.toBe(UNAPPLIED);
    fake.withhold = undefined;
    await claude.attribute(attribution("2".repeat(64)));
    // Claude takes the stale change late: the next turn still writes its own.
    fake.answerLate();
    await claude.attribute(attribution("2".repeat(64)));
    await claude.send("current");
    expect(fake.headers[0]).toContain(`x-gw-ctx-message-id: ${"2".repeat(64)}`);
  });

  it("reports a refused update without failing the turn", async () => {
    const { claude, fake } = await started(ON_GATEWAY);
    fake.refuseEnv = true;
    await expect(claude.attribute(attribution(null))).resolves.toMatch(
      /didn't confirm Buzz's header change/,
    );
    await expect(claude.send("still runs")).resolves.toMatchObject({
      ok: true,
    });
    expect(fake.headers).toEqual(["x-keep: configured"]);
  });
});
