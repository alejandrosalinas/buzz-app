import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowOperation,
  WorkflowView,
  WorkflowRun,
  WorkflowRunCursor,
  WorkflowDefinitions,
} from "../../features/workflows/types";
import type { ProfileQueries } from "../../features/relay/profile-directory";

export const fixtureViewer = "11".repeat(32);
export const fixtureChannel = "44444444-4444-4444-8444-444444444444";
export const fixtureYaml = `# Keep this comment on opening
name: Message helper
enabled: false
trigger:
  on: message_posted
steps:
  - id: notify
    action: send_message
    text: Hello from a fixture
`;
export const fixtureRun: WorkflowRun = {
  id: "77777777-7777-4777-8777-777777777777",
  workflowId: "55555555-5555-4555-8555-555555555555",
  status: "completed",
  currentStep: 1,
  trace: [{ step: "notify", status: "completed" }],
  createdAt: 1_789_224_000,
  startedAt: 1_789_224_000,
  completedAt: 1_789_224_001,
  errorCode: null,
  errorMessage: null,
};
export const fixtureCursor: WorkflowRunCursor = {
  before: "2026-09-12T12:00:00.123456Z",
  beforeId: fixtureRun.id,
};
export const fixtureDefinition: WorkflowDefinition = {
  id: "55555555-5555-4555-8555-555555555555",
  owner: fixtureViewer,
  channelId: fixtureChannel,
  revision: "aa".repeat(32),
  createdAt: 1_789_224_000,
  yaml: fixtureYaml,
};

export function fixtureView<T>(data: T) {
  let current: ReturnType<WorkflowView<T>["snapshot"]> = {
    status: "idle",
    data,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  const update = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const view: WorkflowView<T> = {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (!disposed && current.status !== "unavailable")
        update({ ...current, status: "ready" });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
  return { view, update, disposed: () => disposed };
}

/** Explicit offline test capability; never used by the bundled plugin entry. */
export function createWorkflowFixture(
  profiles?: Pick<ProfileQueries, "owner" | "subscribe">,
) {
  let definitionState: ReturnType<
    WorkflowView<WorkflowDefinitions>["snapshot"]
  > = {
    status: "ready",
    data: { items: [fixtureDefinition], partial: false },
  };
  const definitionViews: ReturnType<typeof fixtureView<WorkflowDefinitions>>[] =
    [];
  const definitions = {
    update(next: typeof definitionState) {
      definitionState = next;
      for (const owned of definitionViews)
        if (!owned.disposed()) owned.update(next);
    },
    disposed: () => definitionViews.every((owned) => owned.disposed()),
    active: () => definitionViews.filter((owned) => !owned.disposed()).length,
    created: () => definitionViews.length,
  };
  const listeners = new Set<() => void>();
  let operations: readonly WorkflowOperation[] = [];
  let counter = 0;
  let savedInput: Parameters<WorkflowCapability["save"]>[0] | undefined;
  const calls = {
    save: 0,
    delete: 0,
    trigger: 0,
    runs: 0,
    take: 0,
    dismiss: [] as string[],
  };
  const secrets = new Map<string, string>();
  const runViews: { disposed(): boolean }[] = [];
  let runCursor: WorkflowRunCursor | undefined;
  const publish = (next: readonly WorkflowOperation[]) => {
    operations = next;
    for (const listener of listeners) listener();
  };
  const start = (
    action: WorkflowOperation["action"],
    workflow: WorkflowDefinition,
  ) => {
    const eventId = (++counter).toString(16).padStart(64, "0");
    publish([
      ...operations,
      {
        eventId,
        workflow,
        action,
        createdAt: fixtureDefinition.createdAt + counter,
        delivery: "sending",
        outcome: "pending",
      },
    ]);
    return eventId;
  };
  let savedOnServer: WorkflowDefinition | undefined;
  let dismissError: string | undefined;
  let dismissGate: Promise<void> | undefined;
  let releaseDismiss: (() => void) | undefined;
  const capability: WorkflowCapability = {
    permissions: {
      canDelete: (workflow) =>
        workflow.owner === fixtureViewer ||
        profiles?.owner?.(workflow.owner) === fixtureViewer,
      subscribe: (listener) => profiles?.subscribe(listener) ?? (() => {}),
    },
    availability: {
      definitions: true,
      history: true,
      save: true,
      trigger: true,
      delete: true,
    },
    definitions: () => {
      const owned = fixtureView(definitionState.data);
      owned.update(definitionState);
      definitionViews.push(owned);
      return {
        ...owned.view,
        async refresh() {
          if (savedOnServer && definitionState.status !== "unavailable") {
            definitions.update({
              status: "ready",
              data: { items: [savedOnServer], partial: false },
            });
            publish(
              operations.map((operation) =>
                operation.action === "save" &&
                operation.outcome === "unknown" &&
                operation.eventId === savedOnServer?.revision
                  ? { ...operation, outcome: "succeeded" }
                  : operation,
              ),
            );
          }
          await owned.view.refresh();
        },
      };
    },
    runs: (_workflow, cursor) => {
      calls.runs++;
      runCursor = cursor;
      const next = fixtureView({
        runs: cursor ? [] : [fixtureRun],
        next: cursor ? null : fixtureCursor,
      });
      runViews.push(next);
      return next.view;
    },
    save(input) {
      calls.save++;
      savedInput = input;
      return start(
        "save",
        input.existing ?? {
          ...fixtureDefinition,
          id: "66666666-6666-4666-8666-666666666666",
          yaml: input.yaml,
        },
      );
    },
    delete(workflow) {
      calls.delete++;
      return start("delete", workflow);
    },
    trigger(workflow) {
      calls.trigger++;
      return start("trigger", workflow);
    },
    takeWebhookSecret(eventId) {
      calls.take++;
      const secret = secrets.get(eventId);
      if (secret === undefined) return undefined;
      secrets.delete(eventId);
      publish(
        operations.map((operation) => {
          if (operation.eventId !== eventId) return operation;
          const { secretHeld: _, ...taken } = operation;
          return taken;
        }),
      );
      return secret;
    },
    webhookUrl: (workflowId) =>
      `https://relay.example.test/hooks/${workflowId}`,
    operations: {
      snapshot: () => operations,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async dismiss(id) {
        calls.dismiss.push(id);
        if (
          operations.some(
            (operation) =>
              operation.eventId === id && operation.outcome === "pending",
          )
        )
          throw new Error("Still pending");
        // Match the durable outbox: persistence completes before removal/notification.
        await dismissGate;
        if (dismissError) throw new Error(dismissError);
        publish(operations.filter((operation) => operation.eventId !== id));
      },
    },
  };
  return {
    capability,
    definitions,
    calls,
    input: () => savedInput,
    runCursor: () => runCursor,
    runViews,
    setDismissError: (message?: string) => {
      dismissError = message;
    },
    holdDismiss() {
      dismissGate = new Promise((resolve) => {
        releaseDismiss = resolve;
      });
    },
    releaseDismiss() {
      releaseDismiss?.();
      dismissGate = undefined;
      releaseDismiss = undefined;
    },
    saveOnServer(exact = true) {
      const operation = operations.at(-1);
      if (operation?.action !== "save" || !savedInput)
        throw new Error("No save");
      savedOnServer = {
        ...fixtureDefinition,
        ...operation.workflow,
        yaml: savedInput.yaml,
        revision: exact ? operation.eventId : "bb".repeat(32),
      };
    },
    /** `secret` mimics a save receipt for a workflow that first gained a webhook trigger. */
    finish(
      outcome: WorkflowOperation["outcome"],
      exact = true,
      secret?: string,
    ) {
      const operation = operations.at(-1);
      if (!operation) throw new Error("No operation");
      const withSecret =
        outcome === "succeeded" &&
        operation.action === "save" &&
        secret !== undefined;
      if (withSecret) secrets.set(operation.eventId, secret);
      if (
        outcome === "succeeded" &&
        operation.action === "save" &&
        savedInput
      ) {
        const revision = exact ? operation.eventId : "bb".repeat(32);
        definitions.update({
          status: "ready",
          data: {
            partial: false,
            items: [
              {
                ...fixtureDefinition,
                ...operation.workflow,
                revision,
                yaml: savedInput.yaml,
              },
            ],
          },
        });
      }
      // Legacy deletion accepts the request without removing the signed definition.
      publish(
        operations.map((item) =>
          item.eventId === operation.eventId
            ? {
                ...item,
                outcome,
                delivery: outcome === "rejected" ? "failed" : "accepted",
                ...(item.action === "trigger" && outcome === "succeeded"
                  ? { runId: fixtureRun.id }
                  : {}),
                ...(outcome === "rejected"
                  ? { error: "Fixture conflict" }
                  : {}),
                ...(withSecret ? { secretHeld: true } : {}),
              }
            : item,
        ),
      );
    },
    revoke() {
      definitions.update({
        status: "unavailable",
        data: { items: [], partial: false },
      });
      publish([]);
    },
  };
}
