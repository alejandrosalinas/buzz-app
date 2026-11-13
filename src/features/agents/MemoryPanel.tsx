import { Accordion } from "../../shared/design-system/ui/Accordion";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Header } from "../../shared/design-system/ui/Header";
// The app's read-only view of an agent's memory. Every agent type keeps its
// memory the same way, encrypted to the owner, so the app shows it once: `core`
// (what each run is given) first, then the slugs the agent reads on demand.
import { useReducedMotion } from "motion/react";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { formatFullTimestamp } from "../../shared/datetime";
import { useClockFormat } from "../../shared/clock-preference";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { CommunityReader } from "../communities/service";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  ArrowsClockwiseIcon,
  BrainIcon,
  ThinkingHighIcon,
  CircleNotchIcon,
} from "../../shared/design-system/icons/index";
import { MAX_MARKDOWN_LENGTH, scanMarkdown } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import type { MemoryEntry, MemorySnapshot } from "./memory";
import type { Agent } from "./service";
import styles from "./MemoryPanel.module.css";
import {
  AgentCommunityScope,
  useAgentScopeCommunity,
  type AgentScopeReader,
} from "./AgentCommunityScope";
import { writeClipboardText } from "../../shared/clipboard";
import { MessageLink } from "../conversation/MessageLink";
import type { ConversationExtensions } from "../conversation/contracts";
import { labelText } from "../messages/label-text";
import { parseBuzzLink } from "../navigation/buzz-links";
import { remarkMemoryLinks } from "./memory-markdown";
import {
  MarkdownDocument,
  sharedComponents,
} from "../markdown/MarkdownDocument";
import type { MarkdownProfile } from "../markdown/profiles";

export type AgentMemories = RelaySession["agentMemories"];
export type MemoryLinks = {
  session: RelaySession;
  registry: ConversationExtensions["links"] | undefined;
  open(url: string): boolean;
};
type View = ReturnType<AgentMemories["open"]>;

const MESSAGES: Record<MemorySnapshot["status"], string> = {
  idle: "Memory isn't loaded.",
  loading: "Loading memory…",
  blocked: "Memory can be read once Buzz is connected.",
  error: "Memory couldn't be read.",
  denied: "This community doesn't let you read this agent's memory.",
  unavailable: "Memory isn't available here.",
  ready: "Memory isn't available here.",
};

const PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [remarkBreaks, remarkMemoryLinks],
  html: "literal",
  urlTransform: (url) => (parseBuzzLink(url) ? url : defaultUrlTransform(url)),
};
const CAPABILITIES = { copy: true };
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const TWO_MONTHS_SECONDS = 2 * MONTH_SECONDS;
const MemoryLinksContext = createContext<MemoryLinks | undefined>(undefined);
const MARKDOWN: Components = {
  // Memories are private context; the shared image shows only its alt text.
  ...sharedComponents,
  // Keep link instances mounted while parent views update their link services.
  a: ({ href, children }) => {
    const links = useContext(MemoryLinksContext);
    if (!href || !parseBuzzLink(href))
      return href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        children
      );
    const label = labelText(children);
    return (
      <MessageLink
        url={href}
        label={label === href ? undefined : label}
        registry={links?.registry}
        session={links?.session}
        scope={links?.session.scope}
        onOpenLink={(url) => links?.open(url) ?? false}
      >
        {label === href ? undefined : children}
      </MessageLink>
    );
  },
};

/** Keeps the view for exactly as long as its plaintext is rendered, so session
 * invalidation can revoke the React copy as well as the service snapshot.
 * Retry and Refresh read again through the same view, so a failed read's
 * entries stay on screen until a newer read replaces or clears them. */
function useMemory(memories: AgentMemories | undefined, pubkey: string) {
  const reread = useRef<(() => void) | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [snapshot, setSnapshot] = useState<MemorySnapshot>({
    status: memories ? "loading" : "unavailable",
  });
  useEffect(() => {
    let view: View;
    try {
      if (!memories) throw new Error("No session");
      view = memories.open(pubkey);
    } catch {
      setRefreshing(false);
      setSnapshot({ status: "unavailable" });
      return;
    }
    let live = true;
    const update = () => {
      if (!live) return;
      const next = view.snapshot();
      // Keep a successful listing mounted while a manual refresh has nothing
      // to show yet; every other transition, especially invalidation and
      // streamed pages, replaces it.
      setSnapshot((current) =>
        next.status === "loading" && !next.listing && current.status === "ready"
          ? current
          : next,
      );
      if (next.status !== "loading") setRefreshing(false);
    };
    const unsubscribe = view.subscribe(update);
    const read = () => {
      setRefreshing(true);
      // Keep a listing mounted while a refresh is in flight; replacing it
      // with the loading state would make its actions disappear.
      setSnapshot((current) =>
        current.listing ? current : { status: "loading" },
      );
      void view.refresh().finally(update);
    };
    reread.current = read;
    read();
    return () => {
      live = false;
      if (reread.current === read) reread.current = undefined;
      unsubscribe();
      view.dispose();
    };
  }, [memories, pubkey]);
  return {
    snapshot,
    refreshing,
    refresh: () => reread.current?.(),
  };
}

export function MemoryPanel({
  agent,
  memories,
  communities,
  agents,
  links,
}: {
  agent: Agent;
  memories: AgentMemories | undefined;
  communities?: CommunityReader | undefined;
  agents: AgentScopeReader;
  links?: MemoryLinks | undefined;
}) {
  const community = useAgentScopeCommunity(agent, agents, communities);
  const { snapshot, refreshing, refresh } = useMemory(memories, agent.pubkey);
  const reducedMotion = useReducedMotion();
  const { status, listing } = snapshot;
  const core = listing?.entries.find((entry) => entry.slug === "core");
  const rest = listing?.entries.filter((entry) => entry.slug !== "core") ?? [];
  const canRefresh =
    memories &&
    (status !== "ready" || listing?.partial) &&
    status !== "loading" &&
    status !== "denied";
  const refreshButton = canRefresh ? (
    <IconButton
      aria-label={listing?.partial ? "Retry loading memories" : "Refresh"}
      disabled={refreshing}
      focusableWhenDisabled
      icon={
        <ArrowsClockwiseIcon
          className={refreshing && !reducedMotion ? "animate-spin" : undefined}
        />
      }
      size="xs"
      data-refreshing={refreshing || undefined}
      onClick={refresh}
    />
  ) : null;
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-6">
      {(status === "ready" || status === "loading" || status === "error") &&
      listing ? (
        <>
          <MemorySection
            title="Core memories"
            links={links}
            description="Included in this agent’s context for every session."
            community={
              <AgentCommunityScope community={community} scope="Memory" />
            }
            entries={core ? [core] : []}
            emptyIcon={<ThinkingHighIcon size={24} aria-hidden="true" />}
            refreshing={refreshing}
          />
          <MemorySection
            title="Memories"
            links={links}
            description="Details the agent can look up as needed."
            community={
              <AgentCommunityScope community={community} scope="Memory" />
            }
            entries={rest}
            emptyIcon={<BrainIcon size={24} aria-hidden="true" />}
            refreshing={refreshing}
          />
          {status === "loading" ? (
            <div
              role="status"
              className="flex items-center gap-2 text-body-sm text-secondary"
            >
              <CircleNotchIcon
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
              Loading more memories…
            </div>
          ) : status === "error" ? (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="m-0 text-body-sm text-danger">
                {MESSAGES.error}
              </p>
              {refreshButton}
            </div>
          ) : (
            listing.partial && (
              <div className="flex items-center justify-between gap-2">
                <p className="m-0 text-body-sm text-secondary">
                  Some memories couldn't be shown.
                </p>
                {refreshButton}
              </div>
            )
          )}
        </>
      ) : status === "loading" ? (
        <div
          role="status"
          aria-label="Loading memories"
          className="flex min-h-12 items-center justify-center text-secondary"
        >
          <CircleNotchIcon
            className="motion-safe:animate-spin"
            aria-hidden="true"
          />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p
            role={status === "error" ? "alert" : undefined}
            className={`m-0 text-body-sm ${status === "error" ? "text-danger" : "text-secondary"}`}
          >
            {MESSAGES[status]}
          </p>
          {refreshButton}
        </div>
      )}
    </div>
  );
}

function MemorySection({
  title,
  description,
  community,
  entries,
  emptyIcon,
  refreshing = false,
  links,
}: {
  title: string;
  description: string;
  community: ReactNode;
  entries: readonly MemoryEntry[];
  emptyIcon: ReactNode;
  refreshing?: boolean;
  links?: MemoryLinks | undefined;
}) {
  const ordered = [...entries].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.slug.localeCompare(right.slug),
  );
  return (
    <section className="grid min-w-0 grid-cols-1 gap-2" aria-label={title}>
      <div className={`group ${styles.sectionHeader}`}>
        <Header
          level={4}
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              {title}
              {community}
            </span>
          }
          subtitle={description}
        />
      </div>
      <div
        className={`grid min-w-0 grid-cols-1 gap-2 transition-opacity ${refreshing ? "opacity-50" : ""}`}
        data-memory-list=""
        data-refreshing={refreshing || undefined}
      >
        {entries.length ? (
          ordered.map((entry) => (
            <MemoryAccordion key={entry.slug} entry={entry} links={links} />
          ))
        ) : (
          <div className={styles.empty}>
            <SettingsGroup>
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-secondary">
                {emptyIcon}
                <p className="m-0 text-body-sm">No memories yet</p>
              </div>
            </SettingsGroup>
          </div>
        )}
      </div>
    </section>
  );
}

function MemoryAccordion({
  entry,
  links,
}: {
  entry: MemoryEntry;
  links?: MemoryLinks | undefined;
}) {
  useClockFormat();
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger render={<div />}>
        <Accordion
          variant="settings"
          items={[
            {
              value: entry.slug,
              title: (
                <span className="flex min-w-0 items-center gap-2">
                  {entry.slug === "core" ? (
                    <ThinkingHighIcon
                      size={20}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <BrainIcon
                      size={20}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {entry.slug.startsWith("mem/") ? (
                      <>
                        <span className="text-secondary font-normal">mem/</span>
                        {entry.slug.slice(4)}
                      </>
                    ) : (
                      entry.slug
                    )}
                  </span>
                  <span
                    className="shrink-0 text-body-sm text-secondary"
                    title={formatFullTimestamp(entry.createdAt)}
                    aria-hidden="true"
                  >
                    {memoryTimestamp(entry.createdAt)}
                  </span>
                </span>
              ),
              content: <MemoryBody body={entry.body} links={links} />,
            },
          ]}
        />
      </ContextMenuTrigger>
      <MenuPopup>
        <MemoryCopyMenu entry={entry} />
      </MenuPopup>
    </ContextMenuRoot>
  );
}

function MemoryCopyMenu({ entry }: { entry: MemoryEntry }) {
  const notify = useToastNotification();
  const copy = (value: string, label: "name" | "body") =>
    writeClipboardText(value).then(
      () => notify(`Memory ${label} copied.`, "success"),
      () => notify(`Couldn’t copy the memory ${label}.`, "error"),
    );
  return (
    <>
      <MenuItem onClick={() => copy(entry.slug, "name")}>Copy name</MenuItem>
      <MenuItem onClick={() => copy(entry.body, "body")}>
        Copy full body
      </MenuItem>
    </>
  );
}

function memoryTimestamp(createdAt: number, nowSeconds = Date.now() / 1_000) {
  const age = Math.max(0, nowSeconds - createdAt);
  if (age >= WEEK_SECONDS && age < MONTH_SECONDS) {
    const weeks = Math.floor(age / WEEK_SECONDS);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  if (age >= MONTH_SECONDS && age < TWO_MONTHS_SECONDS) return "1 month ago";
  return relativeTimestamp(createdAt, nowSeconds).replace(/^on /, "");
}

function MemoryBody({
  body,
  links,
}: {
  body: string;
  links?: MemoryLinks | undefined;
}) {
  if (body.length > MAX_MARKDOWN_LENGTH || scanMarkdown(body).tooDeep)
    return <div className={styles.plain}>{body}</div>;
  return (
    <MemoryLinksContext value={links}>
      <MarkdownDocument
        content={body}
        profile={PROFILE}
        components={MARKDOWN}
        capabilities={CAPABILITIES}
        scale="inherit"
        className={styles.markdown}
      />
    </MemoryLinksContext>
  );
}
