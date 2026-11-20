import { browserOutboxStorage } from "../../src/features/relay/outbox-storage";
// Browser-only native boundary and controllable plugin. Production service,
// composition, admission, activity projection and UI are unchanged.
import type {
  AgentsNative,
  AgentIdentity,
} from "../../src/features/agents/native";
import type { BundledPlugin } from "../../src/plugins/manager";
import { createActivityTab } from "../../src/bundled/builderlab/adapter-type/Activity";
import type { WorkOutcome } from "../../src/features/agents/local-activity";
import type { Agents } from "../../src/features/agents/service";
import type { RelayData } from "../../src/features/relay/service";

// A real curve point: the owner's session derives a NIP-44 key with it to read
// the agent's memory.
export const localAgentKey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const resumable = import.meta.env.VITE_BUZZ_TEST_RESUME_AGENTS === true;
const identityKey = "buzz-test-resumable-agent";
let identities: AgentIdentity[] = resumable
  ? JSON.parse(sessionStorage.getItem(identityKey) ?? "[]")
  : [];
/** Requests the owner stopped, in order. */
const stopped: string[] = [];
const watched: string[] = [];
let services: { agents: Agents; relay: RelayData } | undefined;
const pending: {
  id: string;
  handover(): void;
  step(tool: string, target?: string): void;
  finish(result: WorkOutcome): void;
}[] = [];
/** The latest run of request `id`: a retried request runs again. */
const latest = (id: string) => {
  const row = pending.filter((row) => row.id === id).at(-1);
  if (!row) throw new Error("No pending request");
  return row;
};
const controls = {
  services: () => {
    if (!services) throw new Error("Local agent fixture is not ready");
    return services;
  },
  watched: () => [...watched],
  outboxStorage: browserOutboxStorage,
  pending: () => pending.map((row) => row.id),
  stopped: () => [...stopped],
  /** Hands over and, like a real harness, reports a first step. */
  handover(id: string) {
    const row = latest(id);
    row.handover();
    row.step("Read", "notes.txt");
  },
  step(id: string, tool: string, target?: string) {
    latest(id).step(tool, target);
  },
  finish(id: string, ok: boolean) {
    const row = latest(id);
    row.handover();
    row.finish(
      ok ? { ok: true } : { ok: false, error: "Fixture provider unavailable" },
    );
  },
};
declare global {
  interface Window {
    localAgentFixture: typeof controls;
  }
}
window.localAgentFixture = controls;
export function localAgentsNative(): AgentsNative {
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected native write in local activity fixture");
  };
  return {
    list: async () => identities,
    create: async (relay, owner, type, name) => {
      const identity = {
        pubkey: localAgentKey,
        relay,
        owner,
        type,
        name,
        deleted: false,
      };
      identities = [identity];
      if (resumable)
        sessionStorage.setItem(identityKey, JSON.stringify(identities));
      return identity;
    },
    portable: unsupported,
    port: unsupported,
    setPicture: unsupported,
    media: unsupported,
    rename: unsupported,
    remove: unsupported,
    forget: unsupported,
    publish: async (pubkey, event) => ({
      ...event,
      tags: event.tags?.map((tag) => [...tag]) ?? [],
      pubkey,
      id: crypto.randomUUID(),
      sig: "",
      created_at: Math.floor(Date.now() / 1000),
    }),
    query: async () => [],
    upload: unsupported,
    remember: unsupported,
    publishProfile: async () => {},
    claim: async () => true,
    release: async () => {},
    keepAwake: async () => {},
  };
}
export const localAgentPlugin: BundledPlugin = {
  manifest: { id: "fixture.local-agent", name: "Local agent", apiVersion: 1 },
  enabledByDefault: true,
  module: {
    inject: ["agents", "relay", "navigation"],
    apply(ctx) {
      services = { agents: ctx.agents, relay: ctx.relay };
      ctx.agents.register({
        id: "tester",
        title: "Local tester",
        resumes: resumable,
        defaults: () => ({ config: {} }),
        // The remote agent type's Activity tab, so published turns can be seen.
        tabs: [
          {
            id: "activity",
            title: "Activity",
            role: "activity",
            component: createActivityTab(
              ctx.relay,
              (section) =>
                void ctx.navigation.open({
                  version: 1,
                  kind: "settings",
                  section,
                }),
            ),
          },
        ],
        run(delivery) {
          if (delivery.trigger.type === "catch-up") {
            watched.push(
              ...delivery.trigger.events.map(({ event }) => event.content),
            );
            return;
          }
          if (delivery.trigger.type !== "mention")
            throw new Error("Unexpected trigger");
          let handover!: () => void, finish!: (result: WorkOutcome) => void;
          const done = new Promise<WorkOutcome>((resolve) => {
            finish = resolve;
          });
          delivery.workingUntil?.(done);
          const transferred = new Promise<void>((resolve) => {
            handover = resolve;
          });
          const id = delivery.trigger.event.id;
          // Like a harness, the stop ends the turn as it settles.
          delivery.interruptible?.(async () => {
            stopped.push(id);
            finish({ ok: true, stopped: true });
          });
          pending.push({
            id,
            handover,
            step: (tool, target) => delivery.step?.(tool, target),
            finish,
          });
          return transferred;
        },
      });
      let creating = false;
      const ensure = () => {
        if (
          creating ||
          ctx.relay.snapshot().status !== "ready" ||
          ctx.agents.snapshot().status !== "ready" ||
          ctx.agents.find(localAgentKey)
        )
          return;
        creating = true;
        queueMicrotask(() => {
          void ctx.agents.create({
            type: "fixture.local-agent/tester",
            name: "Local tester",
          });
        });
      };
      const stopRelay = ctx.relay.subscribe(ensure),
        stopAgents = ctx.agents.subscribe(ensure);
      ensure();
      ctx.effect(() => () => {
        services = undefined;
        stopRelay();
        stopAgents();
        for (const row of pending) {
          row.handover();
          row.finish({ ok: true });
        }
      });
    },
  },
};
