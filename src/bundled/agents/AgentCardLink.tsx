// A Builderlab agent card's share link in a message: the card's picture and
// name in place of the web link, and a hover card that offers Add to Buzz.
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  agentCardShares,
  fetchAgentCard,
  type AgentCardDraft,
} from "../../features/agents/agent-card";
import {
  LinkInteractiveContext,
  LinkLabelContext,
  LinkPreviewContext,
} from "../../features/conversation/LinkLabelContext";
import { AGENT_CARD_ID } from "../../features/navigation/buzz-links";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { LinkLabel } from "../links/InlineLink";
import styles from "./AgentCardLink.module.css";

/** The card id of a share link of this build's Builderlab, such as
 * `https://app.builderlab.xyz/a/av_…` or `https://builderlab.xyz/agents/tinker`.
 * Another environment's share link stays a web link: Add to Buzz reads this
 * build's cards only. */
export function agentCardLinkId(href: string, shares = agentCardShares()) {
  try {
    const url = new URL(href);
    const [, section, id, ...rest] = url.pathname.split("/");
    return url.protocol === "https:" &&
      !url.port &&
      Object.hasOwn(shares, url.hostname) &&
      shares[url.hostname] === section &&
      id &&
      AGENT_CARD_ID.test(id) &&
      (rest.length === 0 || (rest.length === 1 && rest[0] === ""))
      ? id
      : null;
  } catch {
    return null;
  }
}

/** What a link shows of its card. */
type Card = Readonly<{ name: string; picture: string }>;

type Read =
  | Readonly<{ state: "reading" }>
  | Readonly<{ state: "read"; card: Card }>
  | Readonly<{ state: "failed"; at: number }>;

/** A failed read is tried again for a link shown after this long. */
const RETRY_MS = 60_000;
/** A read still pending after this long is stopped, and fails. */
const READ_TIMEOUT_MS = 15_000;
/** Cards kept for links no longer shown; a link on screen, or a read still
 * pending, keeps its own. */
const KEPT = 100;

/** Card reads shared by every link to the same card. Only a link live in a
 * message reads one: typing a link mounts a decoration for every prefix. */
export function createAgentCardReads(
  read: (id: string, signal: AbortSignal) => Promise<AgentCardDraft> = (
    id,
    signal,
  ) => fetchAgentCard(id, signal),
  now = () => Date.now(),
) {
  const reads = new Map<string, Read>();
  const listeners = new Map<string, Set<() => void>>();
  const settle = (id: string, next: Read) => {
    // Newest last, so the oldest unwatched cards go first. A pending read
    // stays until it settles, so a card never has two requests in flight.
    reads.delete(id);
    reads.set(id, next);
    for (const [old, kept] of reads) {
      if (reads.size <= KEPT) break;
      if (!listeners.has(old) && kept.state !== "reading") reads.delete(old);
    }
    for (const listener of listeners.get(id) ?? []) listener();
  };
  return {
    get: (id: string) => reads.get(id),
    watch(id: string, listener: () => void) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      const current = reads.get(id);
      if (
        !current ||
        (current.state === "failed" && now() - current.at >= RETRY_MS)
      ) {
        settle(id, { state: "reading" });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
        read(id, controller.signal)
          .then(
            ({ name, picture }) =>
              settle(id, { state: "read", card: { name, picture } }),
            () => settle(id, { state: "failed", at: now() }),
          )
          .finally(() => clearTimeout(timeout));
      }
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(id);
      };
    },
  };
}

export type AgentCardReads = ReturnType<typeof createAgentCardReads>;

/** Opens Create agent from the card, as the share page's Add to Buzz does. */
export const addToBuzzLink = (id: string) =>
  `buzz://agent/new?card=${encodeURIComponent(id)}`;

export function AgentCardLink({
  url,
  reads,
}: {
  url: string;
  reads: AgentCardReads;
}) {
  const id = agentCardLinkId(url) ?? "";
  const live = useContext(LinkInteractiveContext);
  const subscribe = useCallback(
    (listener: () => void) => (live && id ? reads.watch(id, listener) : noop),
    [live, reads, id],
  );
  const snapshot = () => reads.get(id);
  const read = useSyncExternalStore(subscribe, snapshot, snapshot);
  const card = read?.state === "read" ? read.card : undefined;
  const offer = useContext(LinkPreviewContext);
  const preview = useMemo(
    () =>
      card && {
        label: `${card.name} agent card`,
        render: (open: (target: string) => boolean) => (
          <AgentCardLinkPreview
            card={card}
            onAdd={() => open(addToBuzzLink(id))}
          />
        ),
      },
    [card, id],
  );
  useEffect(() => {
    if (!offer || !preview) return;
    offer(preview);
    return () => offer(undefined);
  }, [offer, preview]);
  // An authored label stays; a pasted link takes the card's name.
  const authored = useContext(LinkLabelContext) !== undefined;
  return (
    <LinkLabel
      href={url}
      {...(!authored && card && { label: card.name })}
      {...(card && {
        icon: (
          <span className={styles.icon} aria-hidden="true">
            <Avatar
              src={card.picture}
              alt=""
              fallback={card.name}
              size="tiny"
              shape="squircle"
            />
          </span>
        ),
      })}
    />
  );
}

function AgentCardLinkPreview({ card, onAdd }: { card: Card; onAdd(): void }) {
  return (
    <div className={styles.preview}>
      <Avatar
        src={card.picture}
        alt=""
        fallback={card.name}
        size="large"
        shape="squircle"
      />
      <span className={styles.identity}>
        <strong className={styles.name}>{card.name}</strong>
        <span className={styles.kind}>Agent card</span>
      </span>
      <Button variant="primary" size="sm" onClick={onAdd}>
        Add to Buzz
      </Button>
    </div>
  );
}

const noop = () => {};
