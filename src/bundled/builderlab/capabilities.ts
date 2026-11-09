export type Capabilities = Readonly<{
  canUseRemoteAgents: boolean;
  canUseBuilderlabDecisions: boolean;
}>;

const capabilityFields = {
  canUseRemoteAgents: "can_use_remote_agents",
  canUseBuilderlabDecisions: "can_use_builderlab_decisions",
} as const satisfies Record<keyof Capabilities, string>;
const capabilityKeys = Object.keys(capabilityFields) as (keyof Capabilities)[];

/** How long a sign-in's permissions are trusted before they are read again. */
const PERMISSIONS_MAX_AGE_MS = 60_000;

/** Only literal true grants a capability; missing flags are denied. */
export function capabilitiesFrom(raw: unknown): Capabilities {
  const flags = raw as Record<string, unknown> | null | undefined;
  return Object.fromEntries(
    capabilityKeys.map((key) => [key, flags?.[capabilityFields[key]] === true]),
  ) as Capabilities;
}

function sameCapabilities(a: Capabilities, b: Capabilities): boolean {
  return capabilityKeys.every((key) => a[key] === b[key]);
}

/** The capabilities in an `/auth/me` body, or undefined when it has none. */
function capabilitiesIn(value: unknown): Capabilities | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  if (
    capabilities !== undefined &&
    (!capabilities ||
      typeof capabilities !== "object" ||
      Array.isArray(capabilities))
  )
    return;
  return capabilitiesFrom(capabilities);
}

/**
 * One sign-in's permissions, kept at most a minute old by whoever reads them.
 * Reading never waits: `revalidate` starts a due read in the background, and
 * `settled` waits for it. Concurrent reads share one request; a failed read
 * keeps the previous values and also waits a minute before the next.
 */
export type Permissions = Readonly<{
  /** Starts a read when one is due. True while a read is running. */
  revalidate(): boolean;
  /** Resolves once no read is due or running; never rejects. */
  settled(): Promise<void>;
}>;

export function createPermissions({
  initial,
  read,
  changed,
  settled,
  checkedAt = Date.now(),
}: {
  initial: Capabilities;
  /** Reads `/auth/me`; its result is parsed here. */
  read(): Promise<unknown>;
  /** New values, only when they differ from the previous ones. */
  changed(capabilities: Capabilities): void;
  /** Every read's end, changed or not. */
  settled(): void;
  checkedAt?: number | undefined;
}): Permissions {
  let previous = initial;
  let pending: Promise<void> | undefined;
  const start = () => {
    if (pending) return pending;
    if (Date.now() - checkedAt < PERMISSIONS_MAX_AGE_MS) return;
    checkedAt = Date.now();
    pending = (async () => {
      try {
        const next = capabilitiesIn(await read());
        if (next && !sameCapabilities(previous, next)) {
          previous = next;
          changed(next);
        }
      } catch {
        // A failed read does not end sign-in or erase permissions.
      } finally {
        pending = undefined;
        settled();
      }
    })();
    return pending;
  };
  return {
    revalidate: () => start() !== undefined,
    settled: () => start() ?? Promise.resolve(),
  };
}

/** Waits for `permissions` to settle, or rejects when `signal` aborts first. */
export function settledOrAborted(
  permissions: Permissions,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void permissions.settled().then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}
