import type { ReviewEvent } from "./pull";
import { parseGitHubReference } from "./references";

export type PanelView = "summary" | "changes";

/** A review not yet submitted, and the head it was written against. */
export type ReviewDraft = Readonly<{
  event: ReviewEvent;
  body: string;
  head: string;
}>;

/** What pull request panels were left showing, for the app session. A
 * channel unmounts its panels when you leave it, so the next panel on a pull
 * request starts where the last one was. Only pull requests are kept. */
export type PanelMemory = Readonly<{
  /** The view `url`'s panel was left on in `channelId`, and its unsent
   * review, which is the same from any channel: GitHub keeps one pending
   * review per pull request. */
  get(
    url: string,
    channelId?: string,
  ): Readonly<{
    view?: PanelView | undefined;
    review?: ReviewDraft | undefined;
  }>;
  setView(url: string, view: PanelView, channelId?: string): void;
  /** Undefined forgets the draft. */
  setReview(url: string, review: ReviewDraft | undefined): void;
}>;

/** GitHub names are not case-sensitive, so one key holds every casing, as in
 * the pull request store. */
const keyOf = (url: string) => {
  const reference = parseGitHubReference(url);
  return reference?.kind === "pull" ? reference.url.toLowerCase() : undefined;
};

export function createPanelMemory(): PanelMemory {
  const views = new Map<string, PanelView>();
  const reviews = new Map<string, ReviewDraft>();
  const viewKey = (key: string, channelId = "") => `${channelId} ${key}`;
  return {
    get(url, channelId) {
      const key = keyOf(url);
      return key
        ? {
            view: views.get(viewKey(key, channelId)),
            review: reviews.get(key),
          }
        : {};
    },
    setView(url, view, channelId) {
      const key = keyOf(url);
      if (key) views.set(viewKey(key, channelId), view);
    },
    setReview(url, review) {
      const key = keyOf(url);
      if (!key) return;
      if (review) reviews.set(key, review);
      else reviews.delete(key);
    },
  };
}
