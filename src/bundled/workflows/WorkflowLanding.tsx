import { useProfileGeneration } from "../../features/relay/react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  useReducedMotion,
} from "motion/react";
import { WORKFLOW_CHANNEL_BATCH } from "../../features/workflows/queries";
import {
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { publicKeyLabels } from "../../shared/identity/public-key";
import type {
  WorkflowCapability,
  WorkflowDefinition,
  WorkflowDefinitions,
  WorkflowOperation,
  WorkflowView,
} from "../../features/workflows/types";
import {
  CaretDownIcon,
  ClockIcon,
  ArrowsDownUpIcon,
  UserIcon,
  CheckCircleIcon,
  CircleIcon,
  XIcon,
  HashIcon,
  ArrowRightIcon,
  DotsThreeIcon,
  CalendarIcon,
  ChatCircleIcon,
  GitPullRequestIcon,
  LightningIcon,
  EyeIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
  PlusIcon,
  SmileyIcon,
  TimerIcon,
  WebhooksLogoIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuNote,
  MenuIcon,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { RadioGroup, Radio } from "../../shared/design-system/ui/RadioGroup";
import { Field } from "../../shared/design-system/ui/Field";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Header } from "../../shared/design-system/ui/Header";
import { channelIcon } from "../../features/channels/channel-icon";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { WorkflowDeletionNotices } from "./WorkflowDeletionNotices";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { messages } from "./WorkflowOperations";
import { ConfirmAction } from "./ConfirmAction";
import { useWorkflowCanDelete } from "./useWorkflowCanDelete";
import { WorkflowRuns } from "./WorkflowRuns";
import { getWorkflowActivationWarning } from "./workflowActivationWarning";
import {
  workflowCardPresentation,
  type WorkflowCardIcon,
} from "./workflowCardPresentation";
import {
  readWorkflowDocumentFields,
  yamlWithWorkflowEnabled,
} from "./workflowYamlDocument";

const ICONS: Record<WorkflowCardIcon, typeof LightningIcon> = {
  delay: TimerIcon,
  diff: GitPullRequestIcon,
  message: ChatCircleIcon,
  reaction: SmileyIcon,
  schedule: CalendarIcon,
  webhook: WebhooksLogoIcon,
  workflow: LightningIcon,
};

const EMPTY_DEFINITIONS: WorkflowDefinitions = Object.freeze({
  items: Object.freeze([]),
  partial: false,
});

type DefinitionsSnapshot = ReturnType<
  WorkflowView<WorkflowDefinitions>["snapshot"]
>;

/** Whether this workflow's configuration still has a write in flight or a save
 * awaiting readback. Delivered run requests never lock configuration, and a
 * save is resolved once a newer head replaces it; the relay's expected-revision
 * check still rejects stale saves. */
export function workflowOperationLocked(
  operations: readonly WorkflowOperation[],
  definition: WorkflowDefinition,
) {
  let newestSave: WorkflowOperation | undefined;
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (
      !operation ||
      operation.outcome === "rejected" ||
      operation.workflow.channelId !== definition.channelId ||
      operation.workflow.id !== definition.id ||
      operation.workflow.owner !== definition.owner
    )
      continue;
    if (operation.action === "delete" || operation.outcome === "pending")
      return true;
    if (operation.action === "save") newestSave ??= operation;
  }
  return !!newestSave && saveAwaitsReadback(newestSave, definition);
}

/** The relay still accepts saves and runs there, but every run fails. */
export const ARCHIVED_REASON =
  "This channel is archived, so its workflows can't run.";

/** A save is resolved once its exact revision, or a newer head, is read. */
export function saveAwaitsReadback(
  save: WorkflowOperation,
  definition: WorkflowDefinition,
) {
  return (
    save.eventId !== definition.revision &&
    definition.createdAt <= save.createdAt
  );
}

function useLandingDefinitions(
  capability: WorkflowCapability,
  channels: readonly ChannelSummary[],
  refreshRequest: number,
  retryRequest: number,
  operationRefreshKey: string,
  saveReadback: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined,
) {
  // Mount already reads current definitions; only consume subsequent notifications.
  const observedRefresh = useRef(refreshRequest);
  const observedReadback = useRef(saveReadback);
  const store = useMemo(() => {
    let snapshots: Readonly<Record<string, DefinitionsSnapshot>> = {};
    let paused = false;
    let purgeGeneration = 0;
    let state = { snapshots, paused, purgeGeneration };
    let channelIds: readonly string[] = [];
    const queued = new Map<string, boolean>();
    const listeners = new Set<() => void>();
    type Read = {
      ids: readonly string[];
      ifStale: boolean;
      view: WorkflowView<WorkflowDefinitions>;
      stop(): void;
    };
    let active: Read | undefined;
    let invalidated = false;
    // Retain one completed view to observe session clear/access loss even after
    // discovery finishes. All other views are disposed; at most two are live.
    let retained: Read | undefined;
    const emit = () => {
      state = { snapshots, paused, purgeGeneration };
      for (const listener of listeners) listener();
    };
    const release = (read: Read | undefined) => {
      read?.stop();
      read?.view.dispose();
    };
    const purge = (snapshot: DefinitionsSnapshot) => {
      // Clears can repeat before every recovery batch has left the idle state.
      purgeGeneration++;
      invalidated = true;
      paused = false;
      queued.clear();
      const previous = active;
      active = undefined;
      release(previous);
      snapshots = Object.fromEntries(
        channelIds.map((id) => [
          id,
          {
            status: snapshot.status,
            data: EMPTY_DEFINITIONS,
            ...(snapshot.error ? { error: snapshot.error } : {}),
          },
        ]),
      );
      emit();
    };
    const failure = (id: string) => ({
      status: "error" as const,
      data: snapshots[id]?.data ?? EMPTY_DEFINITIONS,
      error: "Workflow read unavailable. Retry; this is not proof of deletion.",
    });
    const definitionsFor = (id: string, data: WorkflowDefinitions) => ({
      items: data.items.filter((row) => row.channelId === id),
      partial: data.partialChannelIds?.includes(id) ?? data.partial,
    });
    const hasCopiedData = (data: WorkflowDefinitions | undefined) =>
      !!data &&
      (data.items.length > 0 ||
        data.partial ||
        (data.partialChannelIds?.length ?? 0) > 0);
    const record = (owned: Read, snapshot: DefinitionsSnapshot) => {
      for (const id of owned.ids) {
        const previous = snapshots[id]?.data;
        snapshots = {
          ...snapshots,
          [id]: {
            ...snapshot,
            data:
              snapshot.status === "loading" || snapshot.status === "error"
                ? previous && hasCopiedData(previous)
                  ? previous
                  : definitionsFor(id, snapshot.data)
                : definitionsFor(id, snapshot.data),
          },
        };
      }
    };
    const pause = (owned: Read, snapshot: DefinitionsSnapshot) => {
      paused = true;
      for (const id of owned.ids) queued.set(id, false);
      if (active) {
        for (const id of active.ids) queued.set(id, false);
        if (active !== owned) release(active);
      }
      active = undefined;
      if (retained !== owned) release(retained);
      retained = owned;
      record(owned, snapshot);
      emit();
    };
    const observe = (ids: readonly string[], ifStale: boolean): Read => {
      const view = capability.definitions(ids);
      const owned = { ids, ifStale, view, stop: () => {} };
      owned.stop = view.subscribe(() => {
        if (active !== owned && retained !== owned) return;
        const snapshot = view.snapshot();
        if (snapshot.status === "idle" || snapshot.status === "unavailable") {
          purge(snapshot);
        } else if (snapshot.status === "error") {
          pause(owned, snapshot);
        } else {
          record(owned, snapshot);
          emit();
        }
      });
      return owned;
    };
    const readNext = () => {
      if (active || paused) return;
      const ids = channelIds
        .filter((id) => queued.has(id))
        .slice(0, WORKFLOW_CHANNEL_BATCH);
      const first = ids[0];
      if (!first) return;
      const ifStale = ids.every((id) => queued.get(id));
      for (const id of ids) queued.delete(id);
      let owned: Read;
      try {
        owned = observe(ids, ifStale);
        active = owned;
        void owned.view
          .refresh({ ifStale: owned.ifStale })
          .catch(() => {
            if (active === owned) pause(owned, failure(first));
          })
          .finally(() => {
            if (active !== owned) return;
            const snapshot = owned.view.snapshot();
            if (snapshot.status === "error") {
              pause(owned, snapshot);
              return;
            }
            record(owned, snapshot);
            release(retained);
            retained = owned;
            active = undefined;
            emit();
            readNext();
          });
      } catch {
        release(active);
        active = undefined;
        for (const id of ids) {
          snapshots = { ...snapshots, [id]: failure(id) };
          queued.set(id, false);
        }
        paused = true;
        emit();
      }
    };
    return {
      snapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      channels(ids: readonly string[]) {
        // Membership changes re-establish authorized interest after a secure
        // purge. A session clear alone never restarts discovery.
        if (invalidated) snapshots = {};
        invalidated = false;
        channelIds = ids;
        const wanted = new Set(ids);
        if (active?.ids.some((id) => !wanted.has(id))) {
          const previous = active;
          active = undefined;
          for (const id of previous.ids)
            if (wanted.has(id)) queued.set(id, previous.ifStale);
          release(previous);
        }
        if (retained?.ids.some((id) => !wanted.has(id))) {
          release(retained);
          retained = undefined;
          // Keep copied snapshots subscribed to session invalidation without
          // rereading a completed channel just to replace the observer.
          const replacement = ids[0];
          if (replacement && !active) retained = observe([replacement], true);
        }
        for (const id of queued.keys()) if (!wanted.has(id)) queued.delete(id);
        snapshots = Object.fromEntries(
          Object.entries(snapshots).filter(([id]) => wanted.has(id)),
        );
        for (const id of ids)
          if (!snapshots[id]) {
            snapshots = {
              ...snapshots,
              [id]: { status: "loading", data: EMPTY_DEFINITIONS },
            };
            queued.set(id, true);
          }
        emit();
        readNext();
      },
      retry() {
        paused = false;
        readNext();
        emit();
      },
      refresh(ids = channelIds, afterPending = false) {
        invalidated = false;
        if (!afterPending) paused = false;
        for (const id of ids)
          if (channelIds.includes(id)) queued.set(id, false);
        // A pending read already satisfies refresh; never cancel and repeat it.
        if (active && !afterPending)
          for (const id of active.ids) queued.delete(id);
        readNext();
        emit();
      },
      dispose() {
        const previous = active;
        active = undefined;
        queued.clear();
        release(previous);
        release(retained);
        retained = undefined;
        snapshots = {};
        paused = false;
        state = { snapshots, paused, purgeGeneration };
      },
    };
  }, [capability]);
  const channelIdsKey = channels
    .map((channel) => channel.id)
    .sort()
    .join(":");
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => {
    store.channels(channelIdsKey ? channelIdsKey.split(":") : []);
  }, [channelIdsKey, store]);
  useEffect(() => {
    if (observedRefresh.current === refreshRequest) return;
    observedRefresh.current = refreshRequest;
    store.refresh();
  }, [refreshRequest, store]);
  useEffect(() => {
    if (retryRequest) store.retry();
  }, [retryRequest, store]);
  useEffect(() => {
    if (operationRefreshKey)
      store.refresh(
        operationRefreshKey.split(":").map((key) => key.split("/")[0] ?? ""),
        true,
      );
  }, [operationRefreshKey, store]);
  useEffect(() => {
    // The receipt-triggered read may finish before the saved head is visible.
    // Verified editor readback must also invalidate the landing’s copied result.
    if (observedReadback.current === saveReadback) return;
    observedReadback.current = saveReadback;
    if (
      saveReadback &&
      !store
        .snapshot()
        .snapshots[saveReadback.channelId]?.data.items.some(
          (definition) => definition.revision === saveReadback.revision,
        )
    )
      store.refresh([saveReadback.channelId], true);
  }, [saveReadback, store]);
  return {
    ...useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot),
    refresh: store.refresh,
  };
}

function WorkflowIcon({ kind }: { kind: WorkflowCardIcon }) {
  const Icon = ICONS[kind];
  return <Icon size={20} strokeWidth={2.5} aria-hidden="true" />;
}

function WorkflowOwner({
  session,
  owner,
  channelId,
  keyLabel,
}: {
  session: RelaySession;
  owner: string;
  channelId: string;
  keyLabel: string;
}) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [owner]),
    [session, owner],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useChannelIdentityNames(session, channelId);
  const profile = profiles.get(owner);
  const fallback = profile && !profile.nameIsFallback ? profile.name : keyLabel;
  return <>Owner: {name(owner, fallback)}</>;
}

function WorkflowCard({
  session,
  ownerKeyLabels,
  capability,
  channel,
  definition,
  detailTarget,
  locked,
  operations,
  selected,
  viewer,
  showChannel = false,
  onError,
  onOpen,
  onDelete,
  onSelect,
  onRun,
}: {
  session: RelaySession | undefined;
  ownerKeyLabels: ReadonlyMap<string, string>;
  capability: WorkflowCapability;
  channel: ChannelSummary;
  definition: WorkflowDefinition;
  detailTarget: HTMLElement | null;
  locked: boolean;
  operations: readonly WorkflowOperation[];
  selected: boolean;
  viewer: string;
  showChannel?: boolean;
  onSelect: () => void;
  onRun: (eventId: string) => void;
  onError: (message: string | null) => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const present = useIsPresent();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletion = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.action === "delete" &&
        operation.outcome !== "rejected" &&
        operation.workflow.id === definition.id &&
        operation.workflow.owner === definition.owner &&
        operation.workflow.channelId === definition.channelId,
    );
  const [confirmEnable, setConfirmEnable] = useState(false);
  // The change and the revision it was submitted against.
  const [submitted, setSubmitted] = useState<{
    operationId: string;
    revision: string;
  } | null>(null);
  // History reads only the workflow's identity, which the card key fixes.
  const [history] = useState(definition);
  const openRef = useRef<HTMLButtonElement>(null);
  const wasSelected = useRef(selected);
  useEffect(() => {
    // Closing the detail returns lost focus to the card that opened it.
    if (
      wasSelected.current &&
      !selected &&
      (!document.activeElement || document.activeElement === document.body)
    )
      openRef.current?.focus();
    wasSelected.current = selected;
  }, [selected]);
  // Like the editor, a created run rereads history so it is shown.
  const createdRun = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.action === "trigger" &&
        !!operation.runId &&
        operation.workflow.channelId === definition.channelId &&
        operation.workflow.owner === definition.owner &&
        operation.workflow.id === definition.id,
    )?.eventId;
  const fields = readWorkflowDocumentFields(definition.yaml);
  const presentation = workflowCardPresentation(definition.yaml);
  const enabled = fields.enabled !== false;
  const readonly = definition.owner !== viewer;
  const canDelete = useWorkflowCanDelete(capability, definition);
  const submittedOperation = operations.find(
    (operation) => operation.eventId === submitted?.operationId,
  );
  const awaitingReadback =
    submitted?.revision === definition.revision &&
    submittedOperation?.outcome !== "rejected";
  // An enabled workflow can still be turned off, so it stops failing.
  const archivedOff = !!channel.archived && !enabled;
  const toggleReason = archivedOff
    ? ARCHIVED_REASON
    : readonly
      ? "Only the author can change this workflow."
      : locked || awaitingReadback
        ? "Waiting for the submitted change to be resolved."
        : !fields.editable
          ? "Correct the YAML before changing the configured state."
          : !capability.availability.save
            ? "Saving is unavailable from this host."
            : undefined;
  const reasonId = useId();
  const archivedReasonId = useId();
  const deleteReasonId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const warning = getWorkflowActivationWarning(definition.yaml);
  const name = fields.name || "Unnamed or malformed workflow";
  const keyLabel =
    ownerKeyLabels.get(definition.owner.toLowerCase()) ?? "Unknown owner";
  const owner = session ? (
    <WorkflowOwner
      session={session}
      owner={definition.owner}
      channelId={definition.channelId}
      keyLabel={keyLabel}
    />
  ) : (
    <>Owner: {keyLabel}</>
  );
  const runDisabled =
    !!channel.archived ||
    readonly ||
    locked ||
    awaitingReadback ||
    !!deletion ||
    !capability.availability.trigger;
  const runNow = () => {
    if (runDisabled) return;
    try {
      onRun(capability.trigger(definition));
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error ? cause.message : "Run could not be submitted.",
      );
    }
  };
  const toggle = (next: boolean) => {
    // Like runNow: a confirmation can outlive the state that allowed it.
    if (toggleReason) {
      onError(toggleReason);
      return;
    }
    const yaml = yamlWithWorkflowEnabled(definition.yaml, next);
    if (yaml === null) {
      onError("This workflow cannot be changed from the landing page.");
      return;
    }
    try {
      const operationId = capability.save({
        channelId: channel.id,
        existing: definition,
        yaml,
      });
      setSubmitted({ operationId, revision: definition.revision });
      onError(null);
    } catch (cause) {
      onError(
        cause instanceof Error
          ? cause.message
          : "The workflow status could not be submitted.",
      );
    }
  };

  const triggerArt = presentation.triggerEmoji ? (
    <span className="workflow-card-emoji text-body">
      {presentation.triggerEmoji}
    </span>
  ) : (
    <WorkflowIcon kind={presentation.triggerIcon} />
  );
  const controls = (
    <div className="workflow-card-switch">
      <IconButton
        size="sm"
        variant="ghost"
        aria-label={`Run now: ${name}`}
        title={channel.archived ? ARCHIVED_REASON : "Run now"}
        aria-describedby={channel.archived ? archivedReasonId : undefined}
        disabled={runDisabled}
        // A natively disabled button gets no hover, so its reason would never show.
        focusableWhenDisabled={channel.archived}
        icon={<PlayIcon size="1rem" aria-hidden="true" />}
        onClick={runNow}
      />
      {fields.editable && (
        // Like Run now, the archived reason shows on hover and keyboard focus.
        <Tooltip
          content={ARCHIVED_REASON}
          {...(archivedOff ? {} : { open: false })}
          disableHoverablePopup
        >
          <Switch
            aria-label={`Enabled in configuration: ${name}`}
            aria-describedby={toggleReason ? reasonId : undefined}
            checked={enabled}
            disabled={!!toggleReason}
            // Base UI's Switch has no focusableWhenDisabled; a disabled one
            // leaves the tab order unless given a tabIndex.
            {...(archivedOff
              ? {
                  tabIndex: 0,
                  // Space would otherwise scroll the list. useButton drops a
                  // plain onKeyDown while disabled, so this uses capture.
                  onKeyDownCapture: (event) => {
                    if (event.key === " ") event.preventDefault();
                  },
                }
              : {})}
            onCheckedChange={(next) => {
              if (next === enabled) return;
              if (next && warning) setConfirmEnable(true);
              else toggle(next);
            }}
          />
        </Tooltip>
      )}
      <MenuRoot>
        <MenuTrigger
          render={
            <IconButton
              aria-label={`Actions for ${name}`}
              size="sm"
              variant="ghost"
              icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
            />
          }
        />
        <MenuPopup size="compact" align="end">
          <MenuItem
            disabled={!!deletion}
            onClick={() => onOpen(definition, channel)}
          >
            <MenuIcon>
              {readonly ? (
                <EyeIcon size={14} />
              ) : (
                <PencilSimpleIcon size={14} />
              )}
            </MenuIcon>
            {readonly ? "View workflow" : "Edit workflow"}
          </MenuItem>
          <MenuItem
            tone="danger"
            aria-describedby={!canDelete ? `${deleteReasonId}-row` : undefined}
            disabled={
              !canDelete ||
              locked ||
              awaitingReadback ||
              !capability.availability.delete
            }
            onClick={() => setConfirmDelete(true)}
          >
            <MenuIcon>
              <TrashIcon size={14} />
            </MenuIcon>
            Delete workflow
          </MenuItem>
          {!canDelete && (
            <MenuNote id={`${deleteReasonId}-row`}>
              Only the author or their verified agent owner can delete this
              workflow.
            </MenuNote>
          )}
        </MenuPopup>
      </MenuRoot>
    </div>
  );
  const status = (
    <>
      {deletion && (
        <span role="status">
          {deletion.outcome === "pending"
            ? "Deleting…"
            : "Deletion unconfirmed"}
        </span>
      )}
      {!fields.editable && <span>Unreadable configuration</span>}
      {toggleReason && (
        <span id={reasonId} hidden>
          {toggleReason}
        </span>
      )}
      {channel.archived && (
        <span id={archivedReasonId} hidden>
          {ARCHIVED_REASON}
        </span>
      )}
    </>
  );
  const updated = (
    <time dateTime={new Date(definition.createdAt * 1000).toISOString()}>
      {new Date(definition.createdAt * 1000).toLocaleDateString()}
    </time>
  );
  const detail = (
    <section className="workflow-detail" aria-label={name}>
      <div className="workflow-detail-hero">
        <div className="workflow-detail-flow" aria-hidden="true">
          <span className="workflow-detail-icon">{triggerArt}</span>
          {presentation.actionIcons.map((action) => (
            <span className="workflow-detail-step" key={action.key}>
              <ArrowRightIcon size="0.875rem" />
              <span className="workflow-detail-icon">
                <WorkflowIcon kind={action.icon} />
              </span>
            </span>
          ))}
        </div>
        <h2 className="text-heading">{name}</h2>
        <p className="text-body-sm text-secondary">
          {presentation.description}
        </p>
        <p className="text-caption text-subtle">
          #{channel.name} · {channel.archived && "Archived · "}
          {updated}
        </p>
        <p className="text-caption text-subtle">{owner}</p>
        <div className="workflow-detail-actions">
          <Button
            variant="primary"
            title={channel.archived ? ARCHIVED_REASON : undefined}
            aria-describedby={channel.archived ? archivedReasonId : undefined}
            disabled={runDisabled}
            focusableWhenDisabled={channel.archived}
            onClick={runNow}
          >
            <PlayIcon size="1rem" aria-hidden="true" />
            Run now
          </Button>
          <Button
            variant="outline"
            disabled={!!deletion}
            onClick={() => onOpen(definition, channel)}
          >
            {readonly ? (
              <EyeIcon size="1rem" aria-hidden="true" />
            ) : (
              <PencilSimpleIcon size="1rem" aria-hidden="true" />
            )}
            {readonly ? "View workflow" : "Edit workflow"}
          </Button>
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="md"
                  variant="outline"
                  icon={<DotsThreeIcon size="1rem" aria-hidden="true" />}
                />
              }
            />
            <MenuPopup size="compact" align="end">
              <MenuItem
                tone="danger"
                aria-describedby={
                  !canDelete ? `${deleteReasonId}-detail` : undefined
                }
                disabled={
                  !canDelete ||
                  locked ||
                  awaitingReadback ||
                  !capability.availability.delete
                }
                onClick={() => setConfirmDelete(true)}
              >
                <MenuIcon>
                  <TrashIcon size={14} />
                </MenuIcon>
                Delete workflow
              </MenuItem>
              {!canDelete && (
                <MenuNote id={`${deleteReasonId}-detail`}>
                  Only the author or their verified agent owner can delete this
                  workflow.
                </MenuNote>
              )}
            </MenuPopup>
          </MenuRoot>
        </div>
      </div>
      {fields.editable && (
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Enabled in configuration"
            description={
              toggleReason ??
              "Saved configuration only. Turning off does not confirm runs have stopped or cancel active runs."
            }
            checked={enabled}
            disabled={!!toggleReason}
            onCheckedChange={(next) => {
              if (next === enabled) return;
              if (next && warning) setConfirmEnable(true);
              else toggle(next);
            }}
          />
        </SettingsGroup>
      )}
      <WorkflowRuns
        key={createdRun ?? ""}
        capability={capability}
        workflow={history}
      />
    </section>
  );
  return (
    <>
      {present &&
        selected &&
        detailTarget &&
        createPortal(detail, detailTarget)}
      <article className="workflow-card" data-selected={selected || undefined}>
        <div className="workflow-card-row">
          <NavigationItem
            multiline
            ref={openRef}
            aria-label={`Open ${name}: ${presentation.description}`}
            aria-describedby={`${descriptionId} ${statusId}`}
            aria-current={false}
            aria-pressed={selected}
            selected={selected}
            disabled={!!deletion}
            onClick={onSelect}
            icon={
              <span className="workflow-card-flow" aria-hidden="true">
                <span className="workflow-card-icon">{triggerArt}</span>
                {presentation.actionIcons.length > 0 && (
                  <>
                    <ArrowRightIcon
                      className="workflow-card-arrow"
                      size="0.875rem"
                    />
                    {presentation.actionIcons.slice(0, 1).map((action) => (
                      <span className="workflow-card-icon" key={action.key}>
                        <WorkflowIcon kind={action.icon} />
                      </span>
                    ))}
                  </>
                )}
              </span>
            }
            label={
              <span className="workflow-row-copy" id={descriptionId}>
                <span
                  className="workflow-card-description text-body-sm text-standard"
                  title={presentation.description}
                >
                  {presentation.description}
                </span>
                <span className="workflow-card-meta text-caption text-subtle">
                  <span className="workflow-card-name" title={name}>
                    {name}
                  </span>
                  <span aria-hidden="true">·</span>
                  {showChannel && (
                    <>
                      <span className="workflow-card-name" title={channel.name}>
                        #{channel.name}
                      </span>
                      <span aria-hidden="true">·</span>
                      {channel.archived && (
                        <>
                          <span>Archived</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                    </>
                  )}
                  {updated}
                </span>
                <span className="workflow-card-owner text-caption text-subtle">
                  {owner}
                </span>
              </span>
            }
          />
          {controls}
        </div>
        <span
          id={statusId}
          className="workflow-card-status text-caption text-subtle"
        >
          {status}
        </span>
      </article>
      {present && confirmDelete && (
        <ConfirmAction
          title="Delete this workflow?"
          description="The saved workflow may remain visible. Work already running may continue."
          action="Delete workflow"
          cancel="Cancel"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(definition);
          }}
        />
      )}
      {present && confirmEnable && (
        <ConfirmAction
          title={warning?.title ?? "Turn on this workflow?"}
          description={
            warning?.description ??
            "The relay may run this workflow as soon as its trigger matches."
          }
          action="Turn on"
          cancel="Keep off"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            toggle(true);
          }}
        />
      )}
    </>
  );
}

/** Exiting filters/results stop accepting input before their fade completes. */
function WorkflowListTransition({
  children,
  ref,
}: {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  return (
    <motion.div
      ref={ref}
      className="workflow-list-transition"
      layout={instant ? false : "position"}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ opacity: instant ? 1 : 0, scale: instant ? 1 : 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: instant ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

function WorkflowCards({
  session,
  ownerKeyLabels,
  capability,
  channel,
  detailTarget,
  operations,
  selected,
  entries,
  partialChannels,
  viewer,
  onOpen,
  onDelete,
  onSelect,
  onRun,
  onError,
}: {
  session: RelaySession | undefined;
  ownerKeyLabels: ReadonlyMap<string, string>;
  capability: WorkflowCapability;
  channel: ChannelSummary | undefined;
  detailTarget: HTMLElement | null;
  operations: readonly WorkflowOperation[];
  selected: string | undefined;
  entries: readonly {
    definition: WorkflowDefinition;
    channel: ChannelSummary;
  }[];
  partialChannels: readonly ChannelSummary[];
  viewer: string;
  onSelect: (key: string | undefined) => void;
  onRun: (eventId: string) => void;
  onError: (message: string | null) => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  // Present groups receive current props; presence data updates retained exits.
  const present = useIsPresent();
  const channelIds: ReadonlySet<string> = usePresenceData();
  const headingId = useId();
  const currentEntries = present
    ? entries
    : entries.filter((entry) => channelIds.has(entry.channel.id));
  const currentPartialChannels = present
    ? partialChannels
    : partialChannels.filter((item) => channelIds.has(item.id));
  if (!currentEntries.length && !currentPartialChannels.length) return null;
  const Icon = channel && channelIcon(channel);
  return (
    <section
      className="workflow-channel-group"
      aria-labelledby={channel ? headingId : undefined}
      aria-label={channel ? undefined : "Recent workflows"}
    >
      {Icon && channel && (
        <Header
          id={headingId}
          level={2}
          icon={<Icon size={24} />}
          title={channel.name}
          subtitle={channel.archived && "Archived"}
        />
      )}
      <SettingsGroup>
        {currentEntries.map(({ definition, channel: itemChannel }) => {
          const key = workflowKey(definition);
          return (
            <WorkflowCard
              session={session}
              ownerKeyLabels={ownerKeyLabels}
              capability={capability}
              channel={itemChannel}
              showChannel={!channel}
              definition={definition}
              detailTarget={detailTarget}
              key={key}
              locked={workflowOperationLocked(operations, definition)}
              onError={onError}
              onRun={onRun}
              onOpen={onOpen}
              onDelete={onDelete}
              onSelect={() => onSelect(selected === key ? undefined : key)}
              operations={operations}
              selected={selected === key}
              viewer={viewer}
            />
          );
        })}
        {currentPartialChannels.map((partialChannel) => (
          <div
            key={partialChannel.id}
            className="workflow-state-card text-body-sm text-secondary"
          >
            #{partialChannel.name} returned a partial workflow list.
          </div>
        ))}
      </SettingsGroup>
    </section>
  );
}

const workflowKey = (definition: WorkflowDefinition) =>
  `${definition.channelId}:${definition.owner}:${definition.id}`;

const OWNER_OPTIONS = [
  { value: "all", label: "All channel workflows" },
  { value: "mine", label: "My workflows" },
] as const;
const STATUS_OPTIONS = [
  { value: "all", label: "Any status" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
] as const;
const TRIGGER_OPTIONS = [
  { value: "message", label: "Message" },
  { value: "reaction", label: "Reaction" },
  { value: "diff", label: "Diff" },
  { value: "schedule", label: "Schedule" },
  { value: "webhook", label: "Webhook" },
] as const;

function WorkflowFilterMenu<Value extends string>({
  label,
  value,
  options,
  onChange,
  triggerRef,
  icon,
  showDefault = false,
}: {
  label: string;
  value: Value;
  options: readonly [
    { value: Value; label: string },
    ...{ value: Value; label: string }[],
  ];
  onChange: (value: Value) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  icon: ReactNode;
  /** Name the default option on the trigger instead of the bare filter label. */
  showDefault?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = value !== options[0].value;
  const named = active || showDefault;
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? label;
  return (
    <div className="workflow-filter-control">
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={triggerRef}
          aria-label={named ? `${label}: ${selectedLabel}` : label}
          aria-description={named ? selectedLabel : undefined}
          render={
            <Button size="sm" variant="subtle">
              {named && icon}
              <span className="workflow-filter-label">
                {named ? selectedLabel : label}
              </span>
              <CaretDownIcon size={16} aria-hidden="true" />
            </Button>
          }
        />
        <PopoverPopup size="compact" padding="list" aria-label={label}>
          <div className="workflow-filter-options">
            <Field label={label} labelVisibility="hidden">
              <RadioGroup size="sm" value={value} onValueChange={onChange}>
                {options.map((option) => (
                  <Radio
                    size="sm"
                    key={option.value}
                    value={option.value}
                    label={<span className="text-body-sm">{option.label}</span>}
                    onClick={() => setOpen(false)}
                  />
                ))}
              </RadioGroup>
            </Field>
          </div>
        </PopoverPopup>
      </PopoverRoot>
      {active && (
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          title={`Clear ${label.toLowerCase()} filter`}
          icon={<XIcon size={16} aria-hidden="true" />}
          onClick={() => {
            onChange(options[0].value);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function WorkflowMultiFilterMenu<Value extends string>({
  label,
  options,
  value,
  onChange,
  triggerRef,
  icon,
  wide = false,
  pluralLabel,
  emptyMessage,
}: {
  label: string;
  options: readonly { value: Value; label: string; icon?: ReactNode }[];
  value: readonly Value[];
  onChange: (value: readonly Value[]) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  icon: ReactNode;
  wide?: boolean;
  pluralLabel: string;
  emptyMessage: string;
}) {
  const selected = options.filter((option) => value.includes(option.value));
  const active = selected.length > 0;
  const shownText =
    selected.length === 1
      ? (selected[0]?.label ?? label)
      : active
        ? `${selected.length} ${pluralLabel}`
        : label;
  return (
    <div className="workflow-filter-control">
      <PopoverRoot>
        <PopoverTrigger
          ref={triggerRef}
          aria-label={active ? `${label}: ${shownText}` : label}
          aria-description={
            active
              ? selected.map((option) => option.label).join(", ")
              : undefined
          }
          render={
            <Button size="sm" variant="subtle">
              {active &&
                (selected.length === 1 ? (selected[0]?.icon ?? icon) : icon)}
              <span className="workflow-filter-label">{shownText}</span>
              <CaretDownIcon size={16} aria-hidden="true" />
            </Button>
          }
        />
        <PopoverPopup
          size={wide ? "wide" : "compact"}
          padding="list"
          aria-label={label}
        >
          {options.length === 0 && (
            <p className="text-body-sm text-secondary">{emptyMessage}</p>
          )}
          <div
            className={
              wide ? "workflow-filter-channels" : "workflow-filter-options"
            }
          >
            {options.map((option) => (
              <Checkbox
                size="sm"
                key={option.value}
                checked={value.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...value, option.value]
                      : value.filter((current) => current !== option.value),
                  )
                }
                label={
                  <span className="workflow-filter-channel-label text-body-sm">
                    {option.icon}
                    <span
                      className="workflow-filter-label"
                      title={option.label}
                    >
                      {option.label}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </PopoverPopup>
      </PopoverRoot>
      {active && (
        <IconButton
          size="sm"
          variant="ghost"
          aria-label={`Clear ${label.toLowerCase()} filter`}
          title={`Clear ${label.toLowerCase()} filter`}
          icon={<XIcon size={16} aria-hidden="true" />}
          onClick={() => {
            onChange([]);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

export function WorkflowLanding({
  session,
  capability,
  channels,
  filter,
  onFilterChange,
  refreshRequest,
  saveReadback,
  viewer,
  onCreate,
  onOpen,
  onDelete,
  detailTarget,
  selected,
  onSelect,
}: {
  /** Live identity names; offline diagnostic fixtures use public-key labels. */
  session?: RelaySession | undefined;
  capability: WorkflowCapability;
  channels: readonly ChannelSummary[];
  /** Element that receives the selected workflow's detail. */
  detailTarget: HTMLElement | null;
  selected: string | undefined;
  /** Reports the selected workflow and its name, or clears the selection. */
  onSelect: (key: string | undefined, name?: string) => void;
  /** Channel IDs to show; every channel is still read. Empty shows all. */
  filter: readonly string[];
  onFilterChange: (channelIds: readonly string[]) => void;
  refreshRequest: number;
  saveReadback?: Pick<WorkflowDefinition, "channelId" | "revision"> | undefined;
  viewer: string;
  /** Absent when no channel can take a new workflow here. */
  onCreate?: (() => void) | undefined;
  onDelete: (definition: WorkflowDefinition) => void;
  onOpen: (definition: WorkflowDefinition, channel: ChannelSummary) => void;
}) {
  const operations = useSyncExternalStore(
    capability.operations.subscribe,
    capability.operations.snapshot,
    capability.operations.snapshot,
  );
  const [sort, setSort] = useState<"channel" | "recent">("channel");
  const [mineOnly, setMineOnly] = useState(true);
  const [status, setStatus] =
    useState<(typeof STATUS_OPTIONS)[number]["value"]>("all");
  const [triggers, setTriggers] = useState<
    readonly (typeof TRIGGER_OPTIONS)[number]["value"][]
  >([]);
  const ownerTriggerRef = useRef<HTMLButtonElement>(null);
  const statusTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerTypeRef = useRef<HTMLButtonElement>(null);
  const channelsTriggerRef = useRef<HTMLButtonElement>(null);
  const [retryRequest, setRetryRequest] = useState(0);
  // Feedback outlives the card, which a filter may unmount.
  const [runRequests, setRunRequests] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissingRun, setDismissingRun] = useState(false);
  const dismissRun = async (eventId: string) => {
    if (dismissingRun) return;
    setDismissingRun(true);
    try {
      await capability.operations.dismiss(eventId);
      setRunRequests((current) => current.filter((id) => id !== eventId));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn't dismiss this notice. Try again.",
      );
    } finally {
      setDismissingRun(false);
    }
  };
  const runRequest = (eventId: string) =>
    setRunRequests((current) => [...current, eventId]);
  const operationRefreshKey = operations
    .filter(
      (operation) =>
        (operation.action === "save" || operation.action === "delete") &&
        (operation.outcome === "unknown" || operation.outcome === "succeeded"),
    )
    .map(
      (operation) =>
        `${operation.workflow.channelId}/${operation.eventId}/${operation.outcome}${operation.action === "delete" ? `/${operation.delivery}/${!!operation.error}` : ""}`,
    )
    .join(":");
  const { snapshots, paused, purgeGeneration, refresh } = useLandingDefinitions(
    capability,
    channels,
    refreshRequest,
    retryRequest,
    operationRefreshKey,
    saveReadback,
  );
  const filteredSnapshots = useMemo(() => {
    if (!mineOnly && status === "all" && triggers.length === 0)
      return snapshots;
    return Object.fromEntries(
      Object.entries(snapshots).map(([id, snapshot]) => [
        id,
        {
          ...snapshot,
          data: {
            ...snapshot.data,
            items: snapshot.data.items.filter((definition) => {
              if (mineOnly && definition.owner !== viewer) return false;
              if (status !== "all") {
                const fields = readWorkflowDocumentFields(definition.yaml);
                if (
                  !fields.editable ||
                  (fields.enabled !== false) !== (status === "enabled")
                )
                  return false;
              }
              if (triggers.length === 0) return true;
              const type = workflowCardPresentation(
                definition.yaml,
              ).triggerIcon;
              return triggers.some((trigger) => trigger === type);
            }),
          },
        },
      ]),
    );
  }, [snapshots, mineOnly, status, triggers, viewer]);
  const filtered =
    mineOnly || status !== "all" || triggers.length > 0 || filter.length > 0;
  const resetFilters = () => {
    onFilterChange([]);
    setMineOnly(false);
    setStatus("all");
    setTriggers([]);
    ownerTriggerRef.current?.focus();
  };
  const ordered = [...channels].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const populated = ordered.filter(
    (channel) => snapshots[channel.id]?.data.items.length,
  );
  const emptyFromFilters = filtered && populated.length > 0;
  // Only the default My workflows filter hides other owners' workflows.
  const emptyFromOwnership =
    emptyFromFilters &&
    mineOnly &&
    status === "all" &&
    triggers.length === 0 &&
    filter.length === 0;
  const shown = populated.filter((channel) => filter.includes(channel.id));
  useEffect(() => {
    if (filter.length !== shown.length)
      onFilterChange(shown.map((channel) => channel.id));
  }, [filter, shown, onFilterChange]);
  const visible = shown.length ? shown : ordered;
  const reading = visible.some(
    (channel) =>
      !snapshots[channel.id] || snapshots[channel.id]?.status === "loading",
  );
  const items = visible.flatMap(
    (channel) => filteredSnapshots[channel.id]?.data.items ?? [],
  );
  const selectedItem = items.find(
    (definition) => workflowKey(definition) === selected,
  );
  const selectionFilteredOut =
    !selectedItem &&
    ordered.some((channel) =>
      snapshots[channel.id]?.data.items.some(
        (definition) => workflowKey(definition) === selected,
      ),
    );
  const selectedName = selectedItem
    ? readWorkflowDocumentFields(selectedItem.yaml).name ||
      "Unnamed or malformed workflow"
    : undefined;
  useEffect(() => {
    // Filtering is definitive; disappearance waits for pending reads to settle.
    if (selected && !selectedName && (selectionFilteredOut || !reading))
      onSelect(undefined);
    else if (selected && selectedName) onSelect(selected, selectedName);
  }, [onSelect, reading, selected, selectedName, selectionFilteredOut]);
  const cleared = visible.some(
    (channel) =>
      snapshots[channel.id]?.status === "idle" ||
      snapshots[channel.id]?.status === "unavailable",
  );
  // Global clears reset presence; membership changes retire only removed content.
  const channelIds = new Set(channels.map((channel) => channel.id));
  const settledEmpty =
    !paused &&
    !reading &&
    visible.every(
      (channel) =>
        snapshots[channel.id]?.status === "ready" &&
        !filteredSnapshots[channel.id]?.data.items.length &&
        !snapshots[channel.id]?.data.partial,
    );
  const groups = visible.flatMap((channel) => {
    const snapshot = filteredSnapshots[channel.id];
    if (
      !snapshot ||
      snapshot.status === "idle" ||
      snapshot.status === "unavailable" ||
      (!snapshot.data.items.length && !snapshot.data.partial)
    )
      return [];
    return [
      {
        key: channel.id,
        channel,
        entries: snapshot.data.items.map((definition) => ({
          definition,
          channel,
        })),
        partialChannels: snapshot.data.partial ? [channel] : [],
      },
    ];
  });
  const displayedGroups =
    sort === "recent" && groups.length
      ? [
          {
            key: "recent",
            channel: undefined,
            entries: groups
              .flatMap((group) => group.entries)
              .sort(
                (a, b) =>
                  b.definition.createdAt - a.definition.createdAt ||
                  workflowKey(a.definition).localeCompare(
                    workflowKey(b.definition),
                  ),
              ),
            partialChannels: groups.flatMap((group) => group.partialChannels),
          },
        ]
      : groups;
  const ownerKey = [
    ...new Set(
      groups.flatMap((group) =>
        group.entries.map(({ definition }) => definition.owner),
      ),
    ),
  ]
    .sort()
    .join(":");
  const ownerIds = useMemo(
    () => (ownerKey ? ownerKey.split(":") : []),
    [ownerKey],
  );
  // Fallback keys share one suffix length so visible owners stay distinguishable.
  const ownerKeyLabels = useMemo(() => publicKeyLabels(ownerIds), [ownerIds]);
  const profileGeneration = useProfileGeneration(session?.profiles);
  useEffect(() => {
    void profileGeneration;
    if (!session) return;
    // Match the profile directory's query batch size and stay within its
    // per-call budget even when discovery spans many channels and owners.
    for (let offset = 0; offset < ownerIds.length; offset += 500) {
      void session.profiles
        .ensure(ownerIds.slice(offset, offset + 500), "background")
        .catch(() => {});
    }
  }, [session, ownerIds, profileGeneration]);
  return (
    <>
      <fieldset
        className="workflow-filter-toolbar"
        aria-label="Workflow filters"
      >
        <div className="workflow-filter-controls">
          <WorkflowFilterMenu
            label="Owner"
            triggerRef={ownerTriggerRef}
            value={mineOnly ? "mine" : "all"}
            options={OWNER_OPTIONS}
            icon={<UserIcon size={16} aria-hidden="true" />}
            showDefault
            onChange={(value) => setMineOnly(value === "mine")}
          />
          <WorkflowFilterMenu
            label="Status"
            triggerRef={statusTriggerRef}
            value={status}
            options={STATUS_OPTIONS}
            icon={
              status === "enabled" ? (
                <CheckCircleIcon size={16} aria-hidden="true" />
              ) : (
                <CircleIcon size={16} aria-hidden="true" />
              )
            }
            onChange={setStatus}
          />
          <WorkflowMultiFilterMenu
            label="Trigger"
            pluralLabel="triggers"
            emptyMessage="No trigger types available."
            triggerRef={triggerTypeRef}
            value={triggers}
            onChange={setTriggers}
            wide
            icon={<LightningIcon size={16} aria-hidden="true" />}
            options={TRIGGER_OPTIONS.map((option) => {
              const Icon = ICONS[option.value];
              return {
                ...option,
                icon: (
                  <Icon
                    className="workflow-filter-channel-icon"
                    size={14}
                    aria-hidden="true"
                  />
                ),
              };
            })}
          />
          <WorkflowMultiFilterMenu
            label="Channels"
            pluralLabel="channels"
            emptyMessage="No channels with workflows yet."
            triggerRef={channelsTriggerRef}
            value={filter}
            onChange={onFilterChange}
            wide
            icon={<HashIcon size={16} aria-hidden="true" />}
            options={populated.map((channel) => ({
              value: channel.id,
              label: channel.name,
              icon: (
                <HashIcon
                  className="workflow-filter-channel-icon"
                  size={14}
                  aria-hidden="true"
                />
              ),
            }))}
          />
          {filtered && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              Clear all
            </Button>
          )}
        </div>
        <span className="workflow-sort-control">
          <MenuRoot>
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Sort workflows"
                  aria-description={
                    sort === "recent" ? "Recently updated" : "By channel"
                  }
                  title={
                    sort === "recent"
                      ? "Sort: Recently updated"
                      : "Sort: By channel"
                  }
                >
                  {sort === "recent" ? (
                    <ClockIcon size={16} aria-hidden="true" />
                  ) : (
                    <ArrowsDownUpIcon size={16} aria-hidden="true" />
                  )}
                  <CaretDownIcon size={16} aria-hidden="true" />
                </Button>
              }
            />
            <MenuPopup size="compact" align="end" aria-label="Sort workflows">
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) => {
                  if (value === "channel" || value === "recent") setSort(value);
                }}
              >
                <MenuRadioItem value="channel" closeOnClick>
                  By channel
                </MenuRadioItem>
                <MenuRadioItem value="recent" closeOnClick>
                  Recently updated
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </MenuRoot>
        </span>
      </fieldset>
      <WorkflowDeletionNotices
        operations={operations}
        snapshots={snapshots}
        onCheck={refresh}
        onDismiss={(operation) =>
          capability.operations.dismiss(operation.eventId)
        }
      />
      {settledEmpty ? (
        <EmptyState
          icon={<LightningIcon size="1.5rem" aria-hidden="true" />}
          title={
            emptyFromOwnership
              ? "You don’t have any workflows yet"
              : emptyFromFilters
                ? "No matching workflows"
                : "Workflows"
          }
          description={
            emptyFromOwnership
              ? "Workflows you authored appear here. Other authors’ workflows are in All channel workflows."
              : emptyFromFilters
                ? "Try changing or clearing your filters."
                : "Automations that keep your community moving."
          }
          action={
            emptyFromOwnership ? (
              <Button
                onClick={() => {
                  setMineOnly(false);
                  ownerTriggerRef.current?.focus();
                }}
              >
                Show all channel workflows
              </Button>
            ) : emptyFromFilters ? (
              <Button onClick={resetFilters}>Clear filters</Button>
            ) : (
              onCreate && (
                <Button onClick={onCreate}>
                  <PlusIcon size="1rem" aria-hidden="true" />
                  New workflow
                </Button>
              )
            )
          }
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape from a card or its portaled detail clears the selection, as on Agents.
        <div
          className="workflow-collection"
          onKeyDown={(event) => {
            const target = event.target as Element;
            if (
              event.key === "Escape" &&
              selected &&
              !event.nativeEvent.isComposing &&
              !event.defaultPrevented &&
              (event.currentTarget.contains(target) ||
                target.closest(".workflow-detail"))
            ) {
              event.preventDefault();
              onSelect(undefined);
            }
          }}
        >
          <AnimatePresence
            key={`${purgeGeneration}/${sort}`}
            custom={channelIds}
            initial={false}
            mode="popLayout"
          >
            {displayedGroups.map((group) => (
              <WorkflowListTransition key={group.key}>
                <WorkflowCards
                  session={session}
                  ownerKeyLabels={ownerKeyLabels}
                  capability={capability}
                  channel={group.channel}
                  entries={group.entries}
                  partialChannels={group.partialChannels}
                  detailTarget={detailTarget}
                  onOpen={onOpen}
                  onDelete={onDelete}
                  onSelect={onSelect}
                  onRun={runRequest}
                  onError={setError}
                  operations={operations}
                  selected={selected}
                  viewer={viewer}
                />
              </WorkflowListTransition>
            ))}
          </AnimatePresence>
        </div>
      )}
      <p
        className="workflow-page-status text-body-sm text-secondary"
        role="status"
      >
        {paused
          ? "Workflow discovery paused. Some channels could not be checked. Loaded workflows are still shown."
          : reading
            ? "Reading workflows…"
            : cleared
              ? "Workflow data cleared or unavailable. Refresh to check access."
              : null}
        {paused && (
          <Button
            size="sm"
            onClick={() => setRetryRequest((request) => request + 1)}
          >
            Retry
          </Button>
        )}
      </p>
      {operations
        .filter(
          (run) =>
            runRequests.includes(run.eventId) && run.outcome !== "pending",
        )
        .map((run) => (
          <ToastNotice
            key={run.eventId}
            title={messages.trigger[run.outcome]}
            {...(run.outcome === "rejected"
              ? {
                  description:
                    run.error || "The relay did not create a workflow run.",
                }
              : {})}
            tone={
              run.outcome === "succeeded"
                ? "success"
                : run.outcome === "unknown"
                  ? "warning"
                  : "error"
            }
            timeout={run.outcome === "succeeded" ? 4000 : 0}
            {...(run.outcome === "succeeded"
              ? {
                  onDismiss: () =>
                    setRunRequests((current) =>
                      current.filter((eventId) => eventId !== run.eventId),
                    ),
                }
              : {})}
          >
            {run.outcome !== "succeeded" && (
              <Button
                size="compact"
                disabled={dismissingRun}
                onClick={() => void dismissRun(run.eventId)}
              >
                Dismiss notice
              </Button>
            )}
          </ToastNotice>
        ))}
      {error && (
        <ToastNotice
          key={error}
          title={error}
          onDismiss={() => setError(null)}
        />
      )}
      <p className="workflow-page-footnote text-caption text-subtle">
        Saved configuration only. Turning off does not confirm runs have stopped
        or cancel active runs.
      </p>
    </>
  );
}
