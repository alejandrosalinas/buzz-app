import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { resolveMatch, type Contribution } from "../../plugins/contributions";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import type {
  ContributionReader,
  LinkPreviewRenderer,
} from "../conversation/contracts";
import { useTargetOpener } from "../conversation/opener";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./LinkPreviews.module.css";

/** A message shows this many cards before the rest fold behind one button. */
export const FOLD_AFTER = 3;

const none: readonly Contribution<LinkPreviewRenderer>[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => none;

/** One card, with the host's opener for targets other than its link. */
function LinkPreviewCard({
  url,
  messageId,
  registry,
  renderer,
  open,
}: {
  url: string;
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer>;
  renderer: Contribution<LinkPreviewRenderer>;
  open(): boolean;
}) {
  const opener = useTargetOpener(registry, renderer);
  const Preview = renderer.component;
  return (
    <Preview url={url} messageId={messageId} open={open} opener={opener} />
  );
}

export function LinkPreviews({
  urls,
  messageId,
  registry,
  onOpenLink,
}: {
  urls: readonly string[];
  messageId: string;
  registry: ContributionReader<LinkPreviewRenderer> | undefined;
  onOpenLink(url: string): boolean;
}) {
  const renderers = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? noSnapshot,
    registry?.snapshot ?? noSnapshot,
  );
  const [open, setOpen] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const cards = urls.flatMap((url) => {
    const renderer = resolveMatch(renderers, url);
    return renderer ? [{ url, renderer }] : [];
  });
  if (!registry || !cards.length) return null;
  const shown = open ? cards : cards.slice(0, FOLD_AFTER);
  const hidden = cards.length - shown.length;
  return (
    <div className={styles.previews} data-link-previews>
      {shown.map(({ url, renderer }) => {
        const key = contributionKey(renderer);
        return (
          <ContributionBoundary
            key={`${key}:${url}`}
            fallback={null}
            resetIdentity={key}
          >
            <LinkPreviewCard
              url={url}
              messageId={messageId}
              registry={registry}
              renderer={renderer}
              open={() =>
                live.current && registry.snapshot().includes(renderer)
                  ? onOpenLink(url)
                  : false
              }
            />
          </ContributionBoundary>
        );
      })}
      {(hidden > 0 || (open && cards.length > FOLD_AFTER)) && (
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? "Show fewer previews"
            : `Show ${hidden} more ${hidden === 1 ? "preview" : "previews"}`}
        </Button>
      )}
    </div>
  );
}
