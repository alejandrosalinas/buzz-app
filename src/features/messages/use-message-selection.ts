import { useLayoutEffect, useRef, type RefObject } from "react";
import type { ChannelMessage } from "../relay/contracts";
import { compareMessages } from "../relay/message-order";
import type { RelaySession } from "../relay/session";
import { useMessageEditScope } from "./MessageEditScope";
import { useMessageKeyActions } from "./MessageManagement";
import { registerMessageList } from "./message-selection";
import { lastEditableMessage } from "./useMessageEdit";

/** Makes a rendered message list keyboard-selectable within its edit scope. */
export function useMessageSelection(
  list: RefObject<HTMLElement | null>,
  rows: readonly ChannelMessage[],
  session: RelaySession,
) {
  const editScope = useMessageEditScope();
  const actions = useMessageKeyActions(session);
  const latest = useRef(rows);
  latest.current = rows;
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (editScope) editScope.list.current = element;
    const unregister = registerMessageList(element, {
      row: (id) =>
        latest.current.find((row) => row.id === id && !row.membership),
      newest: () =>
        latest.current.reduce<ChannelMessage | undefined>(
          (newest, row) =>
            !row.membership && (!newest || compareMessages(row, newest) > 0)
              ? row
              : newest,
          undefined,
        )?.id,
      canEdit: (row) =>
        !!editScope?.current && !!lastEditableMessage(session, [row]),
      edit: (row) => editScope?.current?.(row),
      canDelete: (row) => !!actions?.canDelete(row),
      remove: (row) => actions?.remove(row),
      canMarkUnread: (row) => !!actions?.canMarkUnread(row),
      markUnread: (row) => actions?.markUnread(row),
      composer: () => editScope?.focusTarget() ?? null,
    });
    return () => {
      unregister();
      if (editScope?.list.current === element) editScope.list.current = null;
    };
  }, [list, editScope, session, actions]);
}

/** For lists that render their own edit scope provider. */
export function MessageSelection(props: {
  list: RefObject<HTMLElement | null>;
  rows: readonly ChannelMessage[];
  session: RelaySession;
}) {
  useMessageSelection(props.list, props.rows, props.session);
  return null;
}
