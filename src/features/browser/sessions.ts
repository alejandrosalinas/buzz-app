import type { BuilderlabViewerSession } from "./api";
import type { BrowserBounds, BrowserPlatform } from "./platform";

/** Native guests open at once; past this the least recently shown hidden one
 * closes, and its view attaches again when it is shown. */
const MAX_GUESTS = 4;
/** How long an unmounted view's guest waits for its view to come back. */
const PARK_MS = 10 * 60_000;
/** Hiding ignores bounds, but the command still takes some. */
const HIDDEN: BrowserBounds = { x: 0, y: 0, width: 1, height: 1 };

/** Each mounted view has its own native guest, which keeps its page while
 * hidden. Lifecycle calls run in order. A view may park its guest when it
 * unmounts, so the same page mounted again soon after finds it as it was. */
export class BrowserSessions {
  private lifecycle = Promise.resolve();
  /** Live guests, least recently shown first. */
  private live: string[] = [];
  private readonly shown = new Set<string>();
  private readonly release = new Map<string, () => void>();
  private readonly parked = new Map<
    string,
    { sessionId: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** Each page's last title, so its tab keeps one name while the page is
   * hidden, loading or opened again. */
  private readonly titles = new Map<string, string>();

  constructor(private readonly platform: BrowserPlatform) {}

  attach(
    url: string,
    bounds: BrowserBounds,
    current: () => boolean,
    storage?: string,
    /** Adopts the guest parked under this key instead of opening `url`. */
    park?: string,
    builderlab?: BuilderlabViewerSession,
  ): Promise<string | undefined> {
    return this.enqueue(async () => {
      if (!current() || builderlab?.signal.aborted) return undefined;
      const parked = park === undefined ? undefined : this.parked.get(park);
      if (park !== undefined && parked) {
        clearTimeout(parked.timer);
        this.parked.delete(park);
        let resumed = true;
        try {
          await this.platform.setMediaSuspended(parked.sessionId, false);
        } catch {
          resumed = false;
        }
        // The view may have gone while the page resumed; then nothing would
        // ever detach it again.
        const wanted = current() && !builderlab?.signal.aborted;
        if (resumed && wanted) return parked.sessionId;
        await this.close(parked.sessionId);
        // A page that cannot play again opens fresh instead.
        if (!wanted) return undefined;
      }
      while (this.live.length >= MAX_GUESTS) await this.close(this.victim());
      const sessionId = await this.platform.attach(
        url,
        bounds,
        storage,
        builderlab,
      );
      this.live.push(sessionId);
      if (current() && !builderlab?.signal.aborted) {
        if (builderlab) {
          // Revocation cannot wait behind another guest's network bootstrap. close removes
          // ownership synchronously; queued lifecycle work then sees a closed session.
          const invalidate = () => {
            void this.close(sessionId);
          };
          builderlab.signal.addEventListener("abort", invalidate, {
            once: true,
          });
          this.release.set(sessionId, () =>
            builderlab.signal.removeEventListener("abort", invalidate),
          );
        }
        return sessionId;
      }
      await this.close(sessionId);
      return undefined;
    });
  }

  /** Closes the guest, or with `park` hides it for the next view that
   * attaches with that key. */
  detach(sessionId: string, park?: string): Promise<void> {
    // An unrelated attach can wait on network exchange; presentation, sound
    // included, must stop now.
    const hidden = this.owns(sessionId)
      ? Promise.all([
          this.platform.setBounds(sessionId, HIDDEN, false),
          this.platform.setMediaSuspended(sessionId, true),
        ])
      : Promise.resolve();
    this.shown.delete(sessionId);
    const detached = this.enqueue(async () => {
      // Re-adoption must not overtake the old view's in-flight hide. A guest
      // that failed to hide or go quiet still closes rather than staying live
      // or parked.
      try {
        await hidden;
      } catch {
        return this.close(sessionId);
      }
      if (park === undefined || !this.owns(sessionId))
        return this.close(sessionId);
      this.shown.delete(sessionId);
      const previous = this.parked.get(park);
      if (previous) await this.close(previous.sessionId);
      // Checked in turn, since an adoption queued before this fires wins.
      const timer = setTimeout(
        () =>
          void this.enqueue(async () => {
            if (this.parked.get(park)?.sessionId === sessionId)
              await this.close(sessionId);
          }),
        PARK_MS,
      );
      this.parked.set(park, { sessionId, timer });
    });
    return Promise.all([hidden, detached]).then(() => undefined);
  }

  /** The last title the page opened under `key` reported. */
  title(key: string): string | undefined {
    return this.titles.get(key);
  }

  rememberTitle(key: string, title: string): void {
    if (title) this.titles.set(key, title);
  }

  /** Whether this session's guest is still open. */
  owns(sessionId: string): boolean {
    return this.live.includes(sessionId);
  }

  /** A view reports whether it is showing its guest. */
  present(sessionId: string, shown: boolean): void {
    if (!this.owns(sessionId)) return;
    if (!shown) {
      this.shown.delete(sessionId);
      return;
    }
    this.shown.add(sessionId);
    this.live = [...this.live.filter((id) => id !== sessionId), sessionId];
  }

  /** A parked guest first, then a hidden one, least recently shown first. */
  private victim(): string {
    const parked = new Set(
      [...this.parked.values()].map((entry) => entry.sessionId),
    );
    return (
      this.live.find((id) => parked.has(id)) ??
      this.live.find((id) => !this.shown.has(id)) ??
      (this.live[0] as string)
    );
  }

  private close(sessionId: string): Promise<void> {
    this.release.get(sessionId)?.();
    this.release.delete(sessionId);
    if (!this.owns(sessionId)) return Promise.resolve();
    this.live = this.live.filter((id) => id !== sessionId);
    this.shown.delete(sessionId);
    for (const [key, entry] of this.parked)
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.parked.delete(key);
      }
    return this.platform.detach(sessionId);
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
