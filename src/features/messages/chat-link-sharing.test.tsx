// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent, ReadFilter } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { MessageComposer } from "./MessageComposer";
import { composerDOMFixture } from "./composer-testing";
import { writeView } from "../../shared/view-state";

composerDOMFixture();
const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const second = "33333333-3333-4333-8333-333333333333";
const root = "a".repeat(64);
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
async function fixture(
  thread = false,
  options: {
    destinationType?: string;
    visibility?: "public" | "private";
    joinRole?: "member" | "guest";
    owned?: boolean;
    shared?: boolean;
    alone?: boolean;
    multiple?: boolean;
    viewOnlySecond?: boolean;
  } = {},
) {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  let clock = Math.floor(Date.now() / 1000);
  const members = new Map([
    [source, options.shared ? [viewer.pubkey, person.pubkey] : [viewer.pubkey]],
    [
      destination,
      options.alone ? [viewer.pubkey] : [viewer.pubkey, person.pubkey],
    ],
    ...(options.multiple
      ? [[second, [viewer.pubkey]] as [string, string[]]]
      : []),
  ]);
  const metadataEvents = new Map(
    [source, ...(options.multiple ? [second] : [])].map((id) => [
      id,
      metadata(relay, id, id === source ? "Work" : "Other work", clock, [
        ["t", "stream"],
        ["t", "buzz.solo"],
        [
          id === second && options.viewOnlySecond
            ? "public"
            : (options.visibility ?? "private"),
        ],
        [
          "join_role",
          id === second && options.viewOnlySecond
            ? "guest"
            : (options.joinRole ?? "member"),
        ],
        ["P", options.owned === false ? person.pubkey : viewer.pubkey],
      ]),
    ]),
  );
  const published: RelayEvent[] = [];
  let reject = false,
    loseResponse = false;
  let hold: Promise<void> | undefined;
  let onQuery: ((filters: readonly ReadFilter[]) => void) | undefined;
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9002) {
      await hold;
      if (reject) throw new PublishRejected("Access refused");
      const id = event.tags.find(([tag]) => tag === "h")?.[1] ?? "";
      const previous = metadataEvents.get(id);
      if (!previous) throw new Error("Unknown chat");
      const tags = previous.tags.filter(
        ([tag]) =>
          tag !== "d" &&
          tag !== "name" &&
          tag !== "private" &&
          tag !== "public" &&
          tag !== "join_role",
      );
      metadataEvents.set(
        id,
        metadata(
          relay,
          id,
          event.tags.find(([tag]) => tag === "name")?.[1] ??
            (id === source ? "Work" : "Other work"),
          ++clock,
          [...tags, ["public"], ["join_role", "guest"]],
        ),
      );
    }
    published.push(event);
    if (event.kind === 9002 && loseResponse) throw new Error("Lost response");
  });
  const sign = vi.fn(async (event: Parameters<typeof signed>[1]) =>
    signed(viewer, event),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      scope: "https://test.example",
      media: () => undefined,
      query: async (filters: readonly ReadFilter[]) => {
        onQuery?.(filters);
        return [
          ...metadataEvents.values(),
          metadata(relay, destination, "Team", clock, [
            ["t", options.destinationType ?? "stream"],
            ["private"],
          ]),
          ...[...members].flatMap(([id, keys]) => [
            signed(relay, {
              kind: 39001,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ...(options.owned !== false && id !== destination
                  ? [["p", viewer.pubkey, "owner"]]
                  : []),
              ],
            }),
            signed(relay, {
              kind: 39002,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ...keys.map((key) => [
                  "p",
                  key,
                  "",
                  key === viewer.pubkey &&
                  options.owned !== false &&
                  id !== destination
                    ? "owner"
                    : "member",
                ]),
              ],
            }),
          ]),
          ...published,
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: { sign, publish },
      writer: {
        kinds: [9, 9000, 9002],
        sign: async (event) => signed(viewer, event),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(members.size),
  );
  const key = `draft:${destination}${thread ? `:thread:${root}` : ""}`;
  writeView(
    owner.session.scope,
    key,
    `${[source, ...(options.multiple ? [second] : [])].map((id) => `buzz://channel/${id}`).join("\n\n")}\n\nPlease look at this`,
  );
  const view = render(
    <MessageComposer
      session={owner.session}
      scope={owner.session.scope}
      channelId={destination}
      channelName="Team"
      {...(thread ? { threadRootId: root } : {})}
    />,
  );
  return {
    view,
    session: owner.session,
    sign,
    published,
    publish,
    members,
    key,
    viewer,
    person,
    reject(value: boolean) {
      reject = value;
    },
    loseResponse(value: boolean) {
      loseResponse = value;
    },
    hold(value: Promise<void>) {
      hold = value;
    },
    watchQueries(value: (filters: readonly ReadFilter[]) => void) {
      onQuery = value;
    },
    makePublic(joinRole = "member") {
      metadataEvents.set(
        source,
        metadata(relay, source, "Work", ++clock, [
          ["t", "stream"],
          ["t", "buzz.solo"],
          ["public"],
          ["join_role", joinRole],
          ["P", viewer.pubkey],
        ]),
      );
    },
    changeDetails({ name = "Work", visibility = "private" } = {}) {
      metadataEvents.set(
        source,
        metadata(relay, source, name, ++clock, [
          ["t", "stream"],
          ["t", "buzz.solo"],
          [visibility],
          ["join_role", options.joinRole ?? "member"],
          ["P", viewer.pubkey],
        ]),
      );
    },
  };
}
const send = () =>
  userEvent.click(screen.getByRole("button", { name: "Send message" }));
const confirm = async () =>
  userEvent.click(await screen.findByRole("button", { name: "Share" }));

it.each([false, true])(
  "confirms community reading before posting exactly once, without grants (thread=%s)",
  async (thread) => {
    const f = await fixture(thread);
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await send();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Share this chat?",
    });
    expect(dialog).toHaveAccessibleDescription(
      /^This changes the chat from Private to View only and sends your message and chat link to #Team\./,
    );
    expect(dialog).toHaveTextContent(
      "full history, Canvas, workspace folders, and agent instructions",
    );
    expect(dialog).toHaveTextContent("#Team");
    expect(screen.queryByRole("button", { name: "Send link only" })).toBeNull();
    expect(f.publish).not.toHaveBeenCalled();
    await confirm();
    try {
      await waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
      expect(f.published).toHaveLength(0);
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
    );
    expect(f.members.get(source)).toEqual([f.viewer.pubkey]);
    expect(f.published[0]?.tags).toContainEqual(["visibility", "open"]);
    expect(f.published[0]?.tags).toContainEqual(["join_role", "guest"]);
    const message = f.published[1];
    expect(message?.content).toContain("Please look at this");
    if (thread) expect(message?.tags).toContainEqual(["e", root, "", "reply"]);
    else expect(message?.tags.some(([tag]) => tag === "e")).toBe(false);
  },
);

it("Cancel preserves access and the original draft", async () => {
  const f = await fixture(true);
  await send();
  await screen.findByRole("alertdialog");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(f.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Please look at this");
  await send();
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
});

it.each(["member", "guest"] as const)(
  "an already open owned chat (%s) preserves access and confirms View only delivery",
  async (joinRole) => {
    const f = await fixture(false, { visibility: "public", joinRole });
    await send();
    if (joinRole === "guest") {
      const dialog = await screen.findByRole("alertdialog", {
        name: "Share this chat?",
      });
      expect(dialog).toHaveAccessibleDescription(
        /^This chat is already View only\. Your message and chat link will be sent to #Team\./,
      );
      expect(f.publish).not.toHaveBeenCalled();
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Cancel" }),
      );
      expect(screen.getByRole("textbox")).toHaveTextContent(
        "Please look at this",
      );
      expect(f.publish).not.toHaveBeenCalled();
      await send();
      await confirm();
    }
    await waitFor(() =>
      expect(f.published.map((event) => event.kind)).toEqual([9]),
    );
    expect(f.sign).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      f.session.channels.list().channels.find((item) => item.id === source)
        ?.joinRole,
    ).toBe(joinRole);
  },
);

it("a chat the viewer does not own sends as a link without granting access", async () => {
  const f = await fixture(false, { owned: false });
  await send();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9]),
  );
  expect(f.sign).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(f.members.get(source)).toEqual([f.viewer.pubkey]);
});

it("access rejection keeps the message unsent and allows explicit retry", async () => {
  const f = await fixture();
  f.reject(true);
  await send();
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent("Access refused");
  expect(f.published).toHaveLength(0);
  f.reject(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Retry share and send" }),
  );
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
});

it("checks an uncertain save without resending it before sending the message", async () => {
  const f = await fixture();
  f.loseResponse(true);
  await send();
  await confirm();
  await screen.findByRole("button", { name: "Check access and send" });
  expect(f.published.map((event) => event.kind)).toEqual([9002]);
  f.loseResponse(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Check access and send" }),
  );
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(f.sign).toHaveBeenCalledOnce();
});

it("does not send after leaving while an already-dispatched access save finishes", async () => {
  const f = await fixture(true);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await send();
  await confirm();
  try {
    await waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    f.view.unmount();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002]),
  );
  await act(async () => {
    await f.session.outbox?.ready();
  });
  expect(f.published.map((event) => event.kind)).toEqual([9002]);
});

it("a private chat still needs community consent when destination members already have access or it is empty", async () => {
  const f = await fixture(false, { shared: true, alone: true });
  await send();
  await screen.findByRole("alertdialog");
  expect(f.publish).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
});

it("sharing into a DM uses community consent without adding its participants", async () => {
  const f = await fixture(false, { destinationType: "dm" });
  await send();
  expect(await screen.findByRole("alertdialog")).toHaveTextContent("this DM");
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(f.members.get(source)).toEqual([f.viewer.pubkey]);
});

it("a changed draft stops all access writes and sending while consent is open", async () => {
  const f = await fixture();
  await send();
  await screen.findByRole("alertdialog");
  act(() => writeView(f.session.scope, f.key, "Something else"));
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The draft changed",
  );
  expect(f.publish).not.toHaveBeenCalled();
});

it("stops before publication if the draft changes during signing", async () => {
  const f = await fixture();
  const original = f.sign.getMockImplementation();
  if (!original) throw new Error("Missing signer");
  f.sign.mockImplementationOnce(async (event) => {
    act(() => writeView(f.session.scope, f.key, "Something else"));
    return original(event);
  });
  await send();
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The draft changed",
  );
  expect(f.publish).not.toHaveBeenCalled();
});

it("multiple private links are confirmed together and opened before one message, with safe partial retry", async () => {
  const f = await fixture(false, { multiple: true });
  f.publish.mockImplementationOnce(async (event) => {
    // Use normal publication for the first chat, then reject the second.
    const original = f.publish.getMockImplementation();
    if (!original) throw new Error("Missing publisher");
    await original(event);
    f.reject(true);
  });
  await send();
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "Work, Other work",
  );
  await confirm();
  expect(await screen.findByRole("alert")).toHaveTextContent("Access refused");
  expect(f.published.map((event) => event.kind)).toEqual([9002]);
  f.reject(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Retry share and send" }),
  );
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9002, 9]),
  );
});

it("confirms mixed Private and View only links without rewriting the View only chat", async () => {
  const f = await fixture(false, { multiple: true, viewOnlySecond: true });
  await send();
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveAccessibleName("Share these chats?");
  expect(dialog).toHaveTextContent(
    "Private chats will change to View only; the other chats will stay View only.",
  );
  expect(dialog).toHaveTextContent(
    "Everyone in this community can read each chat’s full history, Canvas, workspace folders, and agent instructions.",
  );
  expect(dialog).toHaveTextContent("Work, Other work");
  expect(f.publish).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
  expect(f.published[0]?.tags).toContainEqual(["h", source]);
  expect(f.published[1]?.content).toContain(`buzz://channel/${second}`);
  expect(f.members.get(second)).toEqual([f.viewer.pubkey]);
});

it("a chat that becomes Public during consent keeps Public and only sends the message", async () => {
  const f = await fixture();
  await send();
  await screen.findByRole("alertdialog");
  f.makePublic();
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9]),
  );
  expect(f.sign).not.toHaveBeenCalled();
});

it("asks for fresh Private consent when a pasted View only chat narrows before Share", async () => {
  const f = await fixture(false, { visibility: "public", joinRole: "guest" });
  await send();
  await screen.findByRole("alertdialog", { name: "Share this chat?" });
  f.changeDetails();
  await confirm();
  const renewed = await screen.findByRole("alertdialog", {
    name: "Share this chat?",
    description: /from Private to View only/,
  });
  await waitFor(() =>
    expect(
      within(renewed).getByRole("button", { name: "Share" }),
    ).toHaveFocus(),
  );
  expect(renewed).toHaveTextContent("from Private to View only");
  expect(within(renewed).queryByRole("alert")).toBeNull();
  expect(f.publish).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() =>
    expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
  );
});

it.each(["before confirmation", "during signing"])(
  "renews pasted-link consent after details change %s without writing until Share is confirmed again",
  async (when) => {
    const f = await fixture();
    await send();
    await screen.findByRole("alertdialog");
    if (when === "during signing") {
      const original = f.sign.getMockImplementation();
      if (!original) throw new Error("Missing signer");
      f.sign.mockImplementationOnce(async (event) => {
        f.changeDetails({ name: "Updated work" });
        return original(event);
      });
    } else f.changeDetails({ name: "Updated work" });
    await confirm();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share" })).toHaveFocus(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
    expect(f.publish).not.toHaveBeenCalled();
    await confirm();
    await waitFor(() =>
      expect(f.published.map((event) => event.kind)).toEqual([9002, 9]),
    );
    expect(f.published[0]?.tags).toContainEqual(["name", "Updated work"]);
  },
);
