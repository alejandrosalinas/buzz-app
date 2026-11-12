import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { DotsThreeIcon, RobotIcon } from "../../../shared/design-system/icons";
import { Avatar } from "../../../shared/design-system/ui/Avatar";
import type { Agent } from "../../../features/agents/service";
import { Button } from "../../../shared/design-system/ui/Button";
import { IconButton } from "../../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../../shared/design-system/ui/Toast";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { writeClipboardText } from "../../../shared/clipboard";
import { ManagementRow } from "../ManagementRow";
import { ManagementSection } from "../ManagementSection";
import agentsHero from "../assets/agents-hero.png";
import type { OverviewObserver } from "../overview";
import type { BuilderlabSession } from "../session";
import type { AgentClient, RemoteAgent } from "./client";

export function RemoteAgents({
  client,
  session,
  active,
  onOverview,
  showHeading = true,
  openAgents,
  savedAgents = [],
  openAgent,
}: {
  client: AgentClient;
  session: BuilderlabSession;
  active(): boolean;
  onOverview?: OverviewObserver | undefined;
  showHeading?: boolean;
  openAgents?: (() => void) | undefined;
  savedAgents?: readonly Pick<Agent, "pubkey" | "picture">[];
  openAgent?: ((pubkey: string) => void) | undefined;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  useLayoutEffect(() => {
    if (
      active() &&
      (login.status !== "signed-in" || !login.account?.canUseRemoteAgents)
    )
      onOverview?.({
        kind: login.status === "signed-in" ? "unavailable" : "empty",
      });
  }, [active, onOverview, login.status, login.account?.canUseRemoteAgents]);
  if (login.status === "signed-in" && !login.account?.canUseRemoteAgents)
    return (
      <AgentSection>
        {showHeading ? (
          <InlineHeader
            title="Remote agents"
            subtitle="Unavailable for this account"
          />
        ) : (
          <p className="text-body-sm text-secondary">
            Unavailable for this account
          </p>
        )}
      </AgentSection>
    );
  // A sign-in in progress or being checked shows its state in the account
  // notice beside this section, so this section says nothing yet.
  if (login.status === "pending") return null;
  return login.status === "signed-in" ? (
    <AgentList
      key={login.account?.subject}
      client={client}
      active={active}
      onOverview={onOverview}
      showHeading={showHeading}
      openAgents={openAgents}
      savedAgents={savedAgents}
      openAgent={openAgent}
    />
  ) : (
    <AgentSection>
      <p className="text-body-sm text-secondary">
        Sign in to view your remote agents.
      </p>
    </AgentSection>
  );
}

function AgentList({
  client,
  active,
  onOverview,
  showHeading,
  openAgents,
  savedAgents,
  openAgent,
}: {
  client: AgentClient;
  active(): boolean;
  onOverview?: OverviewObserver | undefined;
  showHeading: boolean;
  openAgents?: (() => void) | undefined;
  savedAgents: readonly Pick<Agent, "pubkey" | "picture">[];
  openAgent?: ((pubkey: string) => void) | undefined;
}) {
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const refresh = useRef(() => {});
  useLayoutEffect(() => {
    if (!active() || !onOverview) return;
    onOverview(
      loading
        ? { kind: "pending" }
        : agents
          ? agents.length
            ? {
                kind: "filled",
                items: agents.map((agent) => ({
                  key: agent.id,
                  label: agent.name,
                  ...(agentState(agent) === "Needs setup"
                    ? { note: "Needs setup" }
                    : {}),
                })),
              }
            : { kind: "empty" }
          : { kind: "failed" },
    );
  }, [active, onOverview, agents, loading]);
  useEffect(() => {
    let request: AbortController | undefined;
    let loaded = false;
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    const load = (quiet: boolean) => {
      if (!activeRef.current()) return;
      if (request) {
        if (quiet) return;
        request.abort();
      }
      const controller = new AbortController();
      request = controller;
      const current = () => !controller.signal.aborted && activeRef.current();
      // A retry keeps its failure visible; only the initial read uses loading.
      if (!quiet) setRetrying(true);
      void client
        .list(controller.signal)
        .then(
          (rows) => {
            if (current()) {
              loaded = true;
              setAgents(rows);
              setError(undefined);
              setLoading(false);
              setRetrying(false);
            }
          },
          (reason) => {
            if (current()) {
              if (!quiet || !loaded)
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not load agents.",
                );
              setLoading(false);
              setRetrying(false);
            }
          },
        )
        .finally(() => {
          if (request === controller) request = undefined;
        });
    };
    refresh.current = () => load(false);
    const focus = () => load(true);
    load(false);
    window.addEventListener("focus", focus);
    return () => {
      request?.abort();
      refresh.current = () => {};
      window.removeEventListener("focus", focus);
    };
  }, [client]);
  return (
    <section
      data-buzz-ui=""
      className="flex flex-col gap-3"
      aria-label="Remote agents"
    >
      {showHeading && <InlineHeader title="Remote agents" />}
      <AgentSection>
        {loading && (
          <p role="status" className="text-body-sm text-secondary">
            Loading agents…
          </p>
        )}
        {error && (
          <div role="alert">
            <EmptyState
              icon={<RobotIcon />}
              title="Couldn’t load agents"
              description={error}
              action={
                <Button
                  variant="subtle"
                  loading={retrying}
                  onClick={() => refresh.current()}
                >
                  Try again
                </Button>
              }
            />
          </div>
        )}
        {agents?.length === 0 && (
          <EmptyState
            icon={<RobotIcon />}
            title="No agents yet"
            description="Create agents in the Agents tab. They’ll show up here."
            action={
              openAgents && (
                <Button
                  variant="prominent"
                  onClick={() => {
                    if (active()) openAgents();
                  }}
                >
                  Open Agents
                </Button>
              )
            }
            level={4}
          />
        )}
        {agents && agents.length > 0 && (
          <ul className="m-0 list-none p-0" aria-label="Your remote agents">
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                active={active}
                saved={savedAgents.find(
                  ({ pubkey }) => pubkey === agent.pubkey,
                )}
                openAgent={openAgent}
              />
            ))}
          </ul>
        )}
      </AgentSection>
    </section>
  );
}

function AgentSection({ children }: { children: ReactNode }) {
  return (
    <ManagementSection hero={agentsHero} facts={[]}>
      {children}
    </ManagementSection>
  );
}

function AgentRow({
  agent,
  active,
  saved,
  openAgent,
}: {
  agent: RemoteAgent;
  active(): boolean;
  saved?: Pick<Agent, "pubkey" | "picture"> | undefined;
  openAgent?: ((pubkey: string) => void) | undefined;
}) {
  const notify = useToastNotification();
  const state = agentState(agent);
  const copy = async () => {
    if (!active()) return;
    try {
      await writeClipboardText(agent.pubkey);
      if (active()) notify("Key copied", "success");
    } catch {
      if (active()) notify("Couldn’t copy the key", "error");
    }
  };
  return (
    <li>
      <ManagementRow
        icon={
          <Avatar
            src={saved?.picture}
            alt=""
            fallback={agent.name}
            fallbackContent={<RobotIcon size={20} />}
            size="fill"
            shape="squircle"
          />
        }
        title={agent.name}
        onOpen={
          saved && openAgent
            ? () => {
                if (active()) openAgent(agent.pubkey);
              }
            : undefined
        }
        detail={
          <>
            {agent.modelId ?? "No model selected"} · {state}
          </>
        }
        status={saved ? "In Agents" : undefined}
        actions={
          <MenuRoot>
            <MenuTrigger
              render={
                <IconButton
                  variant="bare"
                  size="sm"
                  shape="row-end"
                  aria-label={`More actions for ${agent.name}`}
                  icon={<DotsThreeIcon size={18} />}
                />
              }
            />
            <MenuPopup
              align="end"
              aria-label={`More actions for ${agent.name}`}
            >
              {saved && openAgent && (
                <MenuItem
                  onClick={() => {
                    if (active()) openAgent(agent.pubkey);
                  }}
                >
                  View Agent
                </MenuItem>
              )}
              <MenuItem onClick={() => void copy()}>Copy key</MenuItem>
            </MenuPopup>
          </MenuRoot>
        }
      />
    </li>
  );
}

function agentState(agent: RemoteAgent) {
  return agent.status === "Revoked"
    ? "Revoked"
    : agent.status === "Unknown"
      ? "Unknown"
      : agent.status === "Active" && agent.modelSelectionStatus === "valid"
        ? "Configured"
        : "Needs setup";
}
