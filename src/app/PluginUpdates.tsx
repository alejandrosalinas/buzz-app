import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { samePluginRelease } from "../plugins/same-release";
import type { PluginManager } from "../plugins/manager";
import { pendingManaged } from "../plugins/managed";
import { canRetryPlugin } from "../plugins/manager";
import type { PluginInstallRequests } from "../plugins/installer";
import {
  createPluginUpdates,
  type PluginUpdate,
  type PluginUpdates as Updates,
  pluginUpdateSource,
  updateFailure,
  updateSourceKey,
} from "../plugins/updates";
import type { AppServices } from "./services";
import { Button } from "../shared/design-system/ui/Button";
import { LoadingRegion } from "../shared/design-system/ui/LoadingRegion";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import {
  MenuItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
} from "../shared/design-system/ui/Menu";
import { SquaresFourIcon } from "../shared/design-system/icons";
import { RecommendationCount } from "./RecommendationCount";
import { PluginImport } from "./PluginImport";
import { pluginAccessIncreases } from "./PluginAccessReview";
import { PluginMenu } from "./PluginMenu";

const Context = createContext<{
  updates: readonly PluginUpdate[];
  recommended: readonly string[];
  busy: boolean;
  open(update: PluginUpdate): void;
  /** Plugins the owner asked to check again, while that check runs. */
  checking: readonly string[];
  checkAgain(id: string): Promise<void>;
} | null>(null);
const noSubscribe = () => () => {};
const empty: readonly PluginUpdate[] = [];
const noUpdates = () => empty;
const noQueueRevision = () => 0;

export function PluginUpdates({
  plugins,
  relay,
  installRequests,
  navigation,
  children,
}: {
  plugins: PluginManager;
  relay: AppServices["relay"];
  installRequests: PluginInstallRequests;
  navigation: Pick<AppServices["navigation"], "open">;
  children: ReactNode;
}) {
  const [store, setStore] = useState<Updates>();
  const [action, setAction] = useState<PluginUpdate>();
  const [actionQueueId, setActionQueueId] = useState<string>();
  const reviewLeaseRevision = useRef<number | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const updates = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? noUpdates,
  );
  const queueRevision = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.revision ?? noQueueRevision,
  );
  const reviewRevision = useSyncExternalStore(
    installRequests.subscribeReview,
    installRequests.reviewRevision,
  );
  const authorizeGit = async (repository: string) =>
    (await relay.snapshot().session.authorizeGit?.(repository)) ?? null;
  useEffect(() => {
    const updates = createPluginUpdates(
      plugins,
      async (repository) =>
        (await relay.snapshot().session.authorizeGit?.(repository)) ?? null,
    );
    setStore(updates);
    const unregisterUpdates = installRequests.registerUpdates(updates);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Being offline is normal, so background checks wait for a connection.
    const ready = () =>
      document.visibilityState !== "hidden" && navigator.onLine !== false;
    // A check that failed when the connection dropped is throttled like any
    // other, so the connection's return checks it again at once. The intent
    // lasts until a check can run: the window may be hidden. A check that
    // starts on the returned connection spends it; one that joins a check in
    // flight keeps it, since that check may be the one that dropped, and a
    // forced check follows its failure.
    let reconnect = false;
    let running = 0;
    const failed = () => updates.snapshot().some((update) => update.error);
    const check = async (force = false) => {
      clearTimeout(timer);
      if (!ready()) return;
      if (reconnect && running === 0) {
        reconnect = false;
        force ||= failed();
      }
      running++;
      const delay = await updates.check(force).finally(() => running--);
      if (disposed || !ready()) return;
      if (reconnect) {
        reconnect = false;
        if (failed()) return check(true);
      }
      if (delay === undefined) return;
      clearTimeout(timer);
      timer = setTimeout(scheduled, delay);
    };
    const scheduled = () => void check();
    const reconnected = () => {
      reconnect = true;
      void check();
    };
    scheduled();
    const unsubscribe = plugins.subscribe(scheduled);
    document.addEventListener("visibilitychange", scheduled);
    window.addEventListener("online", reconnected);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", scheduled);
      window.removeEventListener("online", reconnected);
      unsubscribe();
      unregisterUpdates();
      updates.dispose();
    };
  }, [plugins, relay, installRequests]);
  const configuration = state.configuration;
  const catalog =
    configuration.status === "ready" ? configuration.catalog : undefined;
  const open = (update: PluginUpdate) => {
    if (state.busy || action || !update.token) return;
    returnFocus.current = document.activeElement as HTMLElement;
    if (!store?.capability.queueUpdates([update.token]))
      void store?.check(true);
  };
  useEffect(() => {
    if (
      !store ||
      action ||
      state.busy ||
      queueRevision !== store.revision() ||
      reviewRevision !== installRequests.reviewRevision()
    )
      return;
    const review = store.startNextReview(installRequests.tryHoldReview);
    if (!review) return;
    reviewLeaseRevision.current = installRequests.reviewRevision();
    returnFocus.current = document.activeElement as HTMLElement;
    setAction(review.update);
    setActionQueueId(review.queueId);
  }, [
    store,
    action,
    state.busy,
    queueRevision,
    reviewRevision,
    installRequests,
  ]);
  const activeReview = store?.getActiveReview();
  const endReview = useCallback(
    (review: NonNullable<typeof activeReview>, error?: string) =>
      store?.endReview(review.queueId, review.token, error),
    [store],
  );
  const installed =
    action && catalog?.plugins.find((p) => p.manifest.id === action.id);
  const source = action && pluginUpdateSource(plugins, action.id);
  // Keep stale tokens rendered so their explicit confirmation guard can explain the refusal.
  const validAction =
    action &&
    installed &&
    source &&
    action.token &&
    activeReview &&
    actionQueueId !== undefined &&
    activeReview.queueId === actionQueueId &&
    activeReview.token === action.token &&
    reviewLeaseRevision.current === installRequests.reviewRevision() &&
    samePluginRelease(installed, {
      revision: action.installedRevision,
      publisher: action.installedPublisher,
    }) &&
    updateSourceKey(source) === updateSourceKey(action.source);
  const review = activeReview;
  const reviewToken = action?.token;
  const queuedUpdate =
    reviewToken &&
    actionQueueId !== undefined &&
    review &&
    review.queueId === actionQueueId &&
    review.token === reviewToken
      ? {
          origin: review.callerId,
          validate: () =>
            reviewLeaseRevision.current === installRequests.reviewRevision()
              ? store?.capability.getSnapshot().status === "checking"
                ? {
                    message:
                      "Checking for updates. Try again when the check finishes.",
                    transient: true as const,
                  }
                : store?.isCurrentToken(reviewToken)
                  ? undefined
                  : "The update candidate changed after it was checked. Check for updates again before reviewing it."
              : "Another plugin review opened. Close it before confirming this update.",
          confirmed: () => store?.beginOperation(review.queueId, reviewToken),
          settled: (
            outcome: "installed" | "updated" | "cancelled" | "unavailable",
          ) => store?.finishReview(review.queueId, reviewToken, outcome),
          ended: (error?: string) => endReview(review, error),
        }
      : undefined;
  useEffect(() => {
    if (action && !validAction && !state.busy) {
      const review = store?.getActiveReview();
      if (
        review &&
        review.queueId === actionQueueId &&
        review.token === action.token
      )
        endReview(
          review,
          reviewLeaseRevision.current === installRequests.reviewRevision()
            ? "The installed plugin changed after this update was checked."
            : "Another plugin review opened. Close it before confirming this update.",
        );
      setAction(undefined);
      setActionQueueId(undefined);
    }
  }, [
    action,
    actionQueueId,
    validAction,
    state.busy,
    store,
    endReview,
    installRequests,
  ]);
  useEffect(() => {
    if (
      action &&
      (activeReview?.queueId !== actionQueueId ||
        activeReview?.token !== action.token)
    ) {
      setAction(undefined);
      setActionQueueId(undefined);
    }
  }, [action, actionQueueId, activeReview]);
  const needsReview = (update: PluginUpdate) => {
    const previous = catalog?.plugins.find((p) => p.manifest.id === update.id);
    return (
      !previous ||
      !update.candidate ||
      pluginAccessIncreases(update.candidate.manifest, previous.manifest) ||
      (update.candidate.publisher ?? null) !== (previous.publisher ?? null)
    );
  };
  const [recovering, setRecovering] = useState<readonly string[]>([]);
  const [checking, setChecking] = useState<readonly string[]>([]);
  const checkAgain = async (id: string) => {
    if (!store) return;
    setChecking((ids) => (ids.includes(id) ? ids : [...ids, id]));
    try {
      await store.check(true);
    } finally {
      setChecking((ids) => ids.filter((item) => item !== id));
    }
  };
  return (
    <Context
      value={{
        updates,
        open,
        checking,
        checkAgain,
        busy: state.busy || !!action,
        recommended: pendingManaged(
          configuration.status === "ready" ? configuration.managed : undefined,
        ).map((entry) => entry.id),
      }}
    >
      {children}
      {updates
        .filter(
          (update) =>
            // A failed check stays on its Settings row.
            update.candidate &&
            !store?.hidden(update) &&
            update.id !== action?.id,
        )
        .map((update) => {
          const plugin = catalog?.plugins.find(
            (p) => p.manifest.id === update.id,
          );
          const name = plugin?.manifest.name ?? update.id;
          const manage = {
            label: `Manage ${name} update checks`,
            open: () =>
              void navigation.open({
                version: 1,
                kind: "settings",
                section: "plugins",
                pluginId: update.id,
              }),
          };
          const review = needsReview(update);
          return (
            <ToastNotice
              key={update.id}
              title={`Update ${name}`}
              description="Save unfinished forms and stop active plugin workers first. Updating an enabled plugin reloads it immediately."
              tone="info"
              onDismiss={() => store?.later(update)}
              closeLabel="Dismiss plugin update notice"
              navigation={manage}
            >
              <Button
                size="sm"
                disabled={state.busy || !!action}
                onClick={() => open(update)}
              >
                {review ? "Review permissions" : "Update and reload"}
              </Button>
              <Button size="sm" onClick={() => store?.later(update)}>
                Later
              </Button>
            </ToastNotice>
          );
        })}
      {validAction && catalog && (
        <PluginImport
          key={`${action.id}:${updateSourceKey(action.source)}:${action.token}`}
          plugins={plugins}
          catalog={catalog}
          busy={state.busy}
          updateId={action.id}
          updateAction={{
            source: action.source,
            ...(action.candidate
              ? {
                  candidateRevision: action.candidate.revision,
                  candidatePublisher: action.candidate.publisher ?? null,
                }
              : {}),
          }}
          reviewRequested
          authorizeGit={authorizeGit}
          returnFocus={() => returnFocus.current}
          queuedUpdate={queuedUpdate}
          onClosed={() => {
            setRecovering((ids) =>
              ids.includes(action.id) ? ids : [...ids, action.id],
            );
            setAction(undefined);
          }}
        />
      )}
      {catalog?.plugins
        .filter((plugin) => recovering.includes(plugin.manifest.id))
        .map((recovery) => {
          const activation = state.activation[recovery.manifest.id];
          return activation?.status === "failed" ? (
            <ToastNotice
              key={recovery.manifest.id}
              title={`${recovery.manifest.name} cannot start`}
              description={`${activation.error}${recovery.rollbackBlockedReason ? ` ${recovery.rollbackBlockedReason}` : ""}`}
              tone="error"
            >
              <Button
                size="sm"
                disabled={
                  state.busy ||
                  !canRetryPlugin(
                    recovery,
                    activation,
                    configuration.status === "ready" &&
                      configuration.externalPluginsPaused,
                  )
                }
                onClick={() => plugins.retryPlugin(recovery.manifest.id)}
              >
                Retry activation
              </Button>
              <PluginMenu
                plugin={recovery}
                plugins={plugins}
                busy={state.busy}
                label="Plugin recovery actions"
              />
            </ToastNotice>
          ) : null;
        })}
    </Context>
  );
}

export function PluginUpdatesMenu({
  onManage,
  recommendations,
}: {
  onManage(): void;
  recommendations: number;
}) {
  const context = useContext(Context);
  // A failed check is reported on its plugin's row in Manage plugins.
  const updates = (context?.updates ?? empty).filter(
    (update) => update.candidate,
  );
  const count =
    recommendations +
    updates.filter((update) => !context?.recommended.includes(update.id))
      .length;
  const label = (
    <>
      <MenuIcon>
        <SquaresFourIcon aria-hidden="true" size={16} />
      </MenuIcon>
      Plugins
      {count > 0 && (
        <MenuTrailing>
          <RecommendationCount count={count} />
        </MenuTrailing>
      )}
    </>
  );
  if (!updates.length) return <MenuItem onClick={onManage}>{label}</MenuItem>;
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger>{label}</MenuSubmenuTrigger>
      <MenuSubmenuPopup>
        {updates.map((update) => (
          <MenuItem
            key={update.id}
            disabled={context?.busy}
            onClick={() => context?.open(update)}
          >
            Update {update.candidate?.manifest.name ?? update.id}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onManage}>Manage plugins</MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}

/** A failed check, on its plugin's row in Settings → Plugins: what happened,
 * Check again, and Git's text behind Details. Check again clears it while
 * the check runs. Nothing shows outside `PluginUpdates`. */
export function PluginUpdateFailure({
  pluginId,
  className,
  returnFocus,
}: {
  pluginId: string;
  className?: string | undefined;
  /** Where focus goes when Check again clears the status. */
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const context = useContext(Context);
  // Nothing else reports a failed Check again, so its failure is announced.
  // Once the row clears, a later background failure returns unannounced.
  const [asked, setAsked] = useState(false);
  const update = context?.updates.find(
    (item) => item.id === pluginId && item.error,
  );
  const checking = context?.checking.includes(pluginId);
  if (asked && !checking && !update?.error) setAsked(false);
  if (checking)
    return (
      <LoadingRegion
        pending
        label="Checking for updates…"
        statusVisibility="screen-reader"
      >
        {null}
      </LoadingRegion>
    );
  if (!context || !update?.error) return null;
  const cause = updateFailure(update);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <p
          className="m-0 text-body-sm error"
          role={asked ? "alert" : undefined}
        >
          Couldn’t check for updates.{cause ? ` ${cause}` : ""}
        </p>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => {
            setAsked(true);
            returnFocus?.()?.focus();
            void context.checkAgain(pluginId);
          }}
        >
          Check again
        </Button>
      </div>
      {update.error !== cause && (
        <details>
          <summary className="text-body-sm">Details</summary>
          <p className="m-0 text-body-sm text-subtle">{update.error}</p>
        </details>
      )}
    </div>
  );
}
