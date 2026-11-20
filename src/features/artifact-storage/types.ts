import type { JsonValue } from "../navigation/targets";
import type { RelayEvent } from "../relay/events";

export type ArtifactRevision = Readonly<{
  id: string;
  content: string;
  event?: RelayEvent;
}>;
export type ArtifactAvailability = Readonly<{
  state: "unknown" | "available" | "unavailable" | "deleted";
  reason?: string;
}>;
export type SavedArtifact = Readonly<{
  id: string;
  channelId?: string;
  type?: string;
  current?: ArtifactRevision;
  /** Cached content does not establish current access. */
  availability: ArtifactAvailability;
  /** A plugin-owned snapshot, without shared revision proof. */
  local?: JsonValue;
}>;
export type ArtifactEntry = Readonly<{
  record: SavedArtifact;
  preference?: JsonValue;
}>;
export type ArtifactIndex = Readonly<{
  index: string;
  value: string;
  order: string;
}>;
export type ArtifactCollectionDefinition = Readonly<{
  name: string;
  /** The shared artifact type admitted by this collection. */
  type: string;
  /** Increase when the projection changes. Saved rows are reindexed atomically. */
  version: number;
  project(entry: ArtifactEntry): readonly ArtifactIndex[];
}>;
export type ArtifactPageQuery = Readonly<{
  index: string;
  value: string;
  limit?: number;
  after?: Readonly<{ order: string; id: string }>;
}>;
export type ArtifactPage = Readonly<{
  entries: readonly ArtifactEntry[];
  next?: Readonly<{ order: string; id: string }>;
}>;
export type ArtifactImport = Readonly<{
  records?: readonly Readonly<{ id: string; local: JsonValue }>[];
  preferences?: readonly Readonly<{ id: string; value: JsonValue }>[];
  /** The final batch and this marker commit together. */
  marker?: string;
}>;
export type ArtifactCollectionChange =
  | Readonly<{ ids: readonly string[] }>
  | Readonly<{ reset: true }>;
export type ArtifactCollection = {
  readonly scope: Readonly<{
    viewer: string;
    relay: string;
    partition: string;
  }>;
  get(id: string): Promise<ArtifactEntry | undefined>;
  refreshError(): Promise<string | null>;
  page(query: ArtifactPageQuery): Promise<ArtifactPage>;
  /** Subscribe before the first read. Each notification requires a fresh read. */
  subscribe(listener: () => void): () => void;
  /**
   * Post-commit local invalidation hints, without content or access authority.
   * Subscribe before scanning; buffer IDs during the scan, then re-read with get.
   * Reset discards the scan/index. Rebuild after reopening or any delivery gap.
   * Optional on older hosts. See docs/local-artifact-storage.md for recovery.
   */
  subscribeChanges?(
    listener: (change: ArtifactCollectionChange) => void,
  ): () => void;
  preferences: {
    get(id: string): Promise<JsonValue | undefined>;
    update(
      id: string,
      change: (current: JsonValue | undefined) => JsonValue,
    ): Promise<void>;
  };
  /** Inserts absent refreshs and preferences. Retries preserve later edits. */
  importBatch(batch: ArtifactImport): Promise<void>;
  imported(marker: string): Promise<boolean>;
  close(): void;
};
export type ReceivedArtifact = Readonly<{
  id: string;
  channelId: string;
  type: string;
  revision: ArtifactRevision;
}>;
export type ArtifactRefresh = Readonly<{
  source: string;
  generation: string;
}>;
export type ArtifactBatch = Readonly<{
  /** Exact authoritative query scope, defined by the sync owner. */
  source: string;
  refresh: ArtifactRefresh;
  records?: readonly ReceivedArtifact[];
  availability?: readonly Readonly<{
    id: string;
    /** The current ID observed locally, regardless of missed relay revisions. */
    expectedRevision: string | null;
    value: ArtifactAvailability;
  }>[];
}>;
/** Host-only writes. Plugins submit shared changes through the delivery service. */
export type HostArtifactCollection = ArtifactCollection & {
  subscribeChanges: NonNullable<ArtifactCollection["subscribeChanges"]>;
  applyBatch(batch: ArtifactBatch, signal?: AbortSignal): Promise<void>;
  checkpoint(): Promise<string | null>;
  knownIds(query: {
    after?: string;
    limit?: number;
    channelId?: string;
  }): Promise<{ ids: readonly string[]; next?: string }>;

  setRefreshError(
    refresh: ArtifactRefresh,
    message: string,
    signal?: AbortSignal,
  ): Promise<void>;
  beginRefresh(source: string): Promise<ArtifactRefresh>;
  /** Commit progress after all pages succeed. Unseen records stay unchanged. */
  completeRefresh(
    refresh: ArtifactRefresh,
    checkpoint: { expected: string | null; next: string },
    signal?: AbortSignal,
  ): Promise<void>;
};
