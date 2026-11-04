import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import { LoadingRegion } from "../shared/design-system/ui/LoadingRegion";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { readPluginFolder } from "./plugin-folder-drop";
import styles from "./PluginImport.module.css";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FolderOpenIcon } from "../shared/design-system/icons/index";
import {
  PluginAccessReview,
  pluginAccessIncreases,
} from "./PluginAccessReview";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview, PluginInfo } from "../plugins/types";
import {
  pluginUpdateSource,
  updateSourceKey,
  type GitUpdateSource,
} from "../plugins/updates";
import type { GitPluginSource } from "../features/navigation/targets";

// The native importer has one slot, shared by successive dialogs.
const importOperations = new WeakMap<object, Promise<void>>();
import type {
  PluginInstallOutcome,
  PluginInstallRequest,
} from "../plugins/installer";

const shortCommit = (commit: string) => commit.slice(0, 12);
const sourceLabel = (repository: string, path: string) =>
  path === "." ? repository : `${repository} · ${path}`;
const trimSlash = (value: string) => value.replace(/\/+$/, "");
const requester = ({ id, name }: PluginInstallRequest["origin"]) =>
  name === id ? id : `${name} (${id})`;

function importLocation(
  preview: Pick<ImportPreview, "source" | "commit">,
  path: string | undefined,
) {
  if (!path || path === ".") return preview.source;
  if (preview.commit) return `${preview.source} · ${path}`;
  const windows = /^(?:[a-z]:\\|\\\\)/i.test(preview.source);
  const separator = windows ? "\\" : "/";
  const source = preview.source.replace(windows ? /\\+$/ : /\/+$/, "");
  return `${source}${separator}${path.replaceAll("/", separator)}`;
}

export function importRollbackWarning(
  candidate: { publisher?: string | null; revision: string } | undefined,
  existing: PluginInfo | undefined,
) {
  return candidate?.publisher && existing && !existing.hasSignature
    ? "You cannot roll back to the unsigned revision after this update."
    : candidate?.revision === existing?.revision &&
        existing?.rollbackBlockedReason
      ? `${existing.rollbackBlockedReason}.`
      : null;
}

export function PluginImport({
  initialGit,
  updateAction,
  requestSignal,
  initialUpdateAvailable = false,
  plugins,
  catalog,
  busy,
  authorizeGit,
  actionTarget,
  statusTarget,
  updateId,
  onClosed,
  onOpenInstalled,
  onUpdateAvailableChange,
  reviewRequested = false,
  onReviewHandled,
  returnFocus,
  request,
  onRequestSettled,
  onRequestClaimed,
  onRequestConfirmed,
  onRequestEnded,
  holdReview,
}: {
  initialGit?: GitPluginSource | undefined;
  updateAction?: { source: GitUpdateSource; apply: boolean } | undefined;
  requestSignal?: AbortSignal | undefined;
  initialUpdateAvailable?: boolean;
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  actionTarget?: HTMLElement | null;
  statusTarget?: HTMLElement | null;
  updateId?: string;
  onClosed?: () => void;
  onOpenInstalled?: (id: string) => void;
  onUpdateAvailableChange?: (available: boolean) => void;
  reviewRequested?: boolean;
  onReviewHandled?: () => void;
  returnFocus?: () => HTMLElement | null;
  /** A source to review, prefilled; the user still finds, reviews and confirms it. */
  request?: PluginInstallRequest | undefined;
  onRequestSettled?:
    | ((id: number, outcome: PluginInstallOutcome) => void)
    | undefined;
  onRequestClaimed?: ((id: number) => boolean) | undefined;
  onRequestConfirmed?: ((id: number) => () => void) | undefined;
  /** The review went away; a confirmed install still settles its own outcome. */
  onRequestEnded?: ((id: number) => void) | undefined;
  /** Marks a review dialog as open so a plugin request cannot open a second one. */
  holdReview?: (() => () => void) | undefined;
  /** Signs in to the selected community's Buzz git; null for other repositories. */
  authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
}) {
  const imports = plugins.imports;
  const [open, setOpen] = useState(!!initialGit);
  const [dragging, setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const checkAgain = useRef<HTMLButtonElement>(null);
  const currentPlugin = catalog.plugins.find(
    (item) => item.manifest.id === updateId,
  );
  const savedSource = updateAction?.source ?? currentPlugin?.updateSource;
  const [repository, setRepository] = useState(
    initialGit?.repository ??
      (savedSource && "repository" in savedSource
        ? savedSource.repository
        : ""),
  );
  const [reference, setReference] = useState(
    initialGit?.reference ??
      (savedSource && "reference" in savedSource ? savedSource.reference : ""),
  );
  // A link is newer than a plugin's request, so it replaces it rather than
  // inheriting the request's pinned commit and folder.
  const dropRequestForLink = useEffectEvent(() => {
    if (bound) releaseRequest("cancelled");
  });
  useEffect(() => {
    if (!initialGit || requestSignal?.aborted) return;
    dropRequestForLink();
    setRepository(initialGit.repository);
    setReference(initialGit.reference);
    setOpen(true);
  }, [initialGit, requestSignal]);
  // Snapshot at review entry: our own install catalog refresh must not turn a
  // new install into an update while its enable operation is still pending.
  const [existing, setExisting] = useState<PluginInfo>();
  const [loading, setLoading] = useState(false);
  const [abandonable, setAbandonable] = useState(false);
  const mounted = useRef(true);
  const [bound, setBound] = useState<PluginInstallRequest>();
  const requested = !!bound && !updateId;
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [checkedRevision, setCheckedRevision] = useState<string>();
  const [checking, setChecking] = useState(false);
  const checkPending = useRef(false);

  const [discarding, setDiscarding] = useState(false);
  const [selected, setSelected] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const unchangedTrigger = useRef<HTMLButtonElement>(null);
  const unchangedBack = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (showUnchanged ? unchangedBack.current : unchangedTrigger.current)?.focus();
  }, [showUnchanged]);
  const previewRegion = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const browse = useRef<HTMLButtonElement>(null);
  const errorBack = useRef<HTMLButtonElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const errorReturnsToBack = useRef(false);
  useLayoutEffect(() => {
    if (!open || loading || discarding) return;
    if (preview) {
      const checked = !reviewing
        ? previewRegion.current?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"], input[type="radio"]:checked',
          )
        : null;
      (
        checked ?? (updateId ? installButton.current : previewBack.current)
      )?.focus();
    } else if (sourceTrigger.current) {
      if (
        sourceTrigger.current === document.body ||
        !sourceTrigger.current.isConnected
      )
        browse.current?.focus();
      else sourceTrigger.current.focus();
      sourceTrigger.current = null;
    }
  }, [open, preview, loading, discarding, reviewing, updateId]);
  const errorTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (busy || loading || discarding) return;
    if (error) errorBack.current?.focus();
    else if (errorTrigger.current) {
      if (errorTrigger.current === document.body) browse.current?.focus();
      else if (errorTrigger.current.isConnected) errorTrigger.current.focus();
      else if (errorReturnsToBack.current) previewBack.current?.focus();
      else (installButton.current ?? previewBack.current)?.focus();
      errorTrigger.current = null;
    }
  }, [error, busy, loading, discarding]);
  // Pending operations disable their control, so callers capture the return
  // target before starting rather than reading focus when the failure arrives.
  function showError(reason: unknown, returnTo: Element | null) {
    if (!error) {
      errorTrigger.current = returnTo as HTMLElement | null;
      errorReturnsToBack.current = returnTo === previewBack.current;
    }
    setError(String(reason));
  }
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const lifetime = useRef({ active: true, token: "", installing: false });
  const pending = useRef(false);
  const lastClaimed = useRef(0);
  const boundId = useRef<number>(undefined);
  const settleRequest = useRef(onRequestSettled);
  const endRequest = useRef(onRequestEnded);
  useEffect(() => {
    settleRequest.current = onRequestSettled;
    endRequest.current = onRequestEnded;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        const id = boundId.current;
        if (mounted.current || id === undefined) return;
        if (endRequest.current) endRequest.current(id);
        else settleRequest.current?.(id, "cancelled");
      });
    };
  }, []);
  useEffect(() => {
    if (!open || !holdReview) return;
    return holdReview();
  }, [open, holdReview]);
  const claimRequest = useEffectEvent((next: PluginInstallRequest) => {
    // The store refuses a confirmed request first: its install, perhaps in a
    // replaced importer, still reports the outcome.
    if (onRequestClaimed && !onRequestClaimed(next.id)) return;
    if (open || loading || discarding || preview || pending.current) {
      onRequestSettled?.(next.id, "unavailable");
      return;
    }
    boundId.current = next.id;
    setBound(next);
    setRepository(next.source.repository);
    setReference(next.source.reference);
    setOpen(true);
  });
  useEffect(() => {
    if (updateId || !request || request.id <= lastClaimed.current) return;
    lastClaimed.current = request.id;
    claimRequest(request);
  }, [request, updateId]);
  function releaseRequest(outcome: PluginInstallOutcome) {
    if (!bound) return;
    onRequestSettled?.(bound.id, outcome);
    boundId.current = undefined;
    setBound(undefined);
    setRepository("");
    setReference("");
  }
  async function checkSource(operation: () => Promise<string>) {
    if (checkPending.current) return;
    checkPending.current = true;
    const current = lifetime.current;
    setChecking(true);
    try {
      const revision = await operation();
      if (current.active) {
        setCheckedRevision(revision);
        setError(null);
      }
    } catch (reason) {
      if (current.active) setError(String(reason));
    } finally {
      checkPending.current = false;
      if (current.active) setChecking(false);
    }
  }
  const startSavedFolder = useEffectEvent(() => {
    if (
      imports &&
      savedSource &&
      "root" in savedSource &&
      updateId &&
      !open &&
      !busy &&
      document.visibilityState !== "hidden"
    )
      void checkSource(() => imports.checkFolder(updateId));
  });
  useEffect(() => {
    const current = { active: true, token: "", installing: false };
    lifetime.current = current;
    // Defer until effects settle so Strict Mode's retired mount never acquires.
    queueMicrotask(() => {
      if (current.active) startSavedFolder();
    });
    return () => {
      current.active = false;
      if (current.token && !current.installing)
        void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  const localFolder = !!savedSource && "root" in savedSource;
  useEffect(() => {
    if (!localFolder) return;
    const timer = setInterval(() => startSavedFolder(), 5_000);
    const resume = () => startSavedFolder();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [localFolder]);

  const candidate = preview?.candidates.find((p) => p.path === selected);
  const updating = !!existing;
  const installedSource = existing?.updateSource;
  const conflict =
    requested &&
    existing?.source === "external" &&
    candidate &&
    preview &&
    !(
      installedSource &&
      "repository" in installedSource &&
      trimSlash(installedSource.repository) === trimSlash(preview.source) &&
      installedSource.path === candidate.path
    )
      ? `${existing.manifest.name} is already installed from ${
          installedSource && "repository" in installedSource
            ? sourceLabel(installedSource.repository, installedSource.path)
            : installedSource
              ? sourceLabel(installedSource.root, installedSource.path)
              : "an unknown source"
        }; remove it first to install it from ${sourceLabel(preview.source, candidate.path)}.`
      : null;
  const constraint =
    updateAction?.source ?? (bound ? bound.source : initialGit);
  const linkConstrained = !bound && !!(constraint?.commit || constraint?.path);
  const pinned = bound
    ? requested
      ? bound.source.commit
      : undefined
    : constraint?.commit;
  const pinError =
    pinned && preview && preview.commit?.toLowerCase() !== pinned
      ? "This repository is not at the commit that was requested. Nothing was installed."
      : null;
  const duplicate = updating && !updateId && (!requested || !!conflict);
  const upToDate =
    !conflict &&
    !pinError &&
    // An identical package can still establish a missing source. Native keeps
    // its enabled state and existing rollback target for the same revision.
    !(updateId && !savedSource) &&
    !!existing &&
    candidate?.revision ===
      (updateId
        ? catalog.plugins.find((item) => item.manifest.id === updateId)
            ?.revision
        : existing.revision);
  const updateAvailable =
    !error &&
    (preview
      ? !upToDate
      : checkedRevision !== undefined
        ? checkedRevision !== currentPlugin?.revision
        : initialUpdateAvailable);
  const notifyUpdateAvailable = useEffectEvent((available: boolean) =>
    onUpdateAvailableChange?.(available),
  );
  useEffect(() => {
    if (error || preview || checkedRevision !== undefined)
      notifyUpdateAvailable(updateAvailable);
  }, [updateAvailable, checkedRevision, preview, error]);
  useEffect(() => {
    if (!reviewRequested || loading) return;
    if (error) {
      onReviewHandled?.();
      return;
    }
    if (!preview) return;
    setOpen(true);
    onReviewHandled?.();
  }, [reviewRequested, loading, preview, error, onReviewHandled]);

  const startRequestedReview = useEffectEvent(() => {
    if (!savedSource) {
      setOpen(true);
      onReviewHandled?.();
      return;
    }
    if (!preview && !pending.current) prepareReview();
  });
  useEffect(() => {
    if (!reviewRequested) return;
    const current = lifetime.current;
    queueMicrotask(() => {
      if (current.active) startRequestedReview();
    });
  }, [reviewRequested]);

  const linkedRequest = useRef<AbortSignal | GitPluginSource>(undefined);
  const startLinkedGit = useEffectEvent(() => {
    if (!initialGit || requestSignal?.aborted || !imports || busy) return;
    const request = requestSignal ?? initialGit;
    if (linkedRequest.current === request) return;
    linkedRequest.current = request;
    void loadGit(initialGit.repository, initialGit.reference, true);
  });
  useEffect(() => {
    if (!initialGit || requestSignal?.aborted || !imports || busy) return;
    const current = lifetime.current;
    queueMicrotask(() => {
      if (current.active) startLinkedGit();
    });
  }, [initialGit, requestSignal, imports, busy]);

  // A request retired by its requester while Find or an install is in flight is
  // released once that settles; until then it can't be confirmed. Release is
  // attempted once per request: if discard fails, the error stays up and
  // closing the dialog retries.
  const retired = !!bound && request?.id !== bound.id;
  const releaseAttempted = useRef<number>(undefined);
  const releaseExternally = useEffectEvent(() => {
    if (!bound || pending.current || releaseAttempted.current === bound.id)
      return;
    releaseAttempted.current = bound.id;
    void close();
  });
  useEffect(() => {
    if (retired && !busy && !loading && !discarding) releaseExternally();
  }, [retired, busy, loading, discarding]);

  const blocked = busy || loading || discarding;
  const canAbandonPreview =
    abandonable &&
    loading &&
    !busy &&
    !discarding &&
    !lifetime.current.installing;

  async function load(
    operation: () => Promise<ImportPreview | null>,
    linked = false,
  ) {
    if (!imports || pending.current || blocked) return;
    const returnTo = document.activeElement as HTMLElement | null;
    sourceTrigger.current = returnTo;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    setAbandonable(linked);
    if (!savedSource) setError(null);
    setPreview(null);
    setShowUnchanged(false);
    setEnableOnInstall(true);
    const previous = importOperations.get(imports);
    const acquisition = (async () => {
      if (previous) await previous;
      if (!current.active) return null;
      const result = await operation();
      if (!current.active && result) {
        await imports?.discard(result.token);
        return null;
      }
      return result;
    })();
    importOperations.set(
      imports,
      acquisition.then(
        () => {},
        () => {},
      ),
    );
    try {
      const result = await acquisition;
      if (!result && updateId && savedSource)
        throw new Error("No update source found. Try again.");
      const next =
        result && updateId
          ? {
              ...result,
              candidates: result.candidates.filter(
                (item) =>
                  item.manifest.id === updateId &&
                  (!savedSource || item.path === savedSource.path),
              ),
            }
          : result;
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      if (next && updateId) {
        if (!next.candidates.length) {
          await imports?.discard(next.token);
          current.token = "";
          const prefix =
            savedSource?.path === "."
              ? "Selected folder:"
              : `${savedSource?.path}:`;
          const warning = next.warnings.find((warning) =>
            warning.startsWith(prefix),
          );
          throw new Error(
            warning ??
              (savedSource
                ? "The saved folder or repository no longer contains this plugin at its installed path."
                : "This source does not contain the installed plugin. Choose a source with the same plugin ID."),
          );
        }
      }
      setError(null);
      if (updateId && next?.candidates.length === 1)
        setCheckedRevision(next.candidates[0]?.revision);
      setPreview(next);
      setReviewing(next?.candidates.length === 1);
      setExisting(
        next?.candidates.length === 1
          ? catalog.plugins.find(
              (item) => item.manifest.id === next.candidates[0]?.manifest.id,
            )
          : undefined,
      );
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) showError(reason, returnTo);
    } finally {
      pending.current = false;
      if (current.active) {
        setLoading(false);
      }
    }
  }
  async function loadGit(
    repository: string,
    reference: string,
    linked = false,
  ) {
    if (!imports) return;
    const { commit, path } = (linked ? initialGit : constraint) ?? {};
    await load(async () => {
      const signed = await authorizeGit?.(repository);
      const result = signed
        ? await imports.git(
            signed.repository,
            reference,
            signed.token,
            ...(commit ? [commit] : []),
          )
        : commit
          ? await imports.git(repository, reference, undefined, commit)
          : await imports.git(repository, reference);
      return requestedFolder(result, path);
    }, linked);
  }
  async function requestedFolder(
    result: ImportPreview | null,
    path: string | undefined,
  ) {
    if (!result || path === undefined) return result;
    const candidates = result.candidates.filter((item) => item.path === path);
    if (candidates.length) return { ...result, candidates };
    await imports?.discard(result.token).catch(() => {});
    throw new Error(
      `This repository has no plugin at ${path}. Nothing was installed.`,
    );
  }
  async function dismiss() {
    if (blocked || pending.current || !preview) return;
    pending.current = true;
    setDiscarding(true);
    try {
      await imports?.discard(preview.token);
      lifetime.current.token = "";
      setPreview(null);
      setShowUnchanged(false);
    } catch (reason) {
      showError(reason, previewBack.current);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  async function close() {
    if (canAbandonPreview) {
      lifetime.current.active = false;
      setOpen(false);
      onClosed?.();
      return true;
    }
    if (blocked || pending.current) return false;
    const current = lifetime.current;
    const returnTo = document.activeElement;
    pending.current = true;
    setDiscarding(true);
    try {
      if (lifetime.current.token)
        await imports?.discard(lifetime.current.token);
      current.token = "";
      if (!current.active) {
        onClosed?.();
        return false;
      }
      setPreview(null);
      errorTrigger.current = null;
      setError(null);
      setDragging(false);
      setShowUnchanged(false);
      releaseRequest("cancelled");
      setOpen(false);
      onClosed?.();
      return true;
    } catch (reason) {
      if (current.active) showError(reason, returnTo);
      return false;
    } finally {
      pending.current = false;
      if (current.active) setDiscarding(false);
    }
  }
  const rollbackWarning = importRollbackWarning(candidate, existing);
  function prepareReview() {
    if (!imports) return;
    setOpen(true);
    if (savedSource && "root" in savedSource && updateId) {
      void load(() => imports.previewFolder(updateId));
      return;
    }
    checkSavedGit(false);
  }
  function checkSavedGit(checkOnly = true) {
    const source = savedSource;
    if (!imports || !source || !("repository" in source)) return;
    const acquire = async () => {
      if (!checkOnly && lifetime.current.token) {
        await imports.discard(lifetime.current.token);
        lifetime.current.token = "";
      }
      const signed = await authorizeGit?.(source.repository);
      return (checkOnly ? imports.checkGit : imports.git)(
        signed?.repository ?? source.repository,
        source.reference,
        signed?.token,
        ...(!checkOnly && updateAction?.source.commit
          ? [updateAction.source.commit]
          : []),
      );
    };
    if (!checkOnly) {
      void load(acquire, !!updateAction);
      return;
    }
    void checkSource(async () => {
      const result = await acquire();
      if (!result) throw new Error("No update source found");
      const candidate = result.candidates.find(
        (item) => item.manifest.id === updateId && item.path === source.path,
      );
      if (!candidate)
        throw new Error(
          result.warnings.find((warning) =>
            warning.startsWith(
              `${source.path === "." ? "Selected folder" : source.path}:`,
            ),
          ) ??
            "The saved repository no longer contains this plugin at its installed path.",
        );
      return candidate.revision;
    });
  }
  async function installCandidate() {
    if (
      !imports ||
      !preview ||
      !candidate ||
      blocked ||
      retired ||
      pending.current ||
      pinError
    )
      return;
    if (updateAction && updateId) {
      const source = pluginUpdateSource(plugins, updateId);
      if (
        !source ||
        updateSourceKey(source) !== updateSourceKey(updateAction.source)
      ) {
        showError(
          "The plugin source changed. Close this review and check again.",
          installButton.current,
        );
        return;
      }
    }
    const current = lifetime.current;
    current.installing = true;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    importOperations.set(imports, settled);
    pending.current = true;
    setLoading(true);
    setError(null);
    const requestId = bound?.id;
    const unconfirm =
      requestId === undefined ? undefined : onRequestConfirmed?.(requestId);
    try {
      const success = await plugins.installImport(
        preview.token,
        candidate.path,
      );
      if (!success) {
        if (!current.active) return;
        showError(
          plugins.snapshot().error ??
            "Plugin installation wasn’t confirmed. Check the preview and try again.",
          installButton.current,
        );
        return;
      }
      // Native keeps the prepared preview after install.
      current.token = "";
      await imports.discard(preview.token).catch(() => {});
      if (!existing && enableOnInstall)
        await plugins.change("enable", candidate.manifest.id);
      if (!current.active) {
        if (requestId !== undefined)
          settleRequest.current?.(
            requestId,
            existing ? "updated" : "installed",
          );
        onClosed?.();
        return;
      }
      if (!updateId) setPreview(null);
      else if (existing)
        setExisting({
          ...existing,
          revision: candidate.revision,
        });
      releaseRequest(existing ? "updated" : "installed");
      setOpen(false);
      onClosed?.();
    } finally {
      unconfirm?.();
      current.installing = false;
      if (!current.active && current.token) {
        await imports.discard(current.token).catch(() => {});
        current.token = "";
      }
      release();
      pending.current = false;
      if (current.active) setLoading(false);
    }
  }
  const automaticToken = useRef("");
  const applyFreshUpdate = useEffectEvent(() => {
    if (
      !updateAction?.apply ||
      !preview ||
      !candidate ||
      loading ||
      error ||
      upToDate ||
      automaticToken.current === preview.token
    )
      return;
    automaticToken.current = preview.token;
    const snapshot = plugins.snapshot();
    const live =
      snapshot.configuration.status === "ready"
        ? snapshot.configuration.catalog.plugins.find(
            (item) => item.manifest.id === updateId,
          )
        : undefined;
    if (
      !live ||
      pluginAccessIncreases(candidate.manifest, live.manifest) ||
      (candidate.publisher ?? null) !== (live.publisher ?? null) ||
      importRollbackWarning(candidate, live)
    )
      return;
    void installCandidate();
  });
  useEffect(() => {
    if (preview && !loading && !error && !upToDate) applyFreshUpdate();
  }, [preview, loading, error, upToDate]);
  if (!imports) return null;
  const addButton = (
    <Button
      ref={trigger}
      size="sm"
      aria-label={
        updateId
          ? `Update ${catalog.plugins.find((item) => item.manifest.id === updateId)?.manifest.name ?? "plugin"}`
          : undefined
      }
      disabled={blocked}
      loading={discarding && !open}
      onClick={async () => {
        if (blocked || pending.current) return;
        pending.current = true;
        setDiscarding(true);
        try {
          setOpen(true);
        } catch (reason) {
          showError(reason, trigger.current);
          setOpen(true);
        } finally {
          pending.current = false;
          setDiscarding(false);
        }
      }}
    >
      {updateId ? "Update" : "Add"}
    </Button>
  );
  const updateActions = (
    <>
      {!savedSource && !preview && addButton}
      {savedSource &&
        "repository" in savedSource &&
        !(preview && !error && !upToDate) && (
          <Button
            ref={checkAgain}
            variant="subtle"
            size="sm"
            disabled={blocked || checking}
            onClick={() => checkSavedGit()}
          >
            Check for updates
          </Button>
        )}
      {updateAvailable && (
        <Button
          ref={trigger}
          variant="prominent"
          size="sm"
          disabled={blocked || checking}
          onClick={() => {
            prepareReview();
          }}
        >
          Update
        </Button>
      )}
    </>
  );
  return (
    <>
      {!updateId &&
        (actionTarget ? createPortal(addButton, actionTarget) : addButton)}
      {updateId && (
        <section aria-label="Plugin updates" className="text-body-sm">
          <h3 className={`${styles.sourceHeading} text-caption`}>
            {savedSource && "repository" in savedSource
              ? "Source repository"
              : "Source folder"}
          </h3>
          {savedSource ? (
            <code className={styles.sourcePath}>
              {"root" in savedSource
                ? importLocation(
                    { source: savedSource.root, commit: null },
                    savedSource.path,
                  )
                : `${savedSource.repository} · ${savedSource.reference || "Repository default"} · ${savedSource.path}`}
            </code>
          ) : (
            <p className="m-0 text-muted">
              No saved source. Choose a folder or repository to update this
              plugin.
            </p>
          )}
          <LoadingRegion
            pending={checking || (loading && !open)}
            label="Checking for updates…"
          >
            {null}
          </LoadingRegion>
          {error && !open ? (
            <p role="alert">
              Source{" "}
              {savedSource && "repository" in savedSource
                ? "repository"
                : "folder"}{" "}
              unavailable. {error}
            </p>
          ) : null}
          {(preview || checkedRevision !== undefined) &&
          !open &&
          !error &&
          !updateAvailable ? (
            statusTarget ? (
              createPortal(<span role="status">Up to date</span>, statusTarget)
            ) : (
              <p role="status">Up to date</p>
            )
          ) : null}
          {actionTarget
            ? createPortal(updateActions, actionTarget)
            : updateActions}
        </section>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
        title={
          showUnchanged ? (
            "Unchanged declarations"
          ) : error || !preview ? (
            updateId ? (
              "Update plugin"
            ) : (
              "Add a plugin"
            )
          ) : reviewing ? (
            duplicate ? (
              "Already installed"
            ) : existing ? (
              `Update ${existing.manifest.name}`
            ) : (
              <>
                Review{" "}
                <strong>{candidate?.manifest.name ?? "Unknown"} Plugin</strong>{" "}
                access
              </>
            )
          ) : preview.candidates.length ? (
            "Choose a plugin"
          ) : (
            "No plugins found"
          )
        }
        description={
          updateAction
            ? "Save unfinished forms and stop active plugin workers before you update. Updating an enabled plugin reloads it immediately."
            : error || showUnchanged
              ? undefined
              : preview
                ? reviewing
                  ? updating
                    ? undefined
                    : "Only install code you trust."
                  : preview.candidates.length
                    ? "Select a plugin to review before installing."
                    : "Try another folder or repository."
                : "Load built plugins containing manifest.json and plugin.js. Buzz doesn’t build source code or run install scripts."
        }
        size={error || (reviewing && updating) ? "compact" : "wide"}
        leadingActions={
          !error &&
          !showUnchanged &&
          reviewing &&
          updateId &&
          candidate &&
          currentPlugin?.source === "external" &&
          !currentPlugin.enabled ? (
            <p className="m-0 text-body-sm text-muted">
              This plugin will stay disabled.
            </p>
          ) : reviewing &&
            candidate &&
            !updateId &&
            (!existing || loading) &&
            !error ? (
            <Switch
              label="Enable plugin"
              checked={enableOnInstall}
              disabled={blocked}
              onCheckedChange={setEnableOnInstall}
            />
          ) : undefined
        }
        actions={
          error ? (
            <Button
              ref={errorBack}
              type="button"
              disabled={busy || discarding}
              loading={loading}
              onClick={() => {
                if (!preview && savedSource) prepareReview();
                else setError(null);
              }}
            >
              {!preview && savedSource ? "Try again" : "Back"}
            </Button>
          ) : showUnchanged ? (
            <Button ref={unchangedBack} onClick={() => setShowUnchanged(false)}>
              Back
            </Button>
          ) : preview ? (
            <>
              {!(reviewing && updating) && (
                <Button
                  ref={previewBack}
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    if (
                      reviewing &&
                      preview.candidates.length > 1 &&
                      !(savedSource && "root" in savedSource)
                    ) {
                      setReviewing(false);
                    } else void dismiss();
                  }}
                >
                  Back
                </Button>
              )}
              {reviewing && duplicate && onOpenInstalled && (
                <Button
                  variant="prominent"
                  disabled={blocked}
                  onClick={async () => {
                    const id = existing.manifest.id;
                    if (await close()) onOpenInstalled(id);
                  }}
                >
                  Open in Buzz
                </Button>
              )}
              {reviewing && (duplicate ? !onOpenInstalled : upToDate) && (
                <Button disabled={blocked} onClick={() => void close()}>
                  Done
                </Button>
              )}
              {!reviewing && preview.candidates.length > 1 && (
                <Button
                  variant="prominent"
                  type="button"
                  disabled={blocked || !candidate}
                  onClick={() => {
                    setExisting(
                      catalog.plugins.find(
                        (item) => item.manifest.id === candidate?.manifest.id,
                      ),
                    );
                    setReviewing(true);
                  }}
                >
                  Continue
                </Button>
              )}
              {reviewing &&
                candidate &&
                !upToDate &&
                !conflict &&
                !pinError &&
                (!existing || !!updateId || requested) && (
                  <Button
                    ref={installButton}
                    variant="prominent"
                    type="button"
                    disabled={
                      blocked || retired || existing?.source === "bundled"
                    }
                    onClick={() => void installCandidate()}
                  >
                    {updating ? "Update" : "Install plugin"}
                  </Button>
                )}
            </>
          ) : undefined
        }
        onEscape={() => {
          if (!showUnchanged) return false;
          setShowUnchanged(false);
          return true;
        }}
        dismissOnOutsideClick
        preventClose={blocked && !canAbandonPreview}
        finalFocus={() =>
          returnFocus?.() ?? trigger.current ?? checkAgain.current
        }
      >
        {error && (
          <p role="alert" className="error break-words">
            {error}
          </p>
        )}
        {showUnchanged && candidate && (
          <PluginAccessReview
            manifest={candidate.manifest}
            previousManifest={existing?.manifest}
            unchangedOnly
          />
        )}
        <div hidden={!!error || showUnchanged}>
          <div hidden={!!preview || (!!updateId && !!savedSource)}>
            {(!updateId || !savedSource) && (
              <div className={styles.columns}>
                {!bound && (
                  <section
                    aria-label="Add from folder"
                    className={styles.folder}
                    data-dragging={dragging || undefined}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes("Files")) return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = blocked ? "none" : "copy";
                      setDragging(!blocked);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDragging(false);
                      const items = Array.from(event.dataTransfer.items);
                      const entry =
                        items.length === 1
                          ? items[0]?.webkitGetAsEntry?.()
                          : null;
                      const current = lifetime.current;
                      void load(async () => {
                        if (!entry?.isDirectory)
                          throw new Error("Drop one folder, or choose Browse.");
                        const upload = await readPluginFolder(entry);
                        if (!current.active) return null;
                        const next = await imports.files(
                          upload.source,
                          upload.files,
                        );
                        return next
                          ? {
                              ...next,
                              warnings: [...upload.warnings, ...next.warnings],
                            }
                          : null;
                      });
                    }}
                  >
                    <FolderOpenIcon size={32} aria-hidden="true" />
                    <p className="m-0 text-body-sm">
                      Drop a plugin folder here
                    </p>
                    <Button
                      size="sm"
                      ref={browse}
                      aria-label="Browse plugin folder"
                      disabled={blocked}
                      onClick={() => void load(() => imports.folder())}
                    >
                      Browse
                    </Button>
                  </section>
                )}
                <form
                  aria-label="Add from Git"
                  className={styles.git}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (repository.trim()) void loadGit(repository, reference);
                  }}
                >
                  <SettingsGroup layout="form">
                    <Field label="Git or GitHub repository">
                      <Input
                        required
                        value={repository}
                        disabled={blocked}
                        readOnly={!!bound || linkConstrained}
                        placeholder="https://github.com/owner/repository"
                        onChange={(event) => setRepository(event.target.value)}
                      />
                    </Field>
                    <Field label="Branch or tag (optional)">
                      <Input
                        value={reference}
                        disabled={blocked}
                        readOnly={!!bound || linkConstrained}
                        placeholder="Repository default"
                        onChange={(event) => setReference(event.target.value)}
                      />
                    </Field>
                    {(bound || linkConstrained) && (
                      <p className="m-0 break-all text-caption text-muted">
                        {bound
                          ? `Opened from ${requester(bound.origin)}. `
                          : "Opened from a link. "}
                        {constraint?.commit
                          ? `Pinned to commit ${shortCommit(constraint.commit)}. Nothing is installed unless the fetched repository matches it. `
                          : ""}
                        {constraint?.path
                          ? `Plugin folder: ${constraint.path}. `
                          : ""}
                        {bound
                          ? "Review the source, then choose Find to read it. Nothing is installed until you confirm."
                          : "Nothing is installed until you confirm."}
                      </p>
                    )}
                    <p className="m-0 text-caption text-muted">
                      HTTPS or SSH; GitHub owner/repository also works. SSH uses
                      your agent and known hosts. Password prompts and
                      credential helpers are not used. Buzz git repositories in
                      this community sign in with your account.
                    </p>
                    <div className="justify-self-start">
                      <Button
                        type="submit"
                        size="sm"
                        aria-label="Find plugins"
                        disabled={blocked || !repository.trim()}
                      >
                        Find
                      </Button>
                    </div>
                  </SettingsGroup>
                </form>
              </div>
            )}
          </div>
          {loading && !preview && (
            <p role="status">
              Reading plugin folders… Git imports may take up to a minute.
            </p>
          )}
          {loading && preview && (
            <p role="status">
              {updating ? "Updating plugin…" : "Installing plugin…"}
            </p>
          )}
          {preview && (
            <section ref={previewRegion} aria-label="Plugin import preview">
              <div className="flex flex-col gap-4">
                {!reviewing &&
                  (preview.candidates.length === 0 || preview.commit) && (
                    <div className="min-w-0 text-body-sm">
                      {preview.candidates.length === 0 && (
                        <p className="m-0 break-all text-caption text-muted">
                          Source:{" "}
                          <code className={styles.sourcePath}>
                            {preview.source}
                          </code>
                        </p>
                      )}
                      {preview.commit && (
                        <p className="m-0 break-all text-caption text-muted">
                          Commit: {preview.commit}
                        </p>
                      )}
                    </div>
                  )}
                {preview.candidates.length === 0 ? (
                  <p className="m-0">
                    No built plugins found. Build the plugin first, then choose
                    its output folder, or use a repository that includes built
                    artifacts.
                  </p>
                ) : !reviewing && preview.candidates.length > 1 ? (
                  <Field label="Choose a plugin" labelVisibility="hidden">
                    <RadioGroup
                      name="plugin-folder"
                      aria-label="Choose a plugin"
                      value={selected}
                      disabled={busy}
                      onValueChange={(value) => {
                        setSelected(value);
                      }}
                    >
                      {preview.candidates.map((item) => (
                        <Radio
                          key={item.path}
                          value={item.path}
                          variant="card"
                          label={item.manifest.name}
                          description={
                            <span className="block break-all text-caption text-muted">
                              <code className={styles.sourcePath}>
                                {importLocation(preview, item.path)}
                              </code>{" "}
                              · {item.manifest.id}
                            </span>
                          }
                        />
                      ))}
                    </RadioGroup>
                  </Field>
                ) : null}
                {preview.warnings.length > 0 &&
                  (!reviewing || preview.candidates.length === 1) && (
                    <section
                      aria-label="Skipped folders"
                      className="text-body-sm"
                    >
                      <p className="m-0 text-label">
                        Folders skipped ({preview.warnings.length})
                      </p>
                      <p className="mb-0 mt-1 text-muted">
                        These folders couldn’t be loaded as plugins. Other
                        listed plugins can still be installed.
                      </p>
                      <ul className="mb-0 mt-2 list-disc space-y-1 break-words pl-4">
                        {preview.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                {reviewing &&
                  candidate &&
                  existing &&
                  (candidate.publisher ?? null) !==
                    (existing.publisher ?? null) && (
                    <p className="m-0 break-all text-body-sm">
                      Publisher: {candidate.publisher ?? "Unsigned"}. Previous
                      publisher: {existing.publisher ?? "Unsigned"}.
                    </p>
                  )}
                {reviewing && updating && (
                  <section
                    aria-label="Update source"
                    className="text-body-sm mb-4"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-muted">
                        {preview.commit ? "Source" : "Source folder"}
                      </span>
                    </div>
                    <code className={styles.sourcePath}>
                      {importLocation(preview, candidate?.path)}
                    </code>
                  </section>
                )}
                {reviewing && bound && (
                  <p className="m-0 text-caption text-muted">
                    Opened from {requester(bound.origin)}.
                  </p>
                )}
                {reviewing && pinError && <p className="m-0">{pinError}</p>}
                {reviewing && (requested || pinned) && preview.commit && (
                  <p className="m-0 break-all text-caption text-muted">
                    Commit {shortCommit(preview.commit)}
                    {pinned && !pinError
                      ? " (matches the requested commit)"
                      : ""}
                  </p>
                )}
                {reviewing && conflict && <p className="m-0">{conflict}</p>}
                {reviewing && updating && !updateId && !requested && (
                  <p>
                    This plugin is already installed. Open its details to manage
                    it.
                  </p>
                )}
                {reviewing &&
                  candidate &&
                  (existing?.source !== "bundled" || loading) &&
                  !conflict &&
                  (!existing || !!updateId || requested) && (
                    <PluginAccessReview
                      manifest={candidate.manifest}
                      previousManifest={existing?.manifest}
                      unchangedTrigger={unchangedTrigger}
                      onShowUnchanged={() => setShowUnchanged(true)}
                    />
                  )}
                {reviewing && existing?.source === "bundled" && !loading && (
                  <p className="m-0 text-body-sm">
                    This plugin is included with Buzz. Update Buzz to get its
                    latest version.
                  </p>
                )}
                {reviewing &&
                  (updateId || (requested && !conflict)) &&
                  candidate &&
                  existing?.source === "external" &&
                  rollbackWarning && (
                    <p className="m-0 text-body-sm">{rollbackWarning}</p>
                  )}
              </div>
            </section>
          )}
        </div>
      </Dialog>
    </>
  );
}
