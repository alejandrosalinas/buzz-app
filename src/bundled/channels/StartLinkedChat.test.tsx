// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import {
  readLinkedChat,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import { soloDraft } from "../../features/channel-navigation/routes";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { readView, writeView } from "../../shared/view-state";
import { StartLinkedChat, canStartLinkedChatFrom } from "./StartLinkedChat";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const viewer = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64);
const scope = `https://relay.test:${viewer}`;
/** Each open, like the controller's, supersedes the current attempt. */
function fakeNavigation() {
  let attempt = 0;
  const open = vi.fn<Navigation["open"]>(async () => {
    attempt++;
    return { status: "opened" };
  });
  const navigation = {
    ...({} as Navigation),
    open,
    snapshot: () =>
      ({ attempt: { id: `attempt-${attempt}` } }) as ReturnType<
        Navigation["snapshot"]
      >,
  };
  return {
    open,
    navigation,
    /** Another destination wins without going through this action. */
    elsewhere: () => {
      attempt++;
    },
  };
}
const session = {
  ...owner.session,
  viewer,
  scope,
  channels: {
    ...owner.session.channels,
    list: () => ({
      status: "ready" as const,
      channels: [
        {
          id: "design",
          name: "Design",
          channelType: "stream" as const,
          members: [viewer],
        },
      ],
    }),
  },
  channelWrites: { ...owner.session.channelWrites, available: true },
};
const message = {
  id: reply,
  channelId: "design",
  threadRootId: root,
  delivery: "seen" as const,
  authorId: viewer,
  content: "Please look at this",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
it("opens an isolated Solo draft with the exact source link", async () => {
  const { open, navigation } = fakeNavigation();
  const view = render(
    <MenuRoot>
      <MenuTrigger>Message actions</MenuTrigger>
      <MenuPopup>
        <StartLinkedChat
          session={session}
          navigation={navigation}
          channelId="design"
          message={message}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  const item = await screen.findByRole("menuitem", { name: "Start Solo chat" });
  expect(item).not.toHaveAttribute("aria-haspopup");
  await user.click(item);
  expect(open).toHaveBeenCalledOnce();
  const destination = open.mock.calls[0]?.[0];
  const parsed =
    destination?.kind === "page"
      ? soloDraft(destination.route?.params)
      : undefined;
  const id = parsed?.linked;
  expect(id).toBeTruthy();
  expect(parsed).toEqual({ linked: id });
  expect(readLinkedChat(scope, linkedDraftKey(id ?? ""))).toEqual({
    channelId: "design",
    link: `buzz://message?channel=design&id=${reply}&thread=${root}`,
  });
  // Starting again from the same source returns to its unsent prompt.
  writeView(scope, `${linkedDraftKey(id ?? "")}:new-draft`, "Half typed");
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Start Solo chat" }),
  );
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  const again = open.mock.calls[1]?.[0];
  expect(
    again?.kind === "page" ? soloDraft(again.route?.params)?.linked : undefined,
  ).toBe(id);
  expect(readView(scope, `${linkedDraftKey(id ?? "")}:new-draft`, "")).toBe(
    "Half typed",
  );
  view.unmount();
});

it("drops a start whose visit was superseded while its draft id was computed", async () => {
  const { open, navigation, elsewhere } = fakeNavigation();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (algorithm, data) => {
      await held;
      return digest(algorithm, data);
    });
  try {
    render(
      <MenuRoot>
        <MenuTrigger>Message actions</MenuTrigger>
        <MenuPopup>
          <StartLinkedChat
            session={session}
            navigation={navigation}
            channelId="design"
            message={message}
          />
        </MenuPopup>
      </MenuRoot>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Message actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Start Solo chat" }),
    );
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
    elsewhere();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it.each([
  ["a Solo chat", { channelType: "solo" as const, members: [viewer] }],
  ["a DM", { channelType: "dm" as const, members: [viewer] }],
  [
    "an archived, read-only channel",
    {
      channelType: "stream" as const,
      archived: true as const,
      readOnly: true as const,
    },
  ],
  ["an unjoined channel", { channelType: "forum" as const, members: [] }],
  ["a channel missing from the list", undefined],
])("starts from a message in %s", async (_label, shape) => {
  const { open, navigation } = fakeNavigation();
  const anywhere = {
    ...session,
    channels: {
      ...session.channels,
      list: () => ({
        status: "ready" as const,
        channels: shape ? [{ id: "source", name: "Source", ...shape }] : [],
      }),
    },
  };
  render(
    <MenuRoot>
      <MenuTrigger>Message actions</MenuTrigger>
      <MenuPopup>
        <StartLinkedChat
          session={anywhere}
          navigation={navigation}
          channelId="source"
          message={{ ...message, channelId: "source" }}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Start Solo chat" }),
  );
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  const destination = open.mock.calls[0]?.[0];
  const id =
    destination?.kind === "page"
      ? soloDraft(destination.route?.params)?.linked
      : undefined;
  expect(readLinkedChat(scope, linkedDraftKey(id ?? ""))).toEqual({
    channelId: "source",
    link: `buzz://message?channel=source&id=${reply}&thread=${root}`,
  });
});

it("stays unavailable while Buzz can't create chats", async () => {
  const { navigation } = fakeNavigation();
  render(
    <MenuRoot>
      <MenuTrigger>Message actions</MenuTrigger>
      <MenuPopup>
        <StartLinkedChat
          session={{
            ...session,
            channelWrites: { ...session.channelWrites, available: false },
          }}
          navigation={navigation}
          channelId="design"
          message={message}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Message actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Start Solo chat" }),
  ).toHaveAttribute("aria-disabled", "true");
});

it("offers the message action only on messages the relay accepted", () => {
  for (const delivery of [undefined, "accepted", "seen"] as const)
    expect(canStartLinkedChatFrom({ ...message, delivery }, session)).toBe(
      true,
    );
  // Whatever the source is: here a Solo chat and a DM.
  for (const channelType of ["solo", "dm"] as const) {
    const source = {
      ...session,
      channels: {
        ...session.channels,
        list: () => ({
          status: "ready" as const,
          channels: [{ id: "source", name: "Source", channelType }],
        }),
      },
    };
    expect(
      canStartLinkedChatFrom({ ...message, channelId: "source" }, source),
    ).toBe(true);
  }
  for (const delivery of ["sending", "unknown", "failed"] as const)
    expect(canStartLinkedChatFrom({ ...message, delivery }, session)).toBe(
      false,
    );
});
