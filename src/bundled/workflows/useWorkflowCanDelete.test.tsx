// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createWorkflows } from "../../features/workflows/capability";
import { fixtureDefinition, fixtureViewer } from "./fixtures";
import { useWorkflowCanDelete } from "./useWorkflowCanDelete";

afterEach(cleanup);

it.each(["channel access", "session closure"])(
  "updates mounted delete permission after losing %s without a profile update",
  (loss) => {
    let allowed = true;
    const owner = createWorkflows({
      reader: undefined,
      viewer: fixtureViewer,
      outbox: undefined,
      local: undefined,
      host: undefined,
      canAccess: () => allowed,
    });
    const { result, unmount } = renderHook(() =>
      useWorkflowCanDelete(owner.capability, fixtureDefinition),
    );
    try {
      expect(result.current).toBe(true);
      act(() => {
        if (loss === "session closure") owner.dispose();
        else {
          allowed = false;
          owner.clear();
        }
      });
      expect(result.current).toBe(false);
    } finally {
      unmount();
      owner.dispose();
    }
  },
);
