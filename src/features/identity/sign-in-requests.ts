// "Open Buzz" from the account pages (`buzz://sign-in`, sent after email
// verification) asks first-run to sign in again. The browser keeps the account
// session, so that sign-in finishes without a password. A request that arrives
// before Welcome listens, such as the link that launched the app, waits briefly;
// one that arrives after Welcome is gone is dropped by expiry rather than
// starting a sign-in after a later sign-out.

const FRESH_MS = 2 * 60_000;

let requested: number | undefined;
const listeners = new Set<() => void>();

/** Whether `url` is the sign-in link, and only that: no path, query or fragment. */
export function isSignInLink(url: string): boolean {
  return /^buzz:\/\/sign-in\/?$/i.test(url);
}

export function requestSignIn(now = Date.now()): void {
  requested = now;
  for (const listener of [...listeners]) listener();
}

/** Consumes a fresh request; true when one was waiting. */
export function takeSignInRequest(now = Date.now()): boolean {
  const fresh = requested !== undefined && now - requested <= FRESH_MS;
  requested = undefined;
  return fresh;
}

export function onSignInRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
