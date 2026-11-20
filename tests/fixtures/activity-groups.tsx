// Real timeline and Virtua, with local data and no broker or live credentials.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { keypair, metadata, roster } from "../../src/features/relay/testing";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import styles from "../../src/features/messages/Messages.module.css";
import "../../src/shared/styles/globals.css";

const relayed = new URLSearchParams(location.search).get("relayed");
const viewer = keypair();
const relay = keypair();
const source = "source";
const sourceDetails = metadata(
  relay,
  source,
  "quarterly-infrastructure-planning-and-roadmap-review-for-all-teams",
);
const sourceRoster = roster(relay, source, [viewer.pubkey]);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: () => undefined,
  query: async (filters) =>
    filters.flatMap((filter) =>
      [sourceDetails, sourceRoster].filter((event) =>
        filter.kinds?.includes(event.kind),
      ),
    ),
});
if (relayed !== null) owner.session.channels.ensureList();
const agent = keypair().pubkey;
const update = (index: number, activity = true): ChannelMessage => ({
  id: `activity-${index}`,
  channelId: "solo",
  authorId: agent,
  ...(activity ? { audience: "agents" } : {}),
  createdAt: 1792152000 + index,
  content: `Activity update ${index}. Checked the conversation layout and kept the history available.\n\nThe expanded details explain what changed and why. They stay readable while the surrounding space opens.\n\nLinks, attachments and message actions continue to use the normal message renderer.`,
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  participants: [],
});
const note = "The complete handoff remains readable when this preview opens.";
function Fixture() {
  useKeyboardFocusVisibility();
  const [rows, setRows] = useState<ChannelMessage[]>(
    relayed !== null
      ? [
          {
            ...update(0, false),
            content: "Ordinary chat message",
          },
          {
            ...update(1, false),
            authorId: owner.session.viewer,
            content: `Relayed fixture update. ${"A long preview needs to fit the chat. ".repeat(9)}\n\n${note}`,
            relayedFrom: { agent, channelId: source, verified: true },
          },
          ...(relayed === "group"
            ? [
                {
                  ...update(2, false),
                  authorId: owner.session.viewer,
                  content: "Second relayed fixture update.",
                  relayedFrom: { agent, channelId: source, verified: true },
                },
              ]
            : []),
        ]
      : Array.from({ length: 16 }, (_, index) => update(index)),
  );
  const [inlineTarget, setTarget] = useState<{
    messageId: string;
    signal: AbortSignal;
  }>();
  return (
    <main
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        gap: 8,
      }}
    >
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button
          onClick={() =>
            setRows([
              ...rows,
              update(Number(rows.at(-1)?.id.split("-").at(-1) ?? -1) + 1),
            ])
          }
        >
          Append update
        </Button>
        <Button
          onClick={() =>
            setTarget({
              messageId: "activity-0",
              signal: new AbortController().signal,
            })
          }
        >
          Visit first update
        </Button>
        <Button onClick={() => setRows([update(-1), ...rows])}>
          Prepend history
        </Button>
      </nav>
      <div className={styles.thread} style={{ flex: 1 }}>
        <ChannelTimeline
          transient
          channelId="solo"
          scope="activity-groups-fixture"
          queries={owner.session}
          chatPresentation
          inlineTarget={inlineTarget}
          window={{
            channelId: "solo",
            rows,
            status: "ready",
            hasMore: false,
            loadingOlder: false,
            freshness: "verified",
            error: undefined,
          }}
          onOpenLink={() => false}
        />
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
