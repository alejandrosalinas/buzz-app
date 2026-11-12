import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { OpenTarget } from "../navigation/targets";
import type { ConfigurationState } from "../../plugins/types";
import type { PluginStates } from "../../plugins/runtime";
import { Context } from "@deepseek-ai/cordis";
import { assert } from "vitest";
import { createRelaySession } from "../relay/session";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { ChannelSummary } from "../relay/contracts";
import type {
  SoloRegionBinding,
  SoloRegionHandle,
  SoloRegionSnapshot,
  SoloRegionSource,
} from "./solo-navigation-contract";
import { SoloNavigationService } from "./solo-navigation";

const label = "buzz.region:example:work";
export function createSoloRegionFixture(viewer = "a".repeat(64)) {
  const root = new Context();
  const navigation = createNavigationController(createMemoryHistory());
  root.provide("navigation", navigation.navigation);
  let configuration: ConfigurationState = {
    status: "ready",
    externalPluginsPaused: false,
    catalog: {
      profile: "fixture",
      location: "Fixture",
      plugins: [
        {
          manifest: { id: "example", name: "Example", apiVersion: 1 },
          source: "external",
          enabled: false,
          revision: "one",
          previous: null,
          reloadable: false,
          error: null,
        },
      ],
    },
  };
  const pluginListeners = new Set<() => void>();
  let activation: PluginStates = {};
  const plugins = {
    snapshot: () => ({
      configuration,
      activation,
      busy: false,
      error: null,
      refreshError: null,
    }),
    subscribe(listener: () => void) {
      pluginListeners.add(listener);
      return () => {
        pluginListeners.delete(listener);
      };
    },
  };
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const owner = createRelaySession(null);
  let channels: readonly ChannelSummary[] = [
    {
      id: "owned",
      name: "Owned",
      channelType: "solo",
      creator: viewer,
      labels: ["buzz.solo", label],
    },
    {
      id: "chat",
      name: "Chat",
      channelType: "solo",
      creator: viewer,
      labels: ["buzz.solo"],
    },
    { id: "unknown", name: "Unknown", labels: [label] },
    {
      id: "archived",
      name: "Archived",
      channelType: "solo",
      archived: true,
      labels: [label],
    },
    {
      id: "shared",
      name: "Shared",
      channelType: "solo",
      creator: "b".repeat(64),
      labels: ["buzz.solo", label],
    },
  ];
  let list = { status: "loading" as const, channels };
  const rosterListeners = new Set<() => void>(),
    relayListeners = new Set<() => void>();
  const session = {
    ...owner.session,
    viewer,
    channels: {
      ...owner.session.channels,
      list: () => list,
      subscribeList: (listener: () => void) => {
        rosterListeners.add(listener);
        return () => {
          rosterListeners.delete(listener);
        };
      },
    },
  };
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    session,
    viewer,
    scope: `https://fixture.invalid:${viewer}`,
  };
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: (listener) => {
      relayListeners.add(listener);
      return () => {
        relayListeners.delete(listener);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const service = new SoloNavigationService(root, relay, plugins);
  const register = async (changes: Partial<SoloRegionSource> = {}) => {
    let snapshot: SoloRegionSnapshot;
    let binding!: SoloRegionBinding;
    let signal!: AbortSignal;
    let handle!: SoloRegionHandle;
    let listener = () => {};
    const source: SoloRegionSource = {
      id: "work",
      title: "Work",
      icon: "W",
      component: () => null,
      bind(next, abort) {
        binding = next;
        signal = abort;
        snapshot = { status: "ready", binding, revision: 1 };
      },
      subscribe(next) {
        listener = next;
        return () => {
          listener = () => {};
        };
      },
      read: () => snapshot,
      ...changes,
    };
    const fiber = root
      .extend({ pluginOwner: { id: "example", revision: "one" } })
      .plugin((ctx) => {
        assert(ctx.soloNavigation);
        handle = ctx.soloNavigation.registerSource(source);
      });
    await fiber.await();
    return {
      handle,
      fiber,
      binding: () => binding,
      signal: () => signal,
      update(next: SoloRegionSnapshot) {
        snapshot = next;
        listener();
      },
    };
  };
  return {
    service,
    register,
    navigate(target: OpenTarget) {
      const result = navigation.navigation.open(target);
      navigation.complete(navigation.navigation.snapshot().attempt, {
        status: "opened",
      });
      return result;
    },
    plugins(next: ConfigurationState, nextActivation: PluginStates = {}) {
      configuration = next;
      activation = nextActivation;
      for (const listener of pluginListeners) listener();
    },
    session,
    relay,
    navigator: navigation.navigation,
    scope: connection.scope as string,
    async dispose() {
      await root.fiber.dispose();
      navigation.dispose();
      owner.dispose();
    },
    loseCoordinates() {
      connection = {
        status: "connecting",
        generation: connection.generation + 1,
        session,
      };
      for (const listener of relayListeners) listener();
    },
    cache() {
      connection = {
        ...connection,
        generation: connection.generation + 1,
        cached: true,
      };
      for (const listener of relayListeners) listener();
    },
    reconnect() {
      connection = { ...connection, generation: connection.generation + 1 };
      for (const listener of relayListeners) listener();
    },
    roster(next: readonly ChannelSummary[]) {
      channels = next;
      list = { status: "loading", channels };
      for (const listener of rosterListeners) listener();
    },
  };
}
