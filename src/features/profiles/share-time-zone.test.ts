import { afterEach, expect, it, vi } from "vitest";
import { profileFromEvent } from "../communities/api";
import {
  backgroundProfileWrites,
  beginProfileSave,
  endProfileSave,
} from "../communities/profile-saves";
import type { Communities } from "../communities/service";
import { newer, type EventData } from "../relay/events";
import { keypair, profile } from "../relay/testing";
import {
  resetSharedTimeZones,
  shareDeviceTimeZone,
  withDeviceTimeZone,
} from "./share-time-zone";

const viewer = keypair();
const community = "https://community.example.org";
const zone = "Asia/Kolkata";

afterEach(resetSharedTimeZones);

function share(
  events: Promise<ReturnType<typeof profile>[]>,
  options: {
    zone?: string | undefined;
    signal?: AbortSignal;
    communities?: Communities;
    /** The strong read's events; the background read's by default. */
    strong?: () => Promise<EventData[]>;
  } = {},
) {
  const publish = vi.fn(async () => {});
  const { strong = () => events, ...rest } = options;
  const inspect = vi.fn(async () =>
    profileFromEvent(
      (await strong()).reduce<EventData | undefined>(newer, undefined),
    ),
  );
  return {
    publish,
    inspect,
    shared: shareDeviceTimeZone({
      community,
      viewer: viewer.pubkey,
      communities: {} as Communities,
      read: events,
      inspect,
      publish,
      zone,
      ...rest,
    }),
  };
}

it("adds the device zone to an existing profile that never had one, keeping its fields", async () => {
  const { publish, shared } = share(
    Promise.resolve([
      profile(viewer, { name: "Old", website: "https://example.org" }, 1),
      profile(
        viewer,
        {
          name: "Mic",
          display_name: "Mic",
          picture: "https://example.org/mic.png",
          website: "https://example.org",
        },
        2,
      ),
    ]),
  );
  expect(await shared).toBe(true);
  expect(publish).toHaveBeenCalledWith(
    { name: "Mic", picture: "https://example.org/mic.png", about: "" },
    {
      name: "Mic",
      display_name: "Mic",
      picture: "https://example.org/mic.png",
      website: "https://example.org",
      tz: zone,
    },
  );
  // Once per launch: a later fresh read in the same community publishes nothing.
  const again = share(Promise.resolve([profile(viewer, { name: "Mic" }, 3)]));
  expect(await again.shared).toBe(false);
  expect(again.publish).not.toHaveBeenCalled();
});

it.each([
  ["an opt-out", { name: "Mic", tz: "" }],
  ["a shared zone", { name: "Mic", tz: "Europe/Paris" }],
  ["a zone this engine rejects", { name: "Mic", tz: "Mars/Olympus" }],
  ["a handle the writer would rename", { name: "mic", display_name: "Mic" }],
])("leaves %s alone", async (_case, content) => {
  const { publish, shared } = share(
    Promise.resolve([profile(viewer, content)]),
  );
  expect(await shared).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});

it("publishes the strong read, not a lagging background read", async () => {
  // The background read still holds the profile from before another device
  // added a description; publishing it would revert that edit.
  const { publish, inspect, shared } = share(
    Promise.resolve([profile(viewer, { name: "Mic" }, 1)]),
    {
      strong: async () => [
        profile(
          viewer,
          { name: "Mic", about: "New bio", website: "https://example.org" },
          2,
        ),
      ],
    },
  );
  expect(await shared).toBe(true);
  expect(inspect).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledWith(
    { name: "Mic", picture: "", about: "New bio" },
    {
      name: "Mic",
      about: "New bio",
      website: "https://example.org",
      tz: zone,
    },
  );
});

it.each([
  ["has a zone by now", { name: "Mic", tz: "Europe/Paris" }],
  ["has opted out by now", { name: "Mic", tz: "" }],
  ["the writer would now rename", { name: "mic", display_name: "Mic" }],
])(
  "rechecks the strong read and leaves a profile that %s alone",
  async (_case, content) => {
    const { publish, shared } = share(
      Promise.resolve([profile(viewer, { name: "Mic" }, 1)]),
      { strong: async () => [profile(viewer, content, 2)] },
    );
    expect(await shared).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  },
);

it("reads strongly only when the background read would share", async () => {
  const { inspect, shared } = share(
    Promise.resolve([profile(viewer, { name: "Mic", tz: "" })]),
  );
  expect(await shared).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
});

it("publishes nothing after a failed strong read and tries again on the next read", async () => {
  const failed = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    strong: () => Promise.reject(new Error("offline")),
  });
  expect(await failed.shared).toBe(false);
  expect(failed.publish).not.toHaveBeenCalled();
  const next = share(Promise.resolve([profile(viewer, { name: "Mic" })]));
  expect(await next.shared).toBe(true);
});

it("stands aside for a profile save that is running or started after it began", async () => {
  const communities = {} as Communities;
  // A save running when the share begins.
  beginProfileSave(communities);
  const running = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    communities,
  });
  expect(await running.shared).toBe(false);
  expect(running.publish).not.toHaveBeenCalled();
  endProfileSave(communities);
  resetSharedTimeZones();
  // A save that starts and finishes while the strong read is in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const events = [profile(viewer, { name: "Mic" })];
  const started = share(Promise.resolve(events), {
    communities,
    strong: async () => {
      await held;
      return events;
    },
  });
  await vi.waitFor(() => expect(started.inspect).toHaveBeenCalled());
  beginProfileSave(communities);
  endProfileSave(communities);
  release();
  expect(await started.shared).toBe(false);
  expect(started.publish).not.toHaveBeenCalled();
});

it("retries after a run abandoned during its strong read", async () => {
  // The trigger restarts while the first run's strong read is in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const events = [profile(viewer, { name: "Mic" })];
  const controller = new AbortController();
  const first = share(Promise.resolve(events), {
    signal: controller.signal,
    strong: async () => {
      await held;
      return events;
    },
  });
  await vi.waitFor(() => expect(first.inspect).toHaveBeenCalled());
  controller.abort();
  const second = share(Promise.resolve(events));
  release();
  expect(await first.shared).toBe(false);
  expect(await second.shared).toBe(true);
  expect(first.publish).not.toHaveBeenCalled();
  expect(second.publish).toHaveBeenCalledOnce();
});

it("lets a save wait for a write it has handed to the writer", async () => {
  const communities = {} as Communities;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const { publish, shared } = share(
    Promise.resolve([profile(viewer, { name: "Mic" })]),
    { communities },
  );
  publish.mockImplementation(() => held);
  await vi.waitFor(() => expect(publish).toHaveBeenCalled());
  let settled = false;
  void backgroundProfileWrites(communities)?.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve));
  expect(settled).toBe(false);
  release();
  expect(await shared).toBe(true);
  await vi.waitFor(() => expect(settled).toBe(true));
});

it("never creates a profile", async () => {
  const other = keypair();
  const { publish, shared } = share(
    Promise.resolve([profile(other, { name: "Someone else" })]),
  );
  expect(await shared).toBe(false);
  expect(publish).not.toHaveBeenCalled();
});

it("publishes nothing after a failed read and tries again on the next one", async () => {
  const failed = share(Promise.reject(new Error("offline")));
  expect(await failed.shared).toBe(false);
  expect(failed.publish).not.toHaveBeenCalled();
  const next = share(Promise.resolve([profile(viewer, { name: "Mic" })]));
  expect(await next.shared).toBe(true);
});

it("publishes nothing when the read was abandoned or the device zone is unusable", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    signal: controller.signal,
  });
  expect(await aborted.shared).toBe(false);
  const unzoned = share(Promise.resolve([profile(viewer, { name: "Mic" })]), {
    zone: undefined,
  });
  expect(await unzoned.shared).toBe(false);
  expect(unzoned.publish).not.toHaveBeenCalled();
});

it("adds the device zone to a first or untouched profile but keeps an opt-out", () => {
  expect(withDeviceTimeZone({}, zone)).toEqual({ tz: zone });
  expect(withDeviceTimeZone({ tz: "" }, zone)).toEqual({ tz: "" });
  expect(withDeviceTimeZone({ name: "Mic" }, undefined)).toEqual({
    name: "Mic",
  });
});

it("remembers on this device that a community was settled, across launches", async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  try {
    // An opted-out profile settles the community on this device.
    const first = share(
      Promise.resolve([profile(viewer, { name: "Mic", tz: "" })]),
    );
    expect(await first.shared).toBe(false);
    // Next launch: another app has rewritten the profile without `tz`.
    vi.resetModules();
    const next = await import("./share-time-zone");
    const publish = vi.fn(async () => {});
    const events = [profile(viewer, { name: "Mic" })];
    expect(
      await next.shareDeviceTimeZone({
        community,
        viewer: viewer.pubkey,
        communities: {} as Communities,
        read: Promise.resolve(events),
        inspect: async () => profileFromEvent(events[0]),
        publish,
        zone,
      }),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    resetSharedTimeZones();
    vi.unstubAllGlobals();
  }
});

it("publishes nothing after a failed publication and tries again on the next read", async () => {
  const events = [profile(viewer, { name: "Mic" })];
  const failed = share(Promise.resolve(events));
  failed.publish.mockRejectedValueOnce(new Error("offline"));
  expect(await failed.shared).toBe(false);
  const next = share(Promise.resolve(events));
  expect(await next.shared).toBe(true);
  expect(next.publish).toHaveBeenCalledOnce();
});
