export const OUTBOX_INPUT_MAX_BYTES = 32 * 1024;

/** Profiles kept in memory when no open channel reserves more. */
export const PROFILE_CACHE_BASE = 1024;
/** Hard limit while an open channel reserves room for its members. */
export const PROFILE_CACHE_MAX = 10_240;
/** The roster profiles a view may load at a cache limit: the room an open
 * channel reserved, so the base stays free for every other name on screen.
 * With no reservation a view may still use the base. */
export const profileRosterRoom = (limit: number) =>
  limit > PROFILE_CACHE_BASE ? limit - PROFILE_CACHE_BASE : PROFILE_CACHE_BASE;
/** Byte budget per profile entry; a typical signed kind 0 is 0.5-1 KiB. */
export const PROFILE_ENTRY_BYTES = 2 * 1024;

/** Deterministic UTF-8 budget, used for both warm data and persisted records. */
export const byteSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const sizes = new WeakMap<object, number>();
/** `byteSize` of a list whose members never change, such as verified events.
 * A live window checks its budget on every message; each member is serialized
 * once instead of the whole window each time. */
export function listByteSize(values: readonly object[]) {
  let bytes = 2 + Math.max(0, values.length - 1);
  for (const value of values) {
    let size = sizes.get(value);
    if (size === undefined) {
      size = byteSize(value);
      sizes.set(value, size);
    }
    bytes += size;
  }
  return bytes;
}

export class ByteLru<T> {
  private items = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    public maxEntries: number,
    public maxBytes: number,
    /** Entries eviction takes last; the limits still hold. */
    private keep?: (key: string) => boolean,
  ) {}
  /** Change both limits; shrinking evicts least recently used entries now. */
  resize(maxEntries: number, maxBytes: number) {
    const before = this.evictions;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.evict();
    return this.evictions - before;
  }
  get(key: string): T | undefined {
    const entry = this.items.get(key);
    if (!entry) return;
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }
  peek(key: string) {
    return this.items.get(key)?.value;
  }
  set(key: string, value: T, bytes = byteSize(value)): boolean {
    this.delete(key);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
    this.evict();
    return true;
  }
  /** Replace a present entry without making it the most recent. */
  replace(key: string, value: T, bytes = byteSize(value)): boolean {
    const entry = this.items.get(key);
    if (!entry || bytes > this.maxBytes) {
      this.delete(key);
      return false;
    }
    this.bytes += bytes - entry.bytes;
    this.items.set(key, { value, bytes });
    this.evict();
    return true;
  }
  /** Entries removed to stay within the limits, over this cache's lifetime. */
  evictions = 0;
  /** Least recently used first, kept entries only once no other is left. */
  private evict() {
    for (const spare of [true, false])
      for (const oldest of this.items.keys()) {
        if (this.items.size <= this.maxEntries && this.bytes <= this.maxBytes)
          return;
        if (spare && this.keep?.(oldest)) continue;
        this.delete(oldest);
        this.evictions++;
      }
  }
  delete(key: string) {
    const entry = this.items.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
  keys() {
    return [...this.items.keys()];
  }
  entries(): [string, T][] {
    return [...this.items].map(([key, entry]) => [key, entry.value]);
  }
  stats() {
    return { entries: this.items.size, bytes: this.bytes };
  }
}
