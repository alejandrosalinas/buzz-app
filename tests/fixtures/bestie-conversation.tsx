// Controlled UI proof: real conversation/workspace owners, disposable signed data.
import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { channelTabs } from "../../src/bundled/channels/useChannelTabState";
import { ForwardMessageProvider } from "../../src/features/messages/ForwardMessage";
import { BestieConversation } from "../../src/bundled/bestie/BestieConversation";
import { createNavigationController } from "../../src/features/navigation/controller";
import { createMemoryHistory } from "../../src/features/navigation/history";
import type { PageNavigation } from "../../src/features/navigation/service";
import { threadBinding } from "../../src/features/relay/thread-window";
import { createRelaySession } from "../../src/features/relay/session";
import type { RelayData } from "../../src/features/relay/service";
import {
  keypair,
  message,
  metadata,
  roster,
  summary,
  bounds,
  signed,
  profile,
} from "../../src/features/relay/testing";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { RobotIcon } from "../../src/shared/design-system/icons";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  agent = keypair(),
  authority = keypair();
const id = "11111111-1111-4111-8111-111111111111";
const scope = `https://test.example:${viewer.pubkey}`;
const long = new URLSearchParams(location.search).has("long");
const roots = [
  "Planning the day",
  "A second conversation",
  "[View profile](https://profile.test/person)",
]
  .concat(long ? ["A fourth planning message"] : [])
  .map((text, index) =>
    message(
      viewer,
      id,
      long
        ? `${text}\n${"More planning details for the day.\n".repeat(8)}`
        : text,
      1700000000 + index,
    ),
  );
const replies = roots.map((root, index) =>
  message(agent, id, `Reply ${index + 1}`, 1700000010 + index, [
    ["e", root.id, "", "reply"],
  ]),
);
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    scope: "https://test.example",
    media: () => undefined,
    openDirectMessage: async () => {
      throw new Error("This fixture only exercises opening the forward dialog");
    },
    writer: {
      kinds: [9, 9000],
      sign: async (event) => signed(viewer, event),
      publish: async () => {},
    },
    query: async (filters) =>
      (
        await Promise.all(
          filters.map(async (filter) => {
            if (filter.thread_window) {
              const selected = roots.findIndex(
                (root) => root.id === filter["#e"]?.[0],
              );
              return [
                ...replies.slice(selected, selected + 1),
                signed(authority, {
                  kind: 39007,
                  tags: [
                    [
                      "d",
                      await threadBinding(
                        filter,
                        "https://test.example",
                        viewer.pubkey,
                      ),
                    ],
                    ["h", id],
                    ["e", filter["#e"]?.[0] ?? ""],
                  ],
                  content: JSON.stringify({
                    version: 1,
                    direction: "older",
                    has_more: false,
                    next_cursor: null,
                  }),
                }),
              ];
            }
            if (filter.kinds?.includes(0))
              return [
                profile(viewer, { name: "Avery" }),
                profile(agent, { name: "Bestie" }),
              ];
            if (filter.kinds?.includes(39000))
              return [
                metadata(authority, id, "Bestie DM", 1700000000, [
                  ["channel_type", "dm"],
                ]),
              ];
            if (filter.kinds?.includes(39002))
              return [roster(authority, id, [viewer.pubkey, agent.pubkey])];
            if (filter.top_level)
              return [
                ...roots,
                ...roots.map((root) =>
                  summary(authority, id, root.id, {
                    reply_count: 1,
                    participants: [agent.pubkey],
                  }),
                ),
                bounds(authority, id, "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ];
            if (filter.kinds && !filter.kinds.includes(9)) return [];
            return roots.flatMap((root, index) =>
              filter.ids?.includes(root.id) || filter["#e"]?.includes(root.id)
                ? [root, ...replies.slice(index, index + 1)]
                : [],
            );
          }),
        )
      ).flat(),
  },
  { outboxStorage: { load: () => [], save() {} } },
);
await new Promise<void>((resolve) => {
  const unsubscribe = owner.session.channels.subscribeList(() => {
    if (owner.session.channels.list().status === "ready") {
      unsubscribe();
      resolve();
    }
  });
  owner.session.channels.ensureList();
});
const channel = owner.session.channels
  .list()
  .channels.find((channel) => channel.id === id);
if (!channel) throw new Error("Missing fixture DM");
const verifiedChannel = channel;
const controller = createNavigationController(
  createMemoryHistory({
    version: 1,
    kind: "page",
    pluginId: "buzz.bestie",
    pageId: "bestie",
  }),
);
const navigator = controller.navigation;
const snapshot = {
  status: "ready" as const,
  generation: 1,
  scope,
  viewer: viewer.pubkey,
  session: owner.session,
};
const relay = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as RelayData;
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
function ProfileContent() {
  const [note, setNote] = useState("");
  return (
    <>
      <p>Fixture profile</p>
      <label>
        Profile note
        <input value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
    </>
  );
}
const profilePanel = {
  id: "profile",
  key: "buzz.profiles/profile",
  pluginId: "buzz.profiles",
  revision: "fixture",
  title: "Profile",
  matches: (target: string) => target.startsWith("https://profile.test/"),
  component: ProfileContent,
};
const availablePanels = [profilePanel];
const panels = {
  snapshot: () => availablePanels,
  subscribe: contribution.subscribe,
  resolve: (target: string) =>
    profilePanel.matches(target) ? profilePanel : undefined,
};
Object.assign(window, {
  bestieFixture: {
    back: navigator.back,
    forward: navigator.forward,
    target: () => navigator.snapshot().entry.target,
    open: navigator.open,
    tabs: channelTabs(owner.session, navigator),
    channelId: id,
    rootIds: roots.map((root) => root.id),
  },
});
function Fixture() {
  const { entry, attempt } = useSyncExternalStore(
    navigator.subscribe,
    navigator.snapshot,
  );
  const navigation: PageNavigation = {
    entryId: entry.id,
    target: entry.target,
    signal: attempt.signal,
    position: () => undefined,
    savePosition() {},
    forSession: () => navigation,
    resolve: () => false,
    complete: () => true,
  };
  return (
    <ToastProvider>
      <div
        style={{
          height: long ? "calc(100% - 66px)" : "100%",
          overflow: "hidden",
          color: "var(--text-standard)",
        }}
      >
        <BestieConversation
          session={owner.session}
          scope={scope}
          channel={verifiedChannel}
          agent={{ pubkey: agent.pubkey, name: "Bestie" }}
          icon={<RobotIcon size="1rem" />}
          host={{ relay, panels, navigation: navigator }}
          extensions={{ tools: contribution, inline: contribution }}
          navigator={navigator}
          navigation={navigation}
        />
      </div>
      {/* Separate dialog owner: Bestie must supply its own action context. */}
      <ForwardMessageProvider
        session={owner.session}
        scope={scope}
        navigation={navigator}
        renderDialog
      >
        {null}
      </ForwardMessageProvider>
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
