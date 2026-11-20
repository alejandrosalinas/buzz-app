// A remote agent's Activity tab: the sessions Builderlab stored, with each
// one's transcript on request, above the turns the agent published to its
// owner over the relay this session.
import {
  type ComponentType,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import activityStyles from "../../../features/agents/ActivityLayout.module.css";
import { ownerReads } from "../../../features/agents/reads";
import type { AgentViewProps } from "../../../features/agents/service";
import { useRelayConnection } from "../../../features/relay/react";
import type { RelayData } from "../../../features/relay/service";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import type { AgentClient } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { createActivityTab } from "./Activity";
import { canReadSessions, listSessions } from "./history";
import { type ListedSessions, StoredActivity } from "./StoredActivity";

const EMPTY = { status: "loaded", sessions: [], more: false } as const;

/** The agent's stored sessions, read each time the tab opens for an agent
 * and account. `shown` while the owner can read them and Builderlab stores
 * them. Assumed while the list loads, so the usual layout holds; a server
 * without the list shifts it once, to the live feed alone, when it answers. */
function useListedSessions(
  client: AgentClient,
  session: BuilderlabSession,
  pubkey: string,
) {
  const login = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  const key = canReadSessions(login)
    ? `${pubkey}\u0000${login.account?.subject ?? ""}`
    : "";
  const [listed, setListed] = useState<{
    key: string;
    sessions: ListedSessions;
    unsupported?: true;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the agent and account it reads for.
  useEffect(() => {
    if (!key) return;
    const abort = new AbortController();
    const sessions: ListedSessions = listSessions(
      client,
      session,
      pubkey,
      abort.signal,
    ).then((list) => {
      if (list.status === "loaded") return list;
      if (!abort.signal.aborted)
        setListed((current) =>
          current?.sessions === sessions
            ? { ...current, unsupported: true }
            : current,
        );
      return EMPTY;
    });
    // A read aborted before the list renders has no other reader.
    sessions.catch(() => {});
    setListed({ key, sessions });
    return () => abort.abort();
  }, [key]);
  const current = listed?.key === key ? listed : undefined;
  return {
    shown: !!key && !current?.unsupported,
    sessions: current?.sessions,
  };
}

export function createRemoteActivityTab(
  relay: RelayData,
  client: AgentClient,
  session: BuilderlabSession,
  openSettings?: (section: string) => void,
): ComponentType<AgentViewProps> {
  const Live = createActivityTab(relay, openSettings);
  return function RemoteActivity(props) {
    const { agent, conversation, initialTranscript, close, openConversation } =
      props;
    const connection = useRelayConnection(relay);
    const { shown, sessions } = useListedSessions(
      client,
      session,
      agent.pubkey,
    );
    const reads = ownerReads(relay, agent.pubkey);
    // Without stored sessions the tab is the live feed alone, as before. It
    // mounts afresh then, so it answers a transcript request still pending.
    if (!shown) return <Live {...props} />;
    return (
      <div className={activityStyles.activity}>
        {sessions && (
          <StoredActivity
            agent={agent}
            conversation={conversation}
            initialTranscript={initialTranscript}
            close={close}
            openConversation={openConversation}
            client={client}
            listed={sessions}
            activity={
              connection.status === "ready"
                ? connection.session.agentActivity
                : undefined
            }
            channelLabel={(id) => reads?.channelLabel(id)}
            name={(pubkey) => reads?.name(pubkey)}
          />
        )}
        <section className={activityStyles.section}>
          <InlineHeader title="Live activity" />
          <Live
            {...props}
            // The stored transcript answers the request; the live feed only
            // returns to this conversation for it.
            {...(initialTranscript && {
              initialTranscript: {
                opening: initialTranscript.opening,
                done: () => {},
              },
            })}
          />
        </section>
      </div>
    );
  };
}
