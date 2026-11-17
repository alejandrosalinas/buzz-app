// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, metadata, roster, signed } from "../relay/testing";
import { createHuddleComposerOwner } from "../huddle/composer-owner";
import { createHuddleComposerClient } from "../huddle/composer-client";
import { followUpMessage } from "./follow-up-message";
import { resolveForward } from "./resolve-forward";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const room = "20000000-0000-4000-8000-000000000001";
const source = "20000000-0000-4000-8000-000000000002";
async function fixture(denied = false) {
  const viewer = keypair(),
    relay = keypair();
  const original = message(viewer, source, "Cold public source", 1700000000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookupSignal: AbortSignal | undefined;
  let sourceLookups = 0;
  const messageReads = vi.fn();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://relay.example.test",
    relayHttpUrl: "https://relay.example.test",
    writer: {
      kinds: [9, 9007],
      sign: async (event) => signed(viewer, event),
      publish: async () => {},
    },
    media: () => undefined,
    query: async (filters, signal) => {
      if (
        filters.some(
          (f) => f.kinds?.includes(39000) && f["#d"]?.includes(source),
        )
      ) {
        sourceLookups++;
        lookupSignal = signal;
        await gate;
        if (denied) return [];
        return [
          metadata(relay, source, "Public source", 1700000000, [
            ["public"],
            ["t", "stream"],
          ]),
        ];
      }
      if (filters.some((f) => f.ids?.includes(original.id))) {
        messageReads();
        return [original];
      }
      if (filters.some((f) => f.kinds?.includes(39002)))
        return [roster(relay, room, [viewer.pubkey])];
      if (filters.some((f) => f.kinds?.includes(39000)))
        return [metadata(relay, room, "Destination")];
      return [];
    },
  });
  cleanup.push(() => owner.dispose());
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const reference = {
    version: 1 as const,
    origin: "https://relay.example.test",
    channelId: source,
    id: original.id,
  };
  expect(owner.session.channels.describe?.(source)).toEqual({
    state: "unknown",
  });
  return {
    session: owner.session,
    reference,
    release,
    messageReads,
    lookups: () => sourceLookups,
    signal: () => lookupSignal,
  };
}
it.each(["queued", "detached"] as const)(
  "resolves a cold unjoined public source before opening a %s forward",
  async (path) => {
    const h = await fixture();
    let resolve: () => Promise<unknown>;
    if (path === "queued") {
      // The restored entry contains only its persisted locator, no warm source row.
      const restored = JSON.parse(
        JSON.stringify({
          channelId: room,
          text: "",
          recipients: [],
          attachments: [],
          references: [],
          picks: {},
          forward: h.reference,
        }),
      );
      resolve = () => followUpMessage(h.session, restored).beforeRelease();
    } else {
      const owner = createHuddleComposerOwner(
        h.session,
        room,
        room,
        undefined,
        () => true,
        () => true,
      );
      cleanup.push(() => owner.dispose());
      const client = createHuddleComposerClient(owner.token);
      cleanup.push(() => client.dispose());
      await vi.waitFor(() => expect(client.snapshot().session).toBeDefined());
      resolve = async () =>
        client
          .snapshot()
          .session?.forwarding?.resolve(
            h.reference,
            new AbortController().signal,
          );
    }
    const result = resolve().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(h.lookups()).toBe(1));
      expect(h.messageReads).not.toHaveBeenCalled();
    } finally {
      h.release();
    }
    const answer = await result;
    expect(answer).not.toHaveProperty("error");
    expect(h.messageReads).toHaveBeenCalled();
    expect(h.session.channels.describe?.(source)).toMatchObject({
      state: "found",
      joined: false,
    });
    if (path === "detached")
      expect(answer).toMatchObject({
        value: { row: { content: "Cold public source" }, privateSource: false },
      });
  },
);
it("cancels cold source resolution without opening a thread", async () => {
  const h = await fixture();
  const controller = new AbortController();
  const result = resolveForward(h.session, h.reference, controller.signal).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await vi.waitFor(() => expect(h.lookups()).toBe(1));
    controller.abort();
    await vi.waitFor(() => expect(h.signal()?.aborted).toBe(true));
  } finally {
    h.release();
  }
  expect(await result).toHaveProperty("error");
  expect(h.messageReads).not.toHaveBeenCalled();
});

it("rejects a settled unavailable source without reading message content", async () => {
  const h = await fixture(true);
  h.release();
  await expect(
    resolveForward(h.session, h.reference, new AbortController().signal),
  ).rejects.toThrow();
  expect(h.lookups()).toBe(1);
  expect(h.messageReads).not.toHaveBeenCalled();
});
