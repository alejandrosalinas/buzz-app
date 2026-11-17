import { useCallback, useSyncExternalStore } from "react";
import { readView, subscribeView } from "../../shared/view-state";
import {
  attachmentDraftCount,
  subscribeAttachmentDraftCounts,
} from "../messages/attachment-draft";
import { hasDraftContent, mentionDraft } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";

/** Existing New chat slots, backed by the composer's text and file owners. */
export function hasSoloDraft(
  session: RelaySession,
  scope: string,
  project = "",
) {
  const key = `${project ? `solo:project:${project}` : "solo"}:new-draft`;
  return hasDraftContent(
    mentionDraft(readView<unknown>(scope, key, "")),
    attachmentDraftCount(session, `${scope}:${key}`),
  );
}

export function useSoloDraftProjects(
  session: RelaySession,
  scope: string,
  projects: readonly string[],
) {
  const keys = JSON.stringify(["", ...projects]);
  const subscribe = useCallback(
    (notify: () => void) => {
      const views = subscribeView(scope, (key) => {
        if (
          !key ||
          key === "solo:new-draft" ||
          (key.startsWith("solo:project:") && key.endsWith(":new-draft"))
        )
          notify();
      });
      const files = subscribeAttachmentDraftCounts(session, notify);
      return () => {
        views();
        files();
      };
    },
    [session, scope],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        (JSON.parse(keys) as string[]).filter((project) =>
          hasSoloDraft(session, scope, project),
        ),
      ),
    [session, scope, keys],
  );
  return JSON.parse(
    useSyncExternalStore(subscribe, snapshot, snapshot),
  ) as string[];
}
