import type { Agents } from "../agents/service";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { dmVoiceAgent } from "./dm-agent";
import { huddleRoom } from "./lifecycle";
import type { EventData } from "../relay/events";
import { recentHuddles } from "./discovery";
import type { HuddleSnapshot, Huddles } from "./service";

const idle: HuddleSnapshot = { phase: "idle", muted: false, participants: [] };

/** A peer may have several devices. A leave retires its admission, not its key.
 * Only current-generation relay evidence can request a native seat. */
function ownerAdmissions(
  events: readonly EventData[],
  room: string,
  parent: string,
  authority: string | undefined,
  owner: string,
) {
  if (!authority) return [];
  const scoped = events.filter(
    (event) =>
      event.pubkey === authority &&
      [48101, 48102].includes(event.kind) &&
      huddleRoom(event) === room &&
      event.tags.some(([tag, value]) => tag === "h" && value === parent),
  );
  const records = scoped.flatMap((event) => {
    const body = JSON.parse(event.content);
    if (
      typeof body.generation !== "string" ||
      !body.generation ||
      typeof body.admission_id !== "string" ||
      !body.admission_id
    )
      return [];
    return [
      {
        event,
        generation: body.generation as string,
        admission: body.admission_id as string,
      },
    ];
  });
  records.sort((a, b) => {
    if (/^\d+$/.test(a.generation) && /^\d+$/.test(b.generation)) {
      const difference = BigInt(b.generation) - BigInt(a.generation);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
    }
    return (
      b.event.created_at - a.event.created_at ||
      b.event.id.localeCompare(a.event.id)
    );
  });
  // A delayed teardown from a retired opaque epoch cannot supersede a new join.
  const generation = records.find(
    ({ event }) => event.kind === 48101,
  )?.generation;
  const owned = records.filter(
    (record) =>
      record.generation === generation &&
      record.event.tags.some(([tag, value]) => tag === "p" && value === owner),
  );
  const left = new Set(
    owned
      .filter(({ event }) => event.kind === 48102)
      .map(({ admission }) => admission),
  );
  return [
    ...new Set(
      owned
        .filter(
          ({ event, admission }) =>
            event.kind === 48101 && !left.has(admission),
        )
        .map(({ admission }) => admission),
    ),
  ].sort();
}

/** A phone can supply the owner's audio while this desktop hosts their agent.
 * Only an eligible DM peer explicitly added to the room can receive a seat.
 * The native connection independently verifies membership and owner presence. */
export function remoteDmVoiceCalls(relay: RelayData, agents: Agents) {
  let connection: RelaySnapshot | undefined;
  let view: ReturnType<RelaySession["observe"]> | undefined;
  let stopView: (() => void) | undefined;
  let stopChannels: (() => void) | undefined;
  let stopChoices: (() => void) | undefined;
  let filterKey = "";
  let snapshot = idle;
  let selectedAgent: string | undefined;
  let admissions: string[] = [];
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(next: HuddleSnapshot) {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function refresh() {
    clearTimeout(timer);
    const current = connection;
    const events = view?.snapshot().events ?? [];
    if (
      !current?.scope ||
      !current.viewer ||
      !current.origin ||
      current.status !== "ready" ||
      current.cached
    ) {
      selectedAgent = undefined;
      publish(idle);
      return;
    }
    const { scope, viewer, origin } = current;
    const now = Date.now() / 1000;
    const future = events
      .filter(
        (event) =>
          event.kind === 48100 &&
          event.created_at > now &&
          event.created_at <= now + 30,
      )
      .map((event) => event.created_at);
    let deadline = future.length ? Math.min(...future) : undefined;
    const calls = current.session.channels
      .list()
      .channels.flatMap((parent) => {
        const destination = {
          scope: scope,
          viewer: viewer,
          relayUrl: origin,
          channelId: parent.id,
          channelName: parent.name,
        };
        const agent = dmVoiceAgent(current, destination, agents);
        if (agent?.type !== "buzz.codex/codex") return [];
        return recentHuddles(
          events,
          parent.id,
          current.session.relayAuthor,
          now,
        ).flatMap((room) => {
          const admissions = ownerAdmissions(
            events,
            room.id,
            parent.id,
            current.session.relayAuthor,
            viewer,
          );
          if (!admissions.length) return [];
          return [
            {
              room,
              destination,
              participants: [viewer],
              admissions,
              agent: agent.pubkey,
            },
          ];
        });
      })
      .sort(
        (a, b) =>
          b.room.startedAt - a.room.startedAt ||
          a.room.id.localeCompare(b.room.id),
      );
    const call = calls[0];
    if (!call) {
      selectedAgent = undefined;
      admissions = [];
      publish(idle);
    } else {
      if (
        snapshot.room !== call.room.id ||
        selectedAgent !== call.agent ||
        !call.admissions.some((id) => admissions.includes(id))
      )
        epoch++;
      selectedAgent = call.agent;
      admissions = call.admissions;
      publish({
        phase: "connected",
        id: `remote:${call.room.id}:${call.agent}:${epoch}`,
        room: call.room.id,
        destination: call.destination,
        participants: call.participants,
        muted: false,
      });
      deadline = Math.min(deadline ?? Infinity, call.room.startedAt + 3600);
    }
    if (deadline !== undefined)
      timer = setTimeout(refresh, Math.max(1, (deadline - now) * 1000));
  }

  function watch() {
    const current = connection;
    if (!current || disposed) return;
    const ids = current.session.channels
      .list()
      .channels.filter(
        (channel) =>
          current.scope &&
          current.viewer &&
          current.origin &&
          dmVoiceAgent(
            current,
            {
              scope: current.scope,
              viewer: current.viewer,
              relayUrl: current.origin,
              channelId: channel.id,
              channelName: channel.name,
            },
            agents,
          )?.type === "buzz.codex/codex",
      )
      .map((channel) => channel.id)
      .sort();
    const key = ids.join(":");
    if (key !== filterKey) {
      filterKey = key;
      stopView?.();
      view?.dispose();
      view = undefined;
      if (ids.length && current.status === "ready" && !current.cached) {
        view = current.session.observe([
          {
            kinds: [48100, 48101, 48102, 48103],
            "#h": ids,
            since: Math.floor(Date.now() / 1000) - 3600,
            limit: 500,
          },
        ]);
        stopView = view.subscribe(refresh);
        void view.refresh();
      }
    }
    refresh();
  }
  function connect() {
    const next = relay.snapshot();
    if (
      connection?.session === next.session &&
      connection.status === next.status &&
      connection.cached === next.cached
    ) {
      connection = next;
      watch();
      return;
    }
    stopChannels?.();
    stopChoices?.();
    stopView?.();
    view?.dispose();
    view = undefined;
    filterKey = "";
    connection = next;
    publish(idle);
    stopChannels = next.session.channels.subscribeList(watch);
    stopChoices = next.session.agentChoices.subscribe(watch);
    next.session.agentChoices.ensure(false, true);
    watch();
  }
  const stopRelay = relay.subscribe(connect);
  const stopAgents = agents.subscribe(watch);
  connect();
  return {
    snapshot: () => snapshot,
    voiceAgent: () => selectedAgent,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      stopRelay();
      stopAgents();
      stopChannels?.();
      stopChoices?.();
      stopView?.();
      view?.dispose();
      publish(idle);
      listeners.clear();
    },
  };
}

/** One seat owner arbitrates local and phone calls, preserving native exclusivity. */
export function withRemoteDmVoiceCalls(
  huddles: Huddles,
  remote: ReturnType<typeof remoteDmVoiceCalls>,
) {
  return {
    snapshot: () =>
      ["connecting", "connected", "leaving"].includes(huddles.snapshot().phase)
        ? huddles.snapshot()
        : remote.snapshot(),
    subscribe(listener: () => void) {
      const local = huddles.subscribe(listener),
        other = remote.subscribe(listener);
      return () => {
        local();
        other();
      };
    },
    voiceAgent: () =>
      ["connecting", "connected", "leaving"].includes(huddles.snapshot().phase)
        ? undefined
        : remote.voiceAgent(),
    voiceListening: huddles.voiceListening,
    voiceThinking: huddles.voiceThinking,
  };
}
