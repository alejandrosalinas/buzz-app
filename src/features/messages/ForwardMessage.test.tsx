// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { ChannelMessage } from "../relay/contracts";
import type { OutboxRecovery, OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { ForwardMessageProvider, useForwardMessage } from "./ForwardMessage";
import { MessageActionBar } from "./MessageActionBar";
import { MessageMarkdown } from "./MessageMarkdown";

const viewer = "a".repeat(64),
  recipient = "b".repeat(64),
  messageId = "c".repeat(64);
const scope = `https://relay.example:${viewer}`;
const destination = "11111111-1111-4111-8111-111111111111";
const stops: (() => void)[] = [];
// Toast actions sit on Sonner's swipeable card, which captures the pointer.
HTMLElement.prototype.setPointerCapture ??= () => {};
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.parentElement;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                contentRect: {
                  width: 400,
                  height: target.getAttribute("role") === "listbox" ? 400 : 40,
                },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Trigger() {
  const forward = useForwardMessage();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          forward?.({ channelId: "alpha", id: messageId } as ChannelMessage)
        }
      >
        Forward source
      </button>
      <button
        type="button"
        onClick={() =>
          forward?.({
            channelId: "alpha",
            id: "f".repeat(64),
          } as ChannelMessage)
        }
      >
        Forward another
      </button>
    </>
  );
}
function pendingForward(note = "Saved note"): OutgoingEvent {
  return {
    event: {
      id: "9".repeat(64),
      kind: 9,
      tags: [["h", destination]],
      content: "",
    } as unknown as OutgoingEvent["event"],
    recovery: {
      key: "message:forward",
      value: JSON.stringify({
        source: { channelId: "alpha", forward: messageId },
        person: { pubkey: recipient, name: "Avery Chen" },
        note,
      }),
    },
    delivery: "unknown",
  };
}
function setup({
  saved = [] as OutgoingEvent[],
  nested = false,
  content = <Trigger />,
}: {
  saved?: OutgoingEvent[];
  nested?: boolean;
  content?: ReactNode;
} = {}) {
  const history = createMemoryHistory();
  const controller = createNavigationController(history);
  const navigation = controller.navigation;
  const complete = () => {
    const state = navigation.snapshot();
    if (state.status === "opening")
      controller.complete(state.attempt, { status: "opened" });
  };
  navigation.subscribe(complete);
  complete();
  void navigation.open({
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    scope: { viewer, communityOrigin: "https://relay.example" },
  });
  stops.push(controller.dispose);
  const channels = { channels: [] },
    profiles = new Map();
  const choices = {
    identities: [] as { pubkey: string; managed: boolean }[],
    pending: false,
  };
  const directMessages = {
    available: true,
    people: vi.fn<RelaySession["directMessages"]["people"]>(async () => ({
      people: [
        { pubkey: recipient, name: "Avery Chen" },
        { pubkey: "d".repeat(64), name: "Morgan Lee" },
      ],
      hasMore: false,
    })),
    open: vi.fn(async () => destination),
    delivered: vi.fn<RelaySession["directMessages"]["delivered"]>(
      async () => {},
    ),
  };
  let operations: readonly OutgoingEvent[] = saved;
  const listeners = new Set<() => void>();
  const publish = (next: readonly OutgoingEvent[]) => {
    operations = next;
    for (const listener of [...listeners]) listener();
  };
  const outbox = {
    ready: async () => {},
    snapshot: () => operations,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acknowledge: vi.fn(async (id: string) =>
      publish(operations.filter((item) => item.event.id !== id)),
    ),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(
      (channelId, content, _mentions, _attachments, recovery) => {
        const id = "e".repeat(64);
        publish([
          ...operations,
          {
            event: {
              id,
              kind: 9,
              tags: [["h", channelId]],
              content,
            } as unknown as OutgoingEvent["event"],
            recovery: recovery as OutboxRecovery,
            delivery: "sending",
          },
        ]);
        return id;
      },
    ),
  };
  const session = {
    viewer,
    directMessages,
    messages,
    outbox,
    channels: { list: () => channels, subscribeList: () => () => {} },
    profiles: { snapshot: () => profiles, subscribe: () => () => {} },
    agentChoices: { snapshot: () => choices, subscribe: () => () => {} },
    media: (url: string) => url,
    thread: () => {
      throw new Error("Preview unavailable");
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <ForwardMessageProvider
        session={session}
        scope={scope}
        navigation={navigation}
        renderDialog
      >
        {nested ? (
          <ForwardMessageProvider
            session={session}
            scope={scope}
            navigation={navigation}
          >
            {content}
          </ForwardMessageProvider>
        ) : (
          content
        )}
      </ForwardMessageProvider>
    </ToastProvider>,
  );
  return {
    navigation,
    directMessages,
    messages,
    outbox,
    operations: () => operations,
    publish,
    choices,
    profiles,
  };
}
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await screen.findByRole("dialog", { name: "Forward message" });
  await user.click(await screen.findByRole("option", { name: /Avery Chen/ }));
}

it("keeps the verified name after choosing a forwarding recipient", async () => {
  const user = userEvent.setup();
  const { profiles } = setup();
  profiles.set(recipient, {
    name: "Editable name",
    verified: {
      displayName: "Verified recipient",
      username: "verified",
      issuerLabel: "Community",
      verifiedAt: 1,
      status: "checked",
      multipleIssuers: false,
    },
  });
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await user.click(
    await screen.findByRole("option", { name: /Verified recipient/ }),
  );
  expect(
    screen.getByRole("button", { name: "Remove Verified recipient" }),
  ).toBeInTheDocument();
});

it("closes the people list once its one person is chosen and explains the limit when To is used again", async () => {
  const user = userEvent.setup();
  setup();
  await choose(user);
  const to = screen.getByRole("combobox", { name: "Message recipients" });
  // The full field says so itself; no hint covers the note below it.
  expect(to).toHaveFocus();
  expect(to).toHaveAttribute("aria-expanded", "false");
  expect(to).toHaveAttribute("placeholder", "1 person selected");
  expect(screen.queryByText(/one person/i)).not.toBeInTheDocument();
  await user.click(to);
  expect(
    await screen.findByText(
      "One person at a time. Remove them to choose someone else.",
    ),
  ).toHaveAttribute("role", "status");
  await user.keyboard("{Backspace}");
  expect(
    screen.queryByRole("button", { name: "Remove Avery Chen" }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("option", { name: /Morgan Lee/ }),
  ).toBeInTheDocument();
});

it("forwards a note and permalink through the chosen person's DM and retires the completed dialog", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages, outbox, operations } = setup();
  await choose(user);
  expect(
    screen.getByRole("combobox", { name: "Message recipients" }),
  ).toHaveAttribute("readonly");
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Worth a look",
  );
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(directMessages.open).toHaveBeenCalledWith(
    [recipient],
    expect.any(AbortSignal),
  );
  expect(messages.send).toHaveBeenCalledWith(
    destination,
    `Worth a look\n\nbuzz://message?channel=alpha&id=${messageId}`,
    [],
    [],
    {
      key: "message:forward",
      value: JSON.stringify({
        source: { channelId: "alpha", forward: messageId },
        person: { pubkey: recipient, name: "Avery Chen" },
        note: "Worth a look",
      }),
    },
  );
  expect(directMessages.delivered).toHaveBeenCalledWith(
    "e".repeat(64),
    destination,
    expect.any(AbortSignal),
  );
  expect(outbox.acknowledge).toHaveBeenCalledWith("e".repeat(64));
  expect(operations()).toEqual([]);
  act(() => navigation.back());
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(1);
});

it("opens the forwarded message in the DM from the success notice, with the source behind it", async () => {
  const user = userEvent.setup();
  const { navigation } = setup();
  const source = navigation.snapshot().entry.target;
  await choose(user);
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByText("Message forwarded to Avery Chen");
  // Forwarding leaves you where you were; the notice is the way on.
  expect(navigation.snapshot().entry.target).toEqual(source);
  await user.click(
    screen.getByRole("button", { name: "Open your DM with Avery Chen" }),
  );
  await waitFor(() =>
    expect(navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: "https://relay.example" },
      channelId: destination,
      messageId: "e".repeat(64),
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Message forwarded to Avery Chen"),
    ).not.toBeInTheDocument(),
  );
  act(() => navigation.back());
  expect(navigation.snapshot().entry.target).toEqual(source);
});

it.each([
  ["Enter", "{Enter}"],
  ["Space", " "],
])(
  "reaches the success notice's link by Tab and opens the DM with %s",
  async (_key, press) => {
    const user = userEvent.setup();
    const { navigation } = setup();
    const source = navigation.snapshot().entry.target;
    await choose(user);
    await user.click(screen.getByRole("button", { name: "Forward" }));
    const link = await screen.findByRole("button", {
      name: "Open your DM with Avery Chen",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Forward message" }),
      ).not.toBeInTheDocument(),
    );
    // F6 is Sonner's hotkey for the stack; user-event has no F6 key code.
    fireEvent.keyDown(document.body, { key: "F6", code: "F6" });
    expect(link.closest("[data-sonner-toaster]")).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(link).toHaveFocus();
    await user.keyboard(press);
    await waitFor(() =>
      expect(navigation.snapshot().entry.target).toMatchObject({
        kind: "conversation",
        channelId: destination,
        messageId: "e".repeat(64),
      }),
    );
    act(() => navigation.back());
    expect(navigation.snapshot().entry.target).toEqual(source);
  },
);

it("preserves the selection and note across Back/Forward; Cancel retires the visit", async () => {
  const user = userEvent.setup();
  const { navigation, messages } = setup();
  await choose(user);
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Keep this draft",
  );
  act(() => navigation.back());
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  act(() => navigation.forward());
  expect(
    await screen.findByRole("textbox", { name: "Note (optional)" }),
  ).toHaveValue("Keep this draft");
  expect(
    screen.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => navigation.back());
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).not.toHaveBeenCalled();
});

it("keeps an uncertain send locked and retries its exact event without another DM open or send", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup();
  directMessages.delivered.mockRejectedValueOnce(
    new Error("Delivery could not be confirmed"),
  );
  await choose(user);
  await user.click(screen.getByRole("button", { name: "Forward" }));
  const retry = await screen.findByRole("button", { name: "Retry forward" });
  expect(
    screen.getByRole("textbox", { name: "Note (optional)" }),
  ).toBeDisabled();
  expect(retry).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Forward another" }));
  expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await user.click(
    await screen.findByRole("button", { name: "Retry forward" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(directMessages.open).toHaveBeenCalledTimes(1);
  expect(messages.send).toHaveBeenCalledTimes(1);
  expect(directMessages.delivered).toHaveBeenCalledTimes(2);
  expect(messages.send.mock.calls[0]?.[1]).toBe(
    `buzz://message?channel=alpha&id=${messageId}`,
  );
});

it("restores a saved forward after reload and confirms its exact event instead of sending again", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages, outbox, operations } = setup({
    saved: [pendingForward()],
  });
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  const retry = await screen.findByRole("button", { name: "Retry forward" });
  expect(
    screen.getByRole("button", { name: "Remove Avery Chen" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveValue(
    "Saved note",
  );
  expect(
    screen.getByRole("textbox", { name: "Note (optional)" }),
  ).toBeDisabled();
  await user.click(retry);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(directMessages.open).not.toHaveBeenCalled();
  expect(messages.send).not.toHaveBeenCalled();
  expect(directMessages.delivered).toHaveBeenCalledWith(
    "9".repeat(64),
    destination,
    expect.any(AbortSignal),
  );
  expect(outbox.acknowledge).toHaveBeenCalledWith("9".repeat(64));
  expect(operations()).toEqual([]);
  // The notice names the recovery payload's person and opens its h-tag DM.
  await user.click(
    await screen.findByRole("button", { name: "Open your DM with Avery Chen" }),
  );
  await waitFor(() =>
    expect(navigation.snapshot().entry.target).toMatchObject({
      channelId: destination,
      messageId: "9".repeat(64),
    }),
  );
});

it("names and opens the saved forward's DM when the outbox loads it after another person is picked", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages, outbox, publish } = setup();
  directMessages.open.mockResolvedValueOnce(
    "22222222-2222-4222-8222-222222222222",
  );
  // The outbox finishes loading mid-submit with a forward to Avery pending.
  outbox.ready = async () => publish([pendingForward()]);
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  await user.click(await screen.findByRole("option", { name: /Morgan Lee/ }));
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByText("Message forwarded to Avery Chen");
  await user.click(
    screen.getByRole("button", { name: "Open your DM with Avery Chen" }),
  );
  await waitFor(() =>
    expect(navigation.snapshot().entry.target).toMatchObject({
      channelId: destination,
      messageId: "9".repeat(64),
    }),
  );
  expect(messages.send).not.toHaveBeenCalled();
});

it("blocks another forward while a saved one is pending and offers to review it", async () => {
  const user = userEvent.setup();
  const { navigation, messages } = setup({ saved: [pendingForward()] });
  await user.click(screen.getByRole("button", { name: "Forward another" }));
  expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  await user.click(
    await screen.findByRole("button", { name: "Review pending forward" }),
  );
  expect(navigation.snapshot().entry.target).toMatchObject({
    channelId: "alpha",
    forward: messageId,
  });
  expect(
    await screen.findByRole("button", { name: "Retry forward" }),
  ).toBeEnabled();
  expect(messages.send).not.toHaveBeenCalled();
});

it("routes a hosted conversation's forwards through the dialog owner's pending guard", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup({ nested: true });
  directMessages.delivered.mockRejectedValueOnce(
    new Error("Delivery could not be confirmed"),
  );
  await choose(user);
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByRole("button", { name: "Retry forward" });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Forward another" }));
  expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  await user.click(
    await screen.findByRole("button", { name: "Review pending forward" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Retry forward" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(messages.send).toHaveBeenCalledTimes(1);
});

it("retains an editable draft when opening the DM fails", async () => {
  const user = userEvent.setup();
  const { directMessages, messages } = setup();
  directMessages.open.mockRejectedValueOnce(
    new Error("Connection unavailable"),
  );
  await choose(user);
  const note = screen.getByRole("textbox", { name: "Note (optional)" });
  await user.type(note, "Try again");
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await screen.findByRole("alert");
  // The error notice reports the failure; there is no sent message to open.
  await screen.findByRole("button", { name: "Dismiss notification" });
  expect(
    screen.queryByRole("button", { name: /^Open your DM/ }),
  ).not.toBeInTheDocument();
  expect(note).toBeEnabled();
  expect(note).toHaveValue("Try again");
  expect(messages.send).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() => expect(messages.send).toHaveBeenCalledTimes(1));
});

it("keeps pending work through passive Back and completes without replay on Forward", async () => {
  const user = userEvent.setup();
  const { navigation, directMessages, messages } = setup();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  directMessages.delivered.mockImplementationOnce(() => gate);
  try {
    await choose(user);
    await user.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() =>
      expect(directMessages.delivered).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Note (optional)" }),
    ).toBeDisabled();
    act(() => navigation.back());
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Forward message" }),
      ).not.toBeInTheDocument(),
    );
    const signal = directMessages.delivered.mock.calls[0]?.[2];
    await user.click(screen.getByRole("button", { name: "Forward another" }));
    expect(signal?.aborted).toBe(false);
    expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Message forwarded to Avery Chen");
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(1);
});

it("keeps the permalink renderable when a literal note contains an unclosed Markdown fence", async () => {
  const user = userEvent.setup();
  const { messages } = setup();
  await choose(user);
  const note = "```\nPlease check this";
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    note,
  );
  await user.click(screen.getByRole("button", { name: "Forward" }));
  await waitFor(() => expect(messages.send).toHaveBeenCalledTimes(1));
  render(
    <MessageMarkdown
      row={{
        id: "e".repeat(64),
        channelId: destination,
        authorId: viewer,
        content: messages.send.mock.calls[0]?.[1] ?? "",
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      media={() => undefined}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    `buzz://message?channel=alpha&id=${messageId}`,
  );
  expect(screen.getByText(/Please check this/).innerHTML).toBe(
    "```<br>Please check this",
  );
});

it.each([true, false])(
  "rechecks current DM eligibility after preparation with selected agent metadata=%s",
  async (selectedAgent) => {
    const user = userEvent.setup();
    const { directMessages, messages, choices, profiles } = setup();
    choices.identities = [{ pubkey: recipient, managed: true }];
    directMessages.people.mockResolvedValue({
      people: [
        {
          pubkey: recipient,
          name: "Avery Chen",
          ...(selectedAgent ? { isAgent: true } : {}),
        },
      ],
      hasMore: false,
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    directMessages.open.mockImplementationOnce(async () => {
      await gate;
      return destination;
    });
    try {
      await choose(user);
      await user.click(screen.getByRole("button", { name: "Forward" }));
      await waitFor(() => expect(directMessages.open).toHaveBeenCalledOnce());
      choices.identities = [];
      if (!selectedAgent)
        profiles.set(recipient, { name: "Avery Chen", isAgent: true });
    } finally {
      await act(async () => release());
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer available for direct messages",
    );
    expect(messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  },
);

it("closes the people list on Escape, then the dialog, retiring its visit", async () => {
  const user = userEvent.setup();
  const { navigation } = setup();
  await user.click(screen.getByRole("button", { name: "Forward source" }));
  const dialog = await screen.findByRole("dialog", { name: "Forward message" });
  // Focusing To opens the people list.
  await screen.findByRole("listbox", { name: "People" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("listbox", { name: "People" }),
    ).not.toBeInTheDocument(),
  );
  expect(dialog).toBeInTheDocument();
  expect(navigation.snapshot().entry.target).toHaveProperty(
    "forward",
    messageId,
  );
  expect(
    screen.getByRole("combobox", { name: "Message recipients" }),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
  expect(navigation.snapshot().entry.target).not.toHaveProperty("forward");
  act(() => navigation.back());
  act(() => navigation.forward());
  expect(
    screen.queryByRole("dialog", { name: "Forward message" }),
  ).not.toBeInTheDocument();
});

function MenuForward({ children }: { children?: ReactElement }) {
  const forward = useForwardMessage();
  return (
    <MessageActionBar
      copyText={() => "Message"}
      link={`buzz://message?channel=alpha&id=${messageId}`}
      onForward={() =>
        forward?.({ channelId: "alpha", id: messageId } as ChannelMessage)
      }
    >
      {children}
    </MessageActionBar>
  );
}
async function chooseForward(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("menuitem", { name: "Forward message" }),
  );
  await screen.findByRole("dialog", { name: "Forward message" });
}
async function cancelForward(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Forward message" }),
    ).not.toBeInTheDocument(),
  );
}

it.each(["Cancel", "Escape"])(
  "returns focus to More message actions when Forward from its keyboard-opened menu is dismissed with %s",
  async (dismissal) => {
    const user = userEvent.setup();
    setup({ content: <MenuForward /> });
    const more = screen.getByRole("button", { name: "More message actions" });
    more.focus();
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", {
      name: "Forward message",
    });
    await user.keyboard("{End}");
    expect(item).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Forward message" });
    // The item Forward started from left with the menu.
    expect(item).not.toBeInTheDocument();
    if (dismissal === "Cancel") await cancelForward(user);
    else {
      await screen.findByRole("listbox", { name: "People" });
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("listbox", { name: "People" }),
        ).not.toBeInTheDocument(),
      );
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Forward message" }),
        ).not.toBeInTheDocument(),
      );
    }
    await waitFor(() => expect(more).toHaveFocus());
  },
);

it("returns focus to More message actions, not an earlier control, when a press opened its menu without focusing it", async () => {
  const user = userEvent.setup();
  setup({
    content: (
      <>
        <MenuRoot>
          <MenuTrigger render={<button type="button">Elsewhere</button>} />
          <MenuPopup>
            <MenuItem>Unrelated action</MenuItem>
          </MenuPopup>
        </MenuRoot>
        <MenuForward />
      </>
    ),
  });
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  await user.click(elsewhere);
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(elsewhere).toHaveFocus());
  // WebKit opens the menu on press without focusing its button.
  const more = screen.getByRole("button", { name: "More message actions" });
  fireEvent.pointerDown(more, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(more, { button: 0, detail: 1 });
  await chooseForward(user);
  await cancelForward(user);
  await waitFor(() => expect(more).toHaveFocus());
});

it.each([
  ["right-click", "First"],
  ["Shift+F10", "Second"],
])(
  "returns focus to the context menu's own target when Forward from a %s menu is cancelled",
  async (opening, target) => {
    const user = userEvent.setup();
    setup({
      content: (
        <MenuForward>
          <div data-testid="row">
            <button type="button">First</button>
            <button type="button">Second</button>
          </div>
        </MenuForward>
      ),
    });
    if (opening === "right-click") {
      fireEvent.contextMenu(screen.getByTestId("row"), {
        clientX: 20,
        clientY: 20,
        button: 2,
      });
      await chooseForward(user);
    } else {
      screen.getByRole("button", { name: "Second" }).focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      const item = await screen.findByRole("menuitem", {
        name: "Forward message",
      });
      await user.keyboard("{End}");
      expect(item).toHaveFocus();
      await user.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "Forward message" });
    }
    await cancelForward(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: target })).toHaveFocus(),
    );
  },
);
