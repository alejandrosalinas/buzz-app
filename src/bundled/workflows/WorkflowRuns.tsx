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
import { useClockFormat } from "../../shared/clock-preference";
import { Button } from "../../shared/design-system/ui/Button";
import { useWorkflowView } from "./useWorkflowView";

export function WorkflowRuns({
  capability,
  workflow,
  heading = true,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowDefinition;
  heading?: boolean;
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
    />
  );
}
function RunPage({
  capability,
  workflow,
  cursor,
  onPage,
  heading,
}: {
  capability: WorkflowCapability;
  workflow: WorkflowReference;
  cursor: WorkflowRunCursor | undefined;
  onPage: (cursor: WorkflowRunCursor | undefined) => void;
  heading: boolean;
}) {
  useClockFormat();
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
