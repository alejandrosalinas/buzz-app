import { Service, type Context } from "@deepseek-ai/cordis";

export interface Seen {
  /** True if recorded, false if absent, undefined if the answer is unknown. */
  has(key: string): boolean | undefined;
  /** Record a key for the current identity. */
  mark(key: string): void;
  subscribe(listener: () => void): () => void;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    seen?: Seen;
  }
}

type Viewer = {
  snapshot(): { viewer?: string };
  subscribe(listener: () => void): () => void;
};

function validKey(key: unknown): key is string {
  if (
    typeof key !== "string" ||
    [...key].length > 96 ||
    /[\uD800-\uDFFF]/u.test(key)
  )
    return false;
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1;
}

export class SeenService extends Service implements Seen {
  private prefix: string | undefined;
  private readonly unsaved = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context, viewer: Viewer) {
    super(ctx, "seen");
    ctx.effect(() => {
      const identityChanged = () => {
        const { viewer: pubkey } = viewer.snapshot();
        const prefix = pubkey ? `buzz.seen.v1:${pubkey}:` : undefined;
        if (this.prefix === prefix) return;
        this.prefix = prefix;
        this.unsaved.clear();
        this.emit();
      };
      const storageChanged = (event: StorageEvent) => {
        if (
          !this.prefix ||
          (event.key !== null && !event.key.startsWith(this.prefix))
        )
          return;
        try {
          if (event.storageArea !== localStorage) return;
        } catch {
          return;
        }
        if (event.key === null) this.unsaved.clear();
        this.emit();
      };
      const stop = viewer.subscribe(identityChanged);
      globalThis.window?.addEventListener("storage", storageChanged);
      identityChanged();
      return () => {
        stop();
        globalThis.window?.removeEventListener("storage", storageChanged);
        this.prefix = undefined;
        this.unsaved.clear();
        this.listeners.clear();
      };
    });
  }

  has = (key: string): boolean | undefined => {
    if (!this.prefix || !validKey(key)) return undefined;
    if (this.unsaved.has(key)) return true;
    try {
      const stored = localStorage.getItem(this.prefix + key);
      if (stored === "1") return true;
      return stored === null ? false : undefined;
    } catch {
      return undefined;
    }
  };

  mark = (key: string): void => {
    if (!this.prefix || !validKey(key)) return;
    const known = this.has(key) === true;
    if (known && !this.unsaved.has(key)) return;
    try {
      // One write per key keeps this set add-only across windows.
      localStorage.setItem(this.prefix + key, "1");
      this.unsaved.delete(key);
    } catch {
      this.unsaved.add(key);
    }
    if (!known) this.emit();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
