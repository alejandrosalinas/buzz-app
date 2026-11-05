import { useEffect, useRef, useState } from "react";
import { watchSlug } from "../../features/agents/attention";
import type {
  Agent,
  AgentAddedTab,
  Agents,
} from "../../features/agents/service";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { clearDefaultAgent } from "../../features/solo/default-agent";
import { BestieIcon } from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { bestieName, useBestieChoice } from "../agents/BestieChoice";
import {
  FEATURES,
  type Feature,
  featureState,
  restoredFeature,
} from "./features";
import {
  formerWithSettings,
  startHostedRead,
  subscribeHostedInstructions,
  subscribePrivateMembers,
} from "./former";
import { PrivateChannels } from "./PrivateChannels";
import {
  cannotEdit,
  type FeatureAgents,
  featureOn,
  instructionsOf,
  restoreFeature,
  saveFeature,
} from "./save";
import { inCommunity, savedBestie } from "./saved";

/** The agents a tab saves to, and finds to know which are remote. */
type TabAgents = FeatureAgents & Pick<Agents, "find">;

/** The Bestie tab, on the agent saved as Bestie in its community. */
export function bestieTab(relay: RelayData, agents: TabAgents): AgentAddedTab {
  const bestie = savedBestie(relay);
  return {
    id: "bestie",
    title: "Bestie",
    // Not on another device: its instructions can't be edited from here.
    when: (agent) =>
      (agent.place === "here" || agent.place === "hosted") &&
      agent.pubkey === bestie.snapshot() &&
      inCommunity(agent, relay.snapshot()),
    subscribe: bestie.subscribe,
    component: ({ agent }) => (
      <BestieTab relay={relay} agents={agents} agent={agent} />
    ),
  };
}

/** The Former Bestie tab, on an agent that was Bestie and still has
 * something on. It goes once the agent has nothing left on, and shows only
 * against the account's choice once read, another Bestie or none, as
 * check-ins stop. */
export function formerBestieTab(
  relay: RelayData,
  agents: TabAgents,
): AgentAddedTab {
  const bestie = savedBestie(relay);
  return {
    id: "former-bestie",
    title: "Former Bestie",
    when: (agent) => {
      const current = bestie.snapshot();
      const snapshot = relay.snapshot();
      // A hosted agent whose provider holds no instructions may still be in
      // private channels to take it out of; its memory switches say they
      // aren't available.
      return (
        (agent.place === "here" || agent.place === "hosted") &&
        (!!current || (bestie.known() && bestie.recorded())) &&
        !!snapshot.session.mainAgent &&
        agent.pubkey !== current &&
        inCommunity(agent, snapshot) &&
        formerWithSettings(agent, snapshot)
      );
    },
    subscribe(listener) {
      const stopBestie = bestie.subscribe(listener);
      const stopMembers = subscribePrivateMembers(relay, listener);
      const stopHosted = subscribeHostedInstructions(listener);
      return () => {
        stopBestie();
        stopMembers();
        stopHosted();
      };
    },
    component: ({ agent }) => (
      <BestieTab relay={relay} agents={agents} agent={agent} former />
    ),
  };
}

/** A hosted agent's instructions, as its provider holds them: read when the
 * tab opens, and again by `read` after each save. `shown` is the agent
 * carrying them as a local agent's config does; `hosted` is absent for an
 * agent that isn't hosted or whose provider offers none. */
function useHostedInstructions(agents: FeatureAgents, agent: Agent) {
  const capable =
    agent.place === "hosted" && !!agents.hostedInstructions?.(agent.pubkey);
  const [text, setText] = useState<{ text: string } | { error: string }>();
  // Only the latest read started shows: an earlier one ending later is old.
  const latest = useRef(0);
  const read = async (signal?: AbortSignal) => {
    const hosted = agents.hostedInstructions?.(agent.pubkey);
    if (!hosted) return;
    const order = ++latest.current;
    // Abandoned as soon as the tab closes, before its provider answers.
    const recording = startHostedRead(agent.pubkey, signal);
    try {
      const next = await hosted.get(signal);
      recording.read(next);
      if (order === latest.current) setText({ text: next });
    } catch (cause) {
      if (signal?.aborted) return;
      recording.failed();
      if (order === latest.current)
        setText({
          error: cause instanceof Error ? cause.message : String(cause),
        });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads again only for another agent
  useEffect(() => {
    if (!capable) return;
    setText(undefined);
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [agent.pubkey, capable]);
  if (!capable) return { shown: agent };
  const instructions = text && "text" in text ? text.text : undefined;
  return {
    shown:
      instructions === undefined
        ? agent
        : { ...agent, config: { instructions } },
    hosted: {
      loaded: instructions !== undefined,
      error: text && "error" in text ? text.error : undefined,
      read,
      retry() {
        setText(undefined);
        void read();
      },
    },
  };
}

function BestieTab({
  relay,
  agents,
  agent,
  former = false,
}: {
  relay: RelayData;
  agents: TabAgents;
  agent: Agent;
  former?: boolean;
}) {
  const { session, scope } = useRelayConnection(relay);
  // A remote agent is asked about before it is made Bestie.
  const bestie = useBestieChoice(
    session,
    scope ?? "",
    (pubkey) => agents.find(pubkey)?.place,
  );
  // One save at a time: each switch saves from the instructions it shows.
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { shown, hosted } = useHostedInstructions(agents, agent);
  const others = bestie.choices.selectable.filter(
    (choice) => choice.pubkey !== agent.pubkey,
  );
  const name = agent.name || "This agent";
  const switches = (features: readonly Feature[]) =>
    features.map((feature) => (
      <FeatureSwitch
        key={feature.id}
        agents={agents}
        agent={shown}
        hosted={hosted}
        session={session}
        feature={feature}
        former={former}
        saving={saving}
        setSaving={setSaving}
      />
    ));
  return (
    // Its own size container: rows wrap their buttons to the panel's width,
    // as each agent type's settings form does, and nothing widens the tab.
    <div className="grid gap-6 [container-type:inline-size]">
      <SettingsGroup>
        {former ? (
          <PreferenceRow
            icon={<BestieIcon size="1rem" />}
            title={`${name} is no longer your Bestie. These are still on.`}
            trailing={
              <Button
                variant="outline"
                disabled={
                  !bestie.choices.selectable.some(
                    (choice) => choice.pubkey === agent.pubkey,
                  )
                }
                onClick={() => bestie.make(agent.pubkey)}
              >
                Make my Bestie again
              </Button>
            }
          />
        ) : (
          <PreferenceRow
            icon={<BestieIcon size="1rem" />}
            title="This is your Bestie"
            subtitle="It's pinned at the top of Buzz, with your DM as its home."
            trailing={
              <MenuRoot>
                <MenuTrigger
                  disabled={!others.length}
                  render={<Button variant="outline">Change</Button>}
                />
                <MenuPopup align="end">
                  <MenuGroup>
                    <MenuGroupLabel>Make your Bestie</MenuGroupLabel>
                    {others.map((choice) => (
                      <MenuItem
                        key={choice.pubkey}
                        onClick={() => bestie.make(choice.pubkey)}
                      >
                        {bestieName(choice)}
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </MenuRoot>
            }
          />
        )}
        {/* Without an account to save none to, this device would pick
            another agent at once. */}
        {!former && session.mainAgent && (
          <PreferenceRow
            title="Remove as Bestie"
            subtitle="Have no Bestie until you make one again."
            trailing={(label) => (
              <Button
                variant="outline"
                aria-describedby={label["aria-labelledby"]}
                onClick={() => setRemoving(true)}
              >
                Remove
              </Button>
            )}
          />
        )}
      </SettingsGroup>
      <InlineHeader title="Settings" />
      <SettingsGroup>
        {switches(FEATURES.filter((feature) => !feature.timer))}
      </SettingsGroup>
      <InlineHeader title="Check-ins" />
      <SettingsGroup>
        {switches(FEATURES.filter((feature) => feature.timer))}
      </SettingsGroup>
      <PrivateChannels
        session={session}
        bestie={agent.pubkey}
        {...(former && { former: name })}
      />
      {bestie.view}
      {removing && (
        <RemoveBestie
          name={name}
          remove={() => clearDefaultAgent(session, scope ?? "")}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  );
}

/** Asks before the agent stops being Bestie, then saves no Bestie. The tab
 * goes with it; the agent then shows Former Bestie while a setting is on. */
function RemoveBestie({
  name,
  remove,
  onClose,
}: {
  name: string;
  remove(): Promise<void>;
  onClose(): void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Remove ${name} as your Bestie?`}
      description={`${name} stays in Agents, with your chats in your DMs. Its check-ins stop. Its memory rules and private channels stay; turn them off in its Former Bestie tab.`}
      initialFocus={keep}
      pending={pending}
      onClose={onClose}
      {...(error && { children: <p role="alert">{error}</p> })}
      actions={
        <>
          <Button ref={keep} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            onClick={() => {
              setPending(true);
              setError("");
              remove()
                .then(onClose)
                .catch((cause: unknown) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                )
                .finally(() => setPending(false));
            }}
          >
            Remove as Bestie
          </Button>
        </>
      }
    />
  );
}

/** A feature's switch. Off also turns off the features that require this
 * one. On a former Bestie, check-ins can only be turned off. A section edited
 * by hand where it starts or ends shows that instead, with Restore when what
 * is left of its markers shows where it was. */
function FeatureSwitch({
  agents,
  agent,
  hosted,
  session,
  feature,
  former,
  saving,
  setSaving,
}: {
  agents: FeatureAgents;
  agent: Agent;
  /** A hosted agent's instructions, which are read through its provider. */
  hosted: ReturnType<typeof useHostedInstructions>["hosted"];
  session: RelaySession;
  feature: Feature;
  former: boolean;
  saving: boolean;
  setSaving(saving: boolean): void;
}) {
  const [error, setError] = useState<string>();
  const problem = cannotEdit(agents, agent, feature);
  if (problem)
    return <PreferenceRow title={feature.title} subtitle={problem} />;
  if (hosted && !hosted.loaded)
    return (
      <PreferenceRow
        title={feature.title}
        subtitle={hosted.error ?? "Reading its instructions…"}
        trailing={
          hosted.error ? (
            <Button variant="outline" onClick={hosted.retry}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  const instructions = instructionsOf(agent);
  const timer = feature.timer && agent.attention[watchSlug(feature.timer.id)];
  const required = FEATURES.find(({ id }) => id === feature.requires);
  const blocked = !!required && !featureOn(agent, required);
  const checked = featureOn(agent, feature);
  const formerCheckIn = former && !!feature.timer;
  const run = async (task: () => Promise<void>) => {
    setSaving(true);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // The provider's copy is the one the switch shows next, after a failed
      // save too: one refused as changed elsewhere then shows the change.
      await hosted?.read();
      setSaving(false);
    }
  };
  const save = (on: boolean) =>
    run(async () => {
      // The owner's 1:1 DM with the agent: opening it is idempotent.
      const channel =
        on && feature.timer
          ? await session.directMessages.open(
              [agent.pubkey],
              AbortSignal.timeout(30_000),
            )
          : undefined;
      await saveFeature(agents, agent, feature, on, {
        ...(channel && { channel }),
      });
    });
  const alert = error && (
    <p role="alert" className="buzz-field-error">
      {error}
    </p>
  );
  if (featureState(instructions, feature) === "edited") {
    const restorable =
      !formerCheckIn && restoredFeature(instructions, feature) !== undefined;
    return (
      <>
        <PreferenceRow
          title={feature.title}
          subtitle={
            restorable
              ? "Its section in Instructions was edited where it starts or ends. Restore puts back the original section."
              : "Its section in Instructions was edited where it starts or ends. Fix its start and end lines there."
          }
          trailing={
            restorable ? (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() =>
                  void run(() => restoreFeature(agents, agent, feature))
                }
              >
                Restore
              </Button>
            ) : undefined
          }
        />
        {alert}
      </>
    );
  }
  return (
    <>
      <SwitchPreferenceRow
        label={feature.title}
        description={
          formerCheckIn
            ? "Only your Bestie checks in."
            : blocked && required && !checked
              ? `Turn on ${required.title} first.`
              : // Paused on its own in the Attention tab, which can't resume a
                // timer: saving it again here does.
                checked && timer?.value.type === "timer" && !timer.value.enabled
                ? `Paused in Attention. Turn ${feature.title} off and on again to restart it.`
                : // Attention reads off while no plugin shows it, as when the
                  // Watching plugin is off, or while the agent's switch is off.
                  checked && feature.timer && !agent.attentionEnabled
                  ? "Paused: watches aren't running on this device. Turn on the Watching plugin and its Run watches switch."
                  : feature.description
        }
        checked={checked}
        // One left on can still be turned off.
        disabled={saving || ((blocked || formerCheckIn) && !checked)}
        onCheckedChange={(on) => void save(on)}
      />
      {/* A timer left without its section, as when undoing a failed On
          failed too, still runs: Remove takes it away. */}
      {timer && !checked && (
        <PreferenceRow
          title={`${feature.title}'s timer is still saved`}
          subtitle="Its section in Instructions is missing, so it reads as off."
          trailing={(label) => (
            <Button
              variant="outline"
              aria-describedby={label["aria-labelledby"]}
              disabled={saving}
              onClick={() => void save(false)}
            >
              Remove
            </Button>
          )}
        />
      )}
      {alert}
    </>
  );
}
