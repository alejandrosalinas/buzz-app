import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  sectionTitle,
  type PromptSection,
  type ToolDiff,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "./activity-transcript";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import {
  BulbIcon,
  CaretRightIcon,
  ChatCircleIcon,
  DotsThreeIcon,
  EyeIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  ShieldIcon,
  TerminalWindowIcon,
  TrashIcon,
  UserIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "../../shared/design-system/icons/index";
import {
  formatFullTimestamp,
  formatItemTimestamp,
  formatTime,
} from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import referenceStyles from "../../shared/InlineReference.module.css";
import type { AgentViewProps } from "./service";
import styles from "./ActivityTranscript.module.css";

type TurnState = "working" | "unknown" | "ended";
// Icons follow ACP's standard tool kinds; tool names stay as the adapter sent them.
const ICONS: Record<string, typeof WrenchIcon> = {
  execute: TerminalWindowIcon,
  read: EyeIcon,
  edit: PencilSimpleIcon,
  delete: TrashIcon,
  move: PencilSimpleIcon,
  search: MagnifyingGlassIcon,
  fetch: GlobeIcon,
  think: BulbIcon,
};
const STATUS: Record<string, string> = {
  pending: "Pending",
  in_progress: "Running",
  failed: "Failed",
  terminated: "Terminated",
  yielded: "Yielded",
};
const line = (text: string) => text.split("\n").find(Boolean)?.trim() ?? "";
const time = (at: number) => formatTime(at / 1000);
/** Zero, non-finite and out-of-range times are unknown: show nothing rather
 * than 1970 or a formatter throw. */
const known = (at: number) => !!at && !Number.isNaN(new Date(at).getTime());
/** An entry's time under it; the turn header already dates the prompt. */
function Stamp({ item }: { item: TranscriptItem }) {
  useClockFormat();
  if (item.type === "prompt" || !known(item.at)) return null;
  return (
    <time
      className={`text-body-sm ${styles.at}`}
      dateTime={new Date(item.at).toISOString()}
      title={formatFullTimestamp(item.at / 1000)}
    >
      {time(item.at)}
    </time>
  );
}
export function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
const toolName = (item: ToolItem) => line(item.title) || "tool";
/** The first location, unless the adapter's title already names it. */
const toolPath = (item: ToolItem) =>
  item.paths[0] && !item.title.includes(item.paths[0]) ? item.paths[0] : "";
/** A channel turn is labelled only where the label opens the channel. */
const thread = (turn: TranscriptTurn, linked: boolean) =>
  turn.threadRootId === null
    ? linked
      ? "Channel"
      : ""
    : turn.threadRootId
      ? `Thread ${turn.threadRootId.slice(0, 8)}`
      : "Thread unknown";

/** The nearest ancestor that scrolls, which the host supplies. */
function scroller(element: HTMLElement | null) {
  for (let node = element?.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  return undefined;
}
/** How near the end still counts as reading the latest. */
const END_SLACK = 32;

/** Opens at the latest step and keeps it in view as the transcript grows,
 * unless the reader has scrolled up to read earlier turns. */
function useFollowLatest(content: unknown, enabled: boolean) {
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const view = enabled ? scroller(timeline.current) : undefined;
    if (!view) return;
    const read = () => {
      following.current =
        view.scrollHeight - view.scrollTop - view.clientHeight <= END_SLACK;
    };
    view.addEventListener("scroll", read, { passive: true });
    return () => view.removeEventListener("scroll", read);
  }, [enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: content is the change to follow.
  useLayoutEffect(() => {
    const view = enabled && following.current && scroller(timeline.current);
    if (view) view.scrollTop = view.scrollHeight;
  }, [content, enabled]);
  return timeline;
}

/** Turn-by-turn transcript of the loaded activity, oldest first, opened at
 * the latest. */
export function ActivityTranscript({
  transcript,
  agentName,
  state,
  before,
  follow = true,
  openConversation,
}: {
  transcript: Transcript;
  agentName: string;
  state: (turnId: string) => TurnState | undefined;
  /** Paging controls shown above the oldest loaded turn. */
  before?: ReactNode;
  /** Scroll the host to the latest step; off where the transcript shares
   * its scroll with other content. */
  follow?: boolean;
  /** Links each turn's channel or thread; plain text without it. */
  openConversation?: AgentViewProps["openConversation"];
}) {
  const timeline = useFollowLatest(transcript, follow);
  return (
    <div ref={timeline} className={styles.timeline}>
      {before}
      {!transcript.turns.length && (
        <p className="text-body-sm text-secondary">
          No turns captured for this scope yet.
        </p>
      )}
      {transcript.turns.map((turn) => (
        <Fragment key={turn.turnId}>
          {(turn.newSession || turn.continued) && (
            <p className={`text-body-sm ${styles.session}`}>
              {turn.newSession
                ? "New session"
                : "Session continued; earlier turns not shown"}
            </p>
          )}
          <Turn
            turn={turn}
            state={turn.endedAt ? "ended" : (state(turn.turnId) ?? "unknown")}
            agentName={agentName}
            openConversation={openConversation}
          />
        </Fragment>
      ))}
    </div>
  );
}

function Turn({
  turn,
  state,
  agentName,
  openConversation,
}: {
  turn: TranscriptTurn;
  state: TurnState;
  agentName: string;
  openConversation: AgentViewProps["openConversation"];
}) {
  useClockFormat();
  const status = turn.error
    ? "Error"
    : state === "working"
      ? "Working"
      : turn.endedAt
        ? "Completed"
        : "Status unknown";
  const { channelId, threadRootId } = turn;
  // An unknown thread is not opened as its channel.
  const open =
    openConversation && channelId && threadRootId !== undefined
      ? () => openConversation(channelId, threadRootId ?? undefined)
      : undefined;
  const place = thread(turn, !!open);
  const facts = [
    ...turn.config,
    turn.source === "heartbeat" ? "heartbeat" : "",
    turn.stopReason ?? "",
    turn.context
      ? `context ${Math.round(turn.context.used / 1000)}k/${Math.round(turn.context.size / 1000)}k`
      : "",
  ].filter(Boolean);
  return (
    <article
      className={styles.turn}
      aria-label={
        known(turn.startedAt) ? `Turn ${time(turn.startedAt)}` : "Turn"
      }
    >
      <header className={`text-body-sm ${styles.turnHeader}`}>
        {known(turn.startedAt) && (
          <>
            <time
              dateTime={new Date(turn.startedAt).toISOString()}
              title={new Date(turn.startedAt).toLocaleString()}
            >
              {formatItemTimestamp(turn.startedAt / 1000, { withTime: true })}
            </time>
            {" · "}
          </>
        )}
        <span data-state={turn.error ? "error" : state}>{status}</span>
        {!!turn.endedAt && (
          <span> · {duration(turn.endedAt - turn.startedAt)}</span>
        )}
        {place && (
          <span>
            {" · "}
            {open ? (
              // The shared inline link, in the header's own type.
              <button
                type="button"
                className={referenceStyles.link}
                onClick={open}
              >
                {place}
              </button>
            ) : (
              place
            )}
          </span>
        )}
        {facts.map((fact) => (
          <span key={fact}> · {fact}</span>
        ))}
      </header>
      {turn.partial && (
        <p className="text-body-sm text-secondary">
          The start of this turn isn't loaded.
        </p>
      )}
      {turn.items.map((item) => (
        <div key={item.id} className={styles.item} data-type={item.type}>
          <Item item={item} agentName={agentName} />
          <Stamp item={item} />
        </div>
      ))}
      {turn.error && (
        <p role="note" className={`${styles.row} ${styles.error}`}>
          <WarningCircleIcon size={16} aria-hidden="true" />
          <span className={styles.text}>{turn.error}</span>
        </p>
      )}
      {state === "working" && (
        <p className={`${styles.row} text-secondary`}>
          <DotsThreeIcon size={16} aria-hidden="true" /> Working…
        </p>
      )}
    </article>
  );
}

function Sections({
  title,
  sections,
}: {
  title: string;
  sections: readonly PromptSection[];
}) {
  return (
    <details className={styles.context}>
      <summary className="text-body-sm text-subtle">
        <CaretRightIcon size={14} aria-hidden="true" />
        <span>
          {title} · {sections.length} sections
        </span>
      </summary>
      {sections.map((section, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are a positional, immutable parse of one prompt.
        <details key={index} className={styles.section}>
          <summary className="text-body-sm text-subtle">
            <CaretRightIcon size={14} aria-hidden="true" />
            <span>{sectionTitle(section.tag)}</span>
          </summary>
          <pre className={styles.pre}>{section.body}</pre>
        </details>
      ))}
    </details>
  );
}

function Item({
  item,
  agentName,
}: {
  item: TranscriptItem;
  agentName: string;
}) {
  switch (item.type) {
    case "system":
      return <Sections title="System prompt" sections={item.sections} />;
    case "prompt":
      return (
        <>
          <p className={styles.row}>
            <UserIcon size={16} aria-hidden="true" />
            <span className={styles.text}>
              {item.author && <strong>{item.author} </strong>}
              {item.steer && <em>(steer) </em>}
              {item.text}
            </span>
          </p>
          {item.sections.length > 1 && (
            <Sections title="Prompt context" sections={item.sections} />
          )}
        </>
      );
    case "thought":
      return (
        <p className={`${styles.row} text-secondary`}>
          <BulbIcon size={16} aria-label="Thought" />
          <span className={styles.text}>{item.text}</span>
        </p>
      );
    case "message":
      return (
        <div className={styles.row}>
          <ChatCircleIcon size={16} aria-hidden="true" />
          <div className={styles.reply}>
            <strong>{agentName}</strong>
            {item.posted && (
              <span className="text-body-sm text-secondary"> · Posted</span>
            )}
            <Reply text={item.text} />
          </div>
        </div>
      );
    case "tool":
      return <Tool item={item} agentName={agentName} />;
    case "plan":
      return (
        <div className={styles.row}>
          <ListChecksIcon size={16} aria-hidden="true" />
          <ul className={styles.plan} aria-label="Plan">
            {item.entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are positional and carry no row state.
              <li key={index} data-status={entry.status}>
                {entry.status === "completed" ? "☑" : "☐"} {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "status":
      return <p className="text-body-sm text-secondary">{item.text}</p>;
  }
}

// Module-scoped so rerenders keep rendered links (and their focus) in place.
const REMARK = [remarkGfm];
const MARKDOWN: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: ({ alt }) => alt ?? null,
};

/** Agent replies are Markdown; remote images stay unloaded. */
function Reply({ text }: { text: string }) {
  const bounded = useMemo(
    () => text.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(text).tooDeep,
    [text],
  );
  if (!bounded) return <div className={styles.plain}>{text}</div>;
  return (
    <div className={styles.markdown}>
      <Markdown remarkPlugins={REMARK} components={MARKDOWN}>
        {text}
      </Markdown>
    </div>
  );
}

/** A file's lines; a final newline does not start another line. */
const lines = (text: string) => text.replace(/\n$/, "").split("\n");
/** One hunk between the unchanged leading and trailing lines. */
function Diff({ diff }: { diff: ToolDiff }) {
  const before = diff.oldText === undefined ? [] : lines(diff.oldText);
  const after = lines(diff.newText);
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);
  return (
    <figure className={styles.diff}>
      <figcaption className="text-body-sm text-secondary">
        {diff.oldText === undefined ? "New file" : "Changed"} {diff.path}
      </figcaption>
      <pre className={styles.pre}>
        {removed.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable.
          <span key={`-${index}`} className={styles.removed}>
            {`- ${text}\n`}
          </span>
        ))}
        {added.map((text, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable.
          <span key={`+${index}`} className={styles.added}>
            {`+ ${text}\n`}
          </span>
        ))}
      </pre>
    </figure>
  );
}

function ToolInput({ text }: { text: string }) {
  const content: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(/\btools\.[A-Za-z_$][\w$]*(?=\s*\()/g)) {
    content.push(
      text.slice(end, match.index),
      <span key={match.index} className="text-accent">
        {match[0]}
      </span>,
    );
    end = match.index + match[0].length;
  }
  content.push(text.slice(end));
  return <pre className={styles.pre}>{content}</pre>;
}

function Tool({ item, agentName }: { item: ToolItem; agentName: string }) {
  const Icon = ICONS[item.kind] ?? WrenchIcon;
  const status = STATUS[item.status];
  const path = toolPath(item);
  const failedChildren =
    item.children?.filter(
      (child) => child.type === "tool" && child.status === "failed",
    ).length ?? 0;
  return (
    <details className={styles.tool} data-status={item.status}>
      <summary className={styles.row}>
        <Icon size={16} aria-hidden="true" />
        <span className={styles.summary}>
          {status && <span className={styles.status}>{status} </span>}
          <span className={styles.subject}>{toolName(item)}</span>
          {failedChildren > 0 && (
            <span className={styles.error}>
              {" "}
              · {failedChildren} failed{" "}
              {failedChildren === 1 ? "call" : "calls"}
            </span>
          )}
          {path && <span className={styles.path}> {path}</span>}
        </span>
        {item.permission && (
          <span
            className={`text-body-sm text-secondary ${styles.badge}`}
            title={`Permission options: ${item.permission.options.join(", ")}`}
          >
            <ShieldIcon size={14} aria-hidden="true" />
            {item.permission.outcome ?? "Permission requested"}
          </span>
        )}
        {item.completedAt !== undefined && (
          <span className="text-body-sm text-secondary">
            {duration(item.completedAt - item.at)}
          </span>
        )}
      </summary>
      {item.title.includes("\n") && (
        <pre className={styles.pre}>{item.title}</pre>
      )}
      {item.input && <ToolInput text={item.input} />}
      {item.diffs.map((diff, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diffs are positional tool content.
        <Diff key={index} diff={diff} />
      ))}
      {item.output && <pre className={styles.pre}>{item.output}</pre>}
      {item.children?.length ? (
        <div className={styles.section}>
          <p className="text-body-sm text-secondary">
            Calls recorded during this script
          </p>
          {item.children.map((child) => (
            <div key={child.id}>
              <Item item={child} agentName={agentName} />
              <Stamp item={child} />
            </div>
          ))}
        </div>
      ) : null}
      {item.truncated && (
        <p className="text-body-sm text-secondary">
          Part of this tool call was too large and was elided by the agent.
        </p>
      )}
    </details>
  );
}
