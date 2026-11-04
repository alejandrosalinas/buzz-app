import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PluginManager } from "../plugins/manager";
import { pendingManaged } from "../plugins/managed";
import { canRetryPlugin } from "../plugins/manager";
import type { PluginInstallRequests } from "../plugins/installer";
import {
  createPluginUpdates,
  type PluginUpdate,
  type PluginUpdates as Updates,
  pluginUpdateSource,
  updateSourceKey,
} from "../plugins/updates";
import type { AppServices } from "./services";
import { Button } from "../shared/design-system/ui/Button";
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
} | null>(null);
const noSubscribe = () => () => {};
const empty: readonly PluginUpdate[] = [];
const noUpdates = () => empty;

export function PluginUpdates({
  plugins,
  relay,
  installRequests,
  children,
}: {
  plugins: PluginManager;
  relay: AppServices["relay"];
  installRequests: PluginInstallRequests;
  children: ReactNode;
}) {
  const [store, setStore] = useState<Updates>();
  const [action, setAction] = useState<PluginUpdate>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const updates = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? noUpdates,
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
    const check = () => {
      if (document.visibilityState !== "hidden") void updates.check();
    };
    check();
    const unsubscribe = plugins.subscribe(check);
    const timer = setInterval(check, 3_600_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      unsubscribe();
      updates.dispose();
    };
  }, [plugins, relay]);
  const configuration = state.configuration;
  const catalog =
    configuration.status === "ready" ? configuration.catalog : undefined;
  const open = (update: PluginUpdate) => {
    if (state.busy || action) return;
    returnFocus.current = document.activeElement as HTMLElement;
    setAction(update);
  };
  const installed =
    action && catalog?.plugins.find((p) => p.manifest.id === action.id);
  const source = action && pluginUpdateSource(plugins, action.id);
  const validAction =
    action &&
    installed &&
    source &&
    installed.revision === action.installedRevision &&
    updateSourceKey(source) === updateSourceKey(action.source);
  useEffect(() => {
    if (action && !validAction && !state.busy) setAction(undefined);
  }, [action, validAction, state.busy]);
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
  return (
    <Context
      value={{
        updates,
        open,
        busy: state.busy || !!action,
        recommended: pendingManaged(
          configuration.status === "ready" ? configuration.managed : undefined,
        ).map((entry) => entry.id),
      }}
    >
      {children}
      {updates
        .filter((update) => !store?.hidden(update) && update.id !== action?.id)
        .map((update) => {
          const plugin = catalog?.plugins.find(
            (p) => p.manifest.id === update.id,
          );
          const review = needsReview(update);
          return (
            <ToastNotice
              key={update.id}
              title={
                update.error
                  ? `Cannot check ${plugin?.manifest.name ?? update.id}`
                  : `Update ${plugin?.manifest.name ?? update.id}`
              }
              description={
                update.error ??
                "Save unfinished forms and stop active plugin workers first. Updating an enabled plugin reloads it immediately."
              }
              tone={update.error ? "error" : "info"}
              onDismiss={() => store?.later(update)}
              closeLabel="Dismiss plugin update notice"
            >
              <Button
                size="sm"
                disabled={state.busy || !!action}
                onClick={() =>
                  update.error ? void store?.check(true) : open(update)
                }
              >
                {update.error
                  ? "Retry"
                  : review
                    ? "Review permissions"
                    : "Update and reload"}
              </Button>
              <Button size="sm" onClick={() => store?.later(update)}>
                Later
              </Button>
            </ToastNotice>
          );
        })}
      {validAction && catalog && (
        <PluginImport
          key={`${action.id}:${updateSourceKey(action.source)}`}
          plugins={plugins}
          catalog={catalog}
          busy={state.busy}
          updateId={action.id}
          updateAction={{ source: action.source, apply: !needsReview(action) }}
          reviewRequested
          authorizeGit={authorizeGit}
          holdReview={installRequests.holdReview}
          returnFocus={() => returnFocus.current}
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
  const updates = context?.updates ?? empty;
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
            {update.error ? "Retry update" : "Update"}{" "}
            {update.candidate?.manifest.name ?? update.id}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onManage}>Manage plugins</MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}
