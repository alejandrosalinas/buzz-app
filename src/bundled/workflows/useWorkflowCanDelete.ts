import { useCallback, useSyncExternalStore } from "react";
import type {
  WorkflowCapability,
  WorkflowReference,
} from "../../features/workflows/types";

export function useWorkflowCanDelete(
  capability: WorkflowCapability,
  workflow: WorkflowReference | undefined,
) {
  const read = useCallback(
    () => !!workflow && capability.permissions.canDelete(workflow),
    [capability, workflow],
  );
  return useSyncExternalStore(capability.permissions.subscribe, read, read);
}
