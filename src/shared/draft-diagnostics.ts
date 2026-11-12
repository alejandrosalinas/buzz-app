import { invoke, isTauri } from "@tauri-apps/api/core";
import { getLogger } from "../features/developer/logging";

type Revision = string | null | undefined;
type Operation =
  | "write"
  | "notify"
  | "storage"
  | "persist"
  | "saved"
  | "changed"
  | "failed"
  | "load"
  | "reconcile"
  | "keep"
  | "use-saved"
  | "send-start"
  | "send-start-conflict"
  | "send-upload-conflict"
  | "send-prepare-conflict"
  | "send-publish-conflict"
  | "write-mismatch"
  | "serialize-failed"
  | "write-failed"
  | "notify-failed";
type Comparison = {
  expected: Revision;
  current: Revision;
  next: Revision;
  flags: number;
};
type Record = {
  sequence: number;
  draft: number;
  editor: number;
  operation: Operation;
  expected?: ReturnType<typeof revisionKind>;
  current?: ReturnType<typeof revisionKind>;
  next?: ReturnType<typeof revisionKind>;
  sameExpected?: boolean;
  sameNext?: boolean;
  flags?: number;
};

const records: Record[] = [];
const drafts = new Map<string, number>();
let nextDraft = 0;
let nextEditor = 0;
let sequence = 0;
let saving = false;
let pending: Record[] | undefined;
async function save() {
  if (saving || !pending) return;
  const snapshot = pending;
  pending = undefined;
  saving = true;
  try {
    await invoke<void>("draft_diagnostics_save", { records: snapshot });
  } catch {
    getLogger("draft-diagnostics").warn("Could not save draft diagnostics.");
  } finally {
    saving = false;
    if (pending) void save();
  }
}
export const draftEditorId = () => ++nextEditor;

function revisionKind(value: Revision) {
  if (value === undefined) return "unreadable";
  if (value === null) return "missing";
  if (value === "null") return "null";
  if (value.startsWith('"')) return "string";
  if (value.startsWith("{")) return "object";
  return "other";
}

/** Only comparisons and local numeric IDs enter the trace. No revision is retained. */
export function traceDraft(
  scope: string,
  key: string,
  operation: Operation,
  editor = 0,
  comparison?: Comparison,
) {
  if (!key.startsWith("draft:")) return;
  const coordinate = JSON.stringify([scope, key]);
  let draft = drafts.get(coordinate);
  if (draft === undefined) {
    draft = ++nextDraft;
    drafts.set(coordinate, draft);
    const oldest = drafts.keys().next().value;
    if (drafts.size > 100 && oldest !== undefined) drafts.delete(oldest);
  }
  records.push({
    sequence: ++sequence,
    draft,
    editor,
    operation,
    ...(comparison
      ? {
          expected: revisionKind(comparison.expected),
          current: revisionKind(comparison.current),
          next: revisionKind(comparison.next),
          sameExpected: comparison.expected === comparison.current,
          sameNext: comparison.next === comparison.current,
          flags: comparison.flags,
        }
      : {}),
  });
  if (records.length > 100) records.shift();
  if (
    isTauri() &&
    (operation === "changed" ||
      operation === "failed" ||
      operation.endsWith("-conflict") ||
      operation.endsWith("-failed") ||
      operation === "write-mismatch")
  ) {
    // Keep only the newest pending snapshot while the host writes one file.
    pending = records.slice();
    queueMicrotask(() => void save());
  }
}
