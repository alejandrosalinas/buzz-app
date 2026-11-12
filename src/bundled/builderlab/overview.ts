/** A view of the existing list owner's request, never a separate data source. */
export type OverviewSnapshot =
  | { kind: "pending" | "failed" | "empty" | "unavailable" }
  | {
      kind: "filled";
      items: readonly { key: string; label: string; note?: string }[];
    };

export type OverviewObserver = (snapshot: OverviewSnapshot) => void;
