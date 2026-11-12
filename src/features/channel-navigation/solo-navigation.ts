import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { JsonValue } from "../navigation/targets";
import type { PluginManager } from "../../plugins/manager";
import { relayPartition } from "../relay/partition";
import { ownSolo, soloLabels } from "../solo/labels";
import { regionLabels, soloRegionLabel } from "../solo/region-labels";
import { soloDraftTarget } from "./routes";
import { createSoloWorkspaces } from "./solo-workspaces";
import {
  projectSoloRegions,
  type RegisteredSoloSource,
  type SoloPlacement,
} from "./solo-navigation-model";
import type {
  SoloNavigation,
  SoloRegionBinding,
  SoloRegionHandle,
  SoloRegionSnapshot,
  SoloRegionSource,
} from "./solo-navigation-contract";

type Runtime = {
  source: RegisteredSoloSource;
  controller: AbortController;
  stop?: () => void;
  snapshot?: SoloRegionSnapshot;
  failed: boolean;
};
export type SoloNavigationSnapshot = SoloPlacement &
  Readonly<{ binding?: SoloRegionBinding }>;
const readers = new WeakMap<RelaySession, SoloNavigationService>();
export const soloNavigationFor = (session: RelaySession) =>
  readers.get(session);
/** A region's New chat draft, one per workspace as for ordinary New chat. */
export const regionDraftKey = (label: string, workspace?: string) =>
  `solo:region:${label}${workspace ? `:project:${workspace}` : ""}`;
/** View state linking a chat to the region draft it was started from. */
export const regionStartKey = (channelId: string) =>
  `solo-region-start:${channelId}`;
const sameBinding = (a: SoloRegionBinding | undefined, b: SoloRegionBinding) =>
  !!a &&
  a.scope === b.scope &&
  a.viewer === b.viewer &&
  a.incarnation === b.incarnation;

/** The connection owns source binding even while the sidebar is unmounted. */
export class SoloNavigationService extends Service implements SoloNavigation {
  readonly version = 2 as const;
  readonly workspaces;
  private readonly contributions;
  private readonly listeners = new Set<() => void>();
  private readonly runtimes = new Map<RegisteredSoloSource, Runtime>();
  private binding: SoloRegionBinding | undefined;
  private session: RelaySession | undefined;
  private connection: RelaySnapshot | undefined;
  private stopChannels: (() => void) | undefined;
  private value: SoloNavigationSnapshot = { regions: [], excluded: new Set() };
  private readonly titles = new Map<string, string>();
  private readonly states = new Map<string, JsonValue>();
  private pendingReveal: string | undefined;
  private pendingHostReveal: { id: string; explicit: boolean } | undefined;
  private readonly reveals = new Set<
    (channelId: string, explicit: boolean) => void
  >();
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    ctx: Context,
    private readonly relay: RelayData,
    private readonly plugins?: Pick<PluginManager, "snapshot" | "subscribe">,
  ) {
    super(ctx, "soloNavigation");
    this.workspaces = createSoloWorkspaces(
      (binding) =>
        sameBinding(this.binding, binding)
          ? this.session?.soloPreferences
          : undefined,
      relay.subscribe,
    );
    this.contributions = createContributions<
      SoloRegionSource & { identity: object }
    >(ctx);
    ctx.effect(() => this.contributions.subscribe(this.refresh));
    ctx.effect(() => relay.subscribe(this.bind));
    if (plugins) ctx.effect(() => plugins.subscribe(this.refresh));
    const navigation = ctx.navigation;
    if (navigation)
      ctx.effect(() =>
        navigation.subscribe(() => {
          const target = navigation.snapshot().entry.target;
          if (
            target.kind !== "conversation" ||
            target.channelId !==
              (this.pendingHostReveal?.id ?? this.pendingReveal) ||
            relayPartition(
              target.scope.communityOrigin,
              target.scope.viewer,
            ) !== this.connection?.scope
          )
            this.pendingReveal = this.pendingHostReveal = undefined;
        }),
      );
    ctx.effect(() => {
      this.bind();
      return () => {
        this.stopChannels?.();
        this.endBinding();
      };
    });
  }
  snapshot = () => this.value;
  sources = () => this.contributions.snapshot();
  reveal = (channelId: string, explicit = true) => {
    const target = this.ctx.navigation?.snapshot().entry.target;
    if (
      !this.value.excluded.has(channelId) ||
      (explicit &&
        (target?.kind !== "conversation" ||
          target.channelId !== channelId ||
          relayPartition(target.scope.communityOrigin, target.scope.viewer) !==
            this.connection?.scope))
    )
      return;
    this.pendingReveal = channelId;
    this.pendingHostReveal = { id: channelId, explicit };
    for (const listener of this.reveals) listener(channelId, explicit);
  };
  subscribeReveal = (
    listener: (channelId: string, explicit: boolean) => unknown,
    replay = false,
  ) => {
    const receive = (id: string, explicit: boolean) => {
      const handled = listener(id, explicit);
      if (replay && handled === true && this.pendingHostReveal?.id === id)
        this.pendingHostReveal = undefined;
    };
    this.reveals.add(receive);
    if (replay && this.pendingHostReveal)
      receive(this.pendingHostReveal.id, this.pendingHostReveal.explicit);
    return () => {
      this.reveals.delete(receive);
    };
  };
  presentation(source: RegisteredSoloSource, binding: SoloRegionBinding) {
    const active = () =>
      sameBinding(this.binding, binding) && this.sources().includes(source);
    return {
      revealRequests: {
        subscribe: (listener: (channelId: string) => void) => {
          const fenced = (channelId: string) => {
            if (
              active() &&
              this.value.regions.some(
                (region) =>
                  region.source === source && region.live.has(channelId),
              )
            ) {
              listener(channelId);
              if (this.pendingReveal === channelId)
                this.pendingReveal = undefined;
            }
          };
          const stop = this.subscribeReveal(fenced);
          if (this.pendingReveal) fenced(this.pendingReveal);
          return stop;
        },
      },
      state: this.regionState(source, binding),
    };
  }
  private regionState(
    source: RegisteredSoloSource,
    binding: SoloRegionBinding,
  ) {
    binding = Object.freeze({ ...binding });
    const active = () =>
      sameBinding(this.binding, binding) && this.sources().includes(source);
    const key = `solo-region-state:${binding.viewer}:${source.key}`;
    const memoryKey = `${binding.scope}/${key}`;
    const current = () => {
      if (!active()) throw new Error("This Solo region binding has ended");
    };
    return {
      get: () => {
        current();
        const saved = viewRevision(binding.scope, key);
        if (saved === undefined) {
          if (this.states.has(memoryKey))
            return structuredClone(this.states.get(memoryKey));
          throw new Error("Solo region storage is unavailable");
        }
        try {
          return saved === null ? undefined : (JSON.parse(saved) as JsonValue);
        } catch {
          throw new Error("Solo region state is invalid");
        }
      },
      set: (value: JsonValue) => {
        if (!active()) return false;
        try {
          const json = JSON.stringify(value);
          if (
            json === undefined ||
            new TextEncoder().encode(json).length > 16 * 1024
          )
            return false;
          const copy = JSON.parse(json) as JsonValue;
          const previous = this.states.get(memoryKey);
          // writeView notifies synchronously; a listener can accept a newer value.
          this.states.set(memoryKey, copy);
          if (!writeView(binding.scope, key, copy)) {
            if (previous === undefined) this.states.delete(memoryKey);
            else this.states.set(memoryKey, previous);
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      subscribe: (listener: () => void) => {
        current();
        const signal = this.runtimes.get(source)?.controller.signal;
        if (!signal || signal.aborted)
          throw new Error("This Solo region binding has ended");
        const stopView = subscribeView(binding.scope, (changedKey) => {
          if (active() && (changedKey === undefined || changedKey === key)) {
            try {
              listener();
            } catch {
              /* A source listener cannot reject an accepted storage write. */
            }
          }
        });
        const stop = () => {
          stopView();
          signal.removeEventListener("abort", stop);
        };
        signal.addEventListener("abort", stop, { once: true });
        return stop;
      },
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private endBinding() {
    this.pendingReveal = this.pendingHostReveal = undefined;
    for (const runtime of this.runtimes.values()) this.stop(runtime);
    this.runtimes.clear();
    if (this.session) readers.delete(this.session);
    this.binding = undefined;
  }
  private stop(runtime: Runtime) {
    runtime.controller.abort();
    try {
      runtime.stop?.();
    } catch {
      /* A broken plugin cannot retain the binding. */
    }
  }
  private bind = (force = false) => {
    const connection = this.relay.snapshot();
    if (
      force ||
      connection.session !== this.session ||
      connection.generation !== this.connection?.generation ||
      connection.scope !== this.connection?.scope ||
      connection.viewer !== this.connection?.viewer ||
      connection.cached !== this.connection?.cached
    ) {
      this.stopChannels?.();
      this.endBinding();
      this.session = connection.session;
      this.connection = connection;
      readers.set(connection.session, this);
      if (connection.scope && connection.viewer && !connection.cached) {
        this.binding = Object.freeze({
          scope: connection.scope,
          viewer: connection.viewer,
          incarnation: crypto.randomUUID(),
        });
      }
      this.stopChannels = connection.session.channels.subscribeList(
        this.refresh,
      );
    }
    this.refresh();
  };
  private refresh = () => {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const entries = this.contributions.snapshot();
        for (const [entry, runtime] of this.runtimes)
          if (!entries.includes(entry)) {
            this.stop(runtime);
            this.runtimes.delete(entry);
          }
        const binding = this.binding;
        const connection = this.relay.snapshot();
        if (!this.session) {
          this.value = { regions: [], excluded: new Set() };
          continue;
        }
        for (const source of entries) {
          if (!binding) break;
          let runtime = this.runtimes.get(source);
          if (!runtime) {
            runtime = {
              source,
              controller: new AbortController(),
              failed: false,
            };
            this.runtimes.set(source, runtime);
            try {
              source.bind(binding, runtime.controller.signal);
              runtime.stop = source.subscribe(this.refresh);
              if (typeof runtime.stop !== "function")
                throw new Error("Invalid region subscription");
            } catch {
              runtime.failed = true;
            }
          }
          if (runtime.failed) continue;
          try {
            const next = source.read(binding);
            if (
              !next ||
              !sameBinding(next.binding, binding) ||
              !Number.isSafeInteger(next.revision) ||
              next.revision < 0
            )
              continue;
            if (
              !["loading", "ready", "unavailable"].includes(next.status) ||
              (next.notice !== undefined &&
                (typeof next.notice !== "string" || next.notice.length > 120))
            )
              throw new Error("Invalid region snapshot");
            if (
              runtime.snapshot &&
              next.revision <= runtime.snapshot.revision
            ) {
              if (
                next.revision === runtime.snapshot.revision &&
                next !== runtime.snapshot &&
                import.meta.env.DEV
              )
                console.warn(
                  "Ignored different region snapshot at the same revision",
                );
              continue;
            }
            runtime.snapshot = next;
          } catch {
            runtime.failed = true;
          }
        }
        const placement = projectSoloRegions(
          this.session.channels.list().channels,
          connection.viewer ?? this.session.viewer ?? "",
          binding
            ? [...this.runtimes.values()]
            : entries.map((source) => ({ source, failed: false })),
          (label, title) => {
            const key = `solo-region-title:${label}`;
            const scope = connection.scope;
            if (!scope) return title ?? "Plugin chats";
            const cacheKey = `${scope}/${label}`;
            if (title && this.titles.get(cacheKey) !== title) {
              this.titles.set(cacheKey, title);
              writeView(scope, key, title);
            }
            const saved =
              this.titles.get(cacheKey) ?? readView(scope, key, "Plugin chats");
            return typeof saved === "string" ? saved : "Plugin chats";
          },
        );
        const plugins = this.plugins?.snapshot();
        const configuration = plugins?.configuration;
        this.value = {
          ...placement,
          regions: placement.regions.map((region) => {
            if (region.reason !== "off") return region;
            if (configuration?.status === "loading")
              return { ...region, reason: "loading" as const };
            if (configuration?.status !== "ready") return region;
            const plugin = configuration.catalog.plugins.find((plugin) =>
              region.key.startsWith(`${plugin.manifest.id}/`),
            );
            if (!plugin) return { ...region, reason: "not-installed" as const };
            if (
              !plugin.enabled ||
              (plugin.source === "external" &&
                configuration.externalPluginsPaused)
            )
              return region;
            const activation = plugins?.activation[plugin.manifest.id];
            const reason =
              activation?.revision !== plugin.revision
                ? "off"
                : activation.status === "starting"
                  ? "loading"
                  : activation.status === "failed"
                    ? "failed"
                    : "off";
            return { ...region, reason };
          }),
          ...(binding ? { binding } : {}),
        };
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
    for (const listener of this.listeners) listener();
  };
  /** The running source that owns a region draft, with its binding. */
  draftRegion(label: string) {
    const region = this.value.regions.find((item) => item.label === label);
    const binding = this.value.binding;
    return region?.source && !region.reason && binding
      ? { source: region.source, binding }
      : undefined;
  }
  async openCreatedWorkspace(workspaceId: string): Promise<boolean> {
    const region = this.value.regions.find((item) => item.source);
    const source = region?.source;
    if (!source?.composeWorkspaces || !source.openWorkspace) return false;
    const binding = this.value.binding;
    if (!binding || region?.reason)
      throw new Error("Workspace selection is not ready. Try again.");
    await source.openWorkspace(binding, workspaceId);
    return true;
  }
  retry = (key: string) => {
    if (this.sources().some((source) => source.key === key)) this.bind(true);
  };
  registerSource(source: SoloRegionSource): SoloRegionHandle {
    const owner = this.ctx.pluginOwner;
    if (!owner)
      throw new Error("Solo regions must belong to an installed plugin");
    const label = soloRegionLabel(owner.id, source.id);
    if (
      !source.title?.trim() ||
      source.title.length > 40 ||
      typeof source.bind !== "function" ||
      typeof source.read !== "function" ||
      typeof source.subscribe !== "function" ||
      !source.component ||
      (source.order !== undefined && !Number.isFinite(source.order))
    )
      throw new Error("Invalid Solo region source");
    const identity = {};
    const host = this;
    const active = (binding: SoloRegionBinding) =>
      sameBinding(host.binding, binding) &&
      host.contributions
        .snapshot()
        .some((entry) => entry.identity === identity);
    const current = (binding: SoloRegionBinding) => {
      if (!active(binding) || !host.session)
        throw new Error("This Solo region binding has ended");
      return host.session;
    };
    const started = (binding: SoloRegionBinding, channelId: string) => {
      current(binding);
      const saved = readView<unknown>(
        binding.scope,
        regionStartKey(channelId),
        null,
      );
      if (
        !saved ||
        typeof saved !== "object" ||
        !("region" in saved) ||
        saved.region !== label
      )
        return;
      return "workspace" in saved && typeof saved.workspace === "string"
        ? {
            workspace: saved.workspace,
            ...("lead" in saved && saved.lead === true
              ? { lead: true as const }
              : {}),
          }
        : {};
    };
    this.contributions.register(this.ctx, { ...source, identity });
    return Object.freeze({
      label,
      state(binding) {
        current(binding);
        const registered = host
          .sources()
          .find((entry) => entry.identity === identity);
        if (!registered) throw new Error("This Solo region binding has ended");
        return host.regionState(registered, binding);
      },
      openDraft(binding, input = {}) {
        current(binding);
        const { workspace } = input;
        if (
          (workspace !== undefined &&
            (typeof workspace !== "string" ||
              !workspace ||
              workspace.length > 256)) ||
          (input.lead && !workspace)
        )
          throw new Error("Invalid workspace");
        if (workspace) {
          // As New chat in a workspace: it starts there, and instructions
          // chosen for another workspace do not carry over.
          const key = regionDraftKey(label, workspace);
          const settings = readView<unknown>(
            binding.scope,
            `${key}:settings`,
            null,
          );
          if (
            readView(binding.scope, `${key}:new-project`, workspace) !==
              workspace &&
            settings &&
            typeof settings === "object"
          )
            writeView(binding.scope, `${key}:settings`, {
              ...settings,
              canvas: undefined,
            });
          writeView(binding.scope, `${key}:new-project`, null);
        }
        void host.ctx.navigation?.open(
          soloDraftTarget(binding.scope, {
            region: label,
            ...(workspace ? { project: workspace } : {}),
            ...(workspace && input.lead ? { lead: true } : {}),
          }),
        );
      },
      started,
      forget(binding, channelId) {
        if (started(binding, channelId))
          writeView(binding.scope, regionStartKey(channelId), null);
      },
      async createChat(binding, input) {
        const session = current(binding);
        const start = session.channelWrites.start(
          input.channelId,
          input.title,
          input.members,
          input.ttlSeconds,
          input.named,
          undefined,
          { labels: [label], active: () => active(binding) },
        );
        await start.ready;
      },
      async classify(binding, channelId) {
        const session = current(binding);
        const requireEligible = () => {
          const channel = session.channels
            .list()
            .channels.find((item) => item.id === channelId);
          if (
            !ownSolo(channel, binding.viewer) ||
            channel?.archived ||
            channel?.readOnly
          )
            throw new Error(
              "Only your own active Solo chats can join this region",
            );
        };
        requireEligible();
        const runtime = [...host.runtimes.values()].find(
          (item) => item.source.identity === identity,
        );
        const base = await session.channelDetails.load(
          channelId,
          runtime?.controller.signal,
        );
        current(binding);
        requireEligible();
        if (!soloLabels(base.labels))
          throw new Error("This conversation is no longer a Solo chat");
        const existing = regionLabels(base.labels);
        if (existing.some((value) => value !== label))
          throw new Error("This chat belongs to another region");
        if (!existing.includes(label))
          await session.channelDetails.save(
            base,
            { ...base, labels: [...(base.labels ?? []), label] },
            runtime?.controller.signal,
          );
      },
    });
  }
}

/** Recheck the shared projection immediately before a personal filing write. */
export function prepareSoloMove(session: RelaySession, channelId: string) {
  const region = soloNavigationFor(session)
    ?.snapshot()
    .regions.find((region) =>
      region.channels.some((channel) => channel.id === channelId),
    );
  return region ? `This chat is managed by ${region.title}.` : undefined;
}
