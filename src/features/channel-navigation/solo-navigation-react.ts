import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  soloNavigationFor,
  type SoloNavigationSnapshot,
} from "./solo-navigation";

const empty: SoloNavigationSnapshot = {
  regions: [],
  excluded: new Set(),
  managed: new Set(),
};
const noSubscription = () => () => {};
export function useSoloNavigation(session: RelaySession) {
  const reader = soloNavigationFor(session);
  return useSyncExternalStore(
    reader?.subscribe ?? noSubscription,
    reader?.snapshot ?? (() => empty),
  );
}
