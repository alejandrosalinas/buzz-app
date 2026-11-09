import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
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
  CheckCircleIcon,
  QuestionIcon,
  XCircleIcon,
  CaretRightIcon,
  DotsThreeIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  ShieldIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningCircleIcon,
  WrenchIcon,
} from "../../shared/design-system/icons/index";
import { formatFullTimestamp, formatTime } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import styles from "./ActivityTranscript.module.css";
import referenceStyles from "../../shared/InlineReference.module.css";
import type { AgentViewProps } from "./service";
import messageStyles from "../messages/Messages.module.css";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useAvatarPreview } from "../profiles/use-avatar-preview";
import { bundledPoster } from "./avatar-packs";
import { AgentsContext } from "./react";
import { useProfileGeneration } from "../relay/react";
import type { ProfileQueries } from "../relay/profile-directory";

const noSubscribe = () => () => {};
const none = () => undefined;
const PeopleContext = createContext<{
  profiles?: ProfileQueries | undefined;
  community?: string | undefined;
}>({});

const AgentAvatarSource = createContext<string | undefined>(undefined);

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
/** Quiet trailing metadata; the turn header already dates the prompt. */
function Stamp({ item }: { item: TranscriptItem }) {
  useClockFormat();
  const elapsed =
    item.type === "tool" && item.completedAt !== undefined
      ? item.completedAt - item.at
      : undefined;
  if (item.type === "prompt" || (!known(item.at) && elapsed === undefined))
    return null;
  return (
    <span className={`text-body ${styles.at}`}>
      {elapsed !== undefined && <span>{duration(elapsed)}</span>}
      {elapsed !== undefined && known(item.at) && (
        <span
          className={`text-caption ${styles.metaSeparator}`}
          aria-hidden="true"
        >
          •
        </span>
      )}
      {known(item.at) && (
        <time
          dateTime={new Date(item.at).toISOString()}
          title={formatFullTimestamp(item.at / 1000)}
        >
          {time(item.at)}
        </time>
      )}
    </span>
  );
}
export function duration(ms: number) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
const toolName = (item: ToolItem) => line(item.title) || "tool";
const ACTIONS: Record<string, string> = {
  execute: "Run",
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
};
function toolLabel(item: ToolItem) {
  const title = toolName(item);
  const action = ACTIONS[item.kind];
  if (!action) return { action: title, detail: "" };
  const prefix = new RegExp(`^${action}(?:\\s+|$)`, "i");
  return { action, detail: title.replace(prefix, "") };
}

/** The first location, unless the adapter's title already names it. */
const toolPath = (item: ToolItem) =>
  item.paths[0] && !item.title.includes(item.paths[0]) ? item.paths[0] : "";
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
  agentPicture,
  agentKey,
  community,
}: {
  transcript: Transcript;
  agentName: string;
  state: (turnId: string) => TurnState | undefined;
  /** Paging controls shown above the oldest loaded turn. */
  before?: ReactNode;
  /** Scroll the host to the latest step; off where the transcript shares
   * its scroll with other content. */
  follow?: boolean;
  /** Only aggregate feeds need per-turn conversation navigation. */
  openConversation?: AgentViewProps["openConversation"];
  agentPicture?: string | undefined;
  agentKey?: string;
  community?: string | undefined;
}) {
  const timeline = useFollowLatest(transcript, follow);
  const agents = useContext(AgentsContext);
  const relay = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    () => (agentKey ? agents?.relay(agentKey) : undefined),
    none,
  );
  const connection = useSyncExternalStore(
    relay?.subscribe ?? noSubscribe,
    relay?.snapshot ?? none,
    none,
  );
  const profiles =
    connection?.status === "ready" ? connection.session.profiles : undefined;
  const poster = agentPicture ? bundledPoster(agentPicture) : undefined;
  const picture = useAvatarPreview(
    poster ? "" : (agentPicture ?? ""),
    community,
    "small",
  );
  return (
    <PeopleContext.Provider value={{ profiles, community }}>
      <AgentAvatarSource.Provider value={poster ?? picture}>
        <div ref={timeline} className={`text-body ${styles.timeline}`}>
          {before}
          {!transcript.turns.length && (
            <p className="text-body text-secondary">
              No turns captured for this scope yet.
            </p>
          )}
          {transcript.turns.map((turn) => (
            <Fragment key={turn.turnId}>
              {(turn.newSession || turn.continued) && (
                <p className={`text-body ${styles.session}`}>
                  {turn.newSession
                    ? "New session"
                    : "Session continued; earlier turns not shown"}
                </p>
              )}
              <Turn
                turn={turn}
                state={
                  turn.endedAt ? "ended" : (state(turn.turnId) ?? "unknown")
                }
                agentName={agentName}
                openConversation={openConversation}
              />
            </Fragment>
          ))}
        </div>
      </AgentAvatarSource.Provider>
    </PeopleContext.Provider>
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
  openConversation?: AgentViewProps["openConversation"];
}) {
  useClockFormat();
  const { channelId, threadRootId } = turn;
  const openPlace =
    openConversation && channelId && threadRootId !== undefined
      ? () => openConversation(channelId, threadRootId ?? undefined)
      : undefined;
  const status =
    turn.error || turn.outcome === "error"
      ? "Failed"
      : turn.outcome === "stopped"
        ? "Stopped"
        : turn.outcome === "unknown"
          ? "Status unknown"
          : turn.outcome === "ended"
            ? "Completed"
            : state === "working"
              ? "Working"
              : turn.endedAt
                ? "Completed"
                : "Status unknown";
  const tone =
    status === "Failed"
      ? "failed"
      : status === "Completed"
        ? "completed"
        : "unknown";
  const StatusIcon =
    tone === "failed"
      ? XCircleIcon
      : tone === "completed"
        ? CheckCircleIcon
        : QuestionIcon;
  return (
    <article
      className={styles.turn}
      aria-label={
        known(turn.startedAt) ? `Turn ${time(turn.startedAt)}` : "Turn"
      }
    >
      {state !== "working" && (
        <header
          className={`text-body ${styles.statusRow} ${styles.row}`}
          data-status={tone}
        >
          <StatusIcon size={16} aria-hidden="true" />
          <span>{status}</span>
          {!!turn.endedAt && (
            <span className={styles.statusMeta}>
              {duration(turn.endedAt - turn.startedAt)} ·{" "}
              <time dateTime={new Date(turn.endedAt).toISOString()}>
                {time(turn.endedAt)}
              </time>
            </span>
          )}
        </header>
      )}
      {openConversation && (
        <div className="text-body text-secondary">
          {openPlace ? (
            <button
              type="button"
              className={referenceStyles.link}
              onClick={openPlace}
            >
              {turn.threadRootId
                ? `Thread ${turn.threadRootId.slice(0, 8)}`
                : "Channel"}
            </button>
          ) : (
            "Conversation unknown"
          )}
        </div>
      )}
      {turn.partial && (
        <p className="text-body text-secondary">
          The start of this turn isn't loaded.
        </p>
      )}
      {turn.items.map((item) => (
        <Entry key={item.id} item={item} agentName={agentName} />
      ))}
      {turn.error && (
        <p role="note" className={`${styles.row} ${styles.error}`}>
          <WarningCircleIcon size={16} aria-hidden="true" />
          <span className={styles.text}>{turn.error}</span>
        </p>
      )}
      {state === "working" && (
        <p
          className={`${styles.row} ${styles.statusRow} text-body`}
          data-status="working"
        >
          <WorkingLabel />
        </p>
      )}
    </article>
  );
}

/** The same live-work treatment at the start and end of the turn. */
function WorkingLabel() {
  return (
    <>
      <span className={`${styles.workingIcon} text-accent`}>
        <TypingDots size="small" />
      </span>
      <ShimmerText>Working</ShimmerText>
    </>
  );
}

function Entry({
  item,
  agentName,
}: {
  item: TranscriptItem;
  agentName: string;
}) {
  return (
    <div
      className={styles.item}
      data-type={item.type}
      title={known(item.at) ? formatFullTimestamp(item.at / 1000) : undefined}
    >
      <Item item={item} agentName={agentName} />
    </div>
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
      <summary className="text-body text-subtle">
        <FileTextIcon size="1rem" aria-hidden="true" />
        <span>
          {title} · {sections.length} sections
        </span>
        <CaretRightIcon
          className={styles.chevron}
          size={14}
          aria-hidden="true"
        />
      </summary>
      {sections.map((section, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are a positional, immutable parse of one prompt.
        <section key={index} className={styles.codePanel}>
          <h3 className={`text-body text-secondary ${styles.codePanelHeading}`}>
            {sectionTitle(section.tag)}
          </h3>
          <pre className={styles.pre}>{section.body}</pre>
        </section>
      ))}
    </details>
  );
}

/** Native disclosure keeps expansion local and stable as streamed items update. */
function Disclosure({
  item,
  icon,
  label,
  preview,
  metadata,
  footer,
  children,
}: {
  item: TranscriptItem;
  icon: ReactNode;
  label: ReactNode;
  preview?: string;
  metadata?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      className={styles.tool}
      data-status={item.type === "tool" ? item.status : undefined}
    >
      <summary className={styles.row}>
        {icon}
        <span className={styles.summary}>
          {label}
          {preview && <span className={styles.preview}> {preview}</span>}
        </span>
        {metadata}
        <CaretRightIcon
          className={styles.chevron}
          size={14}
          aria-hidden="true"
        />
        <Stamp item={item} />
      </summary>
      {children && <div className={styles.toolBody}>{children}</div>}
      {footer}
    </details>
  );
}

function PersonAvatar({
  name,
  pubkey,
}: {
  name: string;
  pubkey?: string | undefined;
}) {
  const { profiles, community } = useContext(PeopleContext);
  const key = pubkey && /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : undefined;
  const generation = useProfileGeneration(profiles);
  useEffect(() => {
    void generation;
    if (key) void profiles?.ensure([key], "background").catch(() => {});
  }, [profiles, key, generation]);
  const profile = useSyncExternalStore(
    profiles?.subscribe ?? noSubscribe,
    () => (key ? profiles?.snapshot().get(key) : undefined),
    none,
  );
  const picture = useAvatarPreview(profile?.picture ?? "", community, "small");
  return (
    <span className={styles.avatar}>
      <Avatar src={picture} alt="" fallback={name} size="fill" />
    </span>
  );
}

function Item({
  item,
  agentName,
}: {
  item: TranscriptItem;
  agentName: string;
}) {
  const avatarSource = useContext(AgentAvatarSource);
  switch (item.type) {
    case "system":
      return <Sections title="System prompt" sections={item.sections} />;
    case "prompt": {
      const name = item.author || "Request";
      return (
        <Disclosure
          item={item}
          icon={<PersonAvatar name={name} pubkey={item.authorPubkey} />}
          label={<span className={styles.subject}>{name}</span>}
          preview={line(item.text)}
        >
          <p className={styles.text}>
            {item.steer && <em>(steer) </em>}
            {item.text}
          </p>
          {item.sections.length > 1 && (
            <Sections title="Prompt context" sections={item.sections} />
          )}
        </Disclosure>
      );
    }
    case "thought": {
      const heading =
        line(item.text).replace(/^#{1,6}\s+|^\*\*|\*\*$/g, "") || "Thinking";
      const body = item.text
        .trimStart()
        .split("\n")
        .slice(1)
        .join("\n")
        .trimStart();
      return (
        <Disclosure
          item={item}
          icon={<BulbIcon size={16} aria-label="Thought" />}
          label={<span className={styles.subject}>{heading}</span>}
        >
          {body && <Reply text={body} />}
        </Disclosure>
      );
    }
    case "message":
      return (
        <Disclosure
          item={item}
          icon={
            <span className={styles.avatar}>
              <Avatar
                src={avatarSource}
                alt=""
                fallback={agentName}
                size="fill"
                shape="squircle"
              />
            </span>
          }
          label={
            <span className={styles.subject}>
              {agentName}
              {item.posted && (
                <span className="text-body text-secondary"> · Posted</span>
              )}
            </span>
          }
          preview={line(item.text)}
        >
          <div className={messageStyles.messageBubble}>
            <div className="text-message">
              <Reply text={item.text} />
            </div>
          </div>
        </Disclosure>
      );
    case "tool":
      return <Tool item={item} agentName={agentName} />;
    case "plan":
      return (
        <Disclosure
          item={item}
          icon={<ListChecksIcon size={16} aria-hidden="true" />}
          label={<span className={styles.subject}>Plan</span>}
          preview={`${item.entries.length} steps`}
        >
          <ul className={styles.plan} aria-label="Plan">
            {item.entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are positional and carry no row state.
              <li key={index} data-status={entry.status}>
                {entry.status === "completed" ? "☑" : "☐"} {entry.content}
              </li>
            ))}
          </ul>
        </Disclosure>
      );
    case "status":
      return (
        <Disclosure
          item={item}
          icon={<DotsThreeIcon size={16} aria-hidden="true" />}
          label={<span className={styles.subject}>{line(item.text)}</span>}
        >
          <p className={styles.text}>{item.text}</p>
        </Disclosure>
      );
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
      <figcaption className="text-body text-secondary">
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
  const label = toolLabel(item);
  const failedChildren =
    item.children?.filter(
      (child) => child.type === "tool" && child.status === "failed",
    ).length ?? 0;
  return (
    <Disclosure
      item={item}
      icon={<Icon size="1rem" aria-hidden="true" />}
      label={
        <>
          {status && <span className={styles.status}>{status} </span>}
          <span className={`text-body ${styles.subject}`}>{label.action}</span>
          {label.detail && <span className={styles.path}> {label.detail}</span>}
          {failedChildren > 0 && (
            <span className={styles.error}>
              {" "}
              · {failedChildren} failed{" "}
              {failedChildren === 1 ? "call" : "calls"}
            </span>
          )}
          {path && <span className={`text-body ${styles.path}`}> {path}</span>}
        </>
      }
      metadata={
        item.permission && (
          <span
            className={`text-body text-secondary ${styles.badge}`}
            title={`Permission options: ${item.permission.options.join(", ")}`}
          >
            <ShieldIcon size={14} aria-hidden="true" />
            {item.permission.outcome ?? "Permission requested"}
          </span>
        )
      }
      footer={
        item.truncated && (
          <p className="text-body text-secondary">
            Part of this tool call was too large and was elided by the agent.
          </p>
        )
      }
    >
      {item.title.includes("\n") && (
        <pre className={styles.pre}>{item.title}</pre>
      )}
      {item.input && (
        <section className={styles.codePanel}>
          <h3 className={`text-body text-secondary ${styles.codePanelHeading}`}>
            Input
          </h3>
          <ToolInput text={item.input} />
        </section>
      )}
      {item.diffs.map((diff, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diffs are positional tool content.
        <Diff key={index} diff={diff} />
      ))}
      {item.output && (
        <section className={styles.codePanel}>
          <h3 className={`text-body text-secondary ${styles.codePanelHeading}`}>
            Output
          </h3>
          <pre className={styles.pre}>{item.output}</pre>
        </section>
      )}
      {item.children?.length ? (
        <div className={styles.section}>
          <p className="text-body text-secondary">
            Calls recorded during this script
          </p>
          {item.children.map((child) => (
            <Entry key={child.id} item={child} agentName={agentName} />
          ))}
        </div>
      ) : null}
    </Disclosure>
  );
}
