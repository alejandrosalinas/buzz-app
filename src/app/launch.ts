// Matches the repeated SMIL tracks in public/buzz-loading-mark.svg.
const CYCLE_MS = 1760;
const FADE_MS = 220;
// A saved workspace stays usable if its live refresh stalls.
const SETTLING_BUDGET_MS = CYCLE_MS * 2;

let ready = false;
let leaving = false;
let timer: number | undefined;
let budgetTimer: number | undefined;
let waitingForMark = false;
let observer: MutationObserver | undefined;
let contentReady = false;
let bypassPending = false;
let revision = 0;
const fallbackStartedAt = performance.now();
const listeners = new Set<() => void>();

declare global {
  interface Window {
    /** Installed by public/launch-init.js, which owns the startup fallback. */
    __buzzStartup?: Readonly<{
      failed(error: unknown, detail?: string): void;
      started(): void;
    }>;
  }
}

/** Shows "Buzz couldn’t open", which needs nothing from this bundle, when
 * startup throws or React unmounts the app after an error no boundary caught
 * before its launch ended; "Buzz stopped working" when React unmounts it after
 * the launch ended. */
export function showStartupFailure(error: unknown, detail?: string) {
  console.error("Buzz could not start or continue", error);
  window.__buzzStartup?.failed(error, detail);
}

/** React has the app: from here, its root reports what stops it, and other
 * uncaught errors leave the app running. */
export function startupHandedToReact() {
  window.__buzzStartup?.started();
}

// Native window chrome must remain usable while app content is still inert.
export const launchVisible = () => !!document.getElementById("buzz-launch");
export function subscribeLaunch(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function revealRoot() {
  for (const id of ["root", "buzz-toast-root"]) {
    const root = document.getElementById(id);
    root?.removeAttribute("inert");
    root?.removeAttribute("aria-hidden");
  }
}

function startedAt() {
  const value = Number(
    document.getElementById("buzz-launch")?.dataset.startedAt,
  );
  return Number.isFinite(value) ? value : fallbackStartedAt;
}

function hasPendingContent() {
  if (bypassPending) return false;
  if (document.querySelector('#root [data-buzz-launch-pending="required"]'))
    return true;
  return (
    !!document.querySelector('#root [data-buzz-launch-pending="settling"]') &&
    performance.now() < startedAt() + SETTLING_BUDGET_MS
  );
}

function checkSettlingBudget() {
  budgetTimer = undefined;
  const remaining = startedAt() + SETTLING_BUDGET_MS - performance.now();
  if (remaining > 0)
    budgetTimer = window.setTimeout(checkSettlingBudget, remaining);
  else syncContent();
}

function watchContent() {
  if (observer || !document.getElementById("buzz-launch")) return;
  const root = document.getElementById("root");
  if (!root) return;
  budgetTimer = window.setTimeout(
    checkSettlingBudget,
    Math.max(0, startedAt() + SETTLING_BUDGET_MS - performance.now()),
  );
  observer = new MutationObserver(syncContent);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-buzz-launch-pending"],
  });
}

function fade(launch: HTMLElement) {
  if (leaving || !ready || !launch.isConnected) return;
  if (hasPendingContent()) {
    syncContent();
    return;
  }
  leaving = true;
  if (budgetTimer !== undefined) window.clearTimeout(budgetTimer);
  observer?.disconnect();
  observer = undefined;
  launch.classList.add("buzz-launch--leaving");
  window.setTimeout(() => {
    launch.remove();
    revealRoot();
    for (const listener of listeners) listener();
  }, FADE_MS + 20);
}

function schedule() {
  const launch = document.getElementById("buzz-launch");
  if (!launch || !ready || !contentReady || leaving) return;
  if (timer !== undefined) window.clearTimeout(timer);

  const mark = launch.querySelector("img");
  if (mark && !mark.complete) {
    if (!waitingForMark) {
      waitingForMark = true;
      mark.addEventListener("load", schedule, { once: true });
      mark.addEventListener("error", schedule, { once: true });
    }
    return;
  }
  if (hasPendingContent()) {
    syncContent();
    return;
  }
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    launch.dataset.failed === "true" ||
    !mark?.naturalWidth
  ) {
    fade(launch);
    return;
  }

  const startedAt = Number(launch.dataset.startedAt ?? performance.now());
  const now = performance.now();
  const cycles = Math.max(1, Math.ceil((now - startedAt) / CYCLE_MS));
  const deadline = startedAt + cycles * CYCLE_MS;
  // A backgrounded webview may wake well past the boundary; nobody saw that
  // cycle, so fade then rather than waiting for another throttled timer.
  timer = window.setTimeout(
    () => {
      timer = undefined;
      fade(launch);
    },
    Math.max(0, deadline - now),
  );
}

function syncContent() {
  const next = ready && !hasPendingContent();
  if (
    !next &&
    budgetTimer === undefined &&
    document.querySelector('#root [data-buzz-launch-pending="settling"]')
  ) {
    const remaining = startedAt() + SETTLING_BUDGET_MS - performance.now();
    if (remaining > 0)
      budgetTimer = window.setTimeout(checkSettlingBudget, remaining);
  }
  if (next === contentReady) return;
  contentReady = next;
  const current = ++revision;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (!next) return;
  // Let the first history rows, virtualizer measurements, and fonts paint
  // underneath the overlay before choosing the animation boundary.
  let painted = false;
  const afterPaint = () => {
    if (painted) return;
    painted = true;
    if (current === revision && ready && !hasPendingContent()) schedule();
    else syncContent();
  };
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void (document.fonts?.ready ?? Promise.resolve()).then(afterPaint);
    }),
  );
  // A webview behind other windows may never deliver frames.
  window.setTimeout(afterPaint, CYCLE_MS);
}

export function setLaunchReady(next: boolean, terminal = false) {
  ready = next;
  bypassPending = terminal;
  if (!document.getElementById("buzz-launch")) revealRoot();
  watchContent();
  syncContent();
}
