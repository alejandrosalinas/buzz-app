import { isPrivateForwardSource } from "./is-private-forward-source";
import { snapshotMessage } from "../relay/forwarded-message";
import type { RelaySession } from "../relay/session";
import { splitPartition } from "../relay/partition";
import { linkedMessage } from "../conversation/linked-message";
import { forwardReference, type ForwardReference } from "./forward-clipboard";

/** Freeze the displayed bindings before crossing a composer/queue boundary. */
export function prepareForwardSource(
  ...args: Parameters<typeof snapshotMessage>
) {
  const snapshot = snapshotMessage(...args);
  return {
    row: { ...args[0], mentionLabels: snapshot.mentionLabels ?? [] },
    snapshot,
  };
}

/** Resolve in the owning authorized session, including for detached composers. */
export async function resolveForward(
  session: RelaySession,
  value: ForwardReference,
  signal: AbortSignal,
) {
  const reference = forwardReference(value);
  if (
    !reference ||
    reference.origin !== splitPartition(session.scope)?.communityOrigin
  )
    throw new Error("This message belongs to another community.");
  const aborted = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  aborted.throwIfAborted();
  await session.channels.resolve?.([reference.channelId], { signal: aborted });
  aborted.throwIfAborted();
  const view = session.thread(reference.channelId, reference.id, {
    exact: true,
    priority: "background",
  });
  let unsubscribe = () => {};
  try {
    const row = await new Promise<import("../relay/contracts").ChannelMessage>(
      (resolve, reject) => {
        const fail = () =>
          reject(
            new Error(
              "Couldn't load this message. It may have been deleted, or you no longer have access.",
            ),
          );
        const update = () => {
          const state = linkedMessage(view.snapshot(), reference.id);
          if (state.ready && state.message) resolve(state.message);
          else if (state.stopped) fail();
        };
        const stop = view.subscribe(update);
        aborted.addEventListener("abort", fail, { once: true });
        unsubscribe = () => {
          stop();
          aborted.removeEventListener("abort", fail);
        };
        if (aborted.aborted) fail();
        else {
          update();
          void view.refresh().catch(fail);
        }
      },
    );
    const author = row.workflowOwnerId ?? row.authorId;
    const name =
      session.names?.resolve(
        author,
        session.profiles.snapshot().get(author)?.name ?? author.slice(0, 10),
      ) ??
      session.profiles.snapshot().get(author)?.name ??
      author.slice(0, 10);
    const channel = session.channels.describe?.(row.channelId);
    const privateSource = isPrivateForwardSource(channel);
    const prepared = prepareForwardSource(
      row,
      name,
      session.profiles.snapshot(),
      session.agentLibrary?.snapshot().identities ?? [],
    );
    return {
      row: prepared.row,
      name,
      privateSource: !!privateSource,
      problem: session.messages.forwardProblem(
        reference.channelId,
        prepared.row,
        name,
        "",
      ),
    };
  } finally {
    unsubscribe();
    view.dispose();
  }
}
export type ResolvedForward = Awaited<ReturnType<typeof resolveForward>>;
