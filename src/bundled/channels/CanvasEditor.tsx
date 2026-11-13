import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CanvasHistory } from "./CanvasHistory";
import type {
  CodeBlockRenderer,
  ContributionReader,
} from "../../features/conversation/contracts";
import { CanvasView } from "./CanvasView";
import type { RelayEvent } from "../../features/relay/events";
import {
  clearView,
  readView,
  replaceView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTemplates.module.css";
import panelStyles from "./Canvas.module.css";

type Draft = { content: string; base: string | null };
export function CanvasEditor({
  canvas,
  profiles,
  scope,
  channelId,
  readOnly = false,
  openLink = () => false,
  codeBlocks,
}: {
  canvas: ChannelCanvas;
  profiles: ProfileQueries;
  scope: string;
  channelId: string;
  readOnly?: boolean;
  /** Opens a Buzz link in the app; false lets the link open externally. */
  openLink?: (url: string) => boolean;
  /** Plugin code-block renderers for the View tab. */
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
}) {
  const panelId = useId();
  // A stable callback keeps the retained View from re-rendering its Markdown.
  const linkOpener = useRef(openLink);
  linkOpener.current = openLink;
  const openViewLink = useCallback(
    (url: string) => linkOpener.current(url),
    [],
  );
  const [tab, setTab] = useState<"view" | "edit" | "history">("view");
  const key = `canvas-draft-v1:${channelId}`;
  const draftRevision = useSyncExternalStore(
    useCallback((notify) => subscribeView(scope, notify), [scope]),
    () => viewRevision(scope, key),
  );
  // Only edits are stored. When a stored draft disappears, another editor
  // saved, discarded or reverted it. Unless this editor removed it, it reloads
  // once idle, even if another draft is stored by then. An editor holding text
  // typed here stores that text again and only rereads.
  const retiredDraft = useRef(draftRevision === null);
  const retirement = useRef(false);
  const retire = useCallback(
    (expected: string | null | undefined) => {
      if (expected == null || viewRevision(scope, key) !== expected) return;
      retiredDraft.current = true;
      try {
        clearView(scope, key);
      } catch {
        /* Storage unavailable; the draft stays, as after a failed write. */
      }
    },
    [scope, key],
  );
  const [saved] = useState(() => {
    const value = readView<unknown>(scope, key, null);
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Partial<Draft>;
    return typeof raw.content === "string" &&
      (raw.base === null || typeof raw.base === "string")
      ? (raw as Draft)
      : undefined;
  });
  const [draft, setDraft] = useState(saved?.content ?? "");
  const [base, setBase] = useState<string | null>(saved?.base ?? null);
  // Text this editor took from the relay or the stored draft it opened with.
  // A draft that differs from it was typed here.
  const [adopted, setAdopted] = useState(saved?.content);
  const [head, setHead] = useState<RelayEvent>();
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [readError, setReadError] = useState("");
  const operation = useRef(0);
  const editor = useRef<HTMLTextAreaElement>(null);
  const view = useRef<HTMLElement>(null);
  const viewRetry = useRef<HTMLButtonElement>(null);
  const recovery = useRef<HTMLButtonElement>(null);
  const comparison = useRef<HTMLDivElement>(null);
  const historyRetry = useRef<HTMLButtonElement>(null);
  const [recovering, setRecovering] = useState(false);
  // The tab host places focus when Canvas opens, and a recovery button holds
  // it while its read is pending. Take it into the active tab's content once a
  // read lands only if it is still there; never pull it back from elsewhere.
  const handoff = useRef<Element | null>(null);
  useEffect(() => {
    const host = view.current?.closest("[data-panel-workspace]");
    handoff.current = host?.contains(document.activeElement)
      ? document.activeElement
      : null;
  }, []);
  useEffect(() => {
    const previous = handoff.current;
    if (!previous || !loaded || busy) return;
    handoff.current = null;
    if (
      previous === document.activeElement ||
      (!previous.isConnected && document.activeElement === document.body)
    )
      (tab === "view"
        ? view
        : tab === "history"
          ? comparison
          : editor
      ).current?.focus();
  }, [loaded, busy, tab]);
  const [confirmReload, setConfirmReload] = useState(false);
  const cancelReload = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const load = useCallback(
    async (replace = false, discard = false) => {
      const generation = ++operation.current;
      // A draft stored while this read is pending is newer than its result.
      const stored = viewRevision(scope, key);
      setBusy(true);
      setError("");
      try {
        const event = await canvas.read(channelId);
        if (generation !== operation.current) return;
        setHead(event);
        setLoaded(true);
        setReadError("");
        if (replace || (!saved && !loaded)) {
          setDraft(event?.content ?? "");
          setAdopted(event?.content ?? "");
          setBase(event?.id ?? null);
          if (discard) retire(stored);
        } else if ((event?.id ?? null) !== base)
          setError(
            "Canvas changed since this draft began. Your draft is kept. Copy any edits you want to keep before reloading the saved Canvas.",
          );
      } catch (reason) {
        if (generation === operation.current) {
          // Focus stays on the renewed recovery button.
          handoff.current = null;
          setError(String(reason));
          setReadError(String(reason));
        }
      } finally {
        if (generation === operation.current) setBusy(false);
      }
    },
    [canvas, channelId, saved, loaded, scope, key, base, retire],
  );
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  const differs = (content: string) =>
    (head?.id ?? null) !== base || content !== (head?.content ?? "");
  const dirty = differs(draft);
  const edited = dirty && draft !== adopted;
  useEffect(() => {
    // An edit can retire the draft before this render's passive effect runs.
    if (draftRevision !== null && viewRevision(scope, key) !== null)
      retiredDraft.current = false;
    else if (!retiredDraft.current)
      retiredDraft.current = retirement.current = true;
    if (!retirement.current || !loaded || busy) return;
    retirement.current = false;
    if (edited) replaceView(scope, key, null, { content: draft, base });
    void load(!edited);
  }, [draftRevision, loaded, busy, edited, load, scope, key, draft, base]);
  const recover = (
    replace: boolean,
    control: HTMLElement | null = recovery.current,
  ) => {
    handoff.current = control;
    setRecovering(true);
    void load(replace, replace).finally(() => setRecovering(false));
  };
  const restore = async (revision: RelayEvent) => {
    if (readOnly) return;
    const generation = ++operation.current;
    // An editor that opens during this write starts from this snapshot and
    // reconciles with the Canvas once the write settles and removes it.
    const snapshot =
      viewRevision(scope, key) === null &&
      writeView(scope, key, { content: draft, base });
    const stored = viewRevision(scope, key);
    setBusy(true);
    try {
      const event = await canvas.save(channelId, revision.content, head?.id);
      // A write can land after this editor closed. Retire the unchanged draft
      // unless a reopened editor has replaced it since.
      if (!dirty) retire(stored);
      if (generation !== operation.current) return;
      setHead(event);
      if (dirty) {
        setError(
          "Canvas was restored. Your unsaved draft is kept. Copy any edits you want to keep before reloading the saved Canvas.",
        );
      } else {
        setDraft(event.content);
        setAdopted(event.content);
        setBase(event.id);
        setError("");
      }
    } catch (reason) {
      // Save may replay the same signed event with its original precondition.
      // Even an error may follow a delivered write. Never adopt content, rebase
      // a draft, or start another restore on that uncertain outcome.
      try {
        const event = await canvas.read(channelId);
        if (generation === operation.current) setHead(event);
      } catch {
        /* Preserve the mutation error; explicit reload can retry. */
      }
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      // A restore can be dirty without edits, after Refresh history moved the
      // head, so keep the snapshot only when it holds text typed here.
      if (snapshot && !edited) retire(stored);
      if (generation === operation.current) setBusy(false);
    }
  };
  const save = async () => {
    if (readOnly) return;
    const generation = ++operation.current;
    // An editor that opens during this write starts from this snapshot and
    // reconciles with the Canvas once the write settles and removes it.
    const snapshot =
      viewRevision(scope, key) === null &&
      writeView(scope, key, { content: draft, base });
    const stored = viewRevision(scope, key);
    setBusy(true);
    setError("");
    try {
      const event = await canvas.save(channelId, draft, base ?? undefined);
      // Retire the saved draft even if this editor has closed since.
      retire(stored);
      if (generation === operation.current) {
        setHead(event);
        setBase(event.id);
        setAdopted(event.content);
      }
    } catch (reason) {
      if (generation === operation.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // Save is enabled only on the loaded head, so a dirty snapshot holds text
      // typed here. A failed write keeps it as the draft.
      if (snapshot && !dirty) retire(stored);
      if (generation === operation.current) setBusy(false);
    }
  };
  const actions =
    tab === "edit" ? (
      <>
        {(error || recovering) && (
          <Button
            ref={recovery}
            loading={busy}
            onClick={() => {
              if (!loaded) recover(false);
              else setConfirmReload(true);
            }}
          >
            {loaded ? "Reload saved Canvas" : "Retry loading"}
          </Button>
        )}
        <Button
          variant="prominent"
          loading={busy}
          disabled={
            readOnly ||
            !loaded ||
            !canvas.available ||
            (head?.id ?? null) !== base
          }
          onClick={() => void save()}
        >
          Save Canvas
        </Button>
      </>
    ) : undefined;
  const body = (
    <>
      <div className={`${styles.stack} ${panelStyles.views}`}>
        {readOnly && <p role="status">Canvas is read-only.</p>}
        <Tabs
          variant="panel"
          label="Canvas views"
          value={tab}
          onValueChange={(next) => {
            // History stays mounted while a read or write it started settles.
            if (!busy || (tab !== "history" && next !== "history"))
              setTab(next);
          }}
          items={[
            { value: "view", label: "View", panelId: `${panelId}-view` },
            { value: "edit", label: "Edit", panelId: `${panelId}-edit` },
            {
              value: "history",
              label: "History",
              panelId: `${panelId}-history`,
            },
          ]}
        />
        <div
          hidden={tab !== "view"}
          role="tabpanel"
          id={`${panelId}-view`}
          aria-labelledby={`${panelId}-view-tab`}
        >
          {/* View stays mounted so returning to it does not render again. */}
          <CanvasView
            content={head?.content}
            loaded={loaded}
            readError={readError}
            busy={busy}
            retry={() => recover(false, viewRetry.current)}
            openLink={openViewLink}
            codeBlocks={codeBlocks}
            focusRef={view}
            retryRef={viewRetry}
            active={tab === "view"}
          />
        </div>
        <div
          hidden={tab !== "edit"}
          role="tabpanel"
          id={`${panelId}-edit`}
          aria-labelledby={`${panelId}-edit-tab`}
        >
          <div className={styles.stack}>
            <p className="text-secondary">
              Shared Markdown for this channel. Saves and restores check the
              loaded revision on supporting relays.
            </p>
            {readOnly && loaded && dirty && (
              <p role="status">
                Showing your unsaved local draft. Open History to view saved
                versions.
              </p>
            )}
            <Textarea
              ref={editor}
              data-tab-focus
              readOnly={readOnly || busy}
              aria-label="Canvas Markdown"
              variant="code"
              rows={16}
              value={draft}
              disabled={!loaded}
              onChange={(e) => {
                setDraft(e.target.value);
                if (differs(e.target.value))
                  writeView(scope, key, { content: e.target.value, base });
                else retire(viewRevision(scope, key));
              }}
            />
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
          </div>
        </div>
        <div
          hidden={tab !== "history"}
          role="tabpanel"
          id={`${panelId}-history`}
          aria-labelledby={`${panelId}-history-tab`}
        >
          {tab === "history" && (
            <CanvasHistory
              canvas={canvas}
              channelId={channelId}
              profiles={profiles}
              head={head}
              busy={busy}
              // A failed refresh leaves `head` possibly stale, so History
              // treats it as unread until a read lands.
              loaded={loaded && !readError}
              dirty={dirty}
              readOnly={readOnly}
              refreshHead={() => load()}
              retryHead={() => recover(false, historyRetry.current)}
              comparisonRef={comparison}
              retryRef={historyRetry}
              restore={restore}
            />
          )}
        </div>
      </div>
      <Dialog
        size="compact"
        open={confirmReload}
        onOpenChange={setConfirmReload}
        dismissOnOutsideClick
        initialFocus={cancelReload}
        // A reload that lands before this closes has removed its button.
        finalFocus={() => recovery.current ?? editor.current}
        title="Reload saved Canvas?"
        actions={
          <>
            <Button ref={cancelReload} onClick={() => setConfirmReload(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmReload(false);
                recover(true);
              }}
            >
              Discard and reload
            </Button>
          </>
        }
      >
        Discard your draft and reload the saved Canvas?
      </Dialog>
    </>
  );
  return (
    <section
      className={panelStyles.panel}
      aria-label="Channel Canvas"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape" && busy) event.stopPropagation();
      }}
    >
      <div className={panelStyles.scroll}>{body}</div>
      {actions && <footer className={panelStyles.footer}>{actions}</footer>}
    </section>
  );
}
