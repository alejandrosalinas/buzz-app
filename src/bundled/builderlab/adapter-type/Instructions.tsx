import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AgentViewProps } from "../../../features/agents/service";
import { AgentExecutionNote } from "../../../features/agents/AgentExecutionNote";
import { executionCopy } from "../../../features/agents/execution-location";
import { PreferenceRow } from "../../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import inlineStyles from "../../../shared/InlineReference.module.css";
import type { AgentClient, RemoteAgent } from "../agents/client";
import type { BuilderlabSession } from "../session";
import { ModelSettings } from "./ModelSettings";

/** Hosted settings belong to Builderlab, rather than Agents' local config. */
export function createSettingsTab(
  client: AgentClient,
  session: BuilderlabSession,
) {
  function Editor({
    pubkey,
    retry,
    harnessControl,
  }: {
    pubkey: string;
    retry(): void;
    harnessControl: (action: ReactNode) => ReactNode;
  }) {
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    const [loaded, setLoaded] = useState<{
      agent: RemoteAgent;
      subject: string;
      email: string;
    }>();
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<unknown>("");
    useEffect(() => {
      if (loaded || login.status !== "signed-in") return;
      setBusy(true);
      setError("");
      const current = new AbortController();
      const load = async () => {
        // Retire a discarded mount before starting host I/O.
        await Promise.resolve();
        current.signal.throwIfAborted();
        const credential = session.credential();
        const remote = (await client.list(current.signal)).find(
          (row) => row.pubkey === pubkey,
        );
        current.signal.throwIfAborted();
        if (session.credential() !== credential)
          throw new DOMException("Builderlab session changed.", "AbortError");
        if (!remote)
          throw new Error("Agent not found in this Builderlab account.");
        if (remote.status !== "Active")
          throw new Error("Only Active agents can have their settings edited.");
        setLoaded({
          agent: remote,
          subject: credential.account.subject,
          email: credential.account.email,
        });
      };
      void load()
        .catch((reason: unknown) => {
          if (!current.signal.aborted) setError(reason);
        })
        .finally(() => {
          if (!current.signal.aborted) setBusy(false);
        });
      return () => current.abort();
    }, [pubkey, login, loaded]);
    return (
      <ModelSettings
        client={client}
        session={session}
        settings={
          loaded ?? {
            pending: busy && login.status === "signed-in",
            error,
            retry,
          }
        }
        harnessControl={harnessControl}
      />
    );
  }
  return function Settings({
    agent,
    settingsSection,
    settingsContent,
    settingsHost,
  }: AgentViewProps) {
    const [revision, setRevision] = useState(0);
    const login = useSyncExternalStore(session.subscribe, session.snapshot);
    const signedIn = login.status === "signed-in";
    return (
      <div className="grid gap-4">
        {settingsSection !== "runtime" && signedIn && (
          <AgentExecutionNote runtime={agent.type} />
        )}
        {settingsSection !== "runtime" && (
          <Editor
            key={`${agent.pubkey}/${revision}`}
            pubkey={agent.pubkey}
            retry={() => setRevision((value) => value + 1)}
            harnessControl={(action) =>
              settingsHost?.typeControl?.(false, action)
            }
          />
        )}
        {settingsSection !== "identity" && (
          <>
            <SettingsGroup>
              <PreferenceRow
                title="Runtime"
                subtitle={
                  <>
                    Hosted and managed by{" "}
                    <a
                      className={inlineStyles.link}
                      href={import.meta.env.VITE_BUZZ_BUILDERLAB_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Builderlab
                    </a>
                    .
                  </>
                }
              />
              {signedIn && (
                <PreferenceRow
                  title="Workspace"
                  subtitle={`Remote runtime shared with your other agents in this workspace by default. ${executionCopy.remote.description}`}
                />
              )}
              <PreferenceRow
                title="Sessions"
                subtitle="One session per thread"
              />
            </SettingsGroup>
            {settingsContent}
          </>
        )}
      </div>
    );
  };
}
