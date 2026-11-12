import { Context } from "@deepseek-ai/cordis";
import type { EventTemplate } from "nostr-tools";
import { vi, type Mock } from "vitest";
import {
  AgentsService,
  type AgentCommunities,
} from "../../features/agents/service";
import { BrowserService } from "../../features/browser/service";
import { DecisionsService } from "../../features/decisions/service";
import type { BrowserPlatform } from "../../features/browser/platform";
import type {
  ClientSnapshot,
  KnownCommunities,
} from "../../features/communities/service";
import { HostService } from "../../features/host/service";
import type { Navigation } from "../../features/navigation/controller";
import { ConversationService } from "../../features/conversation/service";
import { PagesService } from "../../features/pages/service";
import { PanelsService } from "../../features/panels/service";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import type { OutgoingEvent } from "../../features/relay/outbox";
import { relayPartition } from "../../features/relay/partition";
import { matchesEvent } from "../../features/relay/projection";
import type { RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { SettingsCardsService } from "../../features/settings/service";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import * as builderlab from "../builderlab/index";
import builderlabManifest from "../builderlab/manifest.json";
import { deferred } from "../builderlab/test-helpers";
import { federatedFixture } from "../../features/federated-identity/testing";
import * as bestiePlugin from "./index";
import bestieManifest from "./manifest.json";
import {
  createRemoteBestie,
  type ModelChoice,
  type RemoteBestie,
} from "./setup";

export const COMMUNITY = "https://community.example";
export const HOME = "11111111-1111-4111-8111-111111111111";
export const cleanups: (() => Promise<void> | void)[] = [];

/** The fake catalog's model and an effort it supports. */
export const MODEL: ModelChoice = {
  modelId: "model-a",
  reasoningEffort: "high",
};
type Row = {
  key: string;
  agent_id: string;
  agent_name: string;
  agent_picture_url?: string;
  agent_pubkey: string;
  status: number;
  agent_instructions?: string;
  model_id?: string;
  reasoning_effort?: string;
  model_selection_status?: number;
};
type Reply = { status: number; body: unknown };

/** Real Builderlab and Bestie plugins, Agents service, relay session and
 * Outbox. Only the native bridge (Beekeeper HTTP, login, owner signing) and the
 * relay wire are simulated. `invoke` is the test file's mocked Tauri invoke. */
export async function bestieFixture(
  invoke: Mock,
  options: {
    mainAgent?: {
      read(signal: AbortSignal): Promise<string | undefined>;
      write(agent: string | null, signal: AbortSignal): Promise<void>;
    };
  } = {},
) {
  const identity = keypair();
  const authority = keypair();
  const remote = keypair();
  const rows: Row[] = [];
  /** Per-endpoint one-shot replies, such as a refused account. */
  const replies = new Map<string, Reply>();
  const holds = new Map<string, Promise<void>>();
  let signInCanceled = false;
  let registered = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === "identity_restore") return identity.pubkey;
    if (command === "identity_prepare_remote_agent_authorization")
      return ["auth", identity.pubkey, "", "ef".repeat(64)];
    if (command === "nsec_backup_session" || command === "nsec_backup_retry")
      return;
    throw new Error(`Unexpected command ${command}`);
  });
  // An FI build: Builderlab signs in with the native NIP-FI session.
  vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "1");
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  const federated = federatedFixture("owner", "owner@example.com");
  const signIn = vi.mocked(federated.service.signIn);
  const signedIn = signIn.getMockImplementation();
  signIn.mockImplementation(async () => {
    if (!signInCanceled && signedIn) return signedIn();
    signInCanceled = false;
    return federated.service.snapshot();
  });
  federated.request.mockImplementation(async ({ path: route, body: sent }) => {
    const url = `https://builderlab.example${route}`;
    const path = route.split("/").at(-1) ?? "";
    const body = JSON.parse(sent || "{}");
    const hold = holds.get(path);
    holds.delete(path);
    if (hold) await hold;
    const reply = replies.get(path);
    replies.delete(path);
    if (reply)
      return {
        status: reply.status,
        headers: {},
        body: JSON.stringify(reply.body),
      };
    let result: unknown;
    if (path === "me")
      result = {
        subject: "owner",
        email: "owner@example.com",
        capabilities: { can_use_remote_agents: true },
      };
    // The owner's key is already linked, so setup skips binding it.
    else if (path === "current")
      result = { identity: { pubkey_hex: identity.pubkey } };
    else if (path === "list-agents") result = { status: 1, agents: rows };
    else if (path === "get-model-catalog")
      result = {
        models: [
          {
            id: "model-a",
            display_name: "Model A",
            supported_reasoning_efforts: ["low", "high"],
          },
        ],
      };
    // Builderlab's known-communities sync, which signing in starts.
    else if (url.endsWith("/known-communities/list"))
      result = { communities: [] };
    else if (path === "register-agent") {
      // Beekeeper replays a registration by its idempotency key.
      let row = rows.find((item) => item.key === body.idempotency_key);
      if (!row) {
        row = {
          key: body.idempotency_key,
          agent_id: `id-${registered}`,
          agent_name: body.agent_name,
          agent_picture_url: body.agent_picture_url,
          agent_pubkey: registered++ ? keypair().pubkey : remote.pubkey,
          status: 1,
        };
        rows.push(row);
      }
      result = {
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      };
    } else if (path === "attest-agent") {
      const row = rows.find((item) => item.agent_pubkey === body.agent_pubkey);
      if (!row) throw new Error("No registered agent");
      row.status = 2;
      result = { status: 1 };
    } else if (path === "update-agent") {
      const row = rows.find((item) => item.agent_pubkey === body.agent_pubkey);
      if (row) {
        if (body.agent_instructions !== undefined)
          row.agent_instructions = body.agent_instructions;
        if (body.model_id) {
          row.model_id = body.model_id;
          row.reasoning_effort = body.reasoning_effort;
          row.model_selection_status = 1;
        }
      }
      result = {};
    } else if (path === "delete-agent") {
      const index = rows.findIndex((item) => item.agent_id === body.agent_id);
      if (index >= 0) rows.splice(index, 1);
      result = { status: index >= 0 ? 1 : 3 };
    } else throw new Error(`Unexpected Builderlab endpoint: ${path}`);
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });

  // Relay wire: channel commands become relay-signed metadata and rosters.
  const channels = new Map<
    string,
    {
      members: string[];
      visibility: "open" | "private";
      labels: string[][];
    }
  >();
  let clock = 1_700_000_000;
  let failKind: number | undefined;
  /** A relay that accepts a create without applying its `p` members. */
  let createMembers = true;
  const events: RelayEvent[] = [];
  let saved: readonly OutgoingEvent[] = [];
  let closed = deferred<void>();
  /** The session whose Outbox owns storage; a crashed one's late saves are lost. */
  let storageOwner = 0;
  /** An Outbox write held before it commits, as if the disk were slow. */
  let heldSave: { kind: number; gate: Promise<void> } | undefined;
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    [
      ...events,
      ...[...channels].flatMap(([id, home]) => [
        metadata(authority, id, "Bestie", clock, [
          [home.visibility === "private" ? "private" : "public"],
          ["t", "stream"],
          ...home.labels,
        ]),
        roster(authority, id, home.members, clock),
        signed(authority, {
          kind: 39001,
          created_at: clock,
          content: "",
          tags: [
            ["d", id],
            ["p", identity.pubkey, "admin"],
          ],
        }),
      ]),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter))),
  );
  const sign = vi.fn(async (event: EventTemplate) => signed(identity, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    if (failKind === event.kind) {
      failKind = undefined;
      throw new Error("Receipt lost");
    }
    events.push(event);
    const tag = (name: string) =>
      event.tags.find(([key]) => key === name)?.[1] ?? "";
    if (event.kind === 9007)
      // The relay adds the create's `p` members (block/buzz#8421).
      channels.set(tag("h"), {
        members: [
          identity.pubkey,
          ...(createMembers
            ? event.tags.flatMap(([key, value]) =>
                key === "p" && value ? [value] : [],
              )
            : []),
        ],
        visibility: tag("visibility") as "open" | "private",
        labels: event.tags.filter(
          ([key, value]) => key === "t" && value !== "stream",
        ),
      });
    if (event.kind === 9000) channels.get(tag("h"))?.members.push(tag("p"));
    clock++;
  });
  const start = () => {
    const id = ++storageOwner;
    const done = closed;
    return createRelaySession(
      {
        viewer: identity.pubkey,
        relayAuthor: authority.pubkey,
        channelIdentity: true,
        scope: COMMUNITY,
        media: () => undefined,
        query,
        writer: {
          kinds: [9, 9000, 9007, 30177, 46020, 5],
          sign,
          publish,
        },
        workflows: { runs: async () => ({ runs: [], next: null }) },
        ...(options.mainAgent
          ? {
              readMainAgent: options.mainAgent.read,
              writeMainAgent: options.mainAgent.write,
            }
          : {}),
      },
      {
        outboxStorage: {
          load: () => structuredClone(saved),
          save: async (next) => {
            const copy = structuredClone(next);
            const hold = heldSave;
            if (hold && next.some((item) => item.event.kind === hold.kind))
              await hold.gate;
            if (id === storageOwner) saved = copy;
          },
          close: () => done.resolve(),
        },
      },
    );
  };
  let owner = start();
  const temporarySessions: ReturnType<typeof createRelaySession>[] = [];
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer: identity.pubkey,
    origin: COMMUNITY,
    scope: relayPartition(COMMUNITY, identity.pubkey),
    session: owner.session,
  };
  const community: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: identity.pubkey,
    selected: COMMUNITY,
    memberships: [],
    profile: { name: "", picture: "", about: "" },
    sync: { known: [], outbox: [] },
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const reader = { snapshot: () => community, subscribe: relay.subscribe };

  const root = new Context();
  // The build adds the native session to `inject`; this module loaded
  // without it.
  const runtime = new PluginRuntime(root, async (plugin) =>
    plugin.manifest.id === builderlabManifest.id
      ? { ...builderlab, inject: [...builderlab.inject, "federatedIdentity"] }
      : bestiePlugin,
  );
  new HostService(root);
  new SettingsCardsService(root);
  new ConversationService(root);
  new PanelsService(root);
  // Builderlab's Apps panel; no native browser here.
  new BrowserService(root, { available: false } as BrowserPlatform);
  new DecisionsService(root, localStorage);
  root.provide("knownCommunities", {
    ...reader,
    pending: () => [],
    apply: async () => {},
  } satisfies KnownCommunities);
  root.provide("communityJoin", { open: () => true });
  const pages = new PagesService(root);
  const open = vi.fn(async () => ({ status: "opened" }));
  const navigation = { open } as unknown as Navigation;
  root.provide("relay", relay);
  root.provide("federatedIdentity", federated.service);
  root.provide("navigation", navigation);
  const agents = new AgentsService(
    root,
    { ...reader, open: () => relay } as unknown as AgentCommunities,
    {
      list: async () => [],
      create: vi.fn(),
      portable: vi.fn(),
      port: vi.fn(),
      rename: vi.fn(),
      setType: vi.fn(),
      setPicture: vi.fn(),
      remove: vi.fn(),
      beginDelete: vi.fn(),
      forget: vi.fn(),
      publish: vi.fn(),
      publishProfile: vi.fn(),
      query: vi.fn(),
      effectiveEdit: vi.fn(),
      searchProfiles: vi.fn(),
      upload: vi.fn(),
      media: vi.fn(),
      remember: vi.fn(),
      gitAuth: vi.fn(),
      claim: async () => true,
      release: vi.fn(),
      join: vi.fn(),
      beginLeave: vi.fn(),
      holdRemoval: vi.fn(),
      releaseRemoval: vi.fn(),
      keepAwake: vi.fn(async () => {}),
    },
  );
  const plugin = (manifest: { id: string; name: string }): PluginInfo => ({
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  });
  runtime.reconcile([plugin(builderlabManifest), plugin(bestieManifest)]);
  await vi.waitFor(() => {
    if (!root.get("builderlab")) throw new Error("Builderlab not provided");
    if (agents.snapshot().status !== "ready")
      throw new Error("Agents not ready");
    if (!pages.snapshot().length) throw new Error("Bestie page missing");
  });
  const provided = root.get("builderlab");
  if (!provided) throw new Error("Builderlab not provided");
  const raw = createRemoteBestie(provided, agents, relay);
  // The owner picks this model whenever setup asks; `raw` stops at the choice.
  const bestie: RemoteBestie = {
    ...raw,
    async setup(selected, options) {
      await raw.setup(selected, options);
      if (raw.snapshot().status === "choose-model")
        await raw.chooseModel(MODEL);
    },
  };
  cleanups.push(async () => {
    raw.dispose();
    await runtime.dispose();
    await root.fiber.dispose();
    owner.dispose();
    for (const temporary of temporarySessions) temporary.dispose();
    await closed.promise;
    listeners.clear();
  });
  return {
    bestie,
    raw,
    agents,
    pages,
    open,
    navigation,
    events,
    channels,
    rows,
    sign,
    publish,
    query,
    viewer: identity.pubkey,
    agent: remote.pubkey,
    /** Each request the native session forwarded to Builderlab. */
    forwarded: federated.request,
    /** The bodies of what Builderlab was sent at `path`, in order. */
    requests: (path: string) =>
      federated.request.mock.calls
        .filter(([input]) => input.path.endsWith(`/${path}`))
        .map(([input]) => input.body ?? ""),
    reply(path: string, status: number, body: unknown) {
      replies.set(path, { status, body });
    },
    holdRequest(path: string) {
      const gate = deferred<void>();
      holds.set(path, gate.promise);
      return gate;
    },
    cancelNextSignIn() {
      signInCanceled = true;
    },
    session: () => owner.session,
    replaceWithConnectingSession() {
      const temporary = createRelaySession(null);
      temporarySessions.push(temporary);
      snapshot = {
        status: "connecting",
        generation: snapshot.generation + 1,
        session: temporary.session,
      };
      notify();
    },
    ignoreCreateMembers() {
      createMembers = false;
    },
    failPublication(kind: number) {
      failKind = kind;
    },
    addMember(pubkey: string) {
      for (const home of channels.values()) home.members.push(pubkey);
      clock++;
    },
    removeMember(pubkey: string) {
      for (const home of channels.values())
        home.members = home.members.filter((member) => member !== pubkey);
      clock++;
    },
    /** Holds Outbox writes of this kind until the gate opens. */
    holdSave(kind: number) {
      const gate = deferred<void>();
      heldSave = { kind, gate: gate.promise };
      return gate;
    },
    /** Ends the app without a clean Outbox shutdown, then starts it again
     * from what storage last committed. */
    async crash() {
      const lost = owner;
      closed = deferred<void>();
      owner = start();
      heldSave = undefined;
      lost.dispose();
      snapshot = {
        ...snapshot,
        session: owner.session,
        generation: snapshot.generation + 1,
      };
      notify();
      await owner.session.outbox?.ready();
    },
    async restart() {
      await owner.session.outbox?.ready();
      owner.dispose();
      await closed.promise;
      closed = deferred<void>();
      owner = start();
      snapshot = {
        ...snapshot,
        session: owner.session,
        generation: snapshot.generation + 1,
      };
      notify();
      await owner.session.outbox?.ready();
    },
  };
}
