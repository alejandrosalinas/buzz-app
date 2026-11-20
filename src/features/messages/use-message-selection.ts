import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ChannelMessage } from "../relay/contracts";
import { compareMessages } from "../relay/message-order";
import type { RelaySession } from "../relay/session";
import { useMessageEditScope } from "./MessageEditScope";
import { useMessageKeyActions } from "./MessageManagement";
import type { ComposerInputElement } from "./composer-dom";
import { registerMessageList } from "./message-selection";
import { lastEditableMessage } from "./useMessageEdit";

/** Makes a rendered message list keyboard-selectable within its edit scope. */
export function useMessageSelection(
  list: RefObject<HTMLElement | null>,
  rows: readonly ChannelMessage[],
  session: RelaySession,
  conversationId: string | undefined,
) {
  const editScope = useMessageEditScope();
  const actions = useMessageKeyActions(session);
  // Action availability changes with outbox state, not the list's lifetime.
  const latest = useRef({ rows, actions, conversationId });
  latest.current = { rows, actions, conversationId };
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (editScope) editScope.list.current = element;
    // This scope's own editable draft: a thread without a reply box must not
    // quote into the channel's, as focusTarget() would fall back to, and a
    // quote never rewrites a sent message that is being edited.
    const quoteTarget = () => {
      if (latest.current.conversationId !== conversationId) return null;
      const input = editScope?.input.current as ComposerInputElement | null;
      return input?.isConnected &&
        !input.disabled &&
        !input.readOnly &&
        !input.closest("[data-editing]")
        ? input
        : null;
    };
    const unregister = registerMessageList(element, {
      scope: session.scope,
      row: (id) =>
        latest.current.rows.find((row) => row.id === id && !row.membership),
      newest: () =>
        latest.current.rows.reduce<ChannelMessage | undefined>(
          (newest, row) =>
            !row.membership && (!newest || compareMessages(row, newest) > 0)
              ? row
              : newest,
          undefined,
        )?.id,
      canEdit: (row) =>
        !!editScope?.current && !!lastEditableMessage(session, [row]),
      edit: (row) => editScope?.current?.(row),
      canDelete: (row) => !!latest.current.actions?.canDelete(row),
      remove: (row) => latest.current.actions?.remove(row),
      canMarkUnread: (row) => !!latest.current.actions?.canMarkUnread(row),
      markUnread: (row) => latest.current.actions?.markUnread(row),
      composer: () => editScope?.focusTarget() ?? null,
      canQuote: () => !!quoteTarget(),
      quote: (html, sourceLinks) =>
        !!quoteTarget()?.insertQuote(html, sourceLinks),
    });
    return () => {
      unregister();
      if (editScope?.list.current === element) editScope.list.current = null;
    };
  }, [list, editScope, session, conversationId]);
}

/** For lists that render their own edit scope provider. */
export function MessageSelection(props: {
  list: RefObject<HTMLElement | null>;
  rows: readonly ChannelMessage[];
  session: RelaySession;
  conversationId: string | undefined;
}) {
  useMessageSelection(
    props.list,
    props.rows,
    props.session,
    props.conversationId,
  );
  return null;
}
