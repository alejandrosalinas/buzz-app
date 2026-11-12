import { createLocalAgentActivity } from "../agents/local-activity";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { expect, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type {
  SidebarDecoder,
  SidebarMuteMutator,
} from "../relay/sidebar-preferences";
import type { LiveCallbacks } from "../relay/live";
import type { ReadFilter } from "../relay/events";
import type { Communities } from "../communities/service";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  flush,
} from "../relay/testing";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "../relay/read-state-storage";
import { NotificationsService } from "./service";
import { createNotificationPreferences } from "./preferences";
import { provideNavigation } from "../navigation/service";
import { bindMessageNotifications, notificationAuthorized } from "./messages";

export const cleanups: (() => unknown)[] = [];
/** A real relay session with message notifications bound to it. */
export async function setup(
  /** Holds each read-state write; a function is asked once per write. */
  readBarrier: Promise<void> | (() => Promise<void>) = Promise.resolve(),
  readFrontier?: number,
  remote?: {
    observation: "bounded" | "snapshot";
    barrier: Promise<void>;
    decodeBarrier?: Promise<void>;
    frontier: number;
    channelsMounted?: boolean;
    deferRoster?: boolean;
  },
  sidebar?: { decode: SidebarDecoder; write?: SidebarMuteMutator },
  /** A signing host, so visible rows publish read intent as in production. */
  readIntent = false,
) {
  const viewer = keypair(),
    peer = keypair(),
    relay = keypair();
  const origin = "https://relay.example.com";
  let callbacks!: LiveCallbacks;
  let readState: ReadJournal | undefined =
    readFrontier === undefined
      ? undefined
      : {
          ...newReadJournal(),
          state: { frontiers: { room: readFrontier }, overrides: {} },
        };
  const markerQuery = vi.fn(async () => {
    await remote?.barrier;
    return [
      signed(viewer, {
        kind: 30078,
        tags: [
          ["d", `read-state:${"a".repeat(32)}`],
          ["t", "read-state"],
        ],
        content: "encrypted remote marker",
      }),
    ];
  });
  const decode = vi.fn(
    async (
      events: readonly ReturnType<typeof message>[],
      signal: AbortSignal,
    ) => {
      await remote?.decodeBarrier;
      signal.throwIfAborted();
      return events.map((event) => ({
        eventId: event.id,
        blob: {
          v: 1,
          client_id: "other-device",
          contexts: { room: remote?.frontier },
        },
      }));
    },
  );
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    remote && filters[0]?.kinds?.includes(30078)
      ? markerQuery()
      : ([] as ReturnType<typeof message>[]),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      query,
      ...(remote
        ? {
            readState: {
              decode,
              ...(remote.observation === "snapshot"
                ? { communityId: "test-community" }
                : {}),
            },
            ...(remote.observation === "snapshot"
              ? { readStateSnapshot: markerQuery }
              : {}),
          }
        : readIntent
          ? {
              readState: {
                decode: async () => [],
                sign: async () => {
                  throw new Error("Not publishing in this test");
                },
                publish: async () => {},
              },
            }
          : {}),
      ...(sidebar
        ? {
            decodeSidebarPreferences: sidebar.decode,
            ...(sidebar.write ? { writeSidebarMute: sidebar.write } : {}),
          }
        : {}),
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [createAgentDirectory()],
            subscribe: () => () => {},
          }),
      },
      ...(readIntent
        ? {
            readPublisherLock: async (
              _signal: AbortSignal,
              work: () => Promise<void>,
            ) => work(),
          }
        : {}),
      readStateStorage: {
        capture: async () => structuredClone(readState),
        async update(change) {
          await (typeof readBarrier === "function"
            ? readBarrier()
            : readBarrier);
          readState = readJournal(change(readState), viewer.pubkey);
          return readState;
        },
        close() {},
      },
    },
  );
  cleanups.push(owner.dispose);
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  cleanups.push(() => ctx.fiber.dispose());
  const navigation = provideNavigation(ctx);
  const data = new Map<string, string>();
  const preferences = createNotificationPreferences({
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window);
  let click = () => {};
  const show = vi.fn(async (_item, activate: () => void) => {
    click = activate;
  });
  const permission = vi.fn(async (): Promise<"granted"> => "granted");
  const listeners = new Set<() => void>();
  let selected: string | null = origin;
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer: viewer.pubkey,
      selected,
      memberships: [{ id: origin, name: "Example" }],
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    relay: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as Communities;
  const notifications = new NotificationsService(
    ctx,
    navigation.navigation,
    {
      label: "Test platform",
      permission,
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    preferences,
    (target) => notificationAuthorized(communities, target),
  );
  const discover = () =>
    callbacks.receive([
      roster(relay, "room", [viewer.pubkey]),
      metadata(relay, "room", "Room"),
    ]);
  // Channels starts the same shared observation once the roster is ready.
  if (remote?.channelsMounted) {
    discover();
    void owner.session.unread.ensure();
  }
  const activity = createLocalAgentActivity();
  const stop = bindMessageNotifications(
    notifications,
    communities,
    activity.reader,
  );
  cleanups.push(stop);
  await flush();
  // Names retain owner inventory independently of notification/roster startup.
  await vi.waitFor(() =>
    expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
  );
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: ReturnType<typeof message>[],
    phase?: "replay" | "live",
    channelId = "room",
  ) => callbacks.receive(events, phase ? { phase, channelId } : undefined);
  if (!remote?.channelsMounted && !remote?.deferRoster) discover();
  const make = (text: string, age = 0, author = peer) =>
    message(author, "room", text, Math.floor(Date.now() / 1000) - age, [
      ["p", viewer.pubkey],
    ]);
  return {
    owner,
    activity,
    notifications,
    navigation,
    emit,
    make,
    show,
    permission,
    query,
    markerQuery,
    decode,
    stop,
    discover,
    peer,
    relay,
    viewer,
    click: () => click(),
    deselect() {
      selected = null;
      for (const listener of listeners) listener();
    },
  };
}
