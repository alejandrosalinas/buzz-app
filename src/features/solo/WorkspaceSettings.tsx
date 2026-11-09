import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import type { KitEntry, Lineup } from "../channel-templates/model";
import { emptyLineup, parseLineup } from "../channel-templates/model";
import { Button } from "../../shared/design-system/ui/Button";
import type { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import { Field } from "../../shared/design-system/ui/Field";
import { readView, writeView } from "../../shared/view-state";
import {
  emptyWorkspace,
  readWorkspace,
  projectTemplateId,
  projectDefault,
  projectTemplate,
  workspaceCanvas,
  type Workspace,
} from "./workspace";
import { useLifetime } from "./Lifetime";
import {
  ChatInstructions,
  ChatSettingsDialog,
  instructionsCanvas,
} from "./ChatSettingsDialog";
import { ChannelDurationField } from "../../bundled/channels/ChannelDurationField";

type Target =
  | { kind: "project"; id: string; name: string }
  | { kind: "chat"; id: string; name: string };
class CanvasSettingsError extends Error {}

export function WorkspaceSettings({
  session,
  scope,
  target,
  close,
  signal,
  finalFocus,
}: {
  session: RelaySession;
  scope: string;
  target: Target;
  close(): void;
  signal?: AbortSignal | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [raw, setRaw] = useState<string>();
  const [base, setBase] = useState<string>();
  const [recipeId, setRecipeId] = useState("");
  const [lineup, setLineup] = useState<Lineup>(emptyLineup);
  const [entries, setEntries] = useState<readonly KitEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingCanvas, setLoadingCanvas] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [canvasError, setCanvasError] = useState(false);
  const [reloadConfirmed, setReloadConfirmed] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const alive = useRef(true);
  const inFlight = useRef(false);
  const confirmedCanvas = useRef("");
  // What reopening would show: the saved settings, or this device's kept draft.
  const kept = useRef("");
  const snapshot = (canvas: string | undefined, { agents, teamIds }: Lineup) =>
    JSON.stringify([canvas, agents, teamIds]);
  const canvasAvailable =
    target.kind === "project" || !!session.canvas?.available;
  const lifetime = useLifetime({
    session,
    id: target.id,
    signal,
    enabled: target.kind === "chat" && !!session.channelDetails?.available,
  });
  const active = () => alive.current && !signal?.aborted;
  // Persisted draft keys predate Solo; a chat's draft keeps its old prefix.
  const key = `solo:workspace-draft:${target.kind}:${target.id}`;
  const adopt = (canvas: string) => {
    try {
      setWorkspace(readWorkspace(canvas));
      setRaw(undefined);
    } catch {
      setRaw(canvas);
    }
  };
  const load = async (replace = false) => {
    if (inFlight.current || !canvasAvailable || !active()) return;
    inFlight.current = true;
    setLoadingCanvas(true);
    setError("");
    setCanvasError(false);
    try {
      let content = "",
        revision: string | undefined,
        defaults = emptyLineup();
      if (target.kind === "project") {
        await session.channelKit.refresh();
        if (!active()) return;
        const kit = session.channelKit.snapshot();
        if (kit.status !== "ready")
          throw new Error(kit.error ?? "Workspace defaults are unavailable.");
        const id = await projectTemplateId(target.id);
        if (!active()) return;
        // Tombstones still own the revision even though they supply no defaults.
        const entry = kit.entries.find(
          (entry) =>
            entry.record.value.type === "template" &&
            entry.record.value.id === id,
        );
        const template = projectDefault(kit.entries, target.id, id);
        setRecipeId(id);
        setEntries(kit.entries);
        defaults = template ?? emptyLineup();
        setLineup(defaults);
        content = template?.canvas ?? "";
        revision = entry?.eventId;
      } else {
        const head = await session.canvas.read(target.id);
        if (!active()) return;
        content = head?.content ?? "";
        revision = head?.id;
      }
      confirmedCanvas.current = content;
      const saved = replace ? null : readView<unknown>(scope, key, null);
      let adopted = content;
      if (
        saved &&
        typeof saved === "object" &&
        "canvas" in saved &&
        typeof saved.canvas === "string" &&
        "base" in saved &&
        (saved.base === null || typeof saved.base === "string")
      ) {
        if (target.kind === "project" && "lineup" in saved) {
          defaults = parseLineup(saved.lineup);
          setLineup(defaults);
        }
        adopt(saved.canvas);
        adopted = saved.canvas;
        setBase(saved.base ?? undefined);
        if ((saved.base ?? undefined) !== revision) {
          setError(
            "Saved settings changed while this draft was open. Your draft is kept; copy it before reloading.",
          );
          setCanvasError(true);
        }
      } else {
        adopt(content);
        setBase(revision);
      }
      kept.current = snapshot(adopted, defaults);
      setLoaded(true);
      setReloadConfirmed(false);
      if (replace && !writeView(scope, key, null))
        throw new CanvasSettingsError(
          "Saved settings loaded, but the old draft couldn’t be cleared on this device.",
        );
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setCanvasError(true);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setLoadingCanvas(false);
    }
  };
  // The dialog is keyed by destination; live reads must not rebase a draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load runs once for this keyed dialog.
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  const save = async () => {
    if (!active() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    let canvasConfirmed = false;
    try {
      if (lifetime.checkOnly) {
        // Checking an uncertain details write never publishes pending Canvas edits.
        await lifetime.run("check");
        if (!active()) return;
        if (canvasAvailable && !loaded) {
          setStatus(
            "Chat name and lifetime saved. Workspace and Canvas were not loaded; retry settings to review them.",
          );
          return;
        }
        if (
          loaded &&
          (raw ?? workspaceCanvas(workspace)) !== confirmedCanvas.current
        ) {
          setStatus(
            "Chat name and lifetime saved. Workspace and Canvas still have unsaved changes.",
          );
          return;
        }
      } else {
        // Validate both drafts before admitting either publication.
        const canvas = loaded
          ? raw === undefined
            ? workspaceCanvas(workspace)
            : workspaceCanvas({ folders: [], canvas: raw })
          : undefined;
        if (lifetime.changed && lifetime.blocked)
          throw new Error(
            lifetime.invalid ||
              "Reload chat details before saving name or lifetime.",
          );
        if (
          canvas !== undefined &&
          !writeView(scope, key, { canvas, base: base ?? null, lineup })
        )
          throw new CanvasSettingsError(
            "Your draft couldn’t be saved on this device. No new changes were sent.",
          );
        if (canvas !== undefined) kept.current = snapshot(canvas, lineup);
        if (
          canvas !== undefined &&
          (target.kind === "project" || canvas !== confirmedCanvas.current)
        ) {
          if (target.kind === "project") {
            const template = projectTemplate(
              session.scope,
              recipeId,
              target.name,
              { ...lineup, canvas },
            );
            try {
              await session.channelKit.save(template, base);
            } catch (reason) {
              throw new CanvasSettingsError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          } else {
            const selected = await session.canvas
              .save(target.id, canvas, base)
              .catch((reason) => {
                throw new CanvasSettingsError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              });
            confirmedCanvas.current = selected.content;
            setBase(selected.id);
            canvasConfirmed = true;
            if (
              !writeView(scope, key, {
                canvas: selected.content,
                base: selected.id,
                lineup,
              })
            )
              throw new CanvasSettingsError(
                "The confirmed Canvas revision couldn’t be saved on this device. Name and lifetime were not sent; keep this dialog open to retry.",
              );
          }
        }
        // Canvas operations remain session-owned; the visit fences only later admission.
        if (!active()) return;
        if (lifetime.changed) await lifetime.run("save");
      }
      if (!active()) return;
      if (loaded && !writeView(scope, key, null))
        throw new CanvasSettingsError(
          target.kind === "project"
            ? "Workspace defaults are confirmed, but the saved draft couldn’t be cleared on this device."
            : "Changes are confirmed, but the saved draft couldn’t be cleared on this device. Retry to finish without resending confirmed changes.",
        );
      close();
    } catch (reason) {
      if (active()) {
        setError(
          `${canvasConfirmed ? "Workspace and Canvas saved. " : ""}${reason instanceof Error ? reason.message : String(reason)}`,
        );
        setCanvasError(reason instanceof CanvasSettingsError);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const templates = entries.flatMap((entry) =>
    !entry.record.deleted &&
    entry.record.value.type === "template" &&
    !entry.record.value.id.startsWith("session-section-") &&
    !entry.record.value.id.startsWith("me-section-")
      ? [entry.record.value]
      : [],
  );
  return (
    <ChatSettingsDialog
      finalFocus={finalFocus}
      close={close}
      dirty={
        // An uncertain details save stays with its owner and reopens to be checked.
        (lifetime.changed && !lifetime.checkOnly) ||
        (loaded &&
          snapshot(instructionsCanvas(workspace, raw), lineup) !== kept.current)
      }
      busy={busy || lifetime.busy}
      title={target.kind === "project" ? "Workspace settings" : undefined}
      saveLabel={
        lifetime.checkOnly
          ? "Check save status"
          : `Save ${target.kind === "project" ? "defaults" : "changes"}`
      }
      saveLoading={busy || lifetime.busy || loadingCanvas}
      saveDisabled={
        loadingCanvas ||
        !!signal?.aborted ||
        (!loaded && !lifetime.eligible) ||
        (lifetime.available &&
          !lifetime.checkOnly &&
          (lifetime.changed || !loaded || lifetime.unrelatedAttempt) &&
          (lifetime.blocked || !!lifetime.invalid))
      }
      onSave={() => void save()}
    >
      {lifetime.available && lifetime.base && (
        <Field label="Chat name" error={lifetime.nameError}>
          <Input
            value={lifetime.name}
            placeholder={lifetime.base.name}
            disabled={busy || lifetime.busy || lifetime.blocked}
            onChange={(event) => lifetime.changeName(event.target.value)}
          />
        </Field>
      )}
      {loaded && (
        <>
          {target.kind === "project" && templates.length > 0 && (
            <Select
              label="Start from a template"
              variant="field"
              value={selectedTemplate}
              groups={[
                {
                  label: "",
                  options: [
                    { value: "", label: "Custom settings" },
                    ...templates.map((template) => ({
                      value: template.id,
                      label: template.name,
                    })),
                  ],
                },
              ]}
              onValueChange={(id) => {
                const template = templates.find(
                  (template) => template.id === id,
                );
                if (template) {
                  setLineup(template);
                  adopt(template.canvas);
                }
                if (!id) setLineup(emptyLineup());
                setSelectedTemplate(id);
              }}
            />
          )}
          <ChatInstructions
            workspace={workspace}
            onWorkspaceChange={setWorkspace}
            raw={raw}
            onRawChange={setRaw}
          />
          {target.kind === "project" &&
            (lineup.agents.length > 0 || lineup.teamIds.length > 0) && (
              <p className="text-secondary">
                The selected template’s agents and teams are also included in
                new chats.
              </p>
            )}
          {canvasError && (
            <Button
              variant="ghost"
              onClick={() => {
                if (reloadConfirmed) void load(true);
                else setReloadConfirmed(true);
              }}
            >
              {reloadConfirmed
                ? "Discard draft and reload saved settings"
                : "Review saved settings"}
            </Button>
          )}
        </>
      )}
      {canvasAvailable && !loaded && !loadingCanvas && (
        <Button onClick={() => void load()}>Retry settings</Button>
      )}
      {!canvasAvailable && (
        <p role="status">Workspace and Canvas are unavailable.</p>
      )}
      {lifetime.available && (
        <>
          {lifetime.base ? (
            <ChannelDurationField
              label="Lifetime"
              temporary={lifetime.ttl !== undefined}
              ttlSeconds={lifetime.temporaryTtl}
              disabled={busy || lifetime.busy || lifetime.blocked}
              error={lifetime.lifetimeError}
              onChange={lifetime.change}
            />
          ) : (
            !lifetime.error && <p role="status">Loading chat details…</p>
          )}
          {lifetime.base && !lifetime.eligible && (
            <p role="status">
              Only a chat you can edit can change its name or lifetime.
            </p>
          )}
          {lifetime.unrelatedAttempt && (
            <p role="status">
              Finish the existing channel details change before editing the chat
              name or lifetime.
            </p>
          )}
          {lifetime.error && !error.includes(lifetime.error) && (
            <p role="alert">{lifetime.error}</p>
          )}
          {lifetime.error && !lifetime.checkOnly && (
            <Button
              disabled={busy || lifetime.busy || !!signal?.aborted}
              onClick={() =>
                void lifetime
                  .run("reload")
                  .then(() => {
                    if (!canvasError) setError("");
                  })
                  .catch(() => {})
              }
            >
              Reload chat details
            </Button>
          )}
        </>
      )}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {canvasAvailable && loadingCanvas && !loaded && (
        <p role="status">Loading settings…</p>
      )}
    </ChatSettingsDialog>
  );
}
