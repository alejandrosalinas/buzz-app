import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import {
  ArrowsClockwiseIcon,
  LightningIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { WorkflowEditor } from "./WorkflowEditor";
import { DEFAULT_FORM_STATE, formStateToYaml } from "./workflowFormTypes";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { WorkflowChannelPicker } from "./WorkflowChannelPicker";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  useWorkflowMentionMembers,
  WorkflowMentionMembers,
} from "./WorkflowMessageText";
import { WorkflowWebhookSecrets } from "./WorkflowWebhookSecrets";
import { WorkflowLanding, workflowOperationLocked } from "./WorkflowLanding";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import "./workflows.css";

export function WorkflowsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return connection.status === "ready" ? (
    <WorkflowCommunity
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      viewer={connection.viewer ?? ""}
    />
  ) : (
    <WorkflowsPanel>
      <WorkflowPageHeader />
      <div className="workflow-page-state">
        <p>
          {connection.status === "connecting"
            ? "Connecting to your community…"
            : "Connect to a community to browse workflows."}
        </p>
        {connection.status === "error" && (
          <>
            <p role="alert">{connection.error}</p>
            <Button onClick={() => relay.retry()}>Retry connection</Button>
          </>
        )}
      </div>
    </WorkflowsPanel>
  );
}

function WorkflowsPanel({ children }: { children: ReactNode }) {
  return (
    <Panel aria-label="Workflows">
      <div className="workflows-page text-body">{children}</div>
    </Panel>
  );
}
export function WorkflowCommunity({
  session,
  viewer,
}: {
  session: RelaySession;
  viewer: string;
}) {
  const capability = session.workflows;
  const channels = useChannelList(session.channels);
  const eligible = channels.channels.filter(
    (item) => !item.huddle && !item.metadataPending,
  );
  const [selected, setSelected] = useState("");
  const [selectedDefinition, setSelectedDefinition] = useState<
    WorkflowDefinition | "new" | undefined
  >();
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [saveReadback, setSaveReadback] =
    useState<Pick<WorkflowDefinition, "channelId" | "revision">>();
  const deleting = useRef(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [filter, setFilter] = useState<readonly string[]>([]);
  const split = usePanelSplit(session.scope, "workflows", 448, 320);
  const [detail, setDetail] = useState<{ key: string; name: string }>();
  const [detailTarget, setDetailTarget] = useState<HTMLElement | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const selectDetail = useCallback((key: string | undefined, name?: string) => {
    setDetail((current) =>
      !key
        ? undefined
        : current?.key === key && (name === undefined || current.name === name)
          ? current
          : { key, name: name ?? (current?.key === key ? current.name : "") },
    );
  }, []);
  // The landing that reconciles the selection unmounts without channels.
  if (detail && !eligible.length) setDetail(undefined);
  const open = !!detail;
  useEffect(() => {
    const narrow = window.matchMedia?.("(max-width: 52rem)");
    if (!open || !narrow || !detailTarget) return;
    // Below 52rem the pane replaces the list, so focus left there moves to it.
    const handoff = () => {
      const focus = document.activeElement;
      if (
        narrow.matches &&
        (focus === document.body || mainRef.current?.contains(focus))
      )
        detailTarget.focus();
    };
    handoff();
    narrow.addEventListener("change", handoff);
    return () => narrow.removeEventListener("change", handoff);
  }, [open, detailTarget]);
  const channel = eligible.find((item) => item.id === selected);
  const mentionMembers = useWorkflowMentionMembers(session, channel);
  useEffect(() => {
    if (
      !selected ||
      channel ||
      (!channels.channels.some(
        (item) => item.id === selected && (item.huddle || item.metadataPending),
      ) &&
        (channels.status !== "ready" || channels.coverage === "partial"))
    )
      return;
    setSelected("");
    setSelectedDefinition(undefined);
  }, [channel, channels, selected]);
  if (!capability) {
    return (
      <WorkflowsPanel>
        <WorkflowPageHeader />
        <div className="workflows-body">
          <p role="status">
            Workflow operations are unavailable from this host.
          </p>
        </div>
      </WorkflowsPanel>
    );
  }

  const openChannel = (
    next: string,
    definition?: WorkflowDefinition | "new",
  ) => {
    if (next && !eligible.some((item) => item.id === next)) return;
    setSelectedDefinition(definition);
    setSelected(next);
  };
  const beginCreate = () => setCreateOpen(true);
  const deleteWorkflow = (definition: WorkflowDefinition) => {
    if (deleting.current) return;
    const locked = workflowOperationLocked(
      capability.operations.snapshot(),
      definition,
    );
    if (locked) {
      setDeleteError(
        "Another workflow change is still being confirmed. Refresh and try again.",
      );
      openChannel("");
      return;
    }
    if (definition.owner !== viewer || !capability.availability.delete) return;
    deleting.current = true;
    try {
      capability.delete(definition);
      setDeleteError(undefined);
    } catch (cause) {
      setDeleteError(
        cause instanceof Error
          ? cause.message
          : "Try again from the workflow menu.",
      );
    } finally {
      deleting.current = false;
      // Confirmation deliberately discards the editor draft, even if submission throws.
      openChannel("");
    }
  };

  return (
    <>
      <div
        ref={split.ref}
        className="workflows-split"
        data-side={detail ? "" : undefined}
      >
        <div className="workflows-main" ref={mainRef}>
          <WorkflowsPanel>
            <WorkflowPageHeader
              actions={
                <>
                  <IconButton
                    hint="familiar"
                    size="sm"
                    variant="ghost"
                    aria-label="New workflow"
                    title="New workflow"
                    aria-haspopup="dialog"
                    disabled={!capability.availability.save || !eligible.length}
                    icon={<PlusIcon size="1rem" aria-hidden="true" />}
                    onClick={beginCreate}
                  />
                  <IconButton
                    hint="familiar"
                    size="sm"
                    variant="ghost"
                    aria-label="Refresh workflows"
                    title="Refresh workflows"
                    icon={
                      <ArrowsClockwiseIcon size="1rem" aria-hidden="true" />
                    }
                    onClick={() => setRefreshRequest((request) => request + 1)}
                  />
                </>
              }
            />
            <div className="workflows-body">
              {channels.status === "loading" && !eligible.length && (
                <p role="status">Reading channels…</p>
              )}
              {channels.status === "error" && (
                <div className="workflow-page-state">
                  <p role="alert" className="text-danger">
                    {channels.error ?? "Channels could not be read."}
                  </p>
                  <Button onClick={() => session.channels.refreshList?.()}>
                    Retry channels
                  </Button>
                </div>
              )}
              {channels.status === "ready" && !eligible.length && (
                <div className="workflow-page-state">
                  <p>No channels are available in this community.</p>
                </div>
              )}
              {channels.coverage === "partial" && (
                <p className="text-secondary">The channel list is partial.</p>
              )}
              {eligible.length > 0 && (
                <WorkflowLanding
                  session={session}
                  capability={capability}
                  channels={eligible}
                  filter={filter}
                  onFilterChange={setFilter}
                  detailTarget={detailTarget}
                  selected={detail?.key}
                  onSelect={selectDetail}
                  onCreate={beginCreate}
                  onDelete={deleteWorkflow}
                  onOpen={(definition, nextChannel) =>
                    openChannel(nextChannel.id, definition)
                  }
                  refreshRequest={refreshRequest}
                  saveReadback={saveReadback}
                  viewer={viewer}
                />
              )}
            </div>
          </WorkflowsPanel>
        </div>
        {detail && (
          <aside className="workflows-side">
            {split.handle}
            <Panel aria-label="Workflow details">
              <PanelWorkspace
                focusOnMount={false}
                adoptSelection={detail.key}
                value={detail.key}
                select={() => {}}
                items={[
                  {
                    id: detail.key,
                    label: detail.name,
                    icon: <LightningIcon size="1rem" />,
                    content: (
                      <section
                        className="workflow-detail-host"
                        ref={setDetailTarget}
                        aria-label={`${detail.name} details`}
                        tabIndex={-1}
                      />
                    ),
                    close: () => selectDetail(undefined),
                  },
                ]}
              />
            </Panel>
          </aside>
        )}
      </div>
      {deleteError && (
        <ToastNotice
          title="Couldn't start deletion"
          description={deleteError}
          onDismiss={() => setDeleteError(undefined)}
        />
      )}
      {channel && selectedDefinition ? (
        <WorkflowMentionMembers.Provider value={mentionMembers}>
          <WorkflowChannel
            key={`${channel.id}:${
              typeof selectedDefinition === "object"
                ? selectedDefinition.revision
                : selectedDefinition
            }`}
            capability={capability}
            channelId={channel.id}
            channel={channel}
            initialSelection={selectedDefinition}
            onSaveReadback={setSaveReadback}
            onDelete={deleteWorkflow}
            viewer={viewer}
            onClose={() => openChannel("")}
          />
        </WorkflowMentionMembers.Provider>
      ) : null}
      <WorkflowWebhookSecrets capability={capability} />
      {createOpen && (
        <WorkflowEditor
          create
          chooseChannel
          yaml={formStateToYaml({
            ...DEFAULT_FORM_STATE,
            name: "Untitled workflow",
          })}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => setCreateOpen(false)}
          scope={
            <WorkflowChannelPicker
              channels={eligible}
              onSelect={(id) => {
                setCreateOpen(false);
                openChannel(id, "new");
              }}
            />
          }
        />
      )}
    </>
  );
}

function WorkflowPageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title="Workflows"
          icon={<LightningIcon size="1rem" />}
        />
      }
      actions={actions}
    />
  );
}
