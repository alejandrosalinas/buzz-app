import { afterEach, expect, it, vi } from "vitest";
import {
  CHECK_MS,
  followRecommended,
  offRecommended,
  onRecommended,
  parseRecommended,
  candidatesFor,
  pickRecommended,
  recommendedCandidates,
  recommendedSetup,
  RETRY_MS,
  recommendedRun,
  recommendedNote,
  setRuntimeRecommendation,
  withRecommended,
} from "./recommended";

// Synthetic candidates; real values come only from a packager's build.
const CODEX = {
  harness: "codex",
  model: "model-a",
  effort: "high",
  label: "Model A",
};
const GOOSE = {
  harness: "goose",
  provider: "provider-b",
  model: "model-b",
  effort: "high",
  label: "Model B",
};
const recommend = (...candidates: object[]) =>
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(candidates));
afterEach(() => vi.unstubAllEnvs());

const harness = (id: string, ready: boolean | Error) => ({
  id,
  title: id === "codex" ? "Codex" : "Goose",
  recommends: vi.fn(async () => {
    if (ready instanceof Error) throw ready;
    return ready;
  }),
});

it("has no recommendation when the build sets none", async () => {
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", "");
  expect(recommendedCandidates()).toEqual([]);
  expect(candidatesFor("goose")).toEqual([]);
  const goose = harness("goose", true);
  expect(await pickRecommended([goose])).toBeUndefined();
  expect(goose.recommends).not.toHaveBeenCalled();
  // An agent saved on Recommended by another build runs on the default.
  const offered = vi.fn(async () => true);
  const run = recommendedRun("goose", offered);
  expect(await run.find()).toBeNull();
  expect(offered).not.toHaveBeenCalled();
  const saved = { preset: "recommended", model: "", effort: "" };
  expect(followRecommended(saved, saved, run.current())).toBe(saved);
});

it("parses candidates in order, several per harness, and rejects anything else", () => {
  const backup = { ...CODEX, model: "model-c", label: "Model C" };
  expect(parseRecommended(JSON.stringify([CODEX, GOOSE, backup]))).toEqual({
    candidates: [CODEX, GOOSE, backup],
  });
  expect(parseRecommended("  ")).toEqual({ candidates: [] });
  // Claude Code takes a candidate too, without a provider.
  const claude = { ...CODEX, harness: "claude-code", label: "Model D" };
  expect(parseRecommended(JSON.stringify([claude]))).toEqual({
    candidates: [claude],
  });
  for (const invalid of [
    "[]",
    "{}",
    "nope",
    JSON.stringify([{ ...CODEX, provider: "p" }]),
    JSON.stringify([{ ...GOOSE, provider: "" }]),
    JSON.stringify([{ ...GOOSE, harness: "pi" }]),
    JSON.stringify([{ ...CODEX, label: "" }]),
    JSON.stringify([{ ...CODEX, extra: "x" }]),
    JSON.stringify([{ ...CODEX, harness: "claude-code", provider: "p" }]),
  ])
    expect(() => parseRecommended(invalid)).toThrow(/BUZZ_RECOMMENDED_AGENT/);
});

it("keeps optional distributor attribution with the configured candidates", () => {
  const setup = {
    recommendedBy: "Example Co",
    description: "Prioritizes compatibility.",
    candidates: [CODEX, GOOSE],
  };
  expect(parseRecommended(JSON.stringify(setup))).toEqual(setup);
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(setup));
  expect(recommendedSetup()).toEqual(setup);
  expect(recommendedCandidates()).toEqual([CODEX, GOOSE]);
  expect(parseRecommended(JSON.stringify({ candidates: [CODEX] }))).toEqual({
    candidates: [CODEX],
  });
});

it("rejects malformed recommendation metadata without exposing its values", () => {
  for (const input of [
    { recommendedBy: "", candidates: [CODEX] },
    { recommendedBy: " secret-name ", candidates: [CODEX] },
    { recommendedBy: 42, candidates: [CODEX] },
    { description: "", candidates: [CODEX] },
    { description: " secret-description ", candidates: [CODEX] },
    { description: 42, candidates: [CODEX] },
    { recommendedBy: "secret-name", candidates: [] },
    { recommendedBy: "secret-name" },
    {
      recommendedBy: "secret-name",
      candidates: [CODEX],
      extra: "secret-value",
    },
    { recommendedBy: "secret-name", candidates: [{ ...CODEX, model: "" }] },
  ]) {
    expect(() => parseRecommended(JSON.stringify(input))).toThrow(
      /BUZZ_RECOMMENDED_AGENT/,
    );
    try {
      parseRecommended(JSON.stringify(input));
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
});

it("runs an agent on Recommended on the candidate found for its own harness", () => {
  // As a type reads a saved pointer: its fields blank, filled at each run.
  const saved = { provider: "", model: "", effort: "", preset: "recommended" };
  expect(onRecommended(saved)).toBe(true);
  expect(followRecommended(saved, saved, GOOSE)).toMatchObject({
    provider: "provider-b",
    model: "model-b",
    effort: "high",
  });
  // Codex takes no provider.
  expect(followRecommended(saved, { model: "", effort: "" }, CODEX)).toEqual({
    model: "model-a",
    effort: "high",
  });
  // Without a candidate, its own blank settings run on the harness default.
  expect(followRecommended(saved, saved, null)).toBe(saved);
  expect(followRecommended(saved, saved, undefined)).toBe(saved);
});

it("finds a harness's first offered candidate once, skipping failed checks", async () => {
  const second = { ...GOOSE, model: "model-c", label: "Model C" };
  recommend(CODEX, GOOSE, second);
  const offered = vi.fn(async ({ model }: { model: string }) => {
    if (model === "model-b") throw new Error("discovery failed");
    return true;
  });
  const run = recommendedRun("goose", offered);
  const changed = vi.fn();
  run.subscribe(changed);
  expect(run.current()).toBeUndefined();
  const [one, two] = [run.find(), run.find()];
  expect(await one).toEqual(second);
  expect(await two).toEqual(second);
  expect(run.current()).toEqual(second);
  expect(changed).toHaveBeenCalledOnce();
  // Only goose's candidates, in order, each asked once per launch.
  expect(offered.mock.calls.map(([{ model }]) => model)).toEqual([
    "model-b",
    "model-c",
  ]);
  await run.find();
  expect(offered).toHaveBeenCalledTimes(2);
});

it("falls back to the harness default when no candidate is offered", async () => {
  recommend(GOOSE);
  const run = recommendedRun("goose", async () => false);
  expect(await run.find()).toBeNull();
  expect(run.current()).toBeNull();
});

it("gives up on a hung check after a bounded wait, for the next candidate", async () => {
  vi.useFakeTimers();
  try {
    const second = { ...GOOSE, model: "model-c", label: "Model C" };
    recommend(GOOSE, second);
    const run = recommendedRun("goose", ({ model }) =>
      model === "model-b"
        ? new Promise<boolean>(() => {})
        : Promise.resolve(true),
    );
    const found = run.find();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(await found).toEqual(second);
  } finally {
    vi.useRealTimers();
  }
});

it("counts a marked config as on Recommended only while it names no model", () => {
  const marked = { provider: "", model: "", effort: "", preset: "recommended" };
  expect(onRecommended(marked)).toBe(true);
  expect(onRecommended({ preset: "recommended" })).toBe(true);
  for (const own of [{ model: "m" }, { provider: "p" }, { effort: "low" }]) {
    const chosen = { ...marked, ...own };
    expect(onRecommended(chosen)).toBe(false);
    expect(followRecommended(chosen, chosen, GOOSE)).toBe(chosen);
  }
});

it("leaves a config off Recommended unchanged, and drops only the preset", () => {
  const own = { provider: "p", model: "m", effort: "low" };
  expect(followRecommended(own, own, GOOSE)).toBe(own);
  expect(offRecommended({ ...own, preset: "recommended" })).toEqual(own);
  expect(offRecommended(own)).toBe(own);
  // Going on Recommended drops its own model settings, so neither a run nor
  // its synced settings can hold a level the recommendation contradicts.
  expect(withRecommended({ ...own, instructions: "Be brief." })).toEqual({
    instructions: "Be brief.",
    preset: "recommended",
  });
});

it("picks the first candidate this computer is ready for", async () => {
  recommend(CODEX, GOOSE);
  const codex = harness("codex", true);
  const goose = harness("goose", true);
  expect(await pickRecommended([goose, codex])).toEqual({
    type: codex,
    candidate: CODEX,
    skipped: [],
  });
  expect(goose.recommends).not.toHaveBeenCalled();
  // Nothing was skipped, so there is no note.
  const pick = await pickRecommended([goose, codex]);
  expect(pick && recommendedNote(pick)).toBeUndefined();
});

it("falls back to goose when Codex is missing, signed out or failing", async () => {
  recommend(CODEX, GOOSE);
  const goose = harness("goose", true);
  for (const ready of [false, new Error("not installed")]) {
    const codex = harness("codex", ready);
    expect(await pickRecommended([codex, goose])).toEqual({
      type: goose,
      candidate: GOOSE,
      skipped: [codex],
    });
    expect(codex.recommends).toHaveBeenCalledWith(CODEX);
    // One line names what it skipped, never the order.
    const pick = await pickRecommended([codex, goose]);
    expect(pick && recommendedNote(pick)).toBe(
      "Codex isn’t set up on this computer, so this uses Goose.",
    );
  }
  // On Windows Codex isn't registered at all, so nothing was skipped.
  expect(await pickRecommended([goose])).toEqual({
    type: goose,
    candidate: GOOSE,
    skipped: [],
  });
  // Hosted types and types that don't follow Recommended are never picked.
  expect(
    await pickRecommended([
      { id: "goose", title: "Goose", remote: {}, recommends: async () => true },
      { id: "codex", title: "Codex" },
    ]),
  ).toBeUndefined();
  expect(await pickRecommended([harness("goose", false)])).toBeUndefined();
});

it("skips a harness whose check hangs, after a bounded wait", async () => {
  vi.useFakeTimers();
  try {
    recommend(CODEX, GOOSE);
    const codex = {
      id: "codex",
      title: "Codex",
      recommends: vi.fn(() => new Promise<boolean>(() => {})),
    };
    const goose = harness("goose", true);
    const picked = pickRecommended([codex, goose]);
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(await picked).toMatchObject({ type: goose, skipped: [codex] });
  } finally {
    vi.useRealTimers();
  }
});

it("finds again after RETRY_MS when a failed check cut the finding short", async () => {
  vi.useFakeTimers();
  try {
    recommend(GOOSE);
    let fail = true;
    const offered = vi.fn(async () => {
      if (fail) throw new Error("offline");
      return true;
    });
    const run = recommendedRun("goose", offered);
    expect(await run.find()).toBeNull();
    // Kept within the window, so runs aren't held up by each retry.
    expect(await run.find()).toBeNull();
    expect(offered).toHaveBeenCalledOnce();
    fail = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(await run.find()).toEqual(GOOSE);
    expect(run.current()).toEqual(GOOSE);
  } finally {
    vi.useRealTimers();
  }
});

it("asks again after RETRY_MS once nothing was offered, as after a sign-in", async () => {
  vi.useFakeTimers();
  try {
    recommend(GOOSE);
    let ready = false;
    const offered = vi.fn(async () => ready);
    const run = recommendedRun("goose", offered);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    run.subscribe(() => {
      throw new Error("listener failed");
    });
    expect(await run.find()).toBeNull();
    // A failing listener doesn't stop the finding.
    expect(warn).toHaveBeenCalled();
    // Kept within the window, so runs aren't held up by each check.
    ready = true;
    expect(await run.find()).toBeNull();
    expect(offered).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(await run.find()).toEqual(GOOSE);
    expect(run.current()).toEqual(GOOSE);
    warn.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

it("names the candidate and field a build rejects, never their values", () => {
  for (const [list, message] of [
    ["nope", "BUZZ_RECOMMENDED_AGENT must be a JSON array"],
    [[GOOSE, "secret-text"], "BUZZ_RECOMMENDED_AGENT[1] must be an object."],
    [
      [GOOSE, { ...CODEX, harness: "secret-harness" }],
      "BUZZ_RECOMMENDED_AGENT[1].harness must be goose, codex or claude-code.",
    ],
    [
      [{ ...GOOSE, model: " secret-model " }],
      "BUZZ_RECOMMENDED_AGENT[0].model must be text without surrounding spaces.",
    ],
    [
      [{ ...GOOSE, provider: "" }],
      "BUZZ_RECOMMENDED_AGENT[0].provider must be text without surrounding spaces.",
    ],
    [
      [CODEX, { ...CODEX, provider: "secret-provider" }],
      "BUZZ_RECOMMENDED_AGENT[1].provider is only for goose.",
    ],
    [
      [{ ...CODEX, extra: "secret-value" }],
      'BUZZ_RECOMMENDED_AGENT[0] has an unknown field, "extra".',
    ],
  ] as const) {
    const text = typeof list === "string" ? list : JSON.stringify(list);
    let thrown = "";
    try {
      parseRecommended(text);
    } catch (error) {
      thrown = String((error as Error).message);
    }
    expect(thrown).toContain(message);
    expect(thrown).not.toMatch(/secret/);
  }
});

it("replaces candidates and attribution together at runtime, until cleared", () => {
  const build = {
    recommendedBy: "Example Co",
    description: "Prioritizes compatibility.",
    candidates: [CODEX],
  };
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify(build));
  try {
    setRuntimeRecommendation(
      parseRecommended(
        JSON.stringify({
          recommendedBy: "Example Team",
          description: "For short tasks.",
          candidates: [GOOSE],
        }),
      ),
    );
    expect(recommendedSetup().recommendedBy).toBe("Example Team");
    expect(recommendedSetup().description).toBe("For short tasks.");
    expect(recommendedCandidates()).toEqual([GOOSE]);
    expect(candidatesFor("codex")).toEqual([]);
    setRuntimeRecommendation(parseRecommended(JSON.stringify([GOOSE])));
    expect(recommendedSetup().recommendedBy).toBeUndefined();
    expect(recommendedSetup().description).toBeUndefined();
    // An empty list recommends nothing, over the build's.
    setRuntimeRecommendation({ candidates: [] });
    expect(recommendedCandidates()).toEqual([]);
    expect(recommendedSetup().recommendedBy).toBeUndefined();
    setRuntimeRecommendation(undefined);
    expect(recommendedCandidates()).toEqual([CODEX]);
    expect(recommendedSetup()).toEqual(build);
  } finally {
    setRuntimeRecommendation(undefined);
    vi.unstubAllEnvs();
  }
});

it("ignores an invalid list set at run time, keeping the last good one", () => {
  vi.stubEnv("VITE_BUZZ_RECOMMENDED_AGENT", JSON.stringify([CODEX]));
  try {
    expect(setRuntimeRecommendation({ candidates: [GOOSE] })).toBe(true);
    // A harness outside the closed set, and an unknown field, as a fetched
    // list might carry.
    const bad = [{ ...GOOSE, harness: "other" }] as never;
    expect(setRuntimeRecommendation({ candidates: bad })).toBe(false);
    expect(
      setRuntimeRecommendation({
        candidates: [{ ...CODEX, sandbox: "off" }],
      } as never),
    ).toBe(false);
    expect(recommendedCandidates()).toEqual([GOOSE]);
  } finally {
    setRuntimeRecommendation(undefined);
    vi.unstubAllEnvs();
  }
});
