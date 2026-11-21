import styles from "./SidebarFrame.module.css";

type Candidate = HTMLElement | null | undefined;
const destinationSelector =
  "button[data-channel-id], button[data-solo-destination-id]";

export function captureSidebarDeparture(departing: HTMLElement) {
  // Composed Solo destinations can sit inside a second navigation landmark.
  const sidebar = departing.closest<HTMLElement>(`nav.${styles.channelList}`);
  const viewport = sidebar?.getBoundingClientRect();
  const row = departing.getBoundingClientRect();
  return {
    sidebar,
    preventScroll:
      !!viewport && (row.bottom <= viewport.top || row.top >= viewport.bottom),
  };
}

/** Recover focus after a passive row removal without scrolling back to an exit. */
export function recoverSidebarFocus(
  { sidebar, preventScroll }: ReturnType<typeof captureSidebarDeparture>,
  candidates: (sidebar: HTMLElement | null) => readonly Candidate[] | undefined,
  { preferVisibleRows = false } = {},
) {
  const restoreFocus = () => {
    const preferred = candidates(sidebar);
    if (!preferred) return;
    if ((preventScroll || preferVisibleRows) && sidebar?.isConnected) {
      const frame = sidebar.getBoundingClientRect();
      const inView = (candidate: HTMLElement) => {
        if (
          !sidebar.contains(candidate) ||
          !candidate.matches(destinationSelector)
        )
          return false;
        const rect = candidate.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.top >= frame.top &&
          rect.bottom <= frame.bottom
        );
      };
      if (
        focusFirst(preferred, true, inView) ||
        (preventScroll &&
          focusFirst(
            sidebar.querySelectorAll<HTMLElement>(destinationSelector),
            true,
            inView,
          ))
      )
        return;
    }
    focusFirst(preferred, preventScroll);
  };
  // The sidebar's mutation observer can be queued later in the same commit.
  // Let it restore the viewport before choosing a live focus target.
  queueMicrotask(() => queueMicrotask(restoreFocus));
}

function focusFirst(
  candidates: Iterable<Candidate>,
  preventScroll: boolean,
  accept?: (candidate: HTMLElement) => boolean,
) {
  for (const candidate of candidates) {
    if (
      !candidate?.isConnected ||
      candidate.closest("[hidden], [inert], :disabled") ||
      (accept && !accept(candidate))
    )
      continue;
    candidate.focus({ preventScroll });
    if (candidate.ownerDocument.activeElement === candidate) return true;
  }
  return false;
}
