import { SidebarSectionEmojiInput } from "../../bundled/channels/SidebarSectionEmojiInput";
import type { SidebarSectionDraft } from "../relay/sidebar-preferences";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import type { RelaySession } from "../relay/session";
import { emptyLineup } from "../channel-templates/model";
import type { Resume } from "../channel-templates/capability";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { useChannelTemplates } from "../channel-templates/local";
import { useTemplateAgents } from "../channel-templates/useTemplateAgents";
import { TemplateAgentsStatus } from "../channel-templates/TemplateAgentsStatus";
import { DiscardChanges } from "../agents/AgentSaveButton";
import {
  emptyWorkspace,
  projectTemplate,
  projectTemplateId,
  readWorkspace,
  workspaceCanvas,
  type Workspace,
  appliedTemplate,
} from "./workspace";
import { WorkspaceFields } from "./WorkspaceFields";
import styles from "./WorkspaceSettings.module.css";

const noSubscription = () => () => {};

/**
 * Creates a workspace with the same starting folders and Canvas that
 * Workspace settings edits. Retrying reuses the same project ID, so a failed
 * defaults save never creates a second project.
 */
export function NewWorkspace({
  session,
  create,
  close,
  onCreated,
  finalFocus,
  moveConversation = false,
}: {
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  session: RelaySession;
  create(project: SidebarSectionDraft): Promise<unknown>;
  moveConversation?: boolean;
  close(): void;
  onCreated?(id: string): void | Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  // A chosen channel template also supplies the workspace's default agents.
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const templates = useChannelTemplates();
  const chosen = templates.find(({ id }) => id === selectedTemplate);
  const templateSetup = useTemplateAgents(session, chosen);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  // Once publication starts, retries must use the same project and defaults.
  const [submitted, setSubmitted] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = useRef(false);
  const published = useRef<{
    template: ReturnType<typeof projectTemplate> | undefined;
  }>(undefined);
  const defaults = useRef<Resume>({
    enqueued: (eventId) => {
      defaults.current.id = eventId;
    },
  });
  const form = useId();
  const input = useRef<HTMLInputElement>(null);
  const refocusAfterFailure = useRef(false);
  useLayoutEffect(() => {
    if (busy || !refocusAfterFailure.current) return;
    refocusAfterFailure.current = false;
    input.current?.focus({ preventScroll: true });
  }, [busy]);
  const preferences = session.sidebarPreferences;
  const writable = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    () => preferences?.sectionCreationWritable !== false,
  );
  const recovering = useRef(!writable);
  useLayoutEffect(() => {
    if (recovering.current && writable) {
      const field = input.current;
      const dialog = field?.closest('[role="dialog"]');
      const active = field?.ownerDocument.activeElement;
      if (!active || active === dialog || !dialog?.contains(active))
        field?.focus({ preventScroll: true });
    }
    recovering.current = !writable;
  }, [writable]);
  const submit = async () => {
    const trimmed = name.trim();
    if (
      !trimmed ||
      !writable ||
      pending.current ||
      conflict ||
      (!published.current && templateSetup.pending)
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      // Validate defaults before anything is published; a retry reuses them
      // even if the template or its agents change meanwhile.
      if (!published.current) {
        const canvas = workspaceCanvas(workspace);
        published.current = {
          template:
            canvas || chosen
              ? projectTemplate(
                  session.scope,
                  await projectTemplateId(id),
                  trimmed,
                  { ...emptyLineup(), agents: templateSetup.agents, canvas },
                )
              : undefined,
        };
      }
      const { template } = published.current;
      setSubmitted(true);
      await create({ id, name: trimmed, ...(icon ? { icon } : {}) });
      if (template) {
        // A confirmed save may have reported failure to its caller. Reconcile
        // the existing record before retrying its exact signed outbox intent.
        await session.channelKit.refresh();
        const state = session.channelKit.snapshot();
        if (state.status !== "ready")
          throw new Error(state.error ?? "Workspace defaults are unavailable.");
        const existing = state.entries.find(
          (entry) =>
            entry.record.value.type === "template" &&
            entry.record.value.id === template.id,
        );
        if (
          existing &&
          (existing.record.deleted ||
            JSON.stringify(existing.record.value) !== JSON.stringify(template))
        ) {
          setConflict(true);
          throw new Error(
            "Workspace defaults changed. Close this dialog and review Workspace settings.",
          );
        }
        if (!existing)
          await session.channelKit.save(
            template,
            undefined,
            false,
            undefined,
            defaults.current,
          );
      }
      if (chosen) appliedTemplate.write(session.scope, id, chosen.id);
      await onCreated?.(id);
      setOpen(false);
    } catch (reason) {
      refocusAfterFailure.current = true;
      setError(
        reason instanceof Error
          ? reason.message
          : "Workspace could not be created. Try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // Escape and Close ask before dropping typed fields or a partly created
  // workspace's retry state; Cancel discards. A conflict leaves nothing to keep.
  const dirty =
    !conflict &&
    (submitted ||
      name.trim() !== "" ||
      icon !== "" ||
      selectedTemplate !== "" ||
      workspace.folders.length > 0 ||
      workspace.worktree !== undefined ||
      workspace.canvas.trim() !== "");
  return (
    <Dialog
      open={open}
      onOpenChangeComplete={(next) => {
        if (!next) close();
      }}
      onOpenChange={(open) => {
        if (open) return;
        if (dirty) setConfirmDiscard(true);
        else setOpen(false);
      }}
      preventClose={busy}
      // A partly created workspace keeps its retry state; never drop it on a stray click.
      dismissOnOutsideClick={false}
      title={moveConversation ? "Move to new workspace" : "New workspace"}
      description="Set defaults for new conversations."
      height="stable-tall"
      initialFocus={input}
      finalFocus={finalFocus}
      actions={
        <>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            {submitted ? "Close" : "Cancel"}
          </Button>
          {!conflict && (
            <Button
              form={form}
              type="submit"
              variant="prominent"
              loading={busy}
              disabled={
                !name.trim() ||
                !writable ||
                (!submitted && templateSetup.pending)
              }
            >
              {submitted
                ? "Retry"
                : moveConversation
                  ? "Create and move"
                  : "Create"}
            </Button>
          )}
        </>
      }
    >
      <form
        id={form}
        className={styles.sections}
        inert={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <SidebarSectionEmojiInput
            session={session}
            scope={session.scope}
            icon={icon}
            onIconChange={setIcon}
            disabled={busy || submitted}
          >
            <Input
              ref={input}
              required
              disabled={busy}
              readOnly={submitted}
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </SidebarSectionEmojiInput>
        </Field>
        {templates.length > 0 && (
          <>
            <Select
              label="Start from a template"
              variant="field"
              value={selectedTemplate}
              disabled={busy || submitted}
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
                setSelectedTemplate(template ? id : "");
                if (!template) return;
                try {
                  setWorkspace(readWorkspace(template.canvas));
                } catch {
                  // Hand-edited workspace instructions stay as written.
                  setWorkspace({
                    ...emptyWorkspace(),
                    canvas: template.canvas,
                  });
                }
              }}
            />
            <TemplateAgentsStatus setup={templateSetup} />
          </>
        )}
        <WorkspaceFields
          value={workspace}
          onChange={setWorkspace}
          disabled={busy || submitted}
          instructionScope="workspace"
        />
        {submitted && !busy && !conflict && (
          <p role="status">
            Name, folders and instructions are kept for the retry.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {!writable && !busy && (
          <>
            <p role="status">Saved workspace preferences are unavailable.</p>
            <Button onClick={() => void preferences.refresh()}>
              Retry preferences
            </Button>
          </>
        )}
      </form>
      {confirmDiscard && (
        <DiscardChanges
          description="Your new workspace has unsaved changes."
          onKeep={() => setConfirmDiscard(false)}
          onDiscard={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}
