import type { Attachment } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

type Dimensions = NonNullable<Attachment["dimensions"]>;
// Like timeline geometry, decoded sizes outlive virtualized rows, not sessions.
// Retain only numbers; relay/media owns the bounded pool of decoded pixels.
const sessions = new WeakMap<RelaySession, Map<string, Dimensions>>();
const limit = 512;

export function imageDimensions(
  session: RelaySession | undefined,
  source: string | undefined,
) {
  return session && source ? sessions.get(session)?.get(source) : undefined;
}

export function rememberImageDimensions(
  session: RelaySession | undefined,
  source: string,
  dimensions: Dimensions,
) {
  if (!session) return;
  const entries = sessions.get(session) ?? new Map<string, Dimensions>();
  sessions.set(session, entries);
  entries.delete(source);
  entries.set(source, dimensions);
  if (entries.size > limit) {
    const first = entries.keys().next().value;
    if (first !== undefined) entries.delete(first);
  }
}
