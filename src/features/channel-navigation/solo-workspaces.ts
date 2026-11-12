import type { RelaySession } from "../relay/session";
import type {
  SoloRegionBinding,
  SoloWorkspaceSnapshot,
  SoloWorkspaces,
} from "./solo-navigation-contract";

type Preferences = RelaySession["soloPreferences"];
const ended: SoloWorkspaceSnapshot = Object.freeze({
  status: "unavailable",
  workspaces: [],
  canCreate: false,
  error: "This Solo workspace binding has ended",
});

/** Project the existing preference owner; never expose ordinary chat assignments. */
export function createSoloWorkspaces(
  resolve: (binding: SoloRegionBinding) => Preferences | undefined,
  subscribeConnection: (listener: () => void) => () => void,
): SoloWorkspaces {
  const cache = new WeakMap<
    Preferences,
    {
      source: ReturnType<Preferences["snapshot"]>;
      value: SoloWorkspaceSnapshot;
    }
  >();
  const current = (binding: SoloRegionBinding) => {
    const preferences = resolve(binding);
    if (!preferences) throw new Error(ended.error);
    return preferences;
  };
  return Object.freeze({
    snapshot(binding) {
      const preferences = resolve(binding);
      if (!preferences) return ended;
      const source = preferences.snapshot();
      const canCreate = preferences.sectionCreationWritable;
      const previous = cache.get(preferences);
      if (previous?.source === source && previous.value.canCreate === canCreate)
        return previous.value;
      const value: SoloWorkspaceSnapshot = Object.freeze({
        status:
          source.cached ||
          source.status === "error" ||
          source.status === "unsupported"
            ? "unavailable"
            : source.status === "ready"
              ? "ready"
              : "loading",
        workspaces: Object.freeze(
          (source.data?.sections ?? []).map(({ id, name }) =>
            Object.freeze({ id, name }),
          ),
        ),
        canCreate,
        ...(source.error ? { error: source.error } : {}),
      });
      cache.set(preferences, { source, value });
      return value;
    },
    subscribe(binding, listener) {
      const preferences = current(binding);
      const stopPreferences = preferences.subscribe(listener);
      const stopConnection = subscribeConnection(listener);
      return () => {
        stopPreferences();
        stopConnection();
      };
    },
    async refresh(binding) {
      const preferences = current(binding);
      await preferences.refresh();
      if (current(binding) !== preferences) throw new Error(ended.error);
    },
    async create(binding, input) {
      const preferences = current(binding);
      await preferences.createSection(input);
      if (current(binding) !== preferences) throw new Error(ended.error);
    },
  });
}
