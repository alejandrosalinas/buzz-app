import { pubkeyOf } from "../../features/agents/membership";
import { ownerReads } from "../../features/agents/reads";
import { MeshGoose } from "./meshGoose";
import { createMeshTranscriptTab } from "./MeshTranscriptTab";
import { MemoryReads, coreOf } from "../../features/agent-harness/core-memory";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";

import { EmbeddedActivity } from "./EmbeddedActivity";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ArrowSquareOutIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { CpuIcon } from "../../shared/design-system/icons";
import { ShareModelPicker } from "./ShareModelPicker";
import { CommunityMesh } from "./CommunityMesh";
import { ConsumerComputeView } from "./ConsumerComputeView";
import styles from "./Compute.module.css";

import { ComputeActivity, type ComputeActivityData } from "./ComputeActivity";
import { MeshAgentTab } from "./MeshAgentTab";
import { soloChat } from "../../features/agents/solo-chat";
import { MeshHelpers } from "./MeshHelpers";
import { MeshCreateSetup } from "./MeshCreateSetup";
import {
  DEFAULT_MESH_AGENT_CONFIG,
  type MeshAgentConfig,
  MeshAgentRuntime,
  type PreparedInference,
} from "./meshAgent";

export type MeshStatus = {
  activity?: ComputeActivityData | null;
  modelReady?: boolean;
  finishingJoin?: boolean;
  boundCommunity?: string | null;
  // Configured intent, not proof of serving; lifecycle supplies the actual phase.
  sharing?: string | null;
  savedSharing?: { model: string; enabled: boolean; auto?: boolean } | null;
  settingsError?: string | null;
  download?: {
    label: string;
    file: string | null;
    downloadedBytes: number | null;
    totalBytes: number | null;
    done: boolean;
  } | null;
  lifecycle?: {
    state: "stopped" | "starting" | "ready" | "stopping" | "failed";
    reason?: string;
  };
  reason?: string;
};
export const inject = [
  "relay",
  "settingsCards",
  "communityReader",
  "agents",
  "host",
];

// Settles when the most recent Share action has fully finished, so tests can
// prove a retired action completed instead of waiting an arbitrary tick.
let lastShareAction: Promise<void> = Promise.resolve();
export const shareActionSettled = () => lastShareAction;
// The native widget is one app window, including across plugin reloads.
let widgetQueue: Promise<unknown> = Promise.resolve();
export const apply: PluginModule["apply"] = (ctx) => {
  let lease: Promise<string | undefined> | undefined;
  let scope: string | undefined;
  let viewer: string | undefined;
  let disposed = false;
  const openWidget = () => {
    widgetQueue = widgetQueue
      .catch(() => {})
      .then(() => (disposed ? undefined : invoke("mesh_compute_widget_open")));
    return widgetQueue;
  };
  let selectionQueue: Promise<unknown> = Promise.resolve();
  const select = (
    community: string,
    restoreSharing = true,
    replaceExisting = false,
  ) => {
    const selected = selectionQueue
      .catch(() => {})
      .then(async () => {
        return invoke<string>("mesh_compute_select", {
          community,
          restoreSharing,
          ...(replaceExisting ? { replaceExisting: true } : {}),
        });
      });
    selectionQueue = selected;
    return selected;
  };
  const release = (old: Promise<string | undefined> | undefined) => {
    void old
      ?.then((lease) =>
        lease ? invoke("mesh_compute_release", { lease }) : undefined,
      )
      .catch(() => {});
  };
  // A rejected selection must not strand every later action behind a dead
  // promise: retry the current community once, then surface the real error.
  const currentLease = async () => {
    const selected = lease;
    if (!selected) throw new Error("Connect to a community first");
    try {
      return { selected, id: await selected };
    } catch (error) {
      if (!scope || selected !== lease) throw error;
      // Recovery for an action must never restore (start) saved sharing first.
      const retry = select(scope, false);
      lease = retry;
      return { selected: retry, id: await retry };
    }
  };
  const sync = () => {
    const snapshot = ctx.relay.snapshot();
    const account = ctx.communityReader.snapshot();
    const identityChanged = viewer !== undefined && account.viewer !== viewer;
    if (snapshot.status !== "ready" && !identityChanged) return;
    if (identityChanged) {
      release(lease);
      lease = undefined;
      scope = undefined;
    }
    viewer = account.viewer;
    const next =
      snapshot.status === "ready" &&
      snapshot.viewer === viewer &&
      snapshot.viewer &&
      snapshot.scope?.endsWith(`:${snapshot.viewer}`)
        ? snapshot.scope.slice(0, -(snapshot.viewer.length + 1))
        : undefined;
    // Foreground navigation is not permission to move the app-owned compute.
    if (scope && !identityChanged) return;
    if (next === scope) return;
    scope = next;
    const old = lease;
    lease = isTauri() && next ? select(next) : undefined;
    void lease?.catch(() => {});
    release(old);
  };
  sync();
  const unsubscribe = ctx.relay.subscribe(sync);
  const unsubscribeAccount = ctx.communityReader.subscribe(sync);
  ctx.effect(() => () => {
    disposed = true;
    unsubscribe();
    unsubscribeAccount();
    if (isTauri()) {
      widgetQueue = widgetQueue
        .catch(() => {})
        .then(() => invoke("mesh_compute_widget_close"))
        .catch(() => {});
    }
    release(lease);
    lease = undefined;
  });

  // Agents "Shared Compute" type: inference through shared compute only.
  const spawn = ctx.host?.spawn?.bind(ctx.host);
  const resolveDirectory = ctx.host?.resolveDirectory?.bind(ctx.host);
  const serve = ctx.host?.serveMcp?.bind(ctx.host);
  if (isTauri() && spawn && resolveDirectory && serve && ctx.agents) {
    const agents = ctx.agents;
    const memoryReads = new MemoryReads();
    const readMemory = async (
      agent: string,
      signal: AbortSignal,
      slug?: string,
    ) => {
      const snapshot = agents.relay(agent)?.snapshot();
      if (snapshot?.status !== "ready")
        throw new Error("Buzz is not connected to this community");
      const source = ownerReads(agents.relay(agent), pubkeyOf(agent));
      if (!source) throw new Error("Buzz is not connected to this community");
      const listing = await memoryReads.read(source, agent, signal, slug);
      if (agents.relay(agent)?.snapshot() !== snapshot)
        throw new Error("Community changed during memory read");
      return listing;
    };
    const inline = new MeshGoose({
      spawn,
      resolveDirectory,
      serve,
      current: (lease) =>
        invoke<boolean>("mesh_compute_inference_current", { lease }),
      memories: readMemory,
      remembered: (agent) => {
        const snapshot = agents.relay(agent)?.snapshot();
        if (snapshot?.status === "ready")
          memoryReads.forget(snapshot.session, agent);
      },
    });
    const runtime = new MeshAgentRuntime({
      inline,
      spawn,
      resolveDirectory,
      origin: (agent) => agents.relay(agent)?.snapshot().origin,
      prepare: (relay) =>
        invoke<PreparedInference>("mesh_compute_prepare_inference", {
          relay,
          model: "auto",
        }),
      current: (lease) =>
        invoke<boolean>("mesh_compute_inference_current", { lease }),
      chat: (inference, messages) =>
        invoke<string>("mesh_compute_chat", {
          lease: inference.lease,
          model: inference.model,
          messages,
        }),
      meChat: (agent, channelId, signal) =>
        soloChat(() => agents.relay(agent.key), agent.owner, channelId, signal),
      dm: (agent, channelId) => {
        const snapshot = agents.relay(agent)?.snapshot();
        return (
          snapshot?.status === "ready" &&
          snapshot.session.channels
            .list()
            .channels.find((row) => row.id === channelId)?.channelType === "dm"
        );
      },
      memories: readMemory,
      coreMemory: async (agent, signal) => {
        try {
          return coreOf(await readMemory(agent, signal));
        } catch (error) {
          signal.throwIfAborted();
          console.warn("Mesh could not read the agent's memory", error);
          return undefined;
        }
      },
      remembered: (agent) => {
        const snapshot = agents.relay(agent)?.snapshot();
        if (snapshot?.status === "ready")
          memoryReads.forget(snapshot.session, agent);
      },
    });
    ctx.effect(() => () => runtime.dispose());
    agents.register<MeshAgentConfig>({
      id: "mesh",
      title: "Shared Compute",
      description:
        "Runs on this community's shared compute: plain chat, or goose with shell, file and Buzz tools.",
      defaults: () => ({ config: DEFAULT_MESH_AGENT_CONFIG }),
      summary: () => "Shared compute",
      Create: ({ disabled }) => (
        <CommunityComputePage setupOnly disabled={disabled} />
      ),
      tabs: [
        { id: "prompt", title: "Settings", component: MeshAgentTab },
        {
          id: "transcript",
          title: "Transcripts",
          component: createMeshTranscriptTab(inline),
        },
      ],
      // Covers compute startup (native waits up to 120s) plus one reply.
      timeoutMs: 5 * 60_000,
      // Keep queued mentions in the host until their own deadline starts.
      run: (delivery) => runtime.run(delivery),
    });
  }

  function CommunityComputePage({
    community,
    setupOnly = false,
    disabled = false,
  }: {
    community?: { id: string; name: string };
    setupOnly?: boolean;
    disabled?: boolean;
  }) {
    const snapshot = useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const [status, setStatus] = useState<MeshStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      let active = true;
      if (isTauri() && status?.sharing)
        void openWidget().catch((reason) => {
          if (active && !disposed)
            setError(`Couldn’t open activity widget: ${String(reason)}`);
        });
      return () => {
        active = false;
      };
    }, [status?.sharing]);
    useEffect(() => {
      let active = true;
      setStatus(null);
      setError(null);
      if (isTauri()) {
        const selected = lease;
        // A rejected selection still shows authoritative status and its error;
        // the next action retries the selection.
        void (selected ?? Promise.resolve())
          .catch((reason) => {
            if (active && snapshot === ctx.relay.snapshot())
              setError(String(reason));
          })
          .then(() => invoke<MeshStatus>("mesh_compute_status"))
          .then(
            (result) => {
              if (active && snapshot === ctx.relay.snapshot())
                setStatus(result);
            },
            (error) => {
              if (active && snapshot === ctx.relay.snapshot())
                setError(String(error));
            },
          );
      }
      return () => {
        active = false;
      };
    }, [snapshot]);
    const [busy, setBusy] = useState(false);
    // One page Refresh also rereads the community list (no second Refresh).
    const [refreshCount, setRefreshCount] = useState(0);
    // Controls wait for this community's selection instead of rejecting clicks.
    const [leaseReady, setLeaseReady] = useState(false);
    // biome-ignore lint/correctness/useExhaustiveDependencies: lease follows the relay snapshot.
    useEffect(() => {
      let active = true;
      const selected = lease;
      setLeaseReady(!selected);
      void selected?.then(
        (id) => {
          if (active) setLeaseReady(Boolean(id));
        },
        () => {
          // A rejected selection is retried by the next action.
          if (active) setLeaseReady(true);
        },
      );
      return () => {
        active = false;
      };
    }, [snapshot.viewer, snapshot.scope]);
    const [replaceConfirmed, setReplaceConfirmed] = useState(false);
    const viewedCommunity =
      snapshot.status === "ready" && snapshot.viewer && snapshot.scope
        ? snapshot.scope.slice(0, -(snapshot.viewer.length + 1))
        : undefined;
    const boundCommunity = status?.boundCommunity ?? null;
    const otherCommunity = Boolean(
      viewedCommunity && boundCommunity && viewedCommunity !== boundCommunity,
    );
    const replace = async () => {
      if (!viewedCommunity || busy) return;
      setBusy(true);
      setError(null);
      const previousLease = lease;
      try {
        lease = select(viewedCommunity, false, true);
        await lease;
        scope = viewedCommunity;
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setStatus(await invoke<MeshStatus>("mesh_compute_status"));
          setReplaceConfirmed(false);
        }
      } catch (error) {
        lease = previousLease;
        setError(String(error));
      } finally {
        setBusy(false);
      }
    };
    const [model, setModel] = useState("");
    const [auto, setAuto] = useState(true);
    const [recommended, setRecommended] = useState<string | null>(null);
    const [modelNames, setModelNames] = useState<Record<string, string>>({});
    // biome-ignore lint/correctness/useExhaustiveDependencies: identity and community changes retire the prior model selection.
    useEffect(() => {
      setModel("");
      setAuto(true);
      setRecommended(null);
    }, [snapshot.viewer, snapshot.scope]);
    useEffect(() => {
      if (status?.savedSharing?.model) {
        setModel(status.savedSharing.model);
        setAuto(status.savedSharing.auto ?? false);
      }
    }, [status?.savedSharing?.model, status?.savedSharing?.auto]);
    const reset = async () => {
      setBusy(true);
      setError(null);
      try {
        const { selected, id } = await currentLease();
        if (!id) throw new Error("Mesh native runtime is unavailable");
        if (disposed || selected !== lease)
          throw new Error("Community changed");
        await invoke("mesh_compute_share", {
          lease: id,
          model: null,
          maxVramGb: null,
          auto: true,
          resetOnly: true,
        });
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setStatus(result);
          setAuto(true);
        }
      } catch (reason) {
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setError(String(reason));
          const result = await invoke<MeshStatus>("mesh_compute_status").catch(
            () => null,
          );
          if (result && !disposed && snapshot === ctx.relay.snapshot())
            setStatus(result);
        }
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    const share = (clearSaved = false, startAuto = false) => {
      const action = runShare(clearSaved, startAuto);
      lastShareAction = action;
      return action;
    };
    const runShare = async (clearSaved: boolean, startAuto: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const turningOff = clearSaved || Boolean(status?.sharing);
        // Capture the operation's owner before awaiting; identity or community
        // changes while waiting retire this action.
        const community = scope;
        const owner = viewer;
        const current = () =>
          !disposed &&
          snapshot === ctx.relay.snapshot() &&
          scope === community &&
          viewer === owner;
        let selected: Promise<string | undefined> | undefined;
        let id: string | undefined;
        try {
          ({ selected, id } = await currentLease());
        } catch (reason) {
          // Without a lease (e.g. an unrecovered failed runtime blocks selection),
          // Off still clears saved consent; it never starts or stops Mesh.
          if (!turningOff || !community || !owner || !current()) throw reason;
          await invoke("mesh_compute_disarm", {
            community,
            expectedViewer: owner,
          });
          const result = await invoke<MeshStatus>("mesh_compute_status");
          if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
          return;
        }
        if (!id) throw new Error("Mesh native runtime is unavailable");
        if (!current() || selected !== lease)
          throw new Error("Community changed");
        if (startAuto) {
          const latest = await invoke<MeshStatus>("mesh_compute_status");
          if (!current() || selected !== lease)
            throw new Error("Community changed");
          if (latest.boundCommunity !== viewedCommunity)
            throw new Error(
              "Open Shared compute settings to switch communities first",
            );
          // A second creation view must not replace sharing started elsewhere.
          if (latest.sharing) {
            setStatus(latest);
            return;
          }
        }
        await invoke("mesh_compute_share", {
          lease: id,
          model: startAuto
            ? "auto"
            : clearSaved || status?.sharing
              ? null
              : auto
                ? (recommended ?? model)
                : model,
          maxVramGb: null,
          auto: startAuto || auto,
        });
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
      } catch (error) {
        if (!disposed && snapshot === ctx.relay.snapshot()) {
          setError(String(error));
          // Share Off may clear intent even when shutdown fails.
          const result = await invoke<MeshStatus>("mesh_compute_status").catch(
            () => null,
          );
          if (result && !disposed && snapshot === ctx.relay.snapshot())
            setStatus(result);
        }
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    const refresh = async () => {
      setRefreshCount((value) => value + 1);
      setBusy(true);
      setError(null);
      try {
        const result = await invoke<MeshStatus>("mesh_compute_status");
        if (!disposed && snapshot === ctx.relay.snapshot()) setStatus(result);
      } catch (error) {
        if (!disposed && snapshot === ctx.relay.snapshot())
          setError(String(error));
      } finally {
        if (!disposed) setBusy(false);
      }
    };
    const phase = status?.lifecycle?.state;
    // Saved consent and live intent, not runtime health.
    const shareOn = Boolean(status?.sharing || status?.savedSharing?.enabled);
    useEffect(() => {
      if (
        busy ||
        error ||
        (status?.lifecycle?.state !== "starting" &&
          status?.lifecycle?.state !== "stopping" &&
          status?.lifecycle?.state !== "ready")
      )
        return;
      let active = true;
      const timer = setTimeout(
        () => {
          void invoke<MeshStatus>("mesh_compute_status").then(
            (result) => {
              if (active && !disposed && snapshot === ctx.relay.snapshot())
                setStatus(result);
            },
            (reason) => {
              if (active && !disposed && snapshot === ctx.relay.snapshot())
                setError(String(reason));
            },
          );
        },
        status?.lifecycle?.state === "ready" && !status.sharing ? 5000 : 1000,
      );
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [status, busy, error, snapshot]);
    if (setupOnly)
      return (
        <MeshCreateSetup
          status={status}
          busy={busy}
          disabled={disabled || snapshot.status !== "ready"}
          leaseReady={leaseReady}
          otherCommunity={otherCommunity}
          error={error}
          share={() => void share(false, true)}
          refresh={() => void refresh()}
        />
      );
    return (
      <ConsumerComputeView
        headerControl={
          isTauri() && status && !otherCommunity ? (
            <div className={styles.sharingControl}>
              <Switch
                aria-label="Share compute"
                checked={shareOn}
                onCheckedChange={(next) => {
                  if (next) void share();
                  else void share(!status.sharing);
                }}
                disabled={
                  busy ||
                  !leaseReady ||
                  // On may replace a connecting consumer; Off may cancel startup.
                  // Native teardown must finish before another transition.
                  phase === "stopping" ||
                  snapshot.status !== "ready" ||
                  (!shareOn && (phase === "failed" || (!auto && !model.trim())))
                }
              />
            </div>
          ) : undefined
        }
        status={
          !isTauri()
            ? "Open Buzz desktop to use shared compute."
            : !status
              ? "Checking shared compute…"
              : leaseReady
                ? shareStatus(status, phase, community?.name, modelNames)
                : "Checking shared compute…"
        }
        error={error ?? status?.settingsError ?? status?.reason}
        attention={
          !isTauri() ||
          phase === "failed" ||
          Boolean(
            status?.savedSharing?.enabled &&
              !status.sharing &&
              phase !== "starting",
          )
        }
        refreshDisabled={busy || !isTauri()}
        refresh={() => void refresh()}
      >
        {community?.name &&
          (status?.sharing && !otherCommunity ? (
            <p className="m-0 text-body">
              Sharing{" "}
              <strong title={status.sharing}>
                {modelNames[status.sharing] ?? status.sharing}
              </strong>{" "}
              with <strong>{community.name}</strong>
            </p>
          ) : (
            <p className="m-0 text-body-sm text-secondary">
              Shared compute for <strong>{community.name}</strong>
            </p>
          ))}
        {otherCommunity && (
          <section aria-label="Bound compute community">
            <p>
              {status?.sharing ? "Sharing" : "Compute connected"} in{" "}
              {boundCommunity}. Navigation does not move it.
            </p>
            {replaceConfirmed ? (
              <>
                <p>
                  Stop that community’s local Mesh agents and compute before
                  switching to {viewedCommunity}?
                </p>
                <Button disabled={busy} onClick={() => void replace()}>
                  Stop agents and switch compute
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setReplaceConfirmed(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => setReplaceConfirmed(true)}>
                Use compute in this community instead
              </Button>
            )}
          </section>
        )}
        {isTauri() && status && !otherCommunity && (
          <section aria-label="Share compute">
            <p className="m-0 text-body-sm text-secondary">
              Let {community?.name ?? "this community"} run prompts on this
              machine. Auto picks the best model for your hardware; you can also
              choose one. Members serving your helper’s model can read its
              prompts, conversation history and, in Agent mode, tool output and
              core memory. Sharing resumes when you reopen Buzz.
            </p>
            {status.sharing && status.download && !status.download.done && (
              <DownloadProgress download={status.download} />
            )}
            <ShareModelPicker
              activity={
                <div className={styles.widgetOverview}>
                  <div className={styles.widgetCard}>
                    <EmbeddedActivity
                      key={snapshot.scope}
                      data={status.activity ?? null}
                      sharing={Boolean(status.sharing)}
                      state={
                        phase === "ready"
                          ? status.modelReady
                            ? "running"
                            : "starting"
                          : (phase ?? "stopped")
                      }
                    />
                    <div className={styles.widgetPopout}>
                      <IconButton
                        size="xs"
                        aria-label="Open activity widget"
                        title="Open activity widget"
                        icon={<ArrowSquareOutIcon size={16} />}
                        variant="subtle"
                        disabled={!status.sharing}
                        onClick={() => {
                          setError(null);
                          void openWidget().catch((reason) => {
                            if (!disposed)
                              setError(
                                `Couldn’t open activity widget: ${String(reason)}`,
                              );
                          });
                        }}
                      />
                    </div>
                  </div>
                </div>
              }
              model={model}
              auto={auto}
              onRecommendation={setRecommended}
              onModelNames={setModelNames}
              runningModel={status.sharing ?? null}
              onReset={() => void reset()}
              resetDisabled={busy || snapshot.status !== "ready"}
              onChange={(value) => {
                setModel(value);
                setAuto(false);
              }}
              disabled={
                busy ||
                phase === "starting" ||
                phase === "stopping" ||
                Boolean(status.sharing)
              }
            />
          </section>
        )}
        {isTauri() &&
          status &&
          community &&
          ctx.agents &&
          snapshot.status === "ready" &&
          snapshot.origin && (
            <MeshHelpers
              key={`${snapshot.origin}:${snapshot.viewer}`}
              agents={ctx.agents}
            />
          )}
        {isTauri() &&
          status &&
          (community || (phase === "ready" && !otherCommunity)) && (
            <Accordion
              variant="settings"
              items={[
                {
                  value: "Community and activity",
                  title: "Community and activity",
                  content: (
                    <>
                      {phase === "ready" && !otherCommunity && (
                        <ComputeActivity data={status.activity ?? null} />
                      )}
                      {community && (
                        <CommunityMesh
                          key={community.id}
                          community={community.id}
                          relay={ctx.relay}
                          refreshKey={refreshCount}
                        />
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
      </ConsumerComputeView>
    );
  }
  ctx.settingsCards.register({
    id: "mesh",
    title: "Shared compute",
    icon: CpuIcon,
    component: CommunityComputePage,
  });
};

/** One status line in the style of the original Compute page. */
function shareStatus(
  status: MeshStatus,
  phase: string | undefined,
  communityName: string | undefined,
  modelNames: Record<string, string> = {},
): string {
  const where = communityName ?? "your community";
  const model =
    status.sharing && (modelNames[status.sharing] ?? status.sharing);
  const enabled = Boolean(model || status.savedSharing?.enabled);
  if (phase === "failed") {
    const cause = status.lifecycle?.reason
      ? ` ${status.lifecycle.reason}.`
      : "";
    return enabled
      ? `Mesh needs recovery.${cause} Sharing is still enabled for next launch; turn it off to disable automatic sharing. Restart Buzz before starting Mesh again.`
      : `Mesh needs recovery.${cause} Shutdown could not be confirmed. Restart Buzz before starting Mesh again.`;
  }
  if (phase === "stopping")
    return status.finishingJoin
      ? "Stopping, finishing a peer connection…"
      : "Stopping…";
  if (!model) {
    if (status.savedSharing?.enabled)
      return "Sharing is enabled but not running. Turn it off and on to start it again.";
    // Consumer-only node (started for agents): Thomas's "connected" wording.
    if (phase === "starting")
      return "Sharing is off. Connecting to community compute…";
    if (phase === "ready")
      return "Sharing is off. Connected to community compute.";
    return "Sharing is off.";
  }
  if (phase === "starting") return `Starting ${model}…`;
  if (phase === "ready")
    return status.modelReady
      ? `Sharing ${model} with ${where}.`
      : `Preparing ${model} — not serving yet.`;
  return `Selected for sharing: ${model}`;
}

function DownloadProgress({
  download,
}: {
  download: NonNullable<MeshStatus["download"]>;
}) {
  const received = download.downloadedBytes ?? 0;
  const total = download.totalBytes ?? 0;
  const percent =
    total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined;
  return (
    <div>
      <progress
        aria-label="Model download"
        max={100}
        value={percent}
        className="w-full"
      />
      <span className="text-body-sm text-secondary">
        {`Downloading ${download.file ?? download.label}`}
        {percent === undefined
          ? "…"
          : ` · ${percent}% (${(received / 1e9).toFixed(2)} GB / ${(total / 1e9).toFixed(2)} GB)`}
      </span>
    </div>
  );
}
