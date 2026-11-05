import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import type { PluginManager } from "../plugins/manager";
import type {
  Catalog,
  ImportPreview,
  ManagedEntry,
  ManagedPlugins as ManagedPolicy,
  PluginInfo,
} from "../plugins/types";
import { PluginAccessReview } from "./PluginAccessReview";
import { importRollbackWarning } from "./PluginImport";
import importStyles from "./PluginImport.module.css";
import styles from "./Settings.module.css";

type Authorize = (
  repository: string,
) => Promise<{ repository: string; token: string } | null>;

const location = ({ repository, reference, path }: ManagedEntry) =>
  [repository, reference, ...(path === "." ? [] : [path])].join(" · ");

export function ManagedPlugins({
  plugins,
  managed,
  catalog,
  busy,
  authorizeGit,
  holdReview,
}: {
  plugins: PluginManager;
  managed: ManagedPolicy | undefined;
  catalog: Catalog;
  busy: boolean;
  authorizeGit?: Authorize | undefined;
  holdReview?: (() => () => void) | undefined;
}) {
  const [reviewingId, setReviewingId] = useState<string>();
  const trigger = useRef<HTMLElement | null>(null);
  if (!plugins.imports || !managed) return null;
  // Rendered outside the group: installing the last pending row empties the group.
  const review = reviewingId ? (
    <ManagedPluginReview
      plugins={plugins}
      catalog={catalog}
      busy={busy}
      source={managed.status === "ready" ? managed.source : ""}
      entry={
        managed.status === "ready"
          ? managed.plugins.find((item) => item.id === reviewingId)
          : undefined
      }
      authorizeGit={authorizeGit}
      holdReview={holdReview}
      returnFocus={() => trigger.current}
      onClose={() => setReviewingId(undefined)}
    />
  ) : null;
  const rows =
    managed.status === "ready"
      ? managed.plugins.filter(({ state }) => state !== "current")
      : [];
  const section =
    managed.status === "invalid" ? (
      <section
        aria-labelledby="managed-plugins-title"
        className={styles.pluginCoreSection}
      >
        <InlineHeader
          id="managed-plugins-title"
          title="Recommended plugins unavailable"
        />
        <p role="status" className="m-0 text-body-sm text-muted break-words">
          Buzz couldn’t use the managed plugin file {managed.path}.{" "}
          {managed.reason}
        </p>
      </section>
    ) : rows.length || managed.problems.length ? (
      <section
        aria-labelledby="managed-plugins-title"
        className={styles.pluginCoreSection}
      >
        <InlineHeader
          id="managed-plugins-title"
          title={
            rows.length
              ? `Recommended by ${managed.source}`
              : "Recommended plugins"
          }
        />
        {rows.length > 0 && (
          <SettingsGroup>
            {rows.map((entry) => (
              <PreferenceRow
                key={entry.id}
                title={entry.id}
                subtitle={
                  entry.state === "other"
                    ? `Installed from a different source. Remove it to review the recommended version. ${location(entry)}`
                    : `${entry.state === "outdated" ? "Update recommended. " : ""}${location(entry)}`
                }
                trailing={
                  entry.state === "other" ? undefined : (
                    <Button
                      size="sm"
                      variant={
                        entry.state === "missing" ? "prominent" : "subtle"
                      }
                      disabled={busy}
                      aria-label={`${entry.state === "missing" ? "Review and install" : "Review update"} ${entry.id}`}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setReviewingId(entry.id);
                      }}
                    >
                      {entry.state === "missing"
                        ? "Review and install"
                        : "Review update"}
                    </Button>
                  )
                }
              />
            ))}
          </SettingsGroup>
        )}
        {managed.problems.length > 0 && (
          <div role="status" className="mt-3 text-body-sm text-muted">
            <p className="m-0">
              Some entries in the managed plugin file were ignored:
            </p>
            <ul className="mb-0 mt-1 list-disc space-y-1 break-words pl-4">
              {managed.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    ) : null;
  // The review stays at one position so a changing group never remounts it mid-install.
  return (
    <>
      {section}
      {review}
    </>
  );
}

/** Details-page replacement for the generic update check, which would follow the reference tip. */
export function ManagedPluginUpdate({
  plugins,
  catalog,
  busy,
  source,
  entry,
  authorizeGit,
  holdReview,
  returnFocus,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  source: string;
  entry: ManagedEntry;
  authorizeGit?: Authorize | undefined;
  holdReview?: (() => () => void) | undefined;
  returnFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <section aria-label="Managed updates" className="flex flex-col gap-2">
      <p className="m-0 text-body-sm text-muted">
        {entry.state === "outdated"
          ? `${source} recommends a different version of this plugin.`
          : `Updates follow the recommendation from ${source}.`}
      </p>
      {entry.state === "outdated" && (
        <div>
          <Button
            ref={trigger}
            size="sm"
            variant="prominent"
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            Review update
          </Button>
        </div>
      )}
      {open && (
        <ManagedPluginReview
          plugins={plugins}
          catalog={catalog}
          busy={busy}
          source={source}
          entry={entry}
          authorizeGit={authorizeGit}
          holdReview={holdReview}
          returnFocus={() => returnFocus?.() ?? trigger.current}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

type Review =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; preview: ImportPreview; path: string; key: string };

const entryKey = ({ repository, reference, commit, path }: ManagedEntry) =>
  [repository, reference, commit, path].join("\n");

export function ManagedPluginReview({
  plugins,
  catalog,
  busy: managing,
  source,
  entry,
  authorizeGit,
  holdReview,
  requestedBy,
  recheck,
  returnFocus,
  onInstalled,
  onClose,
}: {
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  source: string;
  /** The live recommendation; undefined once the policy no longer lists it. */
  entry: ManagedEntry | undefined;
  authorizeGit?: Authorize | undefined;
  holdReview?: (() => () => void) | undefined;
  /** An agent's request, reviewed in place of a recommendation. */
  requestedBy?: Readonly<{ name: string; reason: string }> | undefined;
  /** Run as the owner confirms; a returned reason refuses the install. */
  recheck?: (() => string | undefined) | undefined;
  returnFocus: () => HTMLElement | null;
  onInstalled?: () => void;
  onClose: () => void;
}) {
  const imports = plugins.imports;
  const key = entry && entryKey(entry);
  useEffect(() => holdReview?.(), [holdReview]);
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<Review>({ status: "loading" });
  const [installing, setInstalling] = useState(false);
  const [enable, setEnable] = useState(true);
  // Installing refreshes the catalog before enabling; the dialog keeps what it started with.
  const [frozen, setFrozen] = useState<PluginInfo | null>();
  const token = useRef("");
  const working = useRef(false);
  const latest = useRef({ catalog, entry });
  latest.current = { catalog, entry };
  const live = entry
    ? catalog.plugins.find((plugin) => plugin.manifest.id === entry.id)
    : undefined;
  const existing = frozen === undefined ? live : (frozen ?? undefined);
  const discard = (value: string) =>
    void imports?.discard(value).catch(() => {});
  const acquire = useEffectEvent(
    async (current: { active: boolean }, wanted: ManagedEntry) => {
      if (!imports) return;
      try {
        const signed = await authorizeGit?.(wanted.repository);
        const preview = await imports.git(
          signed?.repository ?? wanted.repository,
          wanted.reference,
          signed?.token,
          wanted.commit,
        );
        if (!preview) throw new Error("No plugin source found.");
        if (!current.active) {
          discard(preview.token);
          return;
        }
        if (preview.commit?.toLowerCase() !== wanted.commit) {
          discard(preview.token);
          throw new Error(
            `The repository returned commit ${preview.commit ?? "unknown"}, not the recommended commit ${wanted.commit}.`,
          );
        }
        const candidate = preview.candidates.find(
          (item) => item.path === wanted.path,
        );
        if (candidate?.manifest.id === wanted.id) {
          token.current = preview.token;
          setReview({
            status: "ready",
            preview,
            path: wanted.path,
            key: entryKey(wanted),
          });
          return;
        }
        discard(preview.token);
        const prefix =
          wanted.path === "." ? "Selected folder:" : `${wanted.path}:`;
        throw new Error(
          candidate
            ? `The plugin at ${wanted.path} is ${candidate.manifest.id}, not ${wanted.id}.`
            : (preview.warnings.find((warning) => warning.startsWith(prefix)) ??
                `This commit has no plugin at ${wanted.path}.`),
        );
      } catch (reason) {
        if (current.active)
          setReview({
            status: "error",
            reason: reason instanceof Error ? reason.message : String(reason),
          });
      }
    },
  );
  const close = useEffectEvent(() => onClose());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry is a new attempt, and a changed recommendation is a new entry.
  useEffect(() => {
    if (working.current) return;
    const wanted = latest.current.entry;
    if (!wanted) {
      close();
      return;
    }
    const current = { active: true };
    setReview({ status: "loading" });
    // Deferred so Strict Mode's retired mount never acquires the import slot.
    queueMicrotask(() => {
      if (current.active) void acquire(current, wanted);
    });
    return () => {
      current.active = false;
      if (token.current && !working.current) discard(token.current);
      if (!working.current) token.current = "";
    };
  }, [attempt, key]);

  const ready = review.status === "ready" && review.key === key;
  const candidate = ready
    ? review.preview.candidates.find((item) => item.path === review.path)
    : undefined;
  const updating = !!existing;
  const sameRevision = !!candidate && candidate.revision === existing?.revision;
  const rollbackWarning =
    existing?.source === "external"
      ? importRollbackWarning(candidate, existing)
      : null;

  async function install() {
    const wanted = latest.current.entry;
    if (
      !candidate ||
      !ready ||
      installing ||
      !wanted ||
      entryKey(wanted) !== review.key
    )
      return;
    const refusal = recheck?.();
    if (refusal) {
      setReview({ status: "error", reason: refusal });
      return;
    }
    const alreadyInstalled = latest.current.catalog.plugins.some(
      (plugin) => plugin.manifest.id === wanted.id,
    );
    setFrozen(
      latest.current.catalog.plugins.find(
        (plugin) => plugin.manifest.id === wanted.id,
      ) ?? null,
    );
    setInstalling(true);
    working.current = true;
    const value = review.preview.token;
    try {
      const success = await plugins.installImport(value, candidate.path);
      if (!success) {
        setFrozen(undefined);
        setReview({
          status: "error",
          reason:
            plugins.snapshot().error ??
            "Plugin installation wasn’t confirmed. Check the preview and try again.",
        });
        return;
      }
      token.current = "";
      await imports?.discard(value).catch(() => {});
      if (!alreadyInstalled && enable)
        await plugins.change("enable", wanted.id);
      onInstalled?.();
      onClose();
    } finally {
      working.current = false;
      setInstalling(false);
    }
  }

  const busy = installing || managing || !ready;
  const name = candidate?.manifest.name ?? entry?.id ?? "plugin";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        ready
          ? updating
            ? `Update ${name}`
            : "Review plugin access"
          : `Review ${entry?.id ?? "plugin"}`
      }
      description={
        ready && !updating
          ? `${requestedBy ? `Requested by ${requestedBy.name}` : `Recommended by ${source}`}. Only install code you trust.`
          : undefined
      }
      size={ready && updating ? "compact" : "wide"}
      preventClose={installing}
      dismissOnOutsideClick
      finalFocus={returnFocus}
      leadingActions={
        ready && !updating ? (
          <Switch
            label="Enable plugin"
            checked={enable}
            disabled={busy}
            onCheckedChange={setEnable}
          />
        ) : ready && existing?.enabled === false ? (
          <p className="m-0 text-body-sm text-muted">
            This plugin will stay disabled.
          </p>
        ) : undefined
      }
      actions={
        <>
          {review.status === "error" && (
            <Button onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
          )}
          <Button disabled={installing} onClick={onClose}>
            {ready ? "Cancel" : "Close"}
          </Button>
          {ready && (
            <Button
              variant="prominent"
              disabled={busy || existing?.source === "bundled"}
              loading={installing}
              onClick={() => void install()}
            >
              {updating ? "Update" : "Install plugin"}
            </Button>
          )}
        </>
      }
    >
      {!ready && review.status !== "error" && (
        <p role="status">
          Reading the plugin at the pinned commit… Git imports may take up to a
          minute.
        </p>
      )}
      {review.status === "error" && (
        <p role="alert" className="error break-words">
          {review.reason}
        </p>
      )}
      {ready && candidate && entry && (
        <section aria-label="Managed plugin source" className="text-body-sm">
          {requestedBy && (
            <p className="mb-4 mt-0 break-words">
              {updating && `${requestedBy.name}: `}
              {requestedBy.reason}
            </p>
          )}
          <code className={`${importStyles.sourcePath} break-all`}>
            {location(entry)}
          </code>
          <p className="mb-4 mt-1 break-all text-caption text-muted">
            Commit: {review.preview.commit}
          </p>
          {existing?.source === "bundled" ? (
            <p className="m-0">
              This plugin is included with Buzz. Update Buzz to get its latest
              version.
            </p>
          ) : (
            <>
              {sameRevision && (
                <p className="mb-4 mt-0">
                  This plugin’s code already matches this revision. Updating
                  records {source}’s recommended source and keeps the plugin as
                  it is.
                </p>
              )}
              <PluginAccessReview
                manifest={candidate.manifest}
                previousManifest={existing?.manifest}
              />
              {rollbackWarning && (
                <p className="mb-0 mt-4">{rollbackWarning}</p>
              )}
            </>
          )}
        </section>
      )}
    </Dialog>
  );
}
