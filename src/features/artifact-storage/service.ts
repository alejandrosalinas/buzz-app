import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../communities/service";
import { communityDestination } from "../communities/destination";
import { createArtifactStore, type ArtifactStore } from "./store";
import type {
  ArtifactCollection,
  ArtifactCollectionDefinition,
  HostArtifactCollection,
} from "./types";

export type ArtifactStorage = {
  /** Captures the current identity and relay. Close the handle on scope changes. */
  open(definition: ArtifactCollectionDefinition): ArtifactCollection;
};
export type OpenArtifactCollection = Readonly<{
  viewer: string;
  relay: string;
  owner: string;
  definition: ArtifactCollectionDefinition;
  collection: HostArtifactCollection;
  signal: AbortSignal;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    artifactStorage: ArtifactStorage;
  }
}

export class ArtifactStorageService extends Service implements ArtifactStorage {
  private stores = new Map<string, ArtifactStore>();
  private opened = new Set<(entry: OpenArtifactCollection) => void>();
  constructor(ctx: Context) {
    super(ctx, "artifactStorage");
    ctx.effect(() => () => {
      for (const store of this.stores.values()) store.close();
      this.stores.clear();
      this.opened.clear();
    });
  }
  /** Host-only attachment point for the shared sync service. */
  onOpen(listener: (entry: OpenArtifactCollection) => void) {
    this.opened.add(listener);
    return () => {
      this.opened.delete(listener);
    };
  }
  open(definition: ArtifactCollectionDefinition): ArtifactCollection {
    const owner = this.ctx.pluginOwner?.id;
    const capture = () => {
      const { viewer, selected } = this.ctx.communityReader.snapshot();
      return {
        viewer,
        origin: selected ? communityDestination(selected).url : undefined,
      };
    };
    const { viewer, origin } = capture();
    if (!owner || !viewer || !origin)
      throw new Error("Artifact storage needs a plugin, identity and relay");
    const scope = JSON.stringify([viewer, origin]);
    let store = this.stores.get(scope);
    if (!store) {
      store = createArtifactStore(viewer, origin);
      this.stores.set(scope, store);
    }
    const collection = store.collection(owner, definition);
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let removeEffect: (() => void) | undefined;
    const close = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      unsubscribe?.();
      collection.close();
      removeEffect?.();
    };
    const valid = () => {
      const now = capture();
      if (
        controller.signal.aborted ||
        now.viewer !== viewer ||
        now.origin !== origin
      )
        throw new Error("Artifact storage scope changed");
    };
    unsubscribe = this.ctx.communityReader.subscribe(() => {
      const now = capture();
      if (now.viewer !== viewer || now.origin !== origin) close();
    });
    const checked = async <T>(operation: Promise<T>) => {
      const result = await operation;
      valid();
      return result;
    };
    const facade: ArtifactCollection = {
      scope: collection.scope,
      refreshError() {
        valid();
        return checked(collection.refreshError());
      },
      get(id) {
        valid();
        return checked(collection.get(id));
      },
      page(query) {
        valid();
        return checked(collection.page(query));
      },
      subscribe(listener) {
        valid();
        return collection.subscribe(listener);
      },
      subscribeChanges(listener) {
        valid();
        return collection.subscribeChanges(listener);
      },
      preferences: {
        get(id) {
          valid();
          return checked(collection.preferences.get(id));
        },
        update(id, change) {
          valid();
          return collection.preferences.update(id, change);
        },
      },
      importBatch(batch) {
        valid();
        return collection.importBatch(batch);
      },
      imported(marker) {
        valid();
        return checked(collection.imported(marker));
      },
      close,
    };
    removeEffect = this.ctx.effect(() => close);
    for (const listener of this.opened)
      listener({
        viewer,
        relay: origin,
        owner,
        definition,
        collection,
        signal: controller.signal,
      });
    return facade;
  }
}
