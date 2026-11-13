import { expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import type { LiveCallbacks } from "./live";
import { createRelaySession } from "./session";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
} from "./testing";

function setup() {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, prioritize() {}, retry() {}, dispose() {} };
    },
  });
  const empty = (id: string) =>
    bounds(relay, id, "head", { has_more: false, next_cursor: null });
  live.receive(["a", "z"].map((id) => roster(relay, id, [viewer.pubkey])));
  return { relay, viewer, wire, live, owner, empty };
}

it("a cold selected channel dispatches while another retained catch-up is stalled", async () => {
  const h = setup();
  try {
    h.owner.session.channels.ensure("a");
    h.wire.next().respond([h.empty("a")]);
    await flush();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("a");
    await flush();
    const previous = h.wire.next();
    h.live.established("z");
    h.owner.session.channels.ensure("z");
    await flush();
    // Do not release the old catch-up to manufacture foreground capacity.
    expect(
      h.wire.pending.map((request) => request.filters[0]?.["#h"]),
    ).toContainEqual(["z"]);
    const row = message(h.viewer, "z", "cold head", 1700000001);
    h.wire.next().respond([row, h.empty("z")]);
    await flush();
    expect(
      h.owner.session.channels.window("z").rows.map((row) => row.id),
    ).toContain(row.id);
    previous.respond([h.empty("a")]);
  } finally {
    h.owner.dispose();
  }
});

it("a failed post-stream cold head leaves loading and exposes a retryable window", async () => {
  const h = setup();
  try {
    h.owner.session.channels.ensure("z");
    const beforeStream = h.wire.next();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("z");
    await flush();
    expect(beforeStream.signal?.aborted).toBe(true);
    h.wire.next().fail(new ReadError("unavailable", "Relay read timed out"));
    await flush();
    expect(h.owner.session.channels.window("z")).toMatchObject({
      status: "error",
      error: "Relay read timed out",
      rows: [],
    });
    h.owner.session.channels.ensure("z");
    await flush();
    const row = message(h.viewer, "z", "retried head", 1700000001);
    h.wire.next().respond([row, h.empty("z")]);
    await flush();
    expect(h.owner.session.channels.window("z")).toMatchObject({
      status: "ready",
      error: undefined,
    });
    expect(
      h.owner.session.channels.window("z").rows.map((row) => row.id),
    ).toContain(row.id);
  } finally {
    h.owner.dispose();
  }
});

it("quota refusal settles queued cold windows without another request and ensure respects cooldown", async () => {
  const h = setup();
  try {
    h.live.receive([roster(h.relay, "b", [h.viewer.pubkey])]);
    h.owner.session.channels.ensure("a");
    h.wire.next().respond([h.empty("a")]);
    await flush();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("a");
    await flush();
    const a = h.wire.next();
    h.live.established("b");
    h.owner.session.channels.ensure("b");
    await flush();
    const b = h.wire.next();
    h.live.established("z");
    h.owner.session.channels.ensure("z");
    await flush();
    expect(h.wire.pending).toHaveLength(0); // two owners, not a parallel drain
    a.fail(new ReadError("unavailable", "Relay requests paused", 429, 60000));
    await flush();
    expect(h.owner.session.channels.window("z")).toMatchObject({
      status: "error",
      error: "Relay requests paused",
      rows: [],
    });
    h.owner.session.channels.ensure("z");
    h.owner.session.live.retry();
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    b.respond([h.empty("b")]);
    await flush();
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    h.owner.session.channels.ensure("z");
    await flush();
    expect(h.wire.pending).toHaveLength(1);
    h.wire.next().respond([h.empty("z")]);
    await flush();
    expect(h.owner.session.channels.window("z").status).toBe("ready");
  } finally {
    vi.restoreAllMocks();
    h.owner.dispose();
  }
});

it("repeated selection shares a catch-up; reestablishment requires a new generation of evidence", async () => {
  const h = setup();
  try {
    h.live.state({ status: "connected", routes: [] });
    h.live.established("z");
    h.owner.session.channels.ensure("z");
    await flush();
    const old = h.wire.next();
    h.owner.session.channels.ensure("z");
    h.owner.session.channels.ensure("z");
    await flush();
    expect(h.wire.pending).toHaveLength(0);
    h.live.state({ status: "retrying", routes: [] });
    h.live.state({ status: "connected", routes: [] });
    h.live.established("z");
    await flush();
    expect(old.signal?.aborted).toBe(true);
    expect(h.wire.pending).toHaveLength(1);
    old.respond([h.empty("z")]);
    await flush();
    expect(
      h.owner.session.live.snapshot().heads.find((h) => h.channelId === "z")
        ?.state,
    ).toBe("pending");
    h.wire.next().respond([h.empty("z")]);
    await flush();
    expect(
      h.owner.session.live.snapshot().heads.find((h) => h.channelId === "z")
        ?.state,
    ).toBe("verified");
  } finally {
    h.owner.dispose();
  }
});

it("a rejected catch-up cannot fail a recreated window after cache clear", async () => {
  const h = setup();
  try {
    h.live.state({ status: "connected", routes: [] });
    h.live.established("z");
    h.owner.session.channels.ensure("z");
    await flush();
    const stale = h.wire.next();
    stale.fail(new ReadError("unavailable", "old failure"));
    // Reader has settled, but the rejection has not reached the session owner.
    await Promise.resolve();
    const clearing = h.owner.clearCache();
    h.owner.session.channels.ensure("z");
    await clearing;
    await flush();
    expect(h.owner.session.channels.window("z")).toMatchObject({
      status: "loading",
      error: undefined,
    });
    const fresh = h.wire.next();
    expect(fresh.filters[0]?.["#h"]).toEqual(["z"]);
    fresh.respond([h.empty("z")]);
    await flush();
    expect(h.owner.session.channels.window("z")).toMatchObject({
      status: "ready",
      error: undefined,
      freshness: "verified",
    });
  } finally {
    h.owner.dispose();
  }
});

it("selecting an already queued background catch-up promotes it without releasing profiles", async () => {
  const h = setup();
  try {
    const names = h.owner.session.profiles
      .ensure([h.viewer.pubkey], "background")
      .catch(() => {});
    const heldNames = h.wire.next();
    h.owner.session.channels.ensure("z");
    const initialZ = h.wire.next();
    h.owner.session.channels.ensure("a");
    // Z's notice read, sent beside its head, holds a read slot until it settles.
    await flush();
    h.wire.next().respond([h.empty("a")]);
    await flush();
    h.live.state({ status: "connected", routes: [] });
    h.live.established("z");
    await flush();
    expect(initialZ.signal?.aborted).toBe(true);
    expect(h.wire.pending).toHaveLength(0); // Z's inactive catch-up is queued behind profiles.
    h.owner.session.channels.ensure("z");
    h.owner.session.channels.ensure("z");
    await flush();
    expect(heldNames.signal?.aborted).toBe(false);
    expect(h.wire.pending).toHaveLength(1);
    const selected = h.wire.next();
    expect(selected.filters[0]?.["#h"]).toEqual(["z"]);
    selected.respond([h.empty("z")]);
    await flush();
    expect(h.owner.session.channels.window("z").status).toBe("ready");
    expect(h.wire.pending).toHaveLength(0);
    heldNames.respond([]);
    await names;
  } finally {
    h.owner.dispose();
  }
});
