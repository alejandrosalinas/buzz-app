import { interestPaused } from "../../features/agents/attention";
import * as React from "react";
import type { Context } from "../../plugins/author";
import type { Agent, Watch } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { sourceCompleted } from "../../features/agents/attention";
import {
  ChatCircleIcon,
  GearIcon,
  HashIcon,
  ClockIcon,
  TerminalWindowIcon,
  CodeIcon,
  ArrowSquareOutIcon,
  CaretRightIcon,
  CircleIcon,
} from "../../shared/design-system/icons";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuNote,
} from "../../shared/design-system/ui/Menu";
import { ActivityExpansion } from "../../features/messages/ActivityExpansion";
import {
  title,
  heading,
  describe,
  channelIcon,
  type Channel,
} from "./presentation";
import { problem, useAction } from "./actions";
import { createAttentionActivity } from "./Activity";
export function createWatchComponents({
  agents,
  navigation,
}: Pick<Context, "agents" | "navigation">) {
  const h = React.createElement;
  const activity = createAttentionActivity(navigation);
  const { Destination, WatchActivity } = activity;
  function Subscription({
    agent,
    slug,
    watch,
    name,
    find,
    scope,
    session,
    returnFocus,
  }: {
    agent: Agent;
    slug: string;
    watch: Watch;
    name(id: string): string;
    find(id: string): Channel | undefined;
    scope?: string | undefined;
    session?: RelaySession | undefined;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const row = React.useRef<HTMLLIElement>(null);
    const popup = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(
      () => () => {
        if (
          row.current?.contains(document.activeElement) ||
          popup.current?.contains(document.activeElement)
        )
          returnFocus.current?.focus();
      },
      [returnFocus],
    );
    const [open, setOpen] = React.useState(false);
    const action = useAction();
    const trigger = React.useRef<HTMLButtonElement>(null);
    const cancel = React.useRef<HTMLButtonElement>(null);
    // The watch as the open dialog reviewed it; a watch changed meanwhile
    // is refused rather than deleted unseen.
    const [confirming, setConfirming] =
      React.useState<Agent["attention"][string]>();
    const remove = (expected: Agent["attention"][string]) =>
      action.run(async () => {
        await agents.save(agent.key, {
          attentionExpected: { [slug]: expected },
          attention: { [slug]: null },
        });
        setConfirming(undefined);
      });
    const detailsId = React.useId();
    const history = agent.attentionHistory?.[slug];
    const command =
      watch.type === "source" && watch.provider === "attention/command";
    const timer = agent.timers[slug];
    const description = describe(
      watch,
      Date.now() / 1000,
      watch.type === "timer" && timer?.armedAt === watch.armed_at
        ? timer.used
        : undefined,
    );
    // Timers have no name; a nameless watch is labelled by its Interest.
    const ownName = "name" in watch && watch.name;
    const label = heading(ownName || title(watch.interest_id ?? slug.slice(6)));
    const completed = sourceCompleted(agent.sourceRuns, agent.attention[slug]);
    const state =
      watch.enabled &&
      !interestPaused(agent.attention, watch.interest_id) &&
      !completed &&
      !description.spent
        ? "Active"
        : "Paused";
    const section = (label: string, content: React.ReactNode) => (
      <dl key={label} className="attention-expanded-meta text-body-sm">
        <div>
          <dt className="text-subtle">{label}</dt>
          <dd>{content}</dd>
        </div>
      </dl>
    );
    const shown =
      watch.type === "source"
        ? agents.presentWatch(watch, label.text)
        : undefined;
    const {
      type,
      icon: TypeIcon,
      target,
    } = (() => {
      switch (watch.type) {
        case "event":
          return {
            type: "Messages",
            icon: ChatCircleIcon,
            target:
              watch.channels === "all"
                ? "All joined channels"
                : watch.channels.map(name).join(", "),
          };
        case "timer":
          return {
            type: "Schedule",
            icon: ClockIcon,
            target: description.title,
          };
        case "source": {
          const command = watch.provider === "attention/command";
          const commandTitle =
            command && Array.isArray(watch.config.command)
              ? watch.name ||
                watch.config.command
                  .slice(0, 2)
                  .map((part, index) =>
                    index ? part : String(part).split(/[\\/]/).pop(),
                  )
                  .join(" ")
              : label.text;
          return {
            type: command ? "Command" : (shown?.type ?? "Function"),
            icon: command ? TerminalWindowIcon : (shown?.icon ?? CodeIcon),
            target: shown?.target || commandTitle,
          };
        }
      }
    })();
    const technicalFilters =
      watch.type === "event" &&
      Boolean(
        watch.authors?.length ||
          watch.exclude_authors?.length ||
          Object.keys(watch.tags ?? {}).length ||
          watch.kinds?.length !== 1 ||
          watch.kinds[0] !== 9,
      );
    const destination = "Independent turn";
    return (
      <li
        ref={row}
        className="attention-card"
        data-expanded={open || undefined}
        data-disabled={!watch.enabled || undefined}
        data-paused={
          completed || description.spent || !watch.enabled ? "" : undefined
        }
      >
        <div className="attention-table-row">
          <button
            className="attention-heading"
            type="button"
            aria-label={`Details for ${label.text}`}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            <TypeIcon size={16} aria-hidden={true} />
            <span
              className="attention-title text-body-sm text-primary"
              title={watch.type === "timer" ? description.title : label.text}
            >
              {watch.type === "timer" ? description.title : label.text}
            </span>
          </button>
          {watch.type !== "timer" && (
            <div className="attention-reference">
              <div className="attention-reference-item">
                <PopoverRoot>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        size="xs"
                        style={{
                          paddingInlineStart: "var(--space-2)",
                        }}
                        aria-label={`Source details for ${label.text}`}
                      >
                        <span className="attention-pill-icon">
                          {h(watch.type === "event" ? HashIcon : TypeIcon, {
                            size: 12,
                            "aria-hidden": true,
                          })}
                        </span>
                        <span className="attention-reference-label">
                          {watch.type === "event"
                            ? watch.channels === "all"
                              ? "All channels"
                              : watch.channels.length === 1
                                ? name(watch.channels[0] ?? "")
                                : `${watch.channels.length} channels`
                            : (shown?.target ?? type)}
                        </span>
                      </Button>
                    }
                  />
                  <PopoverPopup
                    align="end"
                    aria-label={`Source details for ${label.text}`}
                    finalFocus={() =>
                      row.current?.isConnected
                        ? true
                        : (returnFocus.current ?? false)
                    }
                  >
                    <div className="attention-popover-content">
                      {watch.type === "event" ? (
                        <dl className="attention-expanded-meta attention-channel-table text-body-sm">
                          <div>
                            <dt className="text-subtle">Watches</dt>
                            <dd>
                              {watch.channels === "all"
                                ? "All joined channels"
                                : watch.channels.map((channel) => (
                                    <div
                                      key={channel}
                                      className="attention-destination-label"
                                    >
                                      {h(channelIcon(find(channel)), {
                                        size: 16,
                                        "aria-hidden": true,
                                      })}
                                      {name(channel)}
                                    </div>
                                  ))}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-subtle">Delivers to</dt>
                            <dd>
                              {watch.channel
                                ? `${name(watch.channel)}${watch.root ? " thread" : ""}`
                                : "Independent turn"}
                            </dd>
                          </div>
                        </dl>
                      ) : watch.provider === "attention/command" ? (
                        <pre className="attention-command text-mono">
                          {Array.isArray(watch.config.command)
                            ? watch.config.command.join(" ")
                            : label.text}
                        </pre>
                      ) : (
                        <dl className="attention-expanded-meta attention-channel-table text-body-sm">
                          <div>
                            <dt className="text-caption text-subtle">{type}</dt>
                            <dd>{target}</dd>
                          </div>
                        </dl>
                      )}
                      {shown?.link && (
                        <Button
                          variant="link"
                          size="inline"
                          nativeButton={false}
                          role="link"
                          aria-label={`Open ${target}`}
                          render={(props) => (
                            <a
                              {...props}
                              href={shown.link?.href}
                              target="_blank"
                              rel="noreferrer"
                            />
                          )}
                        >
                          <ArrowSquareOutIcon size={16} aria-hidden={true} />
                          {shown.link.title}
                        </Button>
                      )}
                      {shown?.details && h(shown.details)}
                    </div>
                  </PopoverPopup>
                </PopoverRoot>
              </div>
            </div>
          )}
          <div className="attention-destination">
            {watch.channel ? (
              <Destination
                channel={watch.channel}
                root={watch.root}
                name={name(watch.channel)}
                scope={scope}
                summary={find(watch.channel)}
                prefix=""
                compact={true}
              />
            ) : (
              <span className="text-caption text-subtle">Independent turn</span>
            )}
          </div>
          <div className="attention-status">
            <MenuRoot>
              <MenuTrigger
                render={
                  <Button
                    ref={trigger}
                    variant="subtle"
                    size="xs"
                    style={{ paddingInlineStart: "var(--space-2)" }}
                    aria-label={`Watch status for ${label.text}`}
                  >
                    <span className="attention-pill-icon">
                      <CircleIcon
                        data-accent={state === "Active" ? "citrus" : undefined}
                        data-color-mode={
                          state === "Active" ? "light" : undefined
                        }
                        size={12}
                        aria-hidden={true}
                        fill="currentColor"
                        strokeWidth={0}
                        style={
                          state === "Active"
                            ? { color: "var(--affordance-accent-prominent)" }
                            : undefined
                        }
                        className={
                          state === "Active" ? undefined : "text-subtle"
                        }
                      />
                    </span>
                    <span>{state}</span>
                  </Button>
                }
              />
              <MenuPopup
                size="compact"
                align="end"
                ref={popup}
                aria-label={`Watch status for ${label.text}`}
                finalFocus={() =>
                  row.current?.isConnected
                    ? true
                    : (returnFocus.current ?? false)
                }
              >
                <MenuGroup>
                  <MenuGroupLabel>Trigger</MenuGroupLabel>
                  <MenuItem
                    disabled={
                      action.pending ||
                      (watch.type === "timer" && !watch.enabled)
                    }
                    closeOnClick={false}
                    onClick={() =>
                      void action.run(async () => {
                        const expected = agent.attention[slug];
                        if (!expected)
                          throw new Error("This watch no longer exists.");
                        return agents.save(agent.key, {
                          watchEnabled: {
                            [slug]: { enabled: !watch.enabled, expected },
                          },
                        });
                      })
                    }
                  >
                    {watch.enabled ? "Pause" : "Resume"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    disabled={action.pending}
                    aria-label={`Delete ${label.text}`}
                    onClick={() => {
                      // Pause/Resume share this action; a refused Pause's
                      // error must not open inside the dialog.
                      action.reset();
                      setConfirming(agent.attention[slug]);
                    }}
                  >
                    {"Delete"}
                  </MenuItem>
                  {interestPaused(agent.attention, watch.interest_id) && (
                    <MenuNote>
                      This interest is paused. Resume it to run enabled watches.
                    </MenuNote>
                  )}
                  {watch.type === "timer" && !watch.enabled && (
                    <MenuNote>{`Ask ${agent.name} to set this timer’s next run.`}</MenuNote>
                  )}
                </MenuGroup>
              </MenuPopup>
            </MenuRoot>
          </div>
        </div>
        {confirming && (
          <AlertDialog
            // A nameless watch shares its Interest's label, and the Interest's
            // own dialog is a few pixels away, so name the kind instead.
            title={
              ownName
                ? `Delete ${label.text}?`
                : watch.type === "timer"
                  ? "Delete this timer?"
                  : "Delete this watch?"
            }
            description={`This deletes the ${
              watch.type === "timer" ? "timer" : "watch"
            }. The agent will stop watching for this trigger. This cannot be undone.`}
            pending={action.pending}
            initialFocus={cancel}
            finalFocus={() =>
              trigger.current?.isConnected
                ? trigger.current
                : (returnFocus.current ?? false)
            }
            onClose={() => setConfirming(undefined)}
            actions={
              <>
                <Button
                  ref={cancel}
                  disabled={action.pending}
                  onClick={() => setConfirming(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  loading={action.pending}
                  onClick={() => void remove(confirming)}
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
        <ActivityExpansion open={open} className="attention-expansion">
          <div id={detailsId} className="attention-details">
            <details className="attention-watch-details">
              <summary
                className="attention-disclosure text-body-sm text-subtle"
                aria-label={`Watch details for ${label.text}`}
              >
                <span className="attention-disclosure-icon">
                  <GearIcon size={16} aria-hidden={true} />
                </span>
                <span className="whitespace-nowrap">{"Watch details"}</span>
                <span className="attention-detail-preview">{`${type} · ${watch.type === "event" ? (watch.classifier ? "Filtered messages" : "All messages") : watch.type === "timer" ? description.title : target}`}</span>
                <CaretRightIcon size={16} aria-hidden={true} />
              </summary>
              <div className="attention-configuration">
                <dl className="attention-expanded-meta text-body-sm">
                  <div>
                    <dt className="text-subtle">{"Source"}</dt>
                    <dd>{type}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle">{"Runs in"}</dt>
                    <dd>
                      {watch.channel ? (
                        <Destination
                          channel={watch.channel}
                          root={watch.root}
                          name={name(watch.channel)}
                          scope={scope}
                          summary={find(watch.channel)}
                          prefix=""
                        />
                      ) : (
                        destination
                      )}
                    </dd>
                  </div>
                  {history?.lastWokeAt && (
                    <div>
                      <dt className="text-subtle">{"Last woke"}</dt>
                      <dd>{relativeTimestamp(history.lastWokeAt)}</dd>
                    </div>
                  )}
                </dl>
                {watch.type === "source" &&
                watch.provider === "attention/command"
                  ? section(
                      "Command",
                      <pre className="text-caption text-standard">
                        <code>
                          {Array.isArray(watch.config.command)
                            ? watch.config.command.join(" ")
                            : label.text}
                        </code>
                      </pre>,
                    )
                  : section(
                      "Trigger",
                      watch.type === "source"
                        ? label.text
                        : watch.type === "event"
                          ? `New messages in ${watch.channels === "all" ? "all joined channels" : watch.channels.map(name).join(", ")}${watch.classifier ? ", filtered for relevance" : ""}.`
                          : `${description.title}. ${watch.prompt}`,
                    )}
                {!shown?.details && label.url && (
                  <a
                    href={label.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-body-sm"
                  >{`Open ${label.text}`}</a>
                )}
                {watch.type === "event" &&
                  (technicalFilters ||
                    watch.classifier ||
                    watch.is_reply !== undefined) &&
                  section(
                    "Filters",
                    <div className="text-body-sm">
                      {watch.is_reply !== undefined && (
                        <p>
                          {watch.is_reply
                            ? "Replies only"
                            : "Top-level messages only"}
                        </p>
                      )}
                      {Object.entries(watch.classifier?.questions ?? {}).map(
                        ([id, question]) => (
                          <p key={id}>{question.question}</p>
                        ),
                      )}
                      {technicalFilters && (
                        <details>
                          <summary
                            className={
                              "attention-disclosure text-body-sm text-subtle"
                            }
                          >
                            {"Technical filters"}
                            <CaretRightIcon size={16} aria-hidden={true} />
                          </summary>
                          <pre className="text-caption text-standard">
                            {JSON.stringify(
                              {
                                kinds: watch.kinds ?? "all",
                                authors: watch.authors,
                                exclude_authors: watch.exclude_authors,
                                tags: watch.tags,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      )}
                    </div>,
                  )}
              </div>
            </details>
            <WatchActivity
              history={history}
              label={label.text}
              session={session}
              scope={scope}
              command={command}
              messages={watch.type === "event"}
            />
          </div>
        </ActivityExpansion>
      </li>
    );
  }

  return { Subscription, ...activity };
}
