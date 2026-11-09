import * as React from "react";
import { attentionOf, type WatchObject } from "../../features/agents/attention";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import {
  LightningIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { AttentionStatus } from "./AttentionStatus";
import { Switch as SharedSwitch } from "../../shared/design-system/ui/Switch";
import type { Context } from "../../plugins/author";
import type { Agent } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { InstructionsMarkdown, OpenLink } from "./InstructionsMarkdown";
import { title, heading, type Channel } from "./presentation";
import { problem, useAction } from "./actions";
import { AttentionSonar } from "./AttentionSonar";
import { AttentionEmptyState } from "./AttentionEmptyState";
import { createWatchComponents } from "./WatchRow";
export { heading, describe } from "./presentation";
import "./AttentionPage.css";

const button = { variant: "ghost" as const, size: "sm" as const };
/** The watches of an Interest that this app skipped, such as ones over the
 * limit. They still belong to it. */
const skippedWatches = (agent: Agent, id: string) =>
  Object.values(agent.skipped ?? {}).filter(
    (object) =>
      (object.value as { interest_id?: unknown } | null)?.interest_id === id,
  );
/** Uses the host’s controls and surface roles. */
export function createAttentionComponents({
  agents,
  relay,
  navigation,
}: Pick<Context, "agents" | "relay" | "navigation">) {
  const { Subscription, Destination, Message, Entry } = createWatchComponents({
    agents,
    navigation,
  });
  const none = () => () => {};
  const noChannels: { channels: readonly Channel[] } = { channels: [] };
  const emptyChannels = () => noChannels;
  function Switch({
    label,
    tooltip,
    checked,
    disabled,
    onClick,
  }: {
    label: string;
    tooltip?: string;
    checked: boolean;
    disabled: boolean;
    onClick(): void;
  }) {
    return (
      <SharedSwitch
        aria-label={label}
        title={tooltip || label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onClick}
      />
    );
  }
  function InterestStatus({
    agent,
    slug,
    label,
    hasWatches,
    returnFocus,
  }: {
    agent: Agent;
    slug: string;
    label: string;
    hasWatches: boolean;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const trigger = React.useRef<HTMLButtonElement>(null);
    const cancel = React.useRef<HTMLButtonElement>(null);
    const popup = React.useRef<HTMLDivElement>(null);
    const [confirming, setConfirming] = React.useState(false);
    const action = useAction();
    const remove = () =>
      action.run(async () => {
        const focused = document.activeElement;
        const expected = agent.attention[slug];
        if (!expected) throw new Error("This interest no longer exists.");
        const id = slug.slice("interest/".length);
        const watches = Object.values(agent.attention).filter(
          (object) =>
            object.value.type !== "interest" && object.value.interest_id === id,
        );
        // A watch skipped here, such as one over the limit, still belongs to
        // this Interest and could run once there is room for it.
        const skipped = skippedWatches(agent, id);
        await agents.save(agent.key, {
          attentionExpected: Object.fromEntries([
            ...watches.map((watch) => [watch.slug, watch]),
            [slug, expected],
          ]),
          attention: Object.fromEntries([
            ...[...watches, ...skipped].map((watch) => [watch.slug, null]),
            [slug, null],
          ]),
        });
        setConfirming(false);
        if (
          !trigger.current?.isConnected &&
          (document.activeElement === document.body ||
            document.activeElement === focused)
        )
          returnFocus.current?.focus();
      });
    React.useLayoutEffect(
      () => () => {
        if (
          trigger.current === document.activeElement ||
          popup.current?.contains(document.activeElement)
        )
          returnFocus.current?.focus();
      },
      [returnFocus],
    );
    return (
      <>
        <div className="attention-actions">
          <AttentionStatus
            name={label}
            heading="Interest"
            triggerRef={trigger}
            popupRef={popup}
            deleteConfirms={hasWatches}
            returnFocus={returnFocus}
            label={`Interest status for ${label}`}
            active={
              agent.attention[slug]?.value.type === "interest" &&
              agent.attention[slug]?.value.paused !== true
            }
            pending={action.pending}
            onChange={(active) =>
              void action.run(async () => {
                const expected = agent.attention[slug];
                const value = expected?.value;
                if (!expected || value?.type !== "interest")
                  throw new Error("This interest no longer exists.");
                await agents.save(agent.key, {
                  attentionExpected: { [slug]: expected },
                  attention: { [slug]: { ...value, paused: !active } },
                });
              })
            }
            onDelete={() => (hasWatches ? setConfirming(true) : void remove())}
          />
        </div>
        {confirming && (
          <AlertDialog
            title={`Delete ${label}?`}
            description="This deletes the interest and all its watches. The agent will stop watching for these triggers. This cannot be undone."
            pending={action.pending}
            initialFocus={cancel}
            finalFocus={() =>
              trigger.current?.isConnected
                ? trigger.current
                : (returnFocus.current ?? false)
            }
            onClose={() => setConfirming(false)}
            actions={
              <>
                <Button
                  ref={cancel}
                  disabled={action.pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  loading={action.pending}
                  onClick={() => void remove()}
                >
                  Delete
                </Button>
              </>
            }
          >
            {problem(action.error)}
          </AlertDialog>
        )}
        {!confirming && problem(action.error)}
      </>
    );
  }
  function Instructions({ instructions }: { instructions: string }) {
    const firstLine =
      instructions.split("\n").find((line) => line.trim()) || "";
    return (
      <details className="attention-instructions">
        <summary className="attention-disclosure text-body-sm text-subtle">
          <span className="attention-disclosure-icon">
            <LightningIcon size={16} aria-hidden={true} />
          </span>
          <span className="attention-instructions-preview">
            {
              heading(
                instructions
                  .split("\n")
                  .find((line) => line.trim() && !/^#+\s/.test(line)) ||
                  firstLine,
              ).text
            }
          </span>
          <CaretRightIcon size={16} aria-hidden={true} />
        </summary>
        <InstructionsMarkdown text={instructions} />
      </details>
    );
  }
  function Interest({
    object,
    subscriptions,
    agent,
    name,
    find,
    scope,
    session,
    returnFocus,
  }: {
    object: Agent["attention"][string];
    subscriptions: readonly WatchObject[];
    agent: Agent;
    name(id: string): string;
    find(id: string): Channel | undefined;
    scope?: string | undefined;
    session?: RelaySession | undefined;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const id = object.slug.slice("interest/".length);
    const interest = object.value;
    const instructions =
      interest?.type === "interest"
        ? interest.instructions
        : "No instructions saved.";
    const firstLine =
      instructions.split("\n").find((line) => line.trim()) || "";
    const label =
      (interest?.type === "interest" && interest.title) ||
      (/^#+\s/.test(firstLine) ? heading(firstLine).text : title(id));
    return (
      <SettingsGroup layout="cards">
        <section
          className="attention-interest"
          aria-label={`Interest ${label}`}
        >
          <div className="attention-interest-head">
            <h4 className="text-label">{label}</h4>
            <InterestStatus
              agent={agent}
              slug={object.slug}
              label={label}
              hasWatches={
                subscriptions.length > 0 || skippedWatches(agent, id).length > 0
              }
              returnFocus={returnFocus}
            />
          </div>
          {interest?.type === "interest" && interest.summary && (
            <p className="attention-interest-summary text-body-sm text-subtle">
              {interest.summary}
            </p>
          )}
          {subscriptions.length > 0 && (
            <div className="attention-column-headings text-caption text-subtle">
              <h5 className="text-caption">Triggers</h5>
              <span>Sources</span>
              <span>Responds in</span>
              <span>{"Status"}</span>
            </div>
          )}
          {!subscriptions.length && (
            <h5 className="attention-section-label text-caption text-subtle">
              Triggers
            </h5>
          )}
          {!subscriptions.length && (
            <p className="text-body-sm text-subtle">
              {"No watches yet, so nothing wakes this interest."}
            </p>
          )}
          <ul className="attention-list" aria-label={`${label} watches`}>
            {subscriptions.map((object) => (
              <Subscription
                key={object.slug}
                agent={agent}
                slug={object.slug}
                watch={object.value}
                name={name}
                find={find}
                scope={scope}
                session={session}
                returnFocus={returnFocus}
              />
            ))}
          </ul>
          <h5 className="attention-section-label text-caption text-subtle">
            Instructions
          </h5>
          <Instructions instructions={instructions} />
        </section>
      </SettingsGroup>
    );
  }
  function AgentPanel({
    agent,
    channels,
    scope,
    session,
    returnFocus,
  }: {
    agent: Agent;
    channels: readonly Channel[];
    scope?: string | undefined;
    session?: RelaySession | undefined;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const action = useAction();
    const find = (id: string) => channels.find((channel) => channel.id === id);
    const name = (id: string) => find(id)?.name ?? `Channel ${id.slice(0, 8)}`;
    const { interests, watches, orphans } = attentionOf(agent.attention);
    const skipped = Object.values(agent.skipped ?? {});
    const empty =
      !interests.length &&
      !watches.length &&
      !orphans.length &&
      !skipped.length;
    return (
      <div className="attention-agent">
        <SettingsGroup layout="cards">
          <section
            className="attention-setting"
            aria-label="Attention settings"
          >
            {!empty && (
              <AttentionSonar name={agent.name} picture={agent.picture} />
            )}
            <PreferenceRow
              title="Attention"
              subtitle={`Let ${agent.name} watch for updates and check in on a schedule. Runs while Buzz is open on this device.`}
            />
          </section>
        </SettingsGroup>
        {problem(action.error)}
        {skipped.map((object) => (
          <section key={object.slug} className="attention-card">
            <h4 className="text-label-sm">{object.slug}</h4>
            <p className="text-body-sm text-danger">{object.problem}</p>
            <Button
              {...button}
              type="button"
              disabled={action.pending}
              onClick={() =>
                void action.run(() =>
                  agents.save(agent.key, {
                    attention: { [object.slug]: null },
                  }),
                )
              }
            >{`Remove unreadable ${object.slug}`}</Button>
          </section>
        ))}
        {interests.map((object) => (
          <Interest
            key={object.slug}
            object={object}
            agent={agent}
            name={name}
            find={find}
            scope={scope}
            session={session}
            returnFocus={returnFocus}
            subscriptions={watches.filter(
              (watch) =>
                watch.value.interest_id ===
                object.slug.slice("interest/".length),
            )}
          />
        ))}
        {orphans.length > 0 && (
          <section className="attention-interest" aria-label="Stray watches">
            <h4 className="text-label">{"Stray watches"}</h4>
            <p className="text-body-sm text-subtle">
              {
                "These saved watches have no matching Interest. Remove them and create watches under an Interest."
              }
            </p>
            {orphans.map((object) => (
              <div key={object.slug} className="attention-agent-head">
                <span className="text-body-sm">{object.slug}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={action.pending}
                  onClick={() =>
                    void action.run(() =>
                      agents.save(agent.key, {
                        attention: { [object.slug]: null },
                      }),
                    )
                  }
                >{`Delete ${object.slug}`}</Button>
              </div>
            ))}
          </section>
        )}
        {empty && (
          <AttentionEmptyState name={agent.name} picture={agent.picture} />
        )}
      </div>
    );
  }
  function WatchingTab({
    agent: { key },
    open,
    canOpen,
  }: {
    agent: { key: string };
    open?: ((target: string) => boolean) | undefined;
    canOpen?: ((target: string) => boolean) | undefined;
  }) {
    const page = React.useRef<HTMLElement>(null);
    const snapshot = React.useSyncExternalStore(
      agents.subscribe,
      agents.snapshot,
      agents.snapshot,
    );
    const connection = React.useSyncExternalStore(
      relay.subscribe,
      relay.snapshot,
      relay.snapshot,
    );
    const queries =
      connection.status === "ready" ? connection.session.channels : undefined;
    React.useEffect(() => queries?.ensureList(), [queries]);
    const channels = React.useSyncExternalStore<{
      channels: readonly Channel[];
    }>(
      queries?.subscribeList ?? none,
      queries?.list ?? emptyChannels,
      queries?.list ?? emptyChannels,
    ).channels;
    const agent = snapshot.running.find((agent) => agent.key === key);
    const here = (() => {
      try {
        return (
          !!agent &&
          relayPartition(relayOrigin(agent.relay), agent.owner) ===
            connection.scope
        );
      } catch {
        return false;
      }
    })();
    return (
      <section
        data-buzz-ui=""
        className="attention-page"
        aria-label="Attention"
        ref={page}
        tabIndex={-1}
      >
        <div className="attention-content">
          {agent &&
            here &&
            snapshot.classifier !== "available" &&
            Object.values(agent.attention).some(
              ({ value }) => value.type === "event" && value.classifier,
            ) && (
              <p className="text-body-sm text-secondary">
                {
                  "This device can't run message filters, so every message in these channels wakes the agent."
                }
              </p>
            )}
          {agent && here ? (
            <OpenLink.Provider value={open && canOpen && { open, canOpen }}>
              <AgentPanel
                agent={agent}
                returnFocus={page}
                channels={channels}
                scope={connection.scope}
                session={connection.session}
              />
            </OpenLink.Provider>
          ) : (
            <p
              className="text-body-sm text-secondary"
              role={snapshot.status === "loading" ? "status" : undefined}
            >
              {!connection.scope
                ? "Choose a community to manage this agent's watches."
                : snapshot.status === "loading"
                  ? "Loading watches…"
                  : agent
                    ? "This agent belongs to another community. Switch to it to manage its watches."
                    : "This agent isn't running on this device."}
            </p>
          )}
        </div>
      </section>
    );
  }
  return {
    WatchingTab,
    AgentPanel,
    Interest,
    Instructions,
    Subscription,
    Destination,
    Message,
    Entry,
    InterestStatus,
    Switch,
  };
}

export function createTab(
  context: Pick<Context, "agents" | "relay" | "navigation">,
) {
  return createAttentionComponents(context).WatchingTab;
}
