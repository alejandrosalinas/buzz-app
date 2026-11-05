// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createAppearance } from "../shared/theme/service";
import { deviceSettings } from "./device-settings";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Sets `key` to `value` as an agent's settings_set would. */
const set = (
  settings: ReturnType<typeof deviceSettings>,
  key: string,
  value: unknown,
) => settings.set(key, value);

it("offers appearance and the message and agent preferences, and nothing else", () => {
  const appearance = createAppearance(window);
  expect(
    deviceSettings(appearance)
      .list()
      .map(({ key, value, saved }) => ({ key, value, saved })),
  ).toEqual([
    { key: "appearance.mode", value: "system", saved: true },
    { key: "appearance.interface_size", value: 100, saved: true },
    { key: "appearance.accent", value: "citrus", saved: true },
    { key: "appearance.vibe", value: "low", saved: true },
    { key: "conversations.thread_placement", value: "side", saved: true },
    {
      key: "conversations.follow_up_behavior",
      value: "immediate",
      saved: true,
    },
    { key: "conversations.autocorrect", value: false, saved: true },
    { key: "agents.remember_mentioned", value: true, saved: true },
    { key: "search.unread_first", value: true, saved: true },
  ]);
  appearance.dispose();
});

it("changes appearance as its own controls do: live, saved and announced", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  const listener = vi.fn();
  appearance.subscribe(listener);
  expect(set(settings, "appearance.mode", "dark")).toMatchObject({
    value: "dark",
    saved: true,
  });
  expect(document.documentElement.dataset.colorMode).toBe("dark");
  expect(set(settings, "appearance.interface_size", 120).value).toBe(120);
  expect(
    document.documentElement.style.getPropertyValue("--buzz-text-scale"),
  ).toBe("1.2");
  expect(set(settings, "appearance.accent", "cobalt").value).toBe("cobalt");
  expect(set(settings, "appearance.vibe", "high").value).toBe("high");
  expect(listener).toHaveBeenCalledTimes(4);
  appearance.dispose();
  // Another window, or the next launch, reads what was saved.
  const next = createAppearance(window);
  expect(
    deviceSettings(next)
      .list()
      .slice(0, 4)
      .map(({ value }) => value),
  ).toEqual(["dark", 120, "cobalt", "high"]);
  next.dispose();
});

it("refuses an accent's legacy alias rather than mapping it", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  for (const value of ["flame", "gray", "Cobalt"])
    expect(() => set(settings, "appearance.accent", value)).toThrow(
      /appearance.accent takes/,
    );
  expect(appearance.snapshot().accent).toBe("citrus");
  appearance.dispose();
});

it("answers saved false with the owner's reason when storage refuses", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  expect(set(settings, "appearance.mode", "dark")).toMatchObject({
    value: "dark",
    saved: false,
    problem: expect.stringMatching(/could not be saved/),
  });
  expect(set(settings, "conversations.thread_placement", "main")).toEqual(
    expect.objectContaining({
      value: "main",
      saved: false,
      problem: expect.stringMatching(/could not be saved/),
    }),
  );
  vi.mocked(Storage.prototype.setItem).mockRestore();
  expect(set(settings, "conversations.thread_placement", "side").saved).toBe(
    true,
  );
  appearance.dispose();
});

it("changes nothing after the appearance it was made with is disposed", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  appearance.dispose();
  expect(() => set(settings, "appearance.mode", "dark")).toThrow(
    "Buzz is closing",
  );
  expect(localStorage.length).toBe(0);
});

it("moves new threads, saved and announced to open settings screens", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  const changed = vi.fn();
  window.addEventListener("buzz-thread-placement-changed", changed);
  expect(set(settings, "conversations.thread_placement", "main")).toEqual({
    key: "conversations.thread_placement",
    description: expect.any(String),
    schema: { type: "string", enum: ["side", "main"] },
    applies: expect.stringMatching(/New thread tabs only/),
    value: "main",
    saved: true,
  });
  expect(changed).toHaveBeenCalledOnce();
  expect(localStorage.getItem("buzz-thread-placement.v1")).toBe("main");
  window.removeEventListener("buzz-thread-placement-changed", changed);
  appearance.dispose();
});

it("changes the message and agent preferences through their own setters", () => {
  const appearance = createAppearance(window);
  const settings = deviceSettings(appearance);
  const changed = vi.fn();
  const events = [
    "buzz-follow-up-behavior-changed",
    "buzz-message-autocorrect-changed",
    "buzz-remember-mentioned-agents-changed",
  ];
  for (const event of events) window.addEventListener(event, changed);
  expect(set(settings, "conversations.follow_up_behavior", "queue").value).toBe(
    "queue",
  );
  expect(set(settings, "conversations.autocorrect", true).value).toBe(true);
  expect(set(settings, "agents.remember_mentioned", false).value).toBe(false);
  expect(changed).toHaveBeenCalledTimes(3);
  expect(localStorage.getItem("buzz-follow-up-behavior.v1")).toBe("queue");
  expect(localStorage.getItem("buzz-message-autocorrect.v1")).toBe("on");
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
  // Booleans take only true or false, not their stored spelling.
  for (const value of ["on", "off", 1, 0])
    expect(() => set(settings, "agents.remember_mentioned", value)).toThrow(
      "agents.remember_mentioned takes true or false",
    );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  for (const [key, value] of [
    ["conversations.follow_up_behavior", "immediate"],
    ["conversations.autocorrect", false],
    ["agents.remember_mentioned", true],
  ] as const)
    expect(set(settings, key, value)).toMatchObject({
      value,
      saved: false,
      problem: expect.stringMatching(/could not be saved/),
    });
  vi.mocked(Storage.prototype.setItem).mockRestore();
  // Saving again clears each owner's unsaved state.
  for (const key of [
    "conversations.follow_up_behavior",
    "conversations.autocorrect",
    "agents.remember_mentioned",
  ])
    expect(set(settings, key, settings.get(key).value).saved).toBe(true);
  for (const event of events) window.removeEventListener(event, changed);
  appearance.dispose();
});
