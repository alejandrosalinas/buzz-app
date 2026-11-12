import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReadJournal } from "../../features/relay/read-state-storage";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import type { LiveCallbacks } from "../../features/relay/live";
import { PublishRejected } from "../../features/relay/outbox";
import { OutboxStatus } from "../channels/OutboxStatus";
import { WorkflowsPage } from "./WorkflowsPage";
import { fixtureChannel, fixtureDefinition, fixtureYaml } from "./fixtures";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";

// Real session/protocol/read ownership with disposable test keys and memory only.
// No broker, network, keychain, or real workflow writes.
const fixtureParams = new URLSearchParams(location.search);
const writable = fixtureParams.has("writes");
const manyChannels = fixtureParams.has("many");
let traffic: LiveCallbacks;
let publishCount = 0;
let definitionQueries = 0;
const definitionChannels = new Set<string>();
let metadataSequence = 0;
let heldDefinitionRelease: (() => void) | undefined;
let heldDefinitionReject: (() => void) | undefined;
let definitionHoldReleased = false;
let holdEditorRead = false;
let finishPublish: ((value: string) => void) | undefined;
let failPublish: ((error: Error) => void) | undefined;
let lastPublished: RelayEvent | undefined;
let activeEvents: RelayEvent[] = [];
const viewer = keypair();
const authority = keypair();
const secondChannel = "88888888-8888-4888-8888-888888888888";
const extraChannels = Array.from(
  { length: 127 },
  (_, index) =>
    `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`,
);
const channels = manyChannels
  ? [fixtureChannel, secondChannel, ...extraChannels]
  : [fixtureChannel, secondChannel];
let incoming: ((events: readonly RelayEvent[]) => void) | undefined;
let generation = 0;
let currentScope = "Fixture A";
function session(scope: string) {
  let journal: ReadJournal | undefined;
  const events = channels.flatMap((channel, index) => [
    roster(authority, channel, [viewer.pubkey]),
    metadata(
      authority,
      channel,
      index === 0
        ? "First channel"
        : index === 1
          ? "Second channel"
          : `Channel ${index + 1}`,
    ),
    // The second channel exercises the real session's read-only empty state.
    ...(index || fixtureParams.has("empty")
      ? []
      : [
          signed(viewer, {
            kind: 30620,
            content: fixtureYaml.replace("Message helper", `${scope} helper`),
            tags: [
              ["h", channel],
              ["d", fixtureDefinition.id],
            ],
          }),
        ]),
  ]);
  activeEvents = events;
  return createRelaySession(
    {
      scope,
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      ...(writable
        ? {
            writer: {
              kinds: [9, 30620, 46020, 5],
              sign: async (template: Parameters<typeof signed>[1]) =>
                signed(viewer, template),
              publish: (event) => {
                lastPublished = event;
                publishCount++;
                return new Promise<string>((resolve, reject) => {
                  finishPublish = resolve;
                  failPublish = reject;
                });
              },
            },
            workflows: { runs: async () => ({ runs: [], next: null }) },
          }
        : {}),
      async query(filters, signal) {
        const candidates = [...events];
        if (filters.some((filter) => filter.kinds?.includes(30620))) {
          definitionQueries++;
          for (const filter of filters)
            for (const channelId of filter["#h"] ?? [])
              definitionChannels.add(channelId);
          if (
            !definitionHoldReleased &&
            ((fixtureParams.has("hold-editor") &&
              holdEditorRead &&
              !heldDefinitionRelease &&
              filters.length === 1 &&
              filters[0]?.["#h"]?.includes(fixtureChannel)) ||
              (fixtureParams.has("hold") &&
                filters.some((filter) =>
                  filter["#h"]?.includes(
                    manyChannels
                      ? (extraChannels[126] ?? secondChannel)
                      : secondChannel,
                  ),
                )))
          )
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                heldDefinitionReject = undefined;
                if (heldDefinitionRelease === release)
                  heldDefinitionRelease = undefined;
                reject(new DOMException("Aborted", "AbortError"));
              };
              const release = () => {
                heldDefinitionReject = undefined;
                signal?.removeEventListener("abort", abort);
                if (heldDefinitionRelease === release)
                  heldDefinitionRelease = undefined;
                resolve();
              };
              heldDefinitionRelease = release;
              heldDefinitionReject = () => {
                reject(new Error("Fixture workflow read failed"));
                release();
              };
              signal?.addEventListener("abort", abort, { once: true });
            });
        }
        return candidates.filter((event) =>
          filters.some(
            (filter) =>
              (!filter.kinds || filter.kinds.includes(event.kind)) &&
              (!filter["#h"] ||
                event.tags.some(
                  ([k, v]) => k === "h" && v && filter["#h"]?.includes(v),
                )),
          ),
        );
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        traffic = callbacks;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: { load: () => [], save() {} },
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = change(journal);
          return journal;
        },
        close() {},
      },
    },
  );
}
let owner = session(currentScope);
Object.assign(window, {
  workflowSessionFixture: {
    // The modal editor hides the toolbar, so journeys call its closures here.
    switchCommunity: switchScope,
    revokeSelectedChannel,
    publications: () => publishCount,
    echoPublished: () => {
      if (lastPublished) incoming?.([lastPublished]);
    },
    state: (status: "connected" | "retrying") =>
      traffic.state({ status, routes: [] }),
    settle: () =>
      finishPublish?.(
        'response:{"run_id":"33333333-3333-4333-8333-333333333333"}',
      ),
    settleSave: () => {
      if (lastPublished?.kind !== 30620) return;
      finishPublish?.(
        `response:${JSON.stringify({
          workflow_id: lastPublished.tags.find(([key]) => key === "d")?.[1],
          webhook_secret: "fixture-late-webhook-secret",
        })}`,
      );
    },
    settleDelete: (removeDefinition = false) => {
      if (lastPublished?.kind !== 5) return;
      const coordinate = lastPublished?.tags.find(([key]) => key === "a")?.[1];
      if (removeDefinition) {
        for (let index = activeEvents.length - 1; index >= 0; index--) {
          const event = activeEvents[index];
          if (
            event?.kind === 30620 &&
            event.tags.some(
              ([key, value]) =>
                key === "d" && coordinate === `30620:${event.pubkey}:${value}`,
            )
          )
            activeEvents.splice(index, 1);
        }
        finishPublish?.("");
        return;
      }
      finishPublish?.(
        `response:${JSON.stringify({
          workflow_id: coordinate?.split(":").at(-1),
          deleted: true,
        })}`,
      );
    },
    reject: () => failPublish?.(new PublishRejected("Fixture non-delivery")),
    operations: () => owner.session.workflows.operations.snapshot(),
    definitionQueries: () => definitionQueries,
    definitionChannelCount: () => definitionChannels.size,
    definitionReadHeld: () => heldDefinitionRelease !== undefined,
    holdNextEditorRead: () => {
      holdEditorRead = true;
    },
    failDefinitionRead: () => {
      definitionHoldReleased = true;
      heldDefinitionReject?.();
    },
    releaseDefinitionRead: () => {
      definitionHoldReleased = true;
      heldDefinitionRelease?.();
    },
    renameFirstChannel: () => {
      metadataSequence++;
      incoming?.([
        metadata(
          authority,
          fixtureChannel,
          `${metadataSequence % 2 ? "Z-last" : "A-first"} channel ${metadataSequence}`,
          1_800_001_000 + metadataSequence,
        ),
      ]);
    },
    joinUnrelatedChannel: () => {
      const id = extraChannels[0] as string;
      incoming?.([
        roster(authority, id, [viewer.pubkey], 1_800_002_000),
        metadata(authority, id, "Unrelated channel", 1_800_002_000),
      ]);
    },
    restoreAccess: () =>
      incoming?.([
        roster(authority, fixtureChannel, [viewer.pubkey], 1_800_000_001),
      ]),
    readback: () => {
      if (lastPublished?.kind !== 30620) return;
      const workflowId = lastPublished.tags.find(([key]) => key === "d")?.[1];
      for (let index = activeEvents.length - 1; index >= 0; index--) {
        const event = activeEvents[index];
        if (
          event?.kind === 30620 &&
          event.tags.some(([key, value]) => key === "d" && value === workflowId)
        )
          activeEvents.splice(index, 1);
      }
      activeEvents.push(lastPublished);
    },
    sendMessage: () =>
      owner.session.outbox?.send({
        kind: 9,
        content: "Retryable message",
        tags: [["h", fixtureChannel]],
      }),
  },
});
let snapshot: RelaySnapshot = {
  status: "ready",
  generation,
  scope: currentScope,
  viewer: viewer.pubkey,
  session: owner.session,
};
const listeners = new Set<() => void>();
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  tryAgain() {},
  disconnect() {},
  clearCache: () => owner.clearCache(),
};
function revokeSelectedChannel() {
  incoming?.([roster(authority, fixtureChannel, [], 1_800_000_000)]);
}
function switchScope() {
  owner.dispose();
  currentScope = currentScope === "Fixture A" ? "Fixture B" : "Fixture A";
  generation++;
  owner = session(currentScope);
  snapshot = {
    status: "ready",
    generation,
    scope: currentScope,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  for (const listener of listeners) listener();
}
function Fixture() {
  useKeyboardFocusVisibility();
  const [mounted, setMounted] = useState(true);
  return (
    <main data-buzz-ui="" className="text-body">
      <p>
        Offline production-session fixture — ephemeral keys; no network or
        writes.
      </p>
      <div className="workflow-toolbar">
        <Button onClick={switchScope}>Switch community</Button>
        <Button onClick={revokeSelectedChannel}>Revoke selected channel</Button>
        <Button
          onClick={() => {
            void owner.clearCache();
          }}
        >
          Clear session cache
        </Button>
        <Button onClick={() => setMounted((value) => !value)}>
          Toggle workflows page
        </Button>
      </div>
      {mounted && <WorkflowsPage relay={relay} />}
      {writable && owner.session.outbox && (
        <OutboxStatus
          outbox={owner.session.outbox}
          profiling={owner.session.profiling}
          memberAdditions={owner.session.memberAdditions}
        />
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <Fixture />
      </ToastProvider>
    </StrictMode>,
  );
