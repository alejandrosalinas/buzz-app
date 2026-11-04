import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import {
  targetKey,
  type NavigationScope,
  type OpenTarget,
} from "../../features/navigation/targets";
import type {
  WorkflowDefinition,
  WorkflowReference,
} from "../../features/workflows/types";
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
import {
  WorkflowLanding,
  workflowKey,
  workflowOperationLocked,
} from "./WorkflowLanding";
import { routedWorkflow, workflowsRoute, workflowsTarget } from "./routes";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import "./workflows.css";

type WorkflowsNavigation = {
  navigation?: PageNavigation | undefined;
  navigator?: Navigation | undefined;
};
/** The landing a workflow visit returns to when it closes. */
const LANDING = "landing";
const landingOf = (navigation: PageNavigation) =>
  navigation.position(LANDING) as OpenTarget | undefined;

export function WorkflowsPage({
  relay,
  navigation,
  navigator,
}: { relay: RelayData } & WorkflowsNavigation) {
  const connection = useRelayConnection(relay);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const scope = useMemo(
    () =>
      connection.viewer && connection.origin
        ? { viewer: connection.viewer, communityOrigin: connection.origin }
        : undefined,
    [connection.viewer, connection.origin],
  );
  // Bind the visit to this community, so Back returns to it after a switch.
  useEffect(() => {
    if (
      request?.target.kind !== "page" ||
      request.target.scope !== undefined ||
      connection.status !== "ready" ||
      !scope
    )
      return;
    request.resolve({ ...request.target, scope });
  }, [request, connection.status, scope]);
  return connection.status === "ready" ? (
    <WorkflowCommunity
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      viewer={connection.viewer ?? ""}
      scope={scope}
      navigation={request}
      navigator={navigator}
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
  scope,
  navigation,
  navigator,
}: {
  session: RelaySession;
  viewer: string;
  scope?: NavigationScope | undefined;
} & WorkflowsNavigation) {
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
  const page =
    navigation?.target.kind === "page" ? navigation.target : undefined;
  const params = useMemo(
    () => page && (workflowsRoute(page.route?.params) ?? {}),
    [page],
  );
  // The route applies once the channel list, and its channel, are read.
  const routePending =
    channels.status === "loading" ||
    channels.status === "idle" ||
    channels.channels.some(
      (channel) => channel.id === params?.channel && channel.metadataPending,
    );
  const route = useMemo(
    () =>
      navigation && params && !routePending
        ? { visit: navigation.entryId, ...params }
        : undefined,
    [navigation, params, routePending],
  );
  // Each workflow visit this page pushes keeps the landing it left as its
  // position, saved once its presentation arrives, so Close returns there
  // however the reader reached the visit since, even through another page.
  // Visits that arrived from elsewhere have no landing to return to.
  const pushed = useRef<{ visit: string; landing: OpenTarget }>(undefined);
  useEffect(() => {
    const next = pushed.current;
    if (!navigation || next?.visit !== navigation.entryId) return;
    pushed.current = undefined;
    navigation.savePosition(LANDING, next.landing);
  }, [navigation]);
  // A selection the reader makes is a visit; switching selection replaces it
  // and closing retires it. Visits keep the page's scope, bound or not, so
  // Close finds the page again.
  const choose = useCallback(
    (workflow: WorkflowReference | undefined) => {
      const closing = detail?.key;
      selectDetail(workflow && workflowKey(workflow));
      if (
        !navigation ||
        !navigator ||
        !page ||
        navigation.signal.aborted ||
        navigator.snapshot().entry.id !== navigation.entryId
      )
        return;
      const routed = routedWorkflow(params);
      if (workflow) {
        if (routed && workflowKey(routed) === workflowKey(workflow)) return;
        const landing = routed ? landingOf(navigation) : page;
        void navigator.open(
          workflowsTarget(page, {
            channel: workflow.channelId,
            owner: workflow.owner,
            workflow: workflow.id,
          }),
          { focus: "preserve", replace: !!routed },
        );
        // Pushes land synchronously; a guarded departure leaves the entry.
        const visit = navigator.snapshot().entry.id;
        if (landing && (routed || visit !== navigation.entryId))
          pushed.current = { visit, landing };
      } else if (closing) {
        const fallback = landingOf(navigation) ?? workflowsTarget(page);
        const pageKey = targetKey(workflowsTarget(page));
        navigator.dismiss((visit) => {
          if (visit.kind !== "page") return false;
          const routed = routedWorkflow(workflowsRoute(visit.route?.params));
          return (
            !!routed &&
            workflowKey(routed) === closing &&
            targetKey(workflowsTarget(visit)) === pageKey
          );
        }, fallback);
      }
    },
    [detail, navigation, navigator, page, params, selectDetail],
  );
  const openConversation =
    navigator && scope
      ? (channelId: string, messageId?: string) =>
          navigator
            .open({
              version: 1,
              kind: "conversation",
              scope,
              channelId,
              ...(messageId ? { messageId } : {}),
            })
            .then((result) => result.status !== "failed")
      : undefined;
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
                  onChoose={choose}
                  route={route}
                  onOpenConversation={openConversation}
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
                    close: () => choose(undefined),
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
