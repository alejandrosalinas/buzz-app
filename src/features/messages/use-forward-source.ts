import { useEffect, useState } from "react";
import { useChannelReference } from "../conversation/channel-reference";
import { linkedMessage } from "../conversation/linked-message";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";

// A timeline can contain many forwards. Only four finite source checks may
// own session readers at once; the active dialog keeps its own live reader.
const queues = new WeakMap<
  RelaySession,
  { running: number; waiting: Set<() => void> }
>();
function enqueue(
  session: RelaySession,
  start: (done: () => void) => () => void,
) {
  let queue = queues.get(session);
  if (!queue) {
    queue = { running: 0, waiting: new Set() };
    queues.set(session, queue);
  }
  const state = queue;
  let stop: (() => void) | undefined;
  let released = false;
  const pump = () => {
    for (const next of state.waiting) {
      if (state.running >= 4) break;
      state.waiting.delete(next);
      next();
    }
  };
  const done = () => {
    if (released) return;
    released = true;
    queueMicrotask(() => {
      stop?.();
      state.running--;
      pump();
    });
  };
  const run = () => {
    state.running++;
    stop = start(done);
  };
  state.waiting.add(run);
  queueMicrotask(pump);
  return () => {
    if (state.waiting.delete(run)) return;
    stop?.();
    done();
  };
}

/** The session owns authorization and reconciled edits; no raw-event fallback. */
export function useForwardSource(
  session: RelaySession | undefined,
  channelId: string,
  id: string,
  active = true,
  live = false,
) {
  const reference = useChannelReference(
    active ? session?.channels : undefined,
    channelId,
  );
  const readable =
    active && reference.state === "found" && reference.readable !== false;
  const key = `${channelId}:${id}`;
  const [result, setResult] = useState<{
    key: string;
    row?: ChannelMessage;
    stopped: boolean;
  }>();
  useEffect(() => {
    if (!session || !readable) return;
    const start = (done: () => void) => {
      let disposed = false;
      try {
        const view = session.thread(channelId, id, {
          exact: true,
          priority: "background",
        });
        const update = () => {
          if (disposed) return;
          const state = linkedMessage(view.snapshot(), id);
          setResult({
            key,
            ...(state.ready && state.message ? { row: state.message } : {}),
            stopped: state.stopped,
          });
          if (!live && (state.ready || state.stopped)) done();
        };
        const unsubscribe = view.subscribe(update);
        update();
        void view.refresh();
        return () => {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          view.dispose();
        };
      } catch {
        setResult({ key, stopped: true });
        done();
        return () => {};
      }
    };
    return live ? start(() => {}) : enqueue(session, start);
  }, [session, readable, channelId, id, key, live]);
  return {
    reference,
    row: readable && result?.key === key ? result.row : undefined,
    unavailable:
      reference.state === "withheld" ||
      (reference.state === "found" &&
        reference.readable === false &&
        reference.answered === true) ||
      (readable && result?.key === key && result.stopped),
  };
}
