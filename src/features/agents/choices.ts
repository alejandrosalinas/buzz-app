import type { LocalAgent, LocalAgents } from "./local";
import type { AgentExecutionLocation } from "./execution-location";
import type { AgentLibrarySnapshot, createAgentLibrary } from "./library";
import type { ChannelList } from "../relay/contracts";
import { relayOrigin } from "../communities/destination";
import {
  archiveHides,
  type IdentityArchiveSnapshot,
  type IdentityArchives,
} from "../relay/identity-archives";
import { relayPartition } from "../relay/partition";

/** Community evidence, not process readiness or permission to grant access. */
export function sameCommunityAgents(
  agents: readonly LocalAgent[],
  scope: string,
) {
  const viewer = scope.slice(-64);
  if (!/^[0-9a-f]{64}$/.test(viewer)) return [];
  return agents.filter((agent) => {
    try {
      return (
        agent.owner === viewer &&
        relayPartition(relayOrigin(agent.relayUrl), viewer) === scope
      );
    } catch {
      return false;
    }
  });
}

type Choice = AgentLibrarySnapshot["identities"][number] & {
  managed: boolean;
  /** Known from this community's local/hosted source, never presence. */
  execution?: AgentExecutionLocation;
  runtime?: string;
  /** A managed agent's type on this machine; it grants no control. */
  type?: string;
  managedName?: string;
  /** Additional DM eligibility from completed owned hosted-agent records. */
  messageable?: true;
};

export function canMessageAgent(
  agent: Pick<Choice, "managed" | "messageable">,
) {
  return agent.managed || agent.messageable === true;
}
type SelectionSource = boolean | "templates";
type TemplateChoices = Pick<AgentLibrarySnapshot, "status" | "error"> & {
  identities: readonly Choice[];
  complete: boolean;
  pending: boolean;
};
export type AgentChoicesSnapshot = Omit<AgentLibrarySnapshot, "identities"> & {
  /** Every known agent, including archived ones: facts about existing content. */
  identities: readonly Choice[];
  /** Forward-looking choices: `identities` minus known-archived agents. */
  selectable: readonly Choice[];
  /** Archive evidence that produced `selectable`; templates require it ready. */
  archives: IdentityArchiveSnapshot;
  /** Templates mirror Agents, including source readiness and errors. */
  templates: TemplateChoices;
  /** Usable candidates do not imply complete evidence for automatic recipients. */
  complete: boolean;
  pending: boolean;
};

/** One read-only projection of existing sources. No directory scan, timer, runner
 * or write authority. The relay session owns its lifetime; native owns processes. */
export function createAgentChoices({
  scope,
  library,
  native,
  archives,
  signal,
}: {
  scope: string;
  library: ReturnType<typeof createAgentLibrary>["queries"];
  native?: LocalAgents | undefined;
  /** Absent only on hosts without archive evidence; nothing is then hidden. */
  archives?:
    | Pick<
        IdentityArchives,
        "snapshot" | "subscribe" | "state" | "ensure" | "refresh"
      >
    | undefined;
  signal: AbortSignal;
}) {
  const viewer = scope.slice(-64);
  const noArchives: IdentityArchiveSnapshot = Object.freeze({
    status: "unavailable",
    archived: [],
  });
  const empty: AgentChoicesSnapshot = {
    selectable: [],
    archives: noArchives,
    status: "unavailable",
    templates: {
      status: "unavailable",
      identities: [],
      complete: false,
      pending: false,
    },
    definitions: [],
    identities: [],
    complete: false,
    pending: false,
  };
  let cached:
    | {
        legacy: AgentLibrarySnapshot;
        local: ReturnType<LocalAgents["snapshot"]> | undefined;
        archive: IdentityArchiveSnapshot;
        value: AgentChoicesSnapshot;
      }
    | undefined;
  const snapshot = (): AgentChoicesSnapshot => {
    if (signal.aborted) return empty;
    const legacy = library.snapshot(),
      local = native?.snapshot(),
      archive = archives?.snapshot() ?? noArchives;
    if (
      cached?.legacy === legacy &&
      cached.local === local &&
      cached.archive === archive
    )
      return cached.value;
    const choices = new Map<string, Choice>();
    if (legacy.status === "ready")
      for (const row of legacy.identities)
        choices.set(row.pubkey, { ...row, managed: false });
    if (local?.status === "ready")
      for (const row of sameCommunityAgents(local.hosted ?? [], scope)) {
        choices.set(row.pubkey, {
          pubkey: row.pubkey,
          name: row.name,
          ...(row.picture ? { avatar: row.picture } : {}),
          ...choices.get(row.pubkey),
          managed: false,
          messageable: true,
          execution: "remote",
          ...(row.runtime ? { runtime: row.runtime } : {}),
        });
      }
    if (local?.status === "ready")
      for (const row of sameCommunityAgents(local.agents, scope)) {
        // Keep existing source names in serialized mentions; the shared name
        // resolver supplies native display labels independently.
        choices.set(row.pubkey, {
          pubkey: row.pubkey,
          name: row.name,
          ...choices.get(row.pubkey),
          ...(row.picture ? { avatar: row.picture } : {}),
          managed: true,
          managedName: row.name,
          execution: row.execution ?? "local",
          ...(row.type ? { type: row.type } : {}),
        });
      }
    const ready = legacy.status === "ready" || local?.status === "ready";
    const errors = [
      legacy.error,
      local?.status === "error" ? local.error : undefined,
    ].filter(Boolean);
    const templateSource =
      !local || local.status === "unavailable" ? legacy : local;
    const templates: TemplateChoices = {
      status: templateSource.status,
      identities: [...choices.values()]
        .filter((agent) => templateSource === legacy || agent.managed)
        .map((agent) => ({ ...agent, name: agent.managedName ?? agent.name })),
      complete: templateSource.status === "ready" && !templateSource.error,
      pending:
        templateSource === legacy
          ? legacy.status === "idle" || legacy.status === "loading"
          : local?.status === "loading",
      ...(templateSource.error ? { error: templateSource.error } : {}),
    };
    const value: AgentChoicesSnapshot = {
      templates,
      status: ready
        ? "ready"
        : errors.length
          ? "error"
          : legacy.status === "loading" || local?.status === "loading"
            ? "loading"
            : legacy.status === "idle"
              ? "idle"
              : "unavailable",
      pending:
        legacy.status === "idle" ||
        legacy.status === "loading" ||
        local?.status === "loading",
      complete:
        legacy.status === "ready" &&
        !legacy.error &&
        (!local || local.status === "ready" || local.status === "unavailable"),
      definitions: legacy.status === "ready" ? legacy.definitions : [],
      identities: [...choices.values()],
      selectable: [...choices.values()].filter(
        (agent) => !archiveHides(archives, agent.pubkey, viewer),
      ),
      archives: archive,
      ...(errors.length ? { error: errors.join(" ") } : {}),
    };
    cached = { legacy, local, archive, value };
    return value;
  };
  const usesLegacy = (source: SelectionSource) =>
    source === "templates"
      ? !native || native.snapshot().status === "unavailable"
      : source;
  // Booleans only toggle the legacy inventory; local agents are always chosen.
  const usesLocal = (source: SelectionSource) =>
    !!native && (source !== "templates" || !usesLegacy(source));
  return Object.freeze({
    snapshot,
    subscribe(listener: () => void) {
      if (signal.aborted) return () => {};
      const stopLibrary = library.subscribe(listener),
        stopNative = native?.subscribe(listener),
        stopArchives = archives?.subscribe(listener);
      const stop = () => {
        stopLibrary();
        stopNative?.();
        stopArchives?.();
        signal.removeEventListener("abort", retired);
      };
      const retired = () => {
        stop();
        listener();
      };
      signal.addEventListener("abort", retired, { once: true });
      return stop;
    },
    /** Selectors pass `archive` to demand the lazy archive read for `selectable`. */
    ensure(includeLegacy = true, archive = false) {
      if (signal.aborted) return;
      if (includeLegacy && library.snapshot().status === "idle")
        void library.refresh();
      if (archive && archives?.snapshot().status === "idle")
        void archives.ensure();
    },
    /** `fresh` rereads inventory even over a read already in flight, as after
     * a change that read may predate. */
    async refresh(source: SelectionSource = true, { fresh = false } = {}) {
      if (signal.aborted) return;
      await Promise.all([
        usesLegacy(source) ? library.refresh({ fresh }) : undefined,
        usesLocal(source) ? native?.refresh() : undefined,
        // Archive reads stay lazy; templates always need fresh evidence.
        source === "templates" || archives?.snapshot().status !== "idle"
          ? archives?.refresh()
          : undefined,
      ]);
    },
    retain() {
      if (signal.aborted) return () => {};
      // Demand survives reconnect; ensure/explicit Refresh owns reads. A fresh
      // completion mount must not replace ready evidence with loading state.
      return library.retain({ refresh: false });
    },
  });
}

/** Match the Agents page's source, retaining community and archive policy at the
 * action boundary. Never substitute old-library identities during a native error.
 * Templates are stricter than `selectable`: they need verified non-archived state. */
export function templateAgentChoices(
  agents: AgentChoicesSnapshot,
  channels: ChannelList,
) {
  const members = new Set(
    channels.status === "ready"
      ? channels.channels.flatMap((c) => c.members ?? [])
      : [],
  );
  const { archives } = agents;
  if (archives.status !== "ready") return [];
  return agents.templates.identities.filter(
    (agent) =>
      (agent.managed || members.has(agent.pubkey)) &&
      !archives.archived.includes(agent.pubkey),
  );
}
