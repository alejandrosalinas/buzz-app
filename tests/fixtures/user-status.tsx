import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Real UI and signed session traffic; all state and publications stay in this fixture.
import { createRoot } from "react-dom/client";
import { ProfileButton } from "../../src/app/shell/ProfileButton";
import { ChannelSidebarItem } from "../../src/bundled/channels/ChannelSidebarItem";
import channelStyles from "../../src/bundled/channels/Channels.module.css";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { UserStatusDisplay } from "../../src/features/user-status/StatusDisplay";
import { createRelaySession } from "../../src/features/relay/session";
import type { LiveCallbacks } from "../../src/features/relay/live";
import type { RelayEvent } from "../../src/features/relay/events";
import type { Communities } from "../../src/features/communities/service";
import { keypair, signed, profile } from "../../src/features/relay/testing";
import { createAppearance } from "../../src/shared/theme/service";
import "../../src/shared/styles/globals.css";

const appearance = createAppearance();

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const events = new Map<string, RelayEvent>();
const listeners: LiveCallbacks[] = [];
let reject = false;
let releasePublication: (() => void) | undefined;
let holdPublication = false;
Object.assign(window, {
  statusPublication: {
    hold() {
      holdPublication = true;
    },
    pending: () => !!releasePublication,
    release() {
      releasePublication?.();
      releasePublication = undefined;
    },
  },
});
let remoteTime = Math.floor(Date.now() / 1000);
// ?name= renames Bob in the DM row and in his message byline.
const bobName = new URLSearchParams(location.search).get("name") ?? "Bob";
const profiles = [
  profile(viewer, { name: "Alice" }),
  profile(other, { name: bobName }),
];
const catalog = signed(relay, {
  kind: 30030,
  content: "",
  tags: [
    ["d", "buzz:custom-emoji"],
    ["emoji", "party", "https://emoji.test/party.svg"],
  ],
});
const owners = [0, 1].map(() =>
  createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://status.test",
      media: (url) => url,
      async query(filters) {
        const filter = filters[0];
        if (filter?.kinds?.includes(30315))
          return [...events.values()].filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter?.kinds?.includes(0)) return profiles;
        if (filter?.kinds?.includes(30030)) return [catalog];
        return [];
      },
      subscribe(callbacks) {
        listeners.push(callbacks);
        return { update() {}, retry() {}, dispose() {} };
      },
      writer: {
        kinds: [30315],
        async sign(template) {
          return signed(viewer, template);
        },
        async publish(event) {
          if (holdPublication) {
            holdPublication = false;
            await new Promise<void>((resolve) => {
              releasePublication = resolve;
            });
          }
          if (reject) {
            reject = false;
            throw new Error("Fixture save rejected. Try again.");
          }
          events.set(event.pubkey, event);
          for (const listener of listeners) listener.receive([event]);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  ),
);
const first = owners[0]?.session,
  second = owners[1]?.session;
if (!first || !second) throw new Error("Missing fixture sessions");
// Model the connected session lifecycle so community-profile reads can start.
for (const listener of listeners) {
  listener.state({ status: "connected", routes: [] });
  listener.established();
}
const scope = `https://status.test:${viewer.pubkey}`;
const client = {
  profile: { name: "Alice", picture: "" },
  selected: "https://status.test",
  memberships: [],
  status: "ready",
  viewer: viewer.pubkey,
};
const connection = {
  status: "ready",
  generation: 0,
  session: first,
  viewer: viewer.pubkey,
  scope,
};
const presence = { status: "online", preference: "auto", error: null };
const noActions: readonly [] = [];
const accountActions = {
  subscribe: () => () => {},
  snapshot: () => noActions,
} as unknown as import("../../src/features/account-actions/service").AccountActionsService;
const communities = {
  presence: {
    subscribe: () => () => {},
    snapshot: () => presence,
    setPreference() {},
  },
  snapshot: () => client,
  subscribe: () => () => {},
  relay: { snapshot: () => connection, subscribe: () => () => {} },
} as unknown as Communities;
function remote(text: string, emoji = "🏠", url?: string) {
  const event = signed(other, {
    kind: 30315,
    created_at: ++remoteTime,
    content: text,
    tags: [["d", "general"], url ? ["emoji", emoji, url] : ["emoji", emoji]],
  });
  events.set(other.pubkey, event);
  for (const listener of listeners) listener.receive([event]);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <main className="mx-auto max-w-4xl p-8">
      <div className="flex justify-between">
        <h1>Custom statuses</h1>
        <ProfileButton
          communities={communities}
          accountActions={accountActions}
          appearance={appearance}
          settingsSelected={false}
          onSettings={() => {}}
        />
      </div>
      <div className="grid grid-cols-2 gap-8">
        <section
          aria-label="Navigation"
          className="rounded-2xl border border-line p-4"
        >
          <h2>Navigation</h2>
          {/* The real sidebar's row metrics, including its emoji size. */}
          <div className={channelStyles.sidebar}>
            <ChannelSidebarItem
              channel={{
                id: "status-dm",
                name: bobName,
                channelType: "dm",
                participants: [other.pubkey],
              }}
              session={first}
              working={false}
              selected={undefined}
              onSelect={() => {}}
              onOpenThread={() => {}}
              onOpenMessage={() => {}}
            />
          </div>
        </section>
        <section
          aria-label="Chat"
          className="rounded-2xl border border-line p-4"
        >
          <h2>Chat</h2>
          {(
            [
              [viewer.pubkey, "Alice"],
              [other.pubkey, "Bob"],
            ] as const
          ).map(([authorId, name]) => (
            <MessageRow
              key={authorId}
              row={{
                id: name,
                channelId: "status-dm",
                authorId: authorId,
                // Wider than the byline, so the hover toolbar above the
                // bubble's end corner leaves the status reachable.
                content: "A message that runs past its byline",
                createdAt: remoteTime,
                mentions: [],
                participants: [],
                attachments: [],
                reactions: [],
                replyCount: 0,
              }}
              profile={{ name: name }}
              session={first}
              scope={scope}
              media={first.media}
              day={false}
              retry={undefined}
              onOpenLink={() => false}
            />
          ))}
        </section>
        <section
          aria-label="Second device"
          className="rounded-2xl border border-line p-4"
        >
          <h2>Second device</h2>
          Alice <UserStatusDisplay session={second} userId={viewer.pubkey} />
        </section>
        <section
          aria-label="Profile"
          className="rounded-2xl border border-line p-4"
        >
          <h2>Profile</h2>
          <UserStatusDisplay session={first} userId={viewer.pubkey} />
          <UserStatusDisplay session={first} userId={other.pubkey} />
        </section>
      </div>
      <div className="mt-6 flex gap-2">
        <button
          type="button"
          onClick={() => {
            reject = true;
          }}
        >
          Reject next save
        </button>
        <button type="button" onClick={() => remote("Working remotely")}>
          Update Bob
        </button>
        <button type="button" onClick={() => remote("Celebrating", ":party:")}>
          Custom Bob
        </button>
        <button
          type="button"
          onClick={() =>
            remote(
              "Buzzin' between hives all afternoon, so replies may wait until the honey run is done",
              ":bee-intensifies:",
            )
          }
        >
          Uncatalogued Bob
        </button>
        <button
          type="button"
          onClick={() =>
            remote(
              "Buzzin'",
              ":bee-intensifies:",
              "https://emoji.test/bee-intensifies.svg",
            )
          }
        >
          Uncatalogued Bob with image
        </button>
        <button type="button" onClick={() => remote("Buzzy", "")}>
          Text-only Bob
        </button>
        <button type="button" onClick={() => remote("", "")}>
          Clear Bob
        </button>
        {/* Other clients can put text, or several emoji, in the emoji tag. */}
        <button
          type="button"
          onClick={() => remote("Buzzin'", "🐝 working from the office")}
        >
          Free-text Bob
        </button>
        <button
          type="button"
          onClick={() => remote("Buzzin'", "🐝🏠🎉🚀🌊🔥🍕🎸👩‍💻🏳️‍🌈")}
        >
          Emoji-run Bob
        </button>
        <button
          type="button"
          onClick={() => {
            const stale = signed(other, {
              kind: 30315,
              created_at: remoteTime - 1,
              content: "Stale",
              tags: [["d", "general"]],
            });
            for (const listener of listeners) listener.receive([stale]);
          }}
        >
          Replay older Bob
        </button>
      </div>
    </main>
  </ToastProvider>,
);
