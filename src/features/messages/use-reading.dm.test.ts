// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "./use-reading";
import { createRelaySession } from "../relay/session";
import type { RelayEvent } from "../relay/events";
import type { RelaySession } from "../relay/session";
import type { ReadingHandle } from "../relay/unread";
import type { ReadStateSigning } from "../relay/read-state-host";
import {
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "../relay/read-state-storage";
import { keypair, message, metadata, roster } from "../relay/testing";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Test the production Node codec with disposable identities.
} from "../../../browser-host/read-state.mjs";

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("one bottom dwell in a DM reads only through the newest message it saw", async () => {
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair();
  let journal: ReadJournal | undefined;
  // Holds the first read after its change is applied, before it resolves.
  let commitHold: Promise<void> | undefined;
  let committed = () => {};
  const storage: ReadStateStorage = {
    capture: async () => journal && readJournal(journal, viewer.pubkey),
    async update(change) {
      journal = readJournal(change(journal), viewer.pubkey);
      if (commitHold && journal.state.frontiers.dm !== undefined) {
        const wait = commitHold;
        commitHold = undefined;
        committed();
        await wait;
      }
      return journal;
    },
    close() {},
  };
  let incoming: (events: readonly RelayEvent[]) => void = () => {};
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query: async () => [],
      media: () => undefined,
      readState: {
        decode: async (events: readonly RelayEvent[]) =>
          decodeReadState(events, viewer.secret),
        sign: async (intent: ReadStateSigning) =>
          signReadState(intent, viewer.secret),
        publish: async () => {},
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readStateStorage: storage,
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  stops.push(owner.dispose);
  const first = message(alice, "dm", "first", 11);
  incoming([
    roster(relay, "dm", [viewer.pubkey], 10),
    metadata(relay, "dm", "DM", 10, [["t", "dm"]]),
    first,
  ]);
  const unread = owner.session.unread;
  await unread.ensure();

  // A focused list whose only row is the fully visible newest message.
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const list = document.createElement("div");
  list.tabIndex = 0;
  document.body.append(list);
  list.focus();
  vi.spyOn(list, "getClientRects").mockReturnValue([
    new DOMRect(0, 0, 500, 500),
  ] as unknown as DOMRectList);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 500),
  );
  const row = document.createElement("div");
  row.dataset.messageId = first.id;
  list.append(row);
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 100, 400, 100),
  );
  // The real lease, recording disposal: the hook disposes a dwell's lease
  // only after both its catchUp and observe settle. Earlier leases are
  // cancelled before any dwell, so wait for the one that caught up.
  const disposed: boolean[] = [];
  let dwell: number | undefined;
  const session = {
    unread: {
      ...unread,
      reading(channelId: string): ReadingHandle {
        const lease = unread.reading(channelId);
        const index = disposed.push(false) - 1;
        return {
          ...lease,
          catchUp(...args: Parameters<ReadingHandle["catchUp"]>) {
            dwell = index;
            return lease.catchUp(...args);
          },
          dispose() {
            disposed[index] = true;
            lease.dispose();
          },
        };
      },
    },
  } as unknown as RelaySession;
  renderHook(useReading, {
    initialProps: {
      session,
      channelId: "dm",
      scroller: { current: list },
      settled: { current: true },
      latestMessageId: first.id,
    },
  });
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    committed = resolve;
  });
  commitHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  list.dispatchEvent(new Event("scroll"));
  // A scroll measures rows in the next frame.
  vi.advanceTimersToNextFrame();
  // Exactly one dwell: catchUp takes the cutoff and holds at commit.
  await vi.advanceTimersByTimeAsync(300);
  await reached;
  expect(journal?.state.frontiers.dm).toBe(11);
  // A reply arrives offscreen before the same dwell's observe runs.
  const reply = message(alice, "dm", "reply", 12);
  incoming([reply]);
  await vi.advanceTimersByTimeAsync(0);
  expect(unread.attention("dm", reply.id).unread).toBe(true);
  release();
  await vi.waitFor(() =>
    expect(dwell !== undefined && disposed[dwell]).toBe(true),
  );
  expect(journal?.state.frontiers.dm).toBe(11);
  expect(unread.attention("dm", reply.id).unread).toBe(true);
});
