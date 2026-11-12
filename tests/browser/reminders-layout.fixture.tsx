import { apply as applyReminders } from "../../src/bundled/reminders";
import { PageNavigation } from "../../src/app/shell/PageNavigation";
import type { Page, RegisteredPage } from "../../src/features/pages/service";
import { useState } from "react";
import { RemindDialog } from "../../src/bundled/reminders/RemindDialog";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import type { RelaySession } from "../../src/features/relay/session";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { createRoot } from "react-dom/client";
import { RemindersPage } from "../../src/bundled/reminders/RemindersPage";
import type {
  Reminder,
  Reminders,
  RemindersState,
  ReminderTarget,
} from "../../src/features/relay/reminders";
import type { RelayData } from "../../src/features/relay/service";
import type { Navigation } from "../../src/features/navigation/controller";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";

// The real Reminders page in a content region of `?width=` pixels, with one
// ordinary reminder and one whose note is a single unbroken word.
const params = new URLSearchParams(location.search);
const width = Number(params.get("width")) || 900;
const demo = params.has("demo");
const dock = params.has("dock");
if (dock) {
  document.documentElement.dataset.colorMode = params.get("theme") ?? "dark";
  document.documentElement.dataset.accent = "bee";
  document.documentElement.dataset.fontSize = params.get("font") ?? "default";
}
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "200%";
const viewer = "a".repeat(64);
const now = Math.floor(Date.now() / 1000);
const target = (id: string) => ({
  eventId: id.repeat(64),
  channelId: "c",
  preview: "Follow up on the release checklist before the review",
  authorPubkey: viewer,
});
const initialState: RemindersState = Object.freeze({
  status: "ready" as const,
  hydrated: true,
  reminders: [
    {
      id: "ordinary",
      eventId: "e1",
      createdAt: now,
      // Exercise an older year's full date in the narrow-layout regression.
      notBefore: now - (demo ? 60 : 400 * 86400),
      status: "pending" as const,
      target: target("b"),
    },
    {
      id: "unbroken",
      eventId: "e2",
      createdAt: now,
      notBefore: now + 3600,
      status: "pending" as const,
      target: target("c"),
      note: demo
        ? "Check in with the team after the rollout."
        : "x".repeat(2000),
    },
    ...(demo
      ? [
          {
            id: "copy",
            eventId: "e3",
            createdAt: now,
            notBefore: now + 7200,
            status: "pending" as const,
            target: { ...target("d"), preview: "Review the launch copy" },
          },
          {
            id: "designs",
            eventId: "e4",
            createdAt: now,
            notBefore: now + 10800,
            status: "pending" as const,
            target: { ...target("e"), preview: "Share the final designs" },
          },
        ]
      : []),
  ],
});
const channelList = Object.freeze({
  status: "ready",
  channels: [{ id: "c", name: "release-planning", channelType: "stream" }],
});
const profiles = new Map([[viewer, { name: "Ada Lovelace" }]]);
let state = initialState;
if (dock) {
  state = {
    ...state,
    reminders: Array.from(
      { length: Number(params.get("count") ?? 1) },
      (_, i) => ({
        ...initialState.reminders[0],
        id: `due-${i}`,
      }),
    ),
  };
}
const listeners = new Set<() => void>();
function publish(items: readonly Reminder[]) {
  state = { ...state, reminders: items };
  for (const listener of listeners) listener();
}
function update(id: string, patch: Partial<Reminder>) {
  publish(
    state.reminders.map((item) =>
      item.id === id
        ? { ...item, ...patch, createdAt: Math.floor(Date.now() / 1000) }
        : item,
    ),
  );
}
const reminders: Reminders = {
  snapshot: () => state,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  refresh: async () => {},
  create: async (target, notBefore, note) => {
    const id = crypto.randomUUID();
    publish([
      ...state.reminders,
      {
        id,
        eventId: id,
        createdAt: Math.floor(Date.now() / 1000),
        target,
        notBefore,
        note,
        status: "pending",
      },
    ]);
  },
  complete: async (id) => update(id, { status: "done", notBefore: undefined }),
  snooze: async (id, notBefore) => update(id, { status: "pending", notBefore }),
  cancel: async (id) =>
    update(id, { status: "cancelled", notBefore: undefined }),
};
const connection = {
  status: "ready",
  scope: `https://community.example:${viewer}`,
  viewer,
  session: {
    reminders,
    channels: {
      ensureList: () => () => {},
      subscribeList: () => () => {},
      list: () => channelList,
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
    },
    media: (url: string) => url,
  },
};
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
} as unknown as RelayData;

// Capture the real plugin's contribution. Effects are not started: this fixture
// controls the relay boundary and has no notification or background-timer work.
const pages: RegisteredPage[] = [];
if (dock) {
  applyReminders({
    relay,
    pages: {
      register(page: Page) {
        pages.push({
          ...page,
          key: `buzz.reminders/${page.id}`,
          pluginId: "buzz.reminders",
          revision: "fixture",
        });
      },
    },
    notifications: { register: () => ({ submit: async () => {} }) },
    conversation: { registerMessageAction() {} },
    effect() {},
  } as unknown as Parameters<typeof applyReminders>[0]);
}

if (dock) {
  pages.push({
    id: "pages",
    title: "Pages",
    component: () => null,
    key: "fixture/pages",
    pluginId: "fixture",
    revision: "fixture",
  });
}

function DockPreview() {
  const [selected, select] = useState(
    params.has("inactive") ? "other" : pages[0].key,
  );
  return (
    <div className="shell-background flex h-screen pt-2">
      <nav aria-label="Apps dock" className="shell-side-dock">
        <div className="shell-dock-pages">
          <PageNavigation
            pages={pages}
            selected={selected}
            onSelect={select}
            placement="dock"
          />
        </div>
      </nav>
      <main className="flex-1 bg-panel" />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
function Preview() {
  const [dialog, setDialog] = useState<ReminderTarget>();
  const [source, setSource] = useState<ReminderTarget>();
  const [conversation, setConversation] = useState(false);
  return (
    <div className="flex flex-col" style={{ width, height: "100vh" }}>
      {demo && (
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Button size="sm" onClick={() => setDialog(target("b"))}>
            Set a reminder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => publish(initialState.reminders)}
          >
            Reset demo
          </Button>
          <span className="text-caption text-subtle">
            Interactive demo · resets on reload
          </span>
        </div>
      )}
      {dialog && (
        <RemindDialog
          message={
            {
              id: dialog.eventId,
              channelId: dialog.channelId,
              authorId: dialog.authorPubkey,
              content: dialog.preview,
            } as ChannelMessage
          }
          session={connection.session as unknown as RelaySession}
          close={() => setDialog(undefined)}
        />
      )}
      {source && (
        <Dialog
          open
          onOpenChange={(open) => !open && setSource(undefined)}
          title="#release-planning"
          description={
            conversation ? "Demo conversation" : "Demo source message"
          }
          actions={
            <Button
              onClick={() => {
                setDialog(source);
                setSource(undefined);
              }}
            >
              Remind me
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            {(conversation
              ? initialState.reminders.flatMap((item) =>
                  item.target ? [item.target] : [],
                )
              : [source]
            ).map((message) => (
              <div key={message.eventId} className="flex flex-col gap-2">
                <span className="text-label">Ada Lovelace</span>
                <p className="text-body">{message.preview}</p>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      <div className="min-h-0 flex-1">
        <RemindersPage
          relay={relay}
          navigator={
            {
              open: async (link) => {
                const message =
                  link.kind === "conversation"
                    ? state.reminders.find((item) =>
                        link.messageId
                          ? item.target?.eventId === link.messageId
                          : item.target?.channelId === link.channelId,
                      )?.target
                    : undefined;
                if (!message) return { status: "failed", reason: "not-found" };
                setConversation(
                  link.kind === "conversation" && !link.messageId,
                );
                setSource(message);
                return { status: "opened" };
              },
            } as Navigation
          }
          clock={{ subscribe: () => () => {}, read: () => now }}
        />
      </div>
    </div>
  );
}
createRoot(root).render(dock ? <DockPreview /> : <Preview />);
