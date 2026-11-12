import { expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  createNotificationPreferences,
  parsePreferences,
} from "./preferences";
import { DEFAULT_SOUND } from "./sound";

const stored = {
  enabled: true,
  notifyWhileViewing: false,
  sound: true,
  categories: { mention: true, direct: true, thread: false },
};

it("values saved before per-category sounds restore with the defaults", () => {
  expect(parsePreferences(stored).sounds).toEqual(
    DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  );
});

it.each([
  { mention: "ping", direct: "unison", thread: "doop", agent: "doodone" },
  {
    mention: "silent",
    direct: "silent",
    thread: "silent",
    agent: "silent",
  },
])("saved sound choices round-trip: %j", (sounds) => {
  expect(
    parsePreferences(JSON.parse(JSON.stringify({ ...stored, sounds }))).sounds,
  ).toEqual(sounds);
});

it.each([["ping"], [null], [[]]])(
  "a sounds value that is not an object rejects the payload: %j",
  (sounds) => {
    expect(() => parsePreferences({ ...stored, sounds })).toThrow(
      "Invalid notification sounds",
    );
  },
);

it("a sound name this build lacks falls back to the default for its category only", () => {
  // "klaxon" stands in for a name a newer build bundles and this one does not
  // (what a #2877 build writes as "buzz"); it must never join SOUND_NAMES.
  const { sounds } = parsePreferences({
    ...stored,
    sounds: { mention: "klaxon", direct: 7, thread: null, agent: "doodone" },
  });
  expect(sounds).toEqual({
    mention: DEFAULT_SOUND,
    direct: DEFAULT_SOUND,
    thread: DEFAULT_SOUND,
    agent: "doodone",
  });
  expect(Object.isFrozen(sounds)).toBe(true);
});

it("restore keeps alerts on for an unknown sound name and leaves storage untouched", () => {
  const viewer = "a".repeat(64);
  const key = `buzz-notification-preferences.v1:${viewer}`;
  // Every category saved under a name this build lacks, as a #2877 build
  // writes its "buzz" default; "klaxon" must never join SOUND_NAMES.
  const saved = JSON.stringify({
    ...stored,
    sounds: {
      mention: "klaxon",
      direct: "klaxon",
      thread: "klaxon",
      agent: "klaxon",
    },
  });
  const store = new Map([[key, saved]]);
  const setItem = vi.fn((k: string, v: string) => void store.set(k, v));
  const host = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window;
  const service = createNotificationPreferences(host);
  service.selectViewer(viewer);
  expect(service.snapshot()).toEqual({
    preferences: { ...stored, sounds: DEFAULT_NOTIFICATION_PREFERENCES.sounds },
    error: null,
  });
  expect(setItem).not.toHaveBeenCalled();
  expect(store.get(key)).toBe(saved);
  expect(service.update({})).toBe(true);
  expect(JSON.parse(store.get(key) ?? "")).toEqual({
    ...stored,
    sounds: DEFAULT_NOTIFICATION_PREFERENCES.sounds,
  });
  service.dispose();
});
