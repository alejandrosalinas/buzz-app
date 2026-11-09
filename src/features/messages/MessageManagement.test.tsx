// @vitest-environment jsdom
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { afterEach, assert, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { composerDOMFixture } from "./composer-testing";
import type { ComposerInputElement } from "./composer-dom";
import { MessageComposer } from "./MessageComposer";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import {
  MessageManagement,
  MessageManagementItems,
  MessageManagementStatus,
  MessageReadStateItem,
  useMessageKeyActions,
} from "./MessageManagement";
import { createRelaySession } from "../relay/session";
import { readJournal, type ReadJournal } from "../relay/read-state-storage";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  bounds,
  signed,
  type Key,
} from "../relay/testing";
import type { ReadStateSigning } from "../relay/read-state-host";
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Exercise the production codec with disposable identities.
} from "../../../browser-host/read-state.mjs";
import { eventDto, type RelayEvent } from "../relay/events";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(
  own = true,
  readSync = false,
  withAttachments = false,
  originalAttachment = false,
  originalMention = false,
  agentOwner: "viewer" | "other" | undefined = undefined,
  chatCard = false,
  shareRead?: Promise<RelayEvent[]>,
  viewerRole: "member" | "guest" = "member",
  {
    outboxStorage = { load: () => [], save() {} },
    viewer = keypair(),
  }: { outboxStorage?: OutboxStorage; viewer?: Key } = {},
) {
  let role = viewerRole,
    rosterTime = 1700000000;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const relay = keypair(),
    peer = keypair(),
    agent = agentOwner ? keypair() : undefined,
    agentOwnerKey =
      agentOwner === "viewer"
        ? viewer
        : agentOwner === "other"
          ? keypair()
          : undefined;
  const original = message(
    own ? viewer : (agent ?? peer),
    "room",
    chatCard
      ? "[Session: Saved work](buzz://channel/source)"
      : originalAttachment
        ? "Original message\n\n[original.pdf](https://fixture.test/media/original.pdf)"
        : originalMention
          ? "@Honey Original message"
          : "Original message",
    1700000000,
    [
      ...(originalAttachment
        ? [
            [
              "imeta",
              "url https://fixture.test/media/original.pdf",
              "m application/pdf",
            ],
          ]
        : []),
      ...(originalMention ? [["p", peer.pubkey]] : []),
    ],
  );
  let agentProfile =
    agent && agentOwnerKey
      ? eventDto(
          signed(agent, {
            kind: 0,
            content: JSON.stringify({ name: "Test agent" }),
            tags: [
              [
                "auth",
                agentOwnerKey.pubkey,
                "kind=0&created_at<1700000001",
                bytesToHex(
                  schnorr.sign(
                    new Uint8Array(
                      await crypto.subtle.digest(
                        "SHA-256",
                        new TextEncoder().encode(
                          `nostr:agent-auth:${agent.pubkey}:kind=0&created_at<1700000001`,
                        ),
                      ),
                    ),
                    agentOwnerKey.secret,
                  ),
                ),
              ],
            ],
          }),
        )
      : undefined;
  const publications: {
    event: RelayEvent;
    result: ReturnType<typeof deferred<void>>;
  }[] = [];
  let journal: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      ...(readSync
        ? {
            readState: {
              decode: async (events: readonly RelayEvent[]) =>
                decodeReadState(events, viewer.secret),
              sign: async (intent: ReadStateSigning) =>
                signReadState(intent, viewer.secret),
              publish: async () => {},
            },
          }
        : {}),
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      ...(withAttachments
        ? {
            uploadAttachment: async (file: File) => ({
              name: file.name,
              url: `https://fixture.test/media/${"a".repeat(64)}.txt`,
              type: "text/plain",
              size: file.size,
              sha256: "a".repeat(64),
            }),
          }
        : {}),
      async query(filters) {
        const filter = filters[0];
        assert.exists(filter);
        if (shareRead && filter.ids?.includes(original.id)) return shareRead;
        if (filter.kinds?.includes(39000) || filter.kinds?.includes(39002))
          return [
            metadata(relay, "room", "Room"),
            signed(relay, {
              ...roster(relay, "room", [viewer.pubkey, peer.pubkey]),
              created_at: rosterTime,
              tags: [
                ["d", "room"],
                ["p", viewer.pubkey, "", role],
                ["p", peer.pubkey, "", "member"],
              ],
            }),
          ];
        if (filter.kinds?.includes(0))
          return [
            ...(originalMention && filter.authors?.includes(peer.pubkey)
              ? [profile(peer, { name: "Honey" })]
              : []),
            ...(agent && agentProfile && filter.authors?.includes(agent.pubkey)
              ? [agentProfile]
              : []),
          ];
        if (filter.kinds?.includes(9))
          return [
            original,
            bounds(relay, "room", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ];
        return [];
      },
      writer: {
        kinds: [9, 40003, 5],
        async sign(template) {
          return signed(viewer, template);
        },
        publish(event) {
          const result = deferred<void>();
          publications.push({ event, result });
          return result.promise;
        },
      },
    },
    {
      readStateFloor: () => 0,
      outboxStorage,
      readPublisherLock: async (_signal, work) => work(),
      readStateStorage: {
        close() {},
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
      },
    },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  owner.session.channels.ensure("room");
  await waitFor(() =>
    expect(owner.session.channels.window("room").rows).toHaveLength(1),
  );
  if (originalMention) {
    owner.session.profiles.ensure([peer.pubkey]);
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(peer.pubkey)?.name).toBe(
        "Honey",
      ),
    );
  }
  function Surface({
    presented = true,
    composer = true,
  }: {
    presented?: boolean;
    composer?: boolean;
  }) {
    const snapshot = useSyncExternalStore(
      (listener) => owner.session.channels.subscribeWindow("room", listener),
      () => owner.session.channels.window("room"),
    );
    return (
      <ConversationPresentation value={presented}>
        <MessageManagement session={owner.session} channelId="room">
          <MessageManagementStatus />
          {snapshot.rows.map((row) => (
            <div key={row.id}>
              <p>{row.content}</p>
              <MenuRoot>
                <MenuTrigger>Message actions</MenuTrigger>
                <MenuPopup>
                  <MessageReadStateItem row={row} session={owner.session} />
                  <MessageManagementItems row={row} session={owner.session} />
                </MenuPopup>
              </MenuRoot>
            </div>
          ))}
          {composer && (
            <MessageComposer
              session={owner.session}
              scope="management-test"
              channelId="room"
              channelName="Room"
            />
          )}
        </MessageManagement>
      </ConversationPresentation>
    );
  }
  const view = render(<Surface />);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  return {
    owner,
    original,
    publications,
    async setRole(next: "member" | "guest") {
      role = next;
      rosterTime++;
      await owner.session.read([{ kinds: [39002], "#d": ["room"], limit: 1 }]);
    },
    async revokeOwner() {
      assert.exists(agent);
      agentProfile = eventDto(
        signed(agent, {
          kind: 0,
          created_at: 1700000001,
          tags: [],
          content: JSON.stringify({ name: "Test agent" }),
        }),
      );
      await owner.session.read([
        { kinds: [0], authors: [agent.pubkey], limit: 1 },
      ]);
    },
    preview: () => view.rerender(<Surface composer={false} />),
    present: (presented: boolean) =>
      view.rerender(<Surface presented={presented} />),
    publication(index: number) {
      const item = publications[index];
      assert.exists(item);
      return item;
    },
  };
}
function editor() {
  return screen.getByRole<ComposerInputElement>("textbox", {
    name: "Edit message",
  });
}
function fill(text: string) {
  const field = screen.getByRole<ComposerInputElement>("textbox");
  act(() => {
    field.focus();
    field.value = text;
    field.setSelectionRange(text.length, text.length);
  });
  fireEvent.input(field);
  fireEvent(document, new Event("selectionchange"));
}
function submit() {
  const form = editor().closest("form");
  if (!form) throw new Error("Expected the mounted composer form");
  fireEvent.submit(form);
}
async function edit() {
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  await waitFor(() => expect(editor()).toHaveValue("Original message"));
  expect(editor()).toHaveFocus();
  expect(screen.queryByRole("dialog", { name: "Edit message" })).toBeNull();
}

it("edits in the composer, retains a rejected change and retries the same operation", async () => {
  const h = await fixture();
  await edit();
  fill("Corrected message");
  submit();
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(editor()).toHaveAttribute("contenteditable", "false");
  await act(async () =>
    h.publication(0).result.reject(new PublishRejected("Edit refused")),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Edit refused");
  expect(editor()).toHaveValue("Corrected message");
  fireEvent.click(screen.getByRole("button", { name: "Retry edit" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(h.owner.session.channels.window("room").rows[0]?.content).toBe(
    "Corrected message",
  );
});

it.each(["member", "guest"] as const)(
  "offers confirmed owner-agent deletion and retry to a joined %s",
  async (role) => {
    const h = await fixture(
      false,
      false,
      false,
      false,
      false,
      "viewer",
      false,
      undefined,
      role,
    );
    const item = await screen.findByRole("menuitem", {
      name: "Delete message",
    });
    await waitFor(() =>
      expect(h.owner.session.profiles.owner?.(h.original.pubkey)).toBe(
        h.owner.session.viewer,
      ),
    );
    expect(item).toBeVisible();
    fireEvent.click(item);
    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete message?",
    });
    expect(confirmation).toHaveTextContent(
      "This requests removal of this message from Buzz’s relay.",
    );
    expect(confirmation).toHaveTextContent("People may still have copies.");
    expect(h.publications).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.publications).toHaveLength(1));
    expect(h.publication(0).event.kind).toBe(5);
    expect(h.publication(0).event.pubkey).toBe(h.owner.session.viewer);
    expect(h.publication(0).event.tags).toContainEqual(["e", h.original.id]);
    if (role === "guest") {
      await act(async () =>
        h.publication(0).result.reject(new PublishRejected("Deletion refused")),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Deletion refused",
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(h.publications).toHaveLength(2));
      expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
      await act(async () => h.publication(1).result.resolve());
    } else await act(async () => h.publication(0).result.resolve());
  },
);

it.each(["member", "guest"] as const)(
  "does not offer agent-message deletion to a %s non-owner",
  async (role) => {
    await fixture(
      false,
      false,
      false,
      false,
      false,
      "other",
      false,
      undefined,
      role,
    );
    await screen.findByRole("menuitem", { name: /Mark (unread|read)/ });
    expect(
      screen.queryByRole("menuitem", { name: "Delete message" }),
    ).toBeNull();
  },
);

it("does not expose edit or delete for another person's message", async () => {
  await fixture(false);
  await screen.findByRole("menuitem", { name: /Mark (unread|read)/ });
  expect(screen.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete message" })).toBeNull();
});

it("restores the unsent draft on cancel without publishing and keeps menu focus in the composer", async () => {
  const h = await fixture();
  // Closing the initial menu returns focus before writing a draft.
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  fill("Unsent draft");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  fill("Temporary correction");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.queryByText("Editing message")).toBeNull();
  expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(h.publications).toHaveLength(0);
});

it("closes an unchanged bound-mention edit without publishing and restores the unsent draft", async () => {
  const h = await fixture(true, false, false, false, true);
  // Dismiss the initial menu before entering an unsent draft.
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  fill("Unsent draft");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  await waitFor(() => expect(editor().value).toContain("[@Honey](nostr:npub1"));
  expect(editor()).toHaveFocus();
  const seeded = editor().value;
  expect(seeded).toContain("Original message");
  submit();
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(h.owner.session.channels.window("room").rows[0]?.content).toBe(
    "@Honey Original message",
  );
  expect(h.publications).toHaveLength(0);
});

it("offers deletion for an empty edit, permits cancel and then confirms deletion", async () => {
  const h = await fixture();
  await edit();
  fill("");
  submit();
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Delete message?",
  });
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(confirmation).not.toBeInTheDocument());
  expect(editor()).toHaveValue("");
  expect(h.publications).toHaveLength(0);
  submit();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.publication(0).event.kind).toBe(5);
  await act(async () => h.publication(0).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
});

it("hides unsent attachments during edit and restores them after cancel and save", async () => {
  const h = await fixture(true, false, true);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  // Uploads belong to the unsent draft, not to the message opened for editing.
  const file = new File(["draft"], "draft-notes.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Choose attachments"), {
    target: { files: [file] },
  });
  expect(
    await screen.findByRole("region", { name: "Attachments" }),
  ).toHaveTextContent("draft-notes.txt");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
  fill("");
  submit();
  expect(
    await screen.findByRole("alertdialog", { name: "Delete message?" }),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.getByRole("region", { name: "Attachments" })).toHaveTextContent(
    "draft-notes.txt",
  );
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  fill("Corrected without the unsent file");
  submit();
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.publication(0).event.kind).toBe(40003);
  expect(h.publication(0).event.content).toBe(
    "Corrected without the unsent file",
  );
  await act(async () => h.publication(0).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(screen.getByRole("region", { name: "Attachments" })).toHaveTextContent(
    "draft-notes.txt",
  );
});

it("rejects an empty edit of a message with original attachments without deleting it", async () => {
  const h = await fixture(true, false, false, true);
  expect(
    h.owner.session.channels.window("room").rows[0]?.attachments.length,
  ).toBeGreaterThan(0);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Edit message" }),
  ).toHaveFocus();
  fill("");
  submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keep attachment links unchanged. To remove this message, use Delete message.",
  );
  expect(
    screen.queryByRole("alertdialog", { name: "Delete message?" }),
  ).toBeNull();
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
  expect(h.publications).toHaveLength(0);
});

it("reverses an own message force from its menu without changing notification eligibility", async () => {
  const h = await fixture();
  const target = {
    kind: "message" as const,
    channelId: "room",
    messageId: h.original.id,
  };
  const channelTarget = { kind: "channel" as const, channelId: "room" };
  expect(h.owner.session.unread.snapshot(target).manual).toBe("none");
  expect(h.owner.session.unread.attention("room", h.original.id)).toMatchObject(
    {
      status: "ineligible",
      unread: false,
      forced: false,
    },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" }));
  await waitFor(() =>
    expect(
      h.owner.session.unread.attention("room", h.original.id),
    ).toMatchObject({
      status: "ineligible",
      unread: false,
      forced: true,
    }),
  );
  expect(h.owner.session.unread.snapshot(target)).toMatchObject({
    observedCount: 0,
    manual: "local-only",
  });
  expect(h.owner.session.unread.snapshot(channelTarget).manual).toBe(
    "local-only",
  );
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark read" }));
  await waitFor(() =>
    expect(h.owner.session.unread.attention("room", h.original.id).forced).toBe(
      false,
    ),
  );
  expect(h.owner.session.unread.snapshot(target)).toMatchObject({
    observedCount: 0,
    manual: "none",
  });
  expect(h.owner.session.unread.snapshot(channelTarget).manual).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Mark unread" }),
  ).toBeVisible();
  expect(h.publications).toHaveLength(0);
});

it.each(["member", "guest"] as const)(
  "lets a joined %s toggle actual unread state and follow without writing",
  async (role) => {
    const h = await fixture(
      false,
      true,
      false,
      false,
      false,
      undefined,
      false,
      undefined,
      role,
    );
    const target = {
      kind: "message" as const,
      channelId: "room",
      messageId: h.original.id,
    };
    expect(h.owner.session.unread.attention("room", h.original.id).unread).toBe(
      true,
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark read" }));
    await waitFor(() =>
      expect(
        h.owner.session.unread.attention("room", h.original.id).unread,
      ).toBe(false),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark unread" }),
    );
    await waitFor(() =>
      expect(
        h.owner.session.unread.attention("room", h.original.id).unread,
      ).toBe(true),
    );
    expect(h.owner.session.unread.snapshot(target).observedCount).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    expect(screen.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Delete message" }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Follow thread" }),
    );
    await waitFor(() =>
      expect(h.owner.session.unread.following("room", h.original.id)).toBe(
        true,
      ),
    );
    expect(h.publications).toHaveLength(0);
  },
);

it("keeps editing and ordinary deletion hidden from a Guest who authored an earlier message", async () => {
  const h = await fixture(
    true,
    false,
    false,
    false,
    false,
    undefined,
    false,
    undefined,
    "guest",
  );
  expect(h.owner.session.channels.get?.("room")?.viewerRole).toBe("guest");
  expect(screen.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Delete message" })).toBeNull();
  expect(h.publications).toHaveLength(0);
});

const savedFollows = () =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith("buzz.thread-follows.v1:"))
    .map((key) => localStorage.getItem(key));

it("follows a thread without replying and keeps the saved choice", async () => {
  localStorage.clear();
  const h = await fixture(false, true);
  expect(h.owner.session.unread.following("room", h.original.id)).toBe(false);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Follow thread" }),
  );
  await waitFor(() =>
    expect(h.owner.session.unread.following("room", h.original.id)).toBe(true),
  );
  expect(savedFollows()).toEqual([
    JSON.stringify([[`room:${h.original.id}`, true]]),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Unfollow thread" }),
  );
  await waitFor(() =>
    expect(h.owner.session.unread.following("room", h.original.id)).toBe(false),
  );
  expect(savedFollows()).toEqual([
    JSON.stringify([[`room:${h.original.id}`, false]]),
  ]);
  expect(h.publications).toHaveLength(0);
});

it("unfollows a thread the viewer started", async () => {
  localStorage.clear();
  const h = await fixture();
  expect(h.owner.session.unread.following("room", h.original.id)).toBe(true);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Unfollow thread" }),
  );
  await waitFor(() =>
    expect(h.owner.session.unread.following("room", h.original.id)).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Follow thread" }),
  ).toBeVisible();
});

it("keeps showing Follow thread when the choice cannot be saved", async () => {
  localStorage.clear();
  const h = await fixture(false);
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
  try {
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Follow thread" }),
    );
    expect(setItem).toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
  expect(h.owner.session.unread.following("room", h.original.id)).toBe(false);
  expect(savedFollows()).toEqual([]);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save thread follow. Try again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Follow thread" }),
  );
  await waitFor(() =>
    expect(h.owner.session.unread.following("room", h.original.id)).toBe(true),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(savedFollows()).toEqual([
    JSON.stringify([[`room:${h.original.id}`, true]]),
  ]);
});

it("offers the follow choice only once a restored roster is confirmed", async () => {
  localStorage.clear();
  const h = await fixture(false);
  h.owner.session.unread.follow("room", h.original.id, true);
  cleanup();
  const live = h.owner.session.channels.list();
  // Discovery marks a restored roster both cached and read-only.
  let snapshot: typeof live = {
    ...live,
    channels: live.channels.map((channel) => ({
      ...channel,
      cached: true,
      readOnly: true,
    })),
  };
  const listeners = new Set<() => void>();
  const session = {
    ...h.owner.session,
    channels: {
      ...h.owner.session.channels,
      list: () => snapshot,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const row = session.channels.window("room").rows[0];
  assert.exists(row);
  render(
    <MessageManagement session={session} channelId="room">
      <MenuRoot>
        <MenuTrigger>Thread actions</MenuTrigger>
        <MenuPopup>
          <MessageManagementItems row={row} session={session} />
        </MenuPopup>
      </MenuRoot>
    </MessageManagement>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
  await act(async () => {});
  expect(screen.queryByRole("menuitem", { name: /follow thread/i })).toBeNull();
  await act(async () => {
    snapshot = live;
    for (const listener of listeners) listener();
  });
  expect(
    await screen.findByRole("menuitem", { name: "Unfollow thread" }),
  ).toBeVisible();
});

it("keeps deletion recovery outside the optimistically removed row", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  await screen.findByRole("alertdialog", { name: "Delete message?" });
  expect(h.publications).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  expect(h.owner.session.channels.window("room").rows).toHaveLength(0);
  await act(async () =>
    h.publication(0).result.reject(new PublishRejected("Deletion refused")),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Deletion refused",
  );
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("cancelling deletion never publishes", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(h.publications).toHaveLength(0);
  expect(h.owner.session.channels.window("room").rows).toHaveLength(1);
});

it("recovers an uncertain deletion after the row and dialog disappear", async () => {
  const h = await fixture();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  await act(async () =>
    h.publication(0).result.reject(new Error("Connection lost")),
  );
  fireEvent.click(await screen.findByText("Close", { exact: true }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Message actions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry message update" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () => h.publication(1).result.resolve());
});

it.each(["failed", "unknown"] as const)(
  "disables %s own-message deletion retry after demotion to Guest",
  async (delivery) => {
    const h = await fixture();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete message" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.publications).toHaveLength(1));
    await act(async () =>
      h
        .publication(0)
        .result.reject(
          delivery === "failed"
            ? new PublishRejected("Deletion refused")
            : new Error("Connection lost"),
        ),
    );
    fireEvent.click(await screen.findByText("Close", { exact: true }));
    const retry = await screen.findByRole("button", {
      name: "Retry message update",
    });
    expect(retry).toBeEnabled();
    await act(async () => h.setRole("guest"));
    expect(h.owner.session.channels.get?.("room")?.viewerRole).toBe("guest");
    await waitFor(() => expect(retry).toBeDisabled());
    fireEvent.click(retry);
    expect(h.publications).toHaveLength(1);
  },
);

it("retries an owned-agent deletion without its row and disables retry when ownership is revoked", async () => {
  const h = await fixture(
    false,
    false,
    false,
    false,
    false,
    "viewer",
    false,
    undefined,
    "guest",
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  await act(async () =>
    h.publication(0).result.reject(new Error("Connection lost")),
  );
  fireEvent.click(await screen.findByText("Close", { exact: true }));
  expect(h.owner.session.channels.window("room").rows).toHaveLength(0);
  const retry = await screen.findByRole("button", {
    name: "Retry message update",
  });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  await act(async () =>
    h.publication(1).result.reject(new PublishRejected("Deletion refused")),
  );
  const revokedRetry = await screen.findByRole("button", {
    name: "Retry message update",
  });
  expect(revokedRetry).toBeEnabled();
  await act(async () => h.revokeOwner());
  await waitFor(() => expect(revokedRetry).toBeDisabled());
  fireEvent.click(revokedRetry);
  expect(h.publications).toHaveLength(2);
});

/** Sends a message the relay does not accept and opens that row's menu. */
async function unsent(
  h: Awaited<ReturnType<typeof fixture>>,
  error: Error,
  delivery: "failed" | "unknown",
) {
  fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  let id = "";
  act(() => {
    id = h.owner.session.messages.send("room", "Unsent message");
  });
  await waitFor(() => expect(h.publications).toHaveLength(1));
  await act(async () => h.publication(0).result.reject(error));
  await waitFor(() =>
    expect(
      h.owner.session.channels.window("room").rows.find((row) => row.id === id)
        ?.delivery,
    ).toBe(delivery),
  );
  const row = screen.getByText("Unsent message").parentElement;
  assert.exists(row);
  fireEvent.click(within(row).getByRole("button", { name: "Message actions" }));
  return id;
}

it("deletes a failed send from this device without publishing, so no restart restores or retries it", async () => {
  let saved: readonly OutgoingEvent[] = [];
  let refusal: string | undefined;
  const viewer = keypair();
  const h = await fixture(
    true,
    false,
    false,
    false,
    false,
    undefined,
    false,
    undefined,
    "member",
    {
      viewer,
      outboxStorage: {
        load: () => saved,
        save(records) {
          if (refusal) throw new Error(refusal);
          saved = records;
        },
      },
    },
  );
  const id = await unsent(h, new PublishRejected("Message refused"), "failed");
  // A restart restores this journal, which retains the failed send for retry.
  await waitFor(() =>
    expect(saved).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ id }),
        delivery: "failed",
      }),
    ),
  );
  const remove = await screen.findByRole("menuitem", {
    name: "Delete message",
  });
  expect(screen.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
  expect(
    screen.queryByRole("menuitem", { name: /Mark (unread|read)|Follow/ }),
  ).toBeNull();
  fireEvent.click(remove);
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Delete message?",
  });
  expect(confirmation).toHaveTextContent(
    "This message wasn’t sent. Deleting it removes it from this device.",
  );
  refusal = "Storage unavailable";
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
  expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
    "Storage unavailable",
  );
  expect(saved.some((item) => item.event.id === id)).toBe(true);
  expect(screen.getByText("Unsent message")).toBeInTheDocument();
  refusal = undefined;
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByText("Unsent message")).toBeNull();
  expect(saved.some((item) => item.event.id === id)).toBe(false);
  expect(
    h.owner.session.outbox?.snapshot().some((item) => item.event.id === id),
  ).toBe(false);
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
  // Neither a NIP-09 deletion nor a retry followed the refused send.
  expect(h.publications).toHaveLength(1);
  cleanup();
  const restarted = await fixture(
    true,
    false,
    false,
    false,
    false,
    undefined,
    false,
    undefined,
    "member",
    { viewer, outboxStorage: { load: () => saved, save() {} } },
  );
  await restarted.owner.session.outbox?.ready();
  expect(screen.queryByText("Unsent message")).toBeNull();
});

it("reports a failed send that started retrying instead of deleting it", async () => {
  const h = await fixture();
  const id = await unsent(h, new PublishRejected("Message refused"), "failed");
  const delivery = () =>
    h.owner.session.outbox?.snapshot().find((item) => item.event.id === id)
      ?.delivery;
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Delete message?",
  });
  act(() => h.owner.session.outbox?.retry(id));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  try {
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
      "This message’s delivery changed.",
    );
    expect(delivery()).toBe("sending");
  } finally {
    await act(async () =>
      h.publication(1).result.reject(new PublishRejected("Message refused")),
    );
  }
  await waitFor(() => expect(delivery()).toBe("failed"));
  fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(delivery()).toBeUndefined();
  expect(h.publications).toHaveLength(2);
});

it.each(["archived", "left"] as const)(
  "deletes a failed send in a channel that was %s, which only gates relay changes",
  async (state) => {
    const h = await fixture();
    const id = await unsent(
      h,
      new PublishRejected("invalid: channel is archived"),
      "failed",
    );
    cleanup();
    const live = h.owner.session.channels.list();
    // A channel the viewer left is no longer listed at all.
    const closed = {
      ...live,
      channels:
        state === "left"
          ? []
          : live.channels.map((channel) => ({
              ...channel,
              archived: true as const,
              readOnly: true as const,
            })),
    };
    const session = {
      ...h.owner.session,
      channels: { ...h.owner.session.channels, list: () => closed },
    };
    const row = session.channels
      .window("room")
      .rows.find((item) => item.id === id);
    assert.exists(row);
    render(
      <MessageManagement session={session} channelId="room">
        <MenuRoot>
          <MenuTrigger>Message actions</MenuTrigger>
          <MenuPopup>
            <MessageManagementItems row={row} session={session} />
          </MenuPopup>
        </MenuRoot>
      </MessageManagement>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete message" }),
    );
    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete message?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(
      session.outbox?.snapshot().some((item) => item.event.id === id),
    ).toBe(false);
    expect(h.publications).toHaveLength(1);
  },
);

it("does not offer local deletion for an unconfirmed send, which may have reached the relay", async () => {
  const h = await fixture();
  await unsent(h, new Error("Connection lost"), "unknown");
  await screen.findByRole("menu");
  expect(screen.queryByRole("menuitem", { name: "Delete message" })).toBeNull();
});

it("waits for confirmed membership before entering a restored channel visit", async () => {
  const h = await fixture();
  cleanup();
  const live = h.owner.session.channels.list();
  let snapshot: typeof live = {
    ...live,
    channels: live.channels.map((channel) => ({
      ...channel,
      cached: true,
      readOnly: true,
    })),
  };
  const listeners = new Set<() => void>();
  const enterChannel = vi.fn(h.owner.session.unread.enterChannel);
  const leaveChannel = vi.fn(h.owner.session.unread.leaveChannel);
  const session = {
    ...h.owner.session,
    channels: {
      ...h.owner.session.channels,
      list: () => snapshot,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    unread: { ...h.owner.session.unread, enterChannel, leaveChannel },
  };
  const mounted = render(
    <MessageManagement session={session} channelId="room">
      Restored conversation
    </MessageManagement>,
  );
  await act(async () => {});
  expect(enterChannel).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    snapshot = live;
    for (const listener of listeners) listener();
  });
  expect(enterChannel).toHaveBeenCalledExactlyOnceWith(
    "room",
    document.hasFocus(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  mounted.unmount();
  expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("room");
});

it("offers no read action on an agents-audience message", async () => {
  const h = await fixture(false, true);
  cleanup();
  const row = h.owner.session.channels.window("room").rows[0];
  assert.exists(row);
  render(
    <MessageManagement session={h.owner.session} channelId="room">
      <MenuRoot>
        <MenuTrigger>Read actions</MenuTrigger>
        <MenuPopup>
          <MessageReadStateItem
            row={{ ...row, audience: "agents" }}
            session={h.owner.session}
          />
          <MessageReadStateItem row={row} session={h.owner.session} />
        </MenuPopup>
      </MenuRoot>
    </MessageManagement>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Read actions" }));
  expect(
    await screen.findAllByRole("menuitem", { name: /^Mark (un)?read$/ }),
  ).toHaveLength(1);
});

it("offers no keyboard unread action on an agents-audience message", async () => {
  const h = await fixture(false, true);
  cleanup();
  const row = h.owner.session.channels.window("room").rows[0];
  assert.exists(row);
  await h.owner.session.unread.markMessageRead("room", row.id);
  const seen: boolean[] = [];
  const Probe = () => {
    const actions = useMessageKeyActions(h.owner.session);
    assert.exists(actions);
    seen.push(
      actions.canMarkUnread(row),
      actions.canMarkUnread({ ...row, audience: "agents" }),
    );
    return null;
  };
  render(
    <MessageManagement session={h.owner.session} channelId="room">
      <Probe />
    </MessageManagement>,
  );
  expect(seen.slice(-2)).toEqual([true, false]);
});

async function heldUnreadAction(action: "read" | "unread") {
  const h = await fixture(action === "unread", true);
  cleanup();
  const result = deferred<void>();
  const mutation = vi.fn(async () => {
    await result.promise;
    return {
      operationId: "held-read-action",
      durability: "saved" as const,
      sync: "local-only" as const,
    };
  });
  const session = {
    ...h.owner.session,
    unread: {
      ...h.owner.session.unread,
      ...(action === "read"
        ? { markMessageRead: mutation }
        : { markMessageUnread: mutation }),
    },
  };
  const row = session.channels.window("room").rows[0];
  assert.exists(row);
  const surface = (channelId = "room", current = session) => (
    <MessageManagement session={current} channelId={channelId}>
      <MenuRoot>
        <MenuTrigger>Read actions</MenuTrigger>
        <MenuPopup>
          <MessageReadStateItem row={row} session={current} />
        </MenuPopup>
      </MenuRoot>
    </MessageManagement>
  );
  const mounted = render(surface());
  fireEvent.click(screen.getByRole("button", { name: "Read actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: `Mark ${action}` }),
  );
  expect(mutation).toHaveBeenCalledExactlyOnceWith("room", row.id);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return { result, mutation, mounted, surface, session };
}

it.each(["read", "unread"] as const)(
  "does not show a delayed Mark %s failure in another channel or a later visit",
  async (action) => {
    const h = await heldUnreadAction(action);
    try {
      h.mounted.rerender(h.surface("other"));
      await act(async () => h.result.reject(new Error("Old visit failed")));
      expect(screen.queryByRole("alert")).toBeNull();
      h.mounted.rerender(h.surface());
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      await act(async () => h.result.resolve());
    }
  },
);

it.each(["revisit", "session"] as const)(
  "ignores an old action after %s even when the channel ID matches",
  async (transition) => {
    const h = await heldUnreadAction("unread");
    try {
      if (transition === "revisit") {
        h.mounted.rerender(h.surface("other"));
        h.mounted.rerender(h.surface());
      } else {
        h.mounted.rerender(h.surface("room", { ...h.session }));
      }
      await act(async () => h.result.reject(new Error("Old visit failed")));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      await act(async () => h.result.resolve());
    }
  },
);

it("retains same-visit errors after the menu closes, but removes them on navigation", async () => {
  const h = await heldUnreadAction("unread");
  try {
    await act(async () => h.result.reject(new Error("Save failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.queryByRole("menu")).toBeNull();
    h.mounted.rerender(h.surface("other"));
    expect(screen.queryByRole("alert")).toBeNull();
    h.mounted.rerender(h.surface());
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    await act(async () => h.result.resolve());
  }
});

it("keeps a new visit's failure when an older visit finishes later", async () => {
  const h = await heldUnreadAction("unread");
  try {
    h.mounted.rerender(h.surface("other"));
    h.mounted.rerender(h.surface());
    h.mutation.mockRejectedValueOnce(new Error("Current visit failed"));
    fireEvent.click(screen.getByRole("button", { name: "Read actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark unread" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Current visit failed",
    );
    await act(async () => h.result.reject(new Error("Old visit failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Current visit failed");
  } finally {
    await act(async () => h.result.resolve());
  }
});

it("scopes channel-entry failures to their visit and clears displayed failures on retarget", async () => {
  const h = await fixture();
  cleanup();
  const result = deferred<void>();
  const enterChannel = vi.fn(() => result.promise);
  const session = {
    ...h.owner.session,
    unread: { ...h.owner.session.unread, enterChannel },
  };
  const surface = (channelId: string) => (
    <MessageManagement session={session} channelId={channelId}>
      Conversation
    </MessageManagement>
  );
  const mounted = render(surface("room"));
  expect(enterChannel).toHaveBeenCalledOnce();
  try {
    mounted.rerender(surface("other"));
    await act(async () => result.reject(new Error("Old entry failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    enterChannel.mockRejectedValueOnce(new Error("Current entry failed"));
    mounted.rerender(surface("room"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Current entry failed",
    );
    mounted.rerender(surface("other"));
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    await act(async () => result.resolve());
  }
});

it("keeps one unread visit until the last channel or thread view closes", async () => {
  const h = await fixture();
  cleanup();
  const enterChannel = vi.fn(h.owner.session.unread.enterChannel);
  const leaveChannel = vi.fn(h.owner.session.unread.leaveChannel);
  const session = {
    ...h.owner.session,
    unread: { ...h.owner.session.unread, enterChannel, leaveChannel },
  };
  const channel = render(
    <MessageManagement session={session} channelId="room">
      Channel
    </MessageManagement>,
  );
  const thread = render(
    <MessageManagement session={session} channelId="room">
      Thread
    </MessageManagement>,
  );
  await act(async () => {});
  expect(enterChannel).toHaveBeenCalledExactlyOnceWith(
    "room",
    document.hasFocus(),
  );
  channel.rerender(
    <MessageManagement session={session} channelId="room" active={false}>
      Channel
    </MessageManagement>,
  );
  expect(leaveChannel).not.toHaveBeenCalled();
  channel.unmount();
  expect(leaveChannel).not.toHaveBeenCalled();
  thread.unmount();
  expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("room");
  const revisit = render(
    <MessageManagement session={session} channelId="room">
      Revisit
    </MessageManagement>,
  );
  await act(async () => {});
  expect(enterChannel).toHaveBeenCalledTimes(2);
  revisit.unmount();
  expect(leaveChannel).toHaveBeenCalledTimes(2);
});

it("keeps a withheld empty-edit deletion recoverable and restores the draft only after retry succeeds", async () => {
  const h = await fixture();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  fill("Unsent reply draft");
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  await edit();
  fill("");
  submit();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.publications).toHaveLength(1));
  h.present(false);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await act(async () =>
    h.publication(0).result.reject(new PublishRejected("Deletion refused")),
  );
  expect(editor()).toHaveValue("");
  expect(screen.getByText("Message deletion: Deletion refused")).toBeVisible();
  h.present(true);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry message update" }));
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publication(1).event.id).toBe(h.publication(0).event.id);
  expect(editor()).toHaveValue("");
  await act(async () => h.publication(1).result.resolve());
  await waitFor(() => expect(screen.queryByText("Editing message")).toBeNull());
  expect(screen.getByRole("textbox")).toHaveValue("Unsent reply draft");
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("does not offer Edit message in a preview without a composer", async () => {
  const t = await fixture();
  expect(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Edit message" }), {
    key: "Escape",
  });
  t.preview();
  fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Delete message" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("menuitem", { name: "Edit message" }),
  ).not.toBeInTheDocument();
  expect(t.publications).toHaveLength(0);
});

it("row visits follow document focus and visibility, including inactive entry and final cleanup", async () => {
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  try {
    const h = await fixture(false, true);
    cleanup();
    const setActive = vi.fn(h.owner.session.unread.setChannelActive);
    const session = {
      ...h.owner.session,
      unread: { ...h.owner.session.unread, setChannelActive: setActive },
    };
    render(
      <MessageManagement session={session} channelId="room">
        Conversation
      </MessageManagement>,
    );
    await act(async () => {});
    const unread = session.unread;
    const snapshot = () =>
      unread.snapshot({ kind: "channel", channelId: "room" });
    expect(snapshot().row?.observedCount).toBe(1);
    focus.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(snapshot().row?.observedCount).toBe(0);
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    // A focus notification while hidden must not resume the visit.
    act(() => window.dispatchEvent(new Event("focus")));
    expect(setActive).toHaveBeenLastCalledWith("room", false);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(setActive).toHaveBeenLastCalledWith("room", true);
    focus.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(setActive).toHaveBeenLastCalledWith("room", false);
    cleanup();
    setActive.mockClear();
    focus.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(setActive).not.toHaveBeenCalled();
  } finally {
    focus.mockRestore();
    visibility.mockRestore();
  }
});
