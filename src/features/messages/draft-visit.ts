import { useCallback, useEffect, useRef } from "react";
import type { PageNavigation } from "../navigation/service";
import { readView } from "../../shared/view-state";
import { attachmentDraftCount } from "./attachment-draft";
import type { ComposerSession } from "./composer-session";
import {
  hasDraftContent,
  mentionDraft,
  type MentionDraft,
} from "./mention-draft";

/** A new conversation's visit is a Back stop only once its composer draft
 * holds something the person wrote; until then the next page replaces it.
 * `initialDraft` reads what the composer shows while nothing is saved;
 * `held` reports a message the page holds for delivery or retry, a Back stop
 * whatever it contains. Returns the composer's edit listener; the page passes
 * `undefined` once it has spent the draft. */
export function usePassThroughUntilDrafted(
  visit: PageNavigation | undefined,
  session: ComposerSession,
  scope: string,
  draftKey: string,
  {
    initialDraft,
    held,
  }: {
    initialDraft?: () => MentionDraft | string | undefined;
    held?: () => boolean;
  } = {},
) {
  // The composer's latest edit stands for the saved draft, which may be
  // missing when storage fails, until the page spends it.
  const edited = useRef<MentionDraft | undefined>(undefined);
  useEffect(
    () =>
      visit?.passThrough(
        () =>
          !held?.() &&
          !hasDraftContent(
            edited.current ??
              mentionDraft(
                readView<unknown>(scope, draftKey, initialDraft?.() ?? ""),
              ),
            attachmentDraftCount(session, `${scope}:${draftKey}`),
          ),
      ),
    [visit, session, scope, draftKey, initialDraft, held],
  );
  return useCallback((draft: MentionDraft | undefined) => {
    edited.current = draft;
  }, []);
}
