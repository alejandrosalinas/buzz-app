import { useSyncExternalStore } from "react";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type { Backdrops } from "./service";

/** A user who asks for less motion, less transparency or their own colors gets
 * the plain shell. Not mounting also stops the backdrop's own loops. */
const PLAIN =
  "(prefers-reduced-motion: reduce), (prefers-reduced-transparency: reduce), (forced-colors: active)";
function subscribePlain(listener: () => void) {
  const query = window.matchMedia(PLAIN);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
const prefersPlain = () => window.matchMedia(PLAIN).matches;

/** Renders nothing unless a plugin registers a backdrop. Each one gets its own
 * stacking context, so later registrations paint above earlier ones whatever
 * z-index they use inside; a failing one disappears without a message. */
export function ShellBackdrops({ backdrops }: { backdrops: Backdrops }) {
  const entries = useSyncExternalStore(backdrops.subscribe, backdrops.snapshot);
  const plain = useSyncExternalStore(subscribePlain, prefersPlain);
  if (plain || !entries.length) return null;
  return (
    <div className="shell-backdrop" aria-hidden="true" inert>
      {entries.map((entry) => (
        <OwnedContribution
          key={entry.key}
          entry={entry}
          registry={backdrops}
          fallback={null}
        >
          {({ component: Layer }) => (
            <div className="shell-backdrop-layer">
              <Layer />
            </div>
          )}
        </OwnedContribution>
      ))}
    </div>
  );
}
