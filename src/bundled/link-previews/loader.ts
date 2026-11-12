import type { Host, HostPagePreview } from "../../features/host/service";
import { previewable } from "./safety";

export type Page = Readonly<{
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageAlt?: string;
}>;

const MAX_REDIRECTS = 5;
const PARALLEL = 4;
const KEEP_PAGES = 200;
const KEEP_IMAGES = 60;
const MAX_IMAGE_BYTES = 4_000_000;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

type Reader = Pick<Host, "readPage" | "requestBytes">;
type Held = { src: Promise<string | null>; users: number; kept: boolean };
export type ImageLease = Readonly<{
  src: Promise<string | null>;
  release(): void;
}>;

/** Reads previews and their images through the host, at most `PARALLEL` at
 * once, checking every redirect hop with `previewable` before asking again.
 * Results are kept for the session; failures are not. Image `src` values are
 * only ever `blob:` URLs, so the web view never fetches a page-chosen address. */
export function createLoader(host: Reader | undefined) {
  const readPage = host?.readPage?.bind(host);
  const requestBytes = host?.requestBytes?.bind(host);
  const pages = new Map<string, Promise<Page | null>>();
  const images = new Map<string, Held>();
  const waiting: (() => void)[] = [];
  let active = 0;
  let stopped = false;

  async function slot<T>(run: () => Promise<T>): Promise<T | null> {
    if (active >= PARALLEL)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return stopped ? null : await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  /** Follows redirects one checked hop at a time; `ask` returns the next
   * location to try, a final value, or null. */
  async function follow<T>(
    start: string,
    ask: (url: URL) => Promise<{ location: string } | { value: T } | null>,
  ): Promise<T | null> {
    let current = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const target = previewable(current);
      if (!target || stopped) return null;
      const reply = await slot(() => ask(target));
      if (!reply) return null;
      if ("value" in reply) return reply.value;
      try {
        current = new URL(reply.location, target).href;
      } catch {
        return null;
      }
    }
    return null;
  }

  const toPage = (url: string, preview: HostPagePreview): Page | null => {
    const title = preview.title?.trim();
    if (!title) return null;
    const image = preview.image && previewable(preview.image)?.href;
    return {
      url,
      title,
      ...(preview.description ? { description: preview.description } : {}),
      ...(preview.siteName ? { siteName: preview.siteName } : {}),
      ...(image ? { image } : {}),
      ...(preview.imageAlt ? { imageAlt: preview.imageAlt } : {}),
    };
  };

  function remember<T>(
    cache: Map<string, Promise<T | null>>,
    key: string,
    keep: number,
    load: () => Promise<T | null>,
  ) {
    const found = cache.get(key);
    if (found) {
      cache.delete(key);
      cache.set(key, found);
      return found;
    }
    const pending = load().catch(() => null);
    cache.set(key, pending);
    void pending.then((value) => {
      if (value === null && cache.get(key) === pending) cache.delete(key);
    });
    for (const old of cache.keys()) {
      if (cache.size <= keep) break;
      cache.delete(old);
    }
    return pending;
  }

  const revoke = (held: Held) =>
    void held.src.then((src) => src && URL.revokeObjectURL(src));
  const revokeIfUnused = (held: Held) => {
    if (!held.kept && held.users === 0) revoke(held);
  };

  const loadImage = (url: string) =>
    follow(url, async (target) => {
      if (!requestBytes) return null;
      const reply = await requestBytes({
        url: target.href,
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: 8000,
      });
      const header = (name: string) =>
        Object.entries(reply.headers).find(
          ([key]) => key.toLowerCase() === name,
        )?.[1];
      if (reply.status >= 300 && reply.status < 400) {
        const location = header("location");
        return location ? { location } : null;
      }
      const type = (header("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (
        reply.status !== 200 ||
        !reply.body.byteLength ||
        !type ||
        !IMAGE_TYPES.has(type) ||
        stopped
      )
        return null;
      return {
        value: URL.createObjectURL(
          new Blob([reply.body as BlobPart], { type }),
        ),
      };
    }).catch(() => null);

  return {
    available: !!readPage,
    page(url: string): Promise<Page | null> {
      if (!readPage) return Promise.resolve(null);
      return remember(pages, url, KEEP_PAGES, () =>
        follow(url, async (target) => {
          const reply = await readPage(target.href, { timeoutMs: 10_000 });
          if (reply.status >= 300 && reply.status < 400)
            return reply.location ? { location: reply.location } : null;
          return reply.preview
            ? { value: toPage(target.href, reply.preview) }
            : null;
        }),
      );
    },
    /** A lease on the image's `blob:` URL. The cache keeps at most
     * `KEEP_IMAGES` for reuse, but a URL is revoked only once it has left the
     * cache and every lease on it is released. */
    image(url: string): ImageLease {
      if (!requestBytes || stopped)
        return { src: Promise.resolve(null), release() {} };
      let held = images.get(url);
      if (held) {
        images.delete(url);
        images.set(url, held);
      } else {
        const entry: Held = { src: loadImage(url), users: 0, kept: true };
        held = entry;
        images.set(url, entry);
        void entry.src.then((src) => {
          if (src === null && images.get(url) === entry) {
            images.delete(url);
            entry.kept = false;
          }
        });
        for (const [old, value] of images) {
          if (images.size <= KEEP_IMAGES) break;
          images.delete(old);
          value.kept = false;
          revokeIfUnused(value);
        }
      }
      const leased = held;
      leased.users++;
      let released = false;
      return {
        src: leased.src,
        release() {
          if (released) return;
          released = true;
          leased.users--;
          revokeIfUnused(leased);
        },
      };
    },
    stop() {
      stopped = true;
      for (const held of images.values()) {
        held.kept = false;
        revoke(held);
      }
      images.clear();
      pages.clear();
      const released = waiting.splice(0);
      active += released.length;
      for (const resolve of released) resolve();
    },
  };
}
export type Loader = ReturnType<typeof createLoader>;
