import { parseDocument } from "yaml";
import type { EventData } from "../relay/events.ts";
import type {
  WorkflowDefinition,
  WorkflowReference,
  WorkflowRunCursor,
  WorkflowRunPage,
} from "./types.ts";

export const WORKFLOW_KINDS = [30620, 46020, 5] as const;
export function isWorkflowOperation(
  event: Pick<EventData, "kind" | "tags">,
): boolean {
  return (
    event.kind === 30620 ||
    event.kind === 46020 ||
    (event.kind === 5 &&
      event.tags.some(
        // The relay parses the kind numerically (including + and leading zeros).
        // Classify those coordinates here; workflowReference rejects aliases.
        ([name, value]) => name === "a" && /^\+?0*30620:/.test(value ?? ""),
      ))
  );
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validateReference(value: WorkflowReference) {
  if (
    !UUID.test(value.id) ||
    !UUID.test(value.channelId) ||
    !HEX.test(value.owner)
  )
    throw new Error("Invalid workflow coordinate");
}
function one(event: Pick<EventData, "tags">, name: string): string {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length !== 1 || tags[0]?.length !== 2 || !tags[0][1])
    throw new Error(`Invalid workflow ${name} tag`);
  return tags[0][1];
}
export function workflowReference(
  event: Pick<EventData, "kind" | "tags" | "pubkey">,
): WorkflowReference {
  const channelId = one(event, "h");
  let id: string,
    owner = event.pubkey;
  if (event.kind === 5) {
    const parts = one(event, "a").split(":");
    if (parts.length !== 3 || parts[0] !== "30620")
      throw new Error("Invalid workflow deletion coordinate");
    owner = parts[1] ?? "";
    id = parts[2] ?? "";
  } else id = one(event, "d");
  const reference = { id, owner, channelId };
  validateReference(reference);
  return reference;
}
export function definition(event: EventData): WorkflowDefinition {
  if (event.kind !== 30620 || !HEX.test(event.id))
    throw new Error("Invalid workflow definition");
  return Object.freeze({
    ...workflowReference(event),
    revision: event.id,
    createdAt: event.created_at,
    yaml: event.content,
  });
}
/** Structural authoring checks, not a replacement for relay language/role validation. */
export function workflowYaml(text: string) {
  if (new TextEncoder().encode(text).byteLength > 24000)
    throw new Error("Workflow YAML exceeds 24 KB");
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error("Workflow YAML is invalid");
  const value: unknown = doc.toJS({ maxAliasCount: 50 });
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    !record(value.trigger) ||
    typeof value.trigger.on !== "string" ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 100
  )
    throw new Error(
      "Workflow needs a name, boolean enabled state if present, trigger and 1–100 steps",
    );
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (
      !record(step) ||
      typeof step.id !== "string" ||
      !/^[A-Za-z0-9_]{1,64}$/.test(step.id) ||
      ids.has(step.id) ||
      typeof step.action !== "string"
    )
      throw new Error("Workflow steps need unique identifiers and actions");
    ids.add(step.id);
  }
  return {
    // Match legacy WorkflowDef: omission means enabled; do not rewrite YAML.
    enabled: value.enabled !== false,
    name: value.name,
  };
}
/** Shared session/broker signing boundary. Only canonical workflow operations, never generic kind 5. */
export function validateWorkflowEvent(event: EventData, viewer: string) {
  if (
    typeof event.content !== "string" ||
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags) ||
    event.tags.length > 8 ||
    event.tags.some(
      (tag) =>
        !Array.isArray(tag) ||
        tag.length !== 2 ||
        tag.some((value) => typeof value !== "string" || value.length > 256),
    )
  )
    throw new Error("Malformed workflow command");
  if (!WORKFLOW_KINDS.includes(event.kind as 30620 | 46020 | 5))
    throw new Error("Unsupported workflow operation");
  const reference = workflowReference(event);
  // Deletions may target an agent owned by the signer. Ownership is checked
  // by the session capability and authoritatively by the relay, not tag shape.
  if (
    (event.kind !== 5 && reference.owner !== viewer) ||
    event.pubkey !== viewer
  )
    throw new Error("Only the workflow author can manage it");
  const allowed =
    event.kind === 5
      ? ["h", "a", "client-id"]
      : ["h", "d", "expected-revision", "client-id"];
  if (
    new Set(event.tags.map(([name]) => name)).size !== event.tags.length ||
    event.tags.some((tag) => !allowed.includes(tag[0] ?? ""))
  )
    throw new Error("Unsupported workflow command tag");
  if (event.kind !== 30620 && event.content !== "")
    throw new Error("Workflow command content must be empty");
  if (event.kind === 30620) {
    const revisions = event.tags.filter(
      ([name]) => name === "expected-revision",
    );
    if (revisions.length && !HEX.test(one(event, "expected-revision")))
      throw new Error("Invalid expected workflow revision");
    workflowYaml(event.content);
  } else if (event.tags.some(([name]) => name === "expected-revision"))
    throw new Error("Unexpected workflow revision tag");
  return reference;
}
/** The relay's inbound webhook route; the secret travels in an X-Webhook-Secret header. */
export function hookUrl(relayHttpUrl: string, id: string) {
  if (!UUID.test(id)) throw new Error("Invalid workflow ID");
  return `${relayHttpUrl}/hooks/${id}`;
}
export function runsPath(id: string, cursor?: WorkflowRunCursor) {
  if (!UUID.test(id)) throw new Error("Invalid workflow ID");
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) {
    validateCursor(cursor);
    query.set("before", cursor.before);
    query.set("before_id", cursor.beforeId);
  }
  return `/workflows/${id}/runs?${query}`;
}
function validateCursor(cursor: WorkflowRunCursor) {
  if (
    !UUID.test(cursor.beforeId) ||
    cursor.before.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(cursor.before) ||
    !Number.isFinite(Date.parse(cursor.before))
  )
    throw new Error("Invalid workflow run cursor");
}
const number = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const nullableNumber = (v: unknown): v is number | null =>
  v === null || number(v);
const nullableText = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && v.length <= 16000);
export function parseRuns(raw: unknown, workflowId: string): WorkflowRunPage {
  if (!record(raw) || !Array.isArray(raw.runs) || raw.runs.length > 20)
    throw new Error("Invalid workflow run response");
  const ids = new Set<string>();
  const runs = raw.runs.map((run) => {
    if (
      !record(run) ||
      typeof run.id !== "string" ||
      !UUID.test(run.id) ||
      ids.has(run.id) ||
      run.workflow_id !== workflowId ||
      ![
        "pending",
        "running",
        "waiting_approval",
        "completed",
        "failed",
        "cancelled",
      ].includes(String(run.status)) ||
      !number(run.current_step) ||
      !number(run.created_at) ||
      !nullableNumber(run.started_at) ||
      !nullableNumber(run.completed_at) ||
      !Array.isArray(run.execution_trace) ||
      run.execution_trace.length > 1000 ||
      !nullableText(run.error_code) ||
      !nullableText(run.error_message)
    )
      throw new Error("Invalid workflow run row");
    ids.add(run.id);
    return Object.freeze({
      id: run.id,
      workflowId,
      status: run.status as WorkflowRunPage["runs"][number]["status"],
      currentStep: run.current_step,
      trace: Object.freeze(run.execution_trace),
      startedAt: run.started_at,
      completedAt: run.completed_at,
      createdAt: run.created_at,
      errorCode: run.error_code,
      errorMessage: run.error_message,
    });
  });
  let next: WorkflowRunCursor | null = null;
  if (raw.next !== null) {
    if (
      !record(raw.next) ||
      typeof raw.next.before !== "string" ||
      typeof raw.next.before_id !== "string" ||
      !runs.length
    )
      throw new Error("Invalid workflow run cursor");
    next = Object.freeze({
      before: raw.next.before,
      beforeId: raw.next.before_id,
    });
    validateCursor(next);
  }
  return Object.freeze({ runs: Object.freeze(runs), next });
}
