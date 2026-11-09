import type { AgentLibrary, AgentLibraryReader } from "./library";
import { definitionSlug } from "./relay-library";
import { retryRead } from "../relay/read-retry";

/** Preserve local names/artwork; add relay-only keys. Names never join identities. */
export function combineInventory(
  local: AgentLibrary,
  relay: AgentLibrary,
): AgentLibrary {
  const slugs = new Map<string, string[]>();
  for (const row of local.definitions) {
    const slug = definitionSlug(row.id);
    slugs.set(slug, [...(slugs.get(slug) ?? []), row.id]);
  }
  const localId = (id: string) =>
    slugs.get(definitionSlug(id))?.length === 1
      ? `profile:${definitionSlug(id)}`
      : `local:${id}`;
  // Identities can reference omitted local definitions; alias exact IDs only.
  const exact = new Map(
    local.definitions.map((row) => [row.id, localId(row.id)]),
  );
  const localReference = (id: string) => exact.get(id) ?? `local:${id}`;
  const definitions = new Map(
    relay.definitions.map((row) => [
      `profile:${row.id}`,
      { ...row, id: `profile:${row.id}` },
    ]),
  );
  for (const row of local.definitions)
    definitions.set(localId(row.id), { ...row, id: localId(row.id) });
  const identities = new Map(
    relay.identities.map((row) => [
      row.pubkey.toLowerCase(),
      {
        ...row,
        pubkey: row.pubkey.toLowerCase(),
        ...(row.definitionId
          ? { definitionId: `profile:${row.definitionId}` }
          : {}),
      },
    ]),
  );
  for (const row of local.identities) {
    const key = row.pubkey.toLowerCase();
    identities.set(key, {
      ...identities.get(key),
      ...row,
      pubkey: key,
      ...(row.definitionId
        ? { definitionId: localReference(row.definitionId) }
        : {}),
    });
  }
  return {
    definitions: [...definitions.values()],
    identities: [...identities.values()],
  };
}

/** A failed source must not erase the other source's usable inventory. */
export function inventoryReader(
  local: AgentLibraryReader | undefined,
  relay: AgentLibraryReader,
): AgentLibraryReader {
  return async (signal) => {
    const empty = { definitions: [], identities: [] };
    const [saved, remote] = await Promise.allSettled([
      local ? local(signal) : Promise.resolve(empty),
      // Only the relay source is a finite network read; it owns its retries.
      retryRead(relay, signal),
    ]);
    signal.throwIfAborted();
    for (const [source, result] of [
      ["Local agent library", saved],
      ["Relay agent inventory", remote],
    ] as const)
      if (result.status === "rejected")
        console.warn(`${source} read failed`, result.reason);
    if (remote.status === "rejected" && (!local || saved.status === "rejected"))
      throw new Error("Agent inventory sources unavailable");
    const error =
      saved.status === "rejected"
        ? "Local library unavailable; showing relay inventory. Refresh agents to include local identities."
        : remote.status === "rejected"
          ? "Relay inventory unavailable; showing local library. Refresh agents to discover other identities."
          : undefined;
    return {
      ...combineInventory(
        saved.status === "fulfilled" ? saved.value : empty,
        remote.status === "fulfilled" ? remote.value : empty,
      ),
      ...(error ? { error } : {}),
    };
  };
}
