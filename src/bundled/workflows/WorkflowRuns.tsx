import { useCallback, useState } from "react";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowRunCursor,
  WorkflowReference,
} from "../../features/workflows/types";
import {
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { Button } from "../../shared/design-system/ui/Button";
import { HEX, record } from "../../features/workflows/protocol";
import { useWorkflowView } from "./useWorkflowView";

/** Messages a run's completed `send_message` steps posted, as the relay traces
 * them: `{ step_id, status, output: { sent: true, event_id } }`. Only that step
 * reports `sent`, and the relay posts it to the workflow's own channel. */
function postedMessages(trace: readonly unknown[]) {
  // A retried step can trace the same message twice.
  const posted = new Map<string, { step: string | undefined; id: string }>();
  for (const entry of trace)
    if (
      record(entry) &&
      entry.status === "completed" &&
      record(entry.output) &&
      entry.output.sent === true &&
      typeof entry.output.event_id === "string" &&
      HEX.test(entry.output.event_id)
    )
      posted.set(entry.output.event_id, {
        step: typeof entry.step_id === "string" ? entry.step_id : undefined,
        id: entry.output.event_id,
      });
  return [...posted.values()];
}

export function WorkflowRuns({
  capability,
  workflow,
  heading = true,
  onOpenMessage,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowDefinition;
  heading?: boolean;
  onOpenMessage?: ((messageId: string) => void) | undefined;
}) {
  const [cursor, setCursor] = useState<WorkflowRunCursor | undefined>();
  if (!capability.availability.history)
    return (
      <p className="text-secondary">
        Run history is unavailable from this host.
      </p>
    );
  return (
    <RunPage
      key={cursor ? `${cursor.before}:${cursor.beforeId}` : "first"}
      capability={capability}
      workflow={workflow}
      cursor={cursor}
      onPage={setCursor}
      heading={heading}
      onOpenMessage={onOpenMessage}
    />
  );
}
function RunPage({
  capability,
  workflow,
  cursor,
  onPage,
  heading,
  onOpenMessage,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  cursor: WorkflowRunCursor | undefined;
  onPage: (cursor: WorkflowRunCursor | undefined) => void;
  heading: boolean;
  onOpenMessage: ((messageId: string) => void) | undefined;
}) {
  const { snapshot, refresh } = useWorkflowView(
    useCallback(
      () => capability.runs(workflow, cursor),
      [capability, workflow, cursor],
    ),
  );
  if (!snapshot) return <p role="status">Reading runs…</p>;
  return (
    <section aria-label="Workflow runs" className="workflow-runs">
      <div className="workflow-toolbar">
        {heading && <h3 className="text-heading">Runs</h3>}
        <Button
          disabled={snapshot.status === "loading"}
          onClick={() => void refresh()}
        >
          Refresh runs
        </Button>
      </div>
      {snapshot.status === "loading" && !snapshot.data.runs.length && (
        <p role="status">Reading runs…</p>
      )}
      {snapshot.status === "unavailable" && (
        <p role="status">
          Run history is unavailable. This does not mean the workflow was
          deleted.
        </p>
      )}
      {snapshot.status === "idle" && (
        <p role="status">History cleared. Refresh to read it again.</p>
      )}
      {snapshot.status === "error" && (
        <p role="alert" className="text-danger">
          {snapshot.error ??
            "Run history could not be read. Retry with Refresh runs."}
        </p>
      )}
      {snapshot.status === "ready" && !snapshot.data.runs.length && (
        <p>No runs returned on this page.</p>
      )}
      {snapshot.data.runs.map((run) => (
        <article key={run.id} className="workflow-step">
          <p className="text-body">
            <strong>{run.status.replaceAll("_", " ")}</strong> ·{" "}
            <time
              dateTime={new Date(run.createdAt * 1000).toISOString()}
              title={formatFullTimestamp(run.createdAt)}
            >
              {formatItemTimestamp(run.createdAt, { withTime: true })}
            </time>
          </p>
          <p className="text-body-sm text-secondary">
            Current step: {run.currentStep}
          </p>
          {(run.errorCode || run.errorMessage) && (
            <p className="text-danger">
              {run.errorCode}: {run.errorMessage}
            </p>
          )}
          {onOpenMessage &&
            postedMessages(run.trace).map((message, _, posted) => (
              <Button
                key={message.id}
                variant="link"
                size="inline"
                onClick={() => onOpenMessage(message.id)}
              >
                {posted.length > 1 && message.step
                  ? `Open posted message (${message.step})`
                  : "Open posted message"}
              </Button>
            ))}
          <details>
            <summary>Run details and trace</summary>
            <p className="text-mono-sm workflow-key">Run ID: {run.id}</p>
            <pre className="text-mono workflow-trace">
              {JSON.stringify(run.trace, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      <div className="workflow-toolbar">
        {cursor && (
          <Button onClick={() => onPage(undefined)}>Newest runs</Button>
        )}
        {snapshot.status === "ready" && snapshot.data.next && (
          <Button
            onClick={() => {
              if (snapshot.data.next) onPage(snapshot.data.next);
            }}
          >
            Older runs
          </Button>
        )}
      </div>
    </section>
  );
}
