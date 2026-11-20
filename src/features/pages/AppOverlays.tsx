import { useSyncExternalStore } from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import { isBundledContribution } from "../../plugins/provenance";
import type { Pages } from "./service";

/** Bundled plugins' app overlays, each in its own error boundary, so one
 * that fails shows nothing and takes nothing else down. */
export function AppOverlays({ pages }: { pages: Pick<Pages, "overlays"> }) {
  const { overlays } = pages;
  const entries = useSyncExternalStore(overlays.subscribe, overlays.snapshot);
  return entries.filter(isBundledContribution).map((entry) => (
    <OwnedContribution
      key={entry.key}
      entry={entry}
      registry={overlays}
      fallback={null}
    >
      {(owned) => <owned.component />}
    </OwnedContribution>
  ));
}
