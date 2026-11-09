import type { ConversationHostServices } from "../conversation/ConversationHost";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComposerInputElement } from "../messages/composer-dom";
import { composerDOMFixture } from "../messages/composer-testing";

import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useChannelList } from "../relay/react";
import { createRelaySession } from "../relay/session";
import {
  keypair,
  profile,
  roster,
  signed,
  message,
  bounds,
} from "../relay/testing";
import {
  PublishRejected,
  type OutboxStorage,
  type OutgoingEvent,
} from "../relay/outbox";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerCompletion,
  ConversationExtensions,
} from "../conversation/contracts";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import { attachmentDraft } from "../messages/attachment-draft";
import { NewMessage } from "./NewMessage";
import type { PageNavigation } from "../navigation/service";
import { OutboxStatus } from "../../bundled/channels/OutboxStatus";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { createRelayProfiler } from "../relay/profiling";
import { readView, writeView } from "../../shared/view-state";

composerDOMFixture();

const viewer = keypair(),
  other = keypair(),
  another = keypair(),
  third = keypair(),
  relay = keypair();
const channel = "11111111-1111-4111-8111-111111111111";
const group = "33333333-3333-4333-8333-333333333333";

const emptyPanels: never[] = [];
const scope = `https://relay.example:${viewer.pubkey}`;
const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  localStorage.clear();
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
        // Supply row and viewport sizes; real scrolling is covered in browsers.
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
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play() {
        return Promise.resolve();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});
function setup(
  metadata: { name?: string; about?: string; picture?: string } = {},
) {
  let records: readonly OutgoingEvent[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next) => {
      records = structuredClone(next);
    },
  };
  const publish = vi.fn<
    (event: RelayEvent, signal: AbortSignal) => Promise<void>
  >(async () => {});
  const events = [
    profile(other, { name: "Avery", ...metadata }),
    profile(another, { name: "Zoe" }),
    // Relay-signed DM metadata carries the NIP-29 `hidden` and `private` tags.
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", channel],
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ],
      content: JSON.stringify({ name: "Avery", channel_type: "dm" }),
    }),
    roster(relay, channel, [viewer.pubkey, other.pubkey]),
  ];
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const history = filters.find((filter) => filter.kinds?.includes(9));
    if (history) {
      const id = history["#h"]?.[0] ?? channel;
      return [
        ...events.filter(
          (event) =>
            event.kind === 9 &&
            event.tags.some(([name, value]) => name === "h" && value === id),
        ),
        bounds(relay, id, "head", { has_more: false, next_cursor: null }),
      ];
    }
    return events.filter((event) =>
      filters.some(
        (filter) =>
          (!filter.kinds || filter.kinds.includes(event.kind)) &&
          (!filter.ids || filter.ids.includes(event.id)) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#d"] ||
            event.tags.some(
              ([tag, value]) =>
                tag === "d" &&
                value !== undefined &&
                filter["#d"]?.includes(value),
            )),
      ),
    );
  });
  let rosterTime = 1_700_000_000;
  const openDirectMessage = vi.fn(async (pubkeys: readonly string[]) => {
    events[events.length - 1] = roster(
      relay,
      channel,
      [viewer.pubkey, ...pubkeys],
      ++rosterTime,
    );
    return channel;
  });
  const create = () => {
    const owner = createRelaySession(
      {
        scope: "https://relay.example",
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        query,
        openDirectMessage,
        writer: {
          kinds: [9],
          sign: async (event) => signed(viewer, event),
          publish,
        },
      },
      { outboxStorage: storage },
    );
    owners.push(owner);
    return owner;
  };
  const onStarted = vi.fn();
  function Draft({
    owner,
    extensions,
    visit,
  }: {
    owner: ReturnType<typeof create>;
    extensions?: ConversationExtensions | undefined;
    visit?: PageNavigation | undefined;
  }) {
    const { channels } = useChannelList(owner.session.channels);
    return (
      <NewMessage
        session={owner.session}
        channels={channels}
        scope={scope}
        host={
          {
            panels: {
              snapshot: () => emptyPanels,
              subscribe: () => () => {},
              resolve: () => undefined,
            },
            relay: {
              snapshot: () => ({
                status: "ready",
                session: owner.session,
                scope,
              }),
            },
            navigation: { open: vi.fn() },
          } as unknown as ConversationHostServices
        }
        onOpenThread={vi.fn()}
        onStarted={onStarted}
        extensions={extensions}
        visit={visit}
      />
    );
  }
  const mount = (
    owner: ReturnType<typeof create>,
    extensions?: ConversationExtensions,
    visit?: PageNavigation,
  ) => render(<Draft owner={owner} extensions={extensions} visit={visit} />);
  const user = userEvent.setup();
  const compose = async () => {
    await user.click(await screen.findByRole("option", { name: "Avery" }));
    await user.type(screen.getByRole("textbox"), "Durable first message");
  };
  return {
    storage,
    query,
    events,
    openDirectMessage,
    publish,
    create,
    mount,
    compose,
    user,
    onStarted,
    records: () => records,
  };
}
const send = () => screen.getByRole("button", { name: "Send message" });

it("restores a bounded recipient and draft when unused profile metadata exceeds the view quota", async () => {
  const name = "A".repeat(600);
  const t = setup({
    name,
    about: "x".repeat(2 * 1024 * 1024),
    picture: `https://example.com/${"x".repeat(20000)}`,
  });
  const setItem = Storage.prototype.setItem;
  const rejected = vi.fn();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (value.length > 16000) {
      rejected();
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    setItem.call(this, key, value);
  });
  const owner = t.create();
  const page = t.mount(owner);
  await t.user.click(await screen.findByRole("option", { name }));
  await t.user.type(screen.getByRole("textbox"), "Saved before sending");
  expect(readView(scope, "direct-message:recipients", [])).toEqual([
    { pubkey: other.pubkey, name: name.slice(0, 500) },
  ]);
  expect(rejected).not.toHaveBeenCalled();
  page.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(
    screen.getByRole("button", {
      name: `Remove ${name.slice(0, 500)}`,
    }),
  ).toBeEnabled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Saved before sending");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("locks recipient edits until outbox hydration finishes, then accepts them", async () => {
  const t = setup();
  writeView(scope, "direct-message:recipients", [
    { pubkey: other.pubkey, name: "Avery" },
  ]);
  let release: (records: readonly OutgoingEvent[]) => void = () => {};
  const hydration = new Promise<readonly OutgoingEvent[]>((resolve) => {
    release = resolve;
  });
  t.storage.load = vi.fn(() => hydration);
  const play = vi.fn(async () => {});
  vi.stubGlobal(
    "Audio",
    class {
      pause = vi.fn();
      play = play;
    },
  );
  const owner = t.create();
  // Populate the actual directory before mounting so loading people cannot hide
  // a prematurely enabled picker while the outbox is held.
  await owner.session.directMessages.people(
    "",
    1,
    new AbortController().signal,
  );
  t.mount(owner);
  try {
    expect(t.storage.load).toHaveBeenCalledOnce();
    const input = screen.getByRole("combobox");
    const remove = screen.getByRole("button", { name: "Remove Avery" });
    expect(input).toBeDisabled();
    expect(remove).toBeDisabled();
    await t.user.click(remove);
    await t.user.type(input, "Zoe{Enter}");
    expect(remove).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Zoe" }),
    ).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release([]);
      await owner.session.outbox?.ready();
    });
  }
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  expect(screen.getByRole("combobox")).toHaveFocus();
  await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(play).toHaveBeenCalledOnce();
  await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
  expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeEnabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("recovers an uncertain first send after localStorage failure and session restart without a new event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const first = t.create();
  const page = t.mount(first);
  await t.compose();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(t.records().find((item) => item.recovery)?.delivery).toBe("unknown"),
  );
  const original = t.publish.mock.calls[0]?.[0];
  assert.exists(original);
  page.unmount();
  first.dispose();
  const second = t.create();
  const resumed = t.mount(second);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeDisabled();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
  expect(t.records().some((item) => item.recovery)).toBe(false);
  resumed.unmount();
  second.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
});

it("removing a failed operation in Diagnostics unlocks the preserved draft on reopening", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  const diagnostics = render(
    <OutboxStatus
      outbox={outbox}
      profiling={createRelayProfiler()}
      memberAdditions={owner.session.memberAdditions}
    />,
  );
  await t.user.click(
    screen.getByRole("button", { name: "Remove from outbox" }),
  );
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  diagnostics.unmount();
  t.mount(owner);
  await waitFor(() => expect(send()).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
  expect(screen.getByRole("button", { name: "Remove Avery" })).toBeEnabled();
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledTimes(2);
});

it("keeps a failed message in Back history when only the outbox holds it", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
  const owner = t.create();
  const outbox = owner.session.outbox;
  assert.exists(outbox);
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  await waitFor(() => expect(outbox.snapshot()[0]?.delivery).toBe("failed"));
  page.unmount();
  // The disposable draft view is gone; the durable outbox entry remains.
  writeView(scope, "direct-message:new-draft", null);
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount(owner, undefined, { passThrough } as unknown as PageNavigation);
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveTextContent(
      "Durable first message",
    ),
  );
  expect(passThrough.mock.lastCall?.[0]()).toBe(false);
});

it("never publishes if the durable recovery write fails", async () => {
  const t = setup();
  t.storage.save = async () => {
    throw new Error("Disk full");
  };
  const owner = t.create();
  t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Durable first message",
  );
});

it.each([false, true])(
  "preserves post-failure edits across restart, empty=%s",
  async (empty) => {
    const t = setup();
    t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
    const owner = t.create();
    const page = t.mount(owner);
    await t.compose();
    await t.user.click(send());
    await screen.findByRole("alert");
    await t.user.clear(screen.getByRole("textbox"));
    if (!empty)
      await t.user.type(screen.getByRole("textbox"), "Corrected message");
    await t.user.click(screen.getByRole("button", { name: "Remove Avery" }));
    if (!empty)
      await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
    page.unmount();
    owner.dispose();
    const restored = t.create();
    t.mount(restored);
    await act(async () => {
      await restored.session.outbox?.ready();
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveProperty(
        "value",
        empty ? "" : "Corrected message",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Remove Avery" }),
    ).not.toBeInTheDocument();
    if (empty) expect(send()).toBeDisabled();
    else {
      expect(screen.getByRole("button", { name: "Remove Zoe" })).toBeVisible();
      await t.user.click(send());
      await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
      expect(t.publish.mock.calls[1]?.[0].content).toBe("Corrected message");
    }
  },
);

it("retains recovery if saved-view cleanup fails, then retires without republishing", async () => {
  const t = setup();
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  await t.user.click(send());
  await screen.findByRole("alert");
  expect(t.records().some((item) => item.recovery)).toBe(true);
  page.unmount();
  const resumed = t.mount(owner);
  await screen.findByRole("button", { name: "Retry send" });
  remove.mockRestore();
  await t.user.click(screen.getByRole("button", { name: "Retry send" }));
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  t.mount(owner);
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(send()).toBeDisabled();
});

it("reconciles a remount while acknowledgement is held without reviving the delivered draft", async () => {
  const t = setup();
  const save = t.storage.save;
  let release: () => void = () => {};
  let held = false;
  t.storage.save = async (records) => {
    if (
      !held &&
      records.some((item) => item.delivery === "accepted" && !item.recovery)
    ) {
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await save(records);
  };
  const owner = t.create();
  const page = t.mount(owner);
  await t.compose();
  await t.user.click(send());
  await waitFor(() => expect(held).toBe(true));
  page.unmount();
  const resumed = t.mount(owner);
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove Avery" }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("textbox")).toHaveTextContent(
      "Durable first message",
    );
  } finally {
    release();
  }
  await waitFor(() =>
    expect(t.records().some((item) => item.recovery)).toBe(false),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(
    screen.queryByRole("button", { name: "Remove Avery" }),
  ).not.toBeInTheDocument();
  expect(send()).toBeDisabled();
  expect(t.onStarted).not.toHaveBeenCalled();
  expect(t.publish).toHaveBeenCalledOnce();
  resumed.unmount();
  owner.dispose();
  const restored = t.create();
  t.mount(restored);
  await act(async () => {
    await restored.session.outbox?.ready();
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveProperty("value", ""),
  );
  expect(send()).toBeDisabled();
});

const tools: readonly Contribution<ComposerTool>[] = [
  {
    id: "picker",
    key: "mentions/picker",
    pluginId: "mentions",
    revision: "1",
    title: "Mentions",
    component: ({ insertMention, ...props }) => (
      <MentionPicker {...props} select={insertMention} />
    ),
  },
];
const completions: readonly Contribution<ComposerCompletion>[] = [
  {
    id: "typeahead",
    key: "mentions/typeahead",
    pluginId: "mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  },
];
const noSubscribe = () => () => {};
const extensions: ConversationExtensions = {
  tools: { snapshot: () => tools, subscribe: noSubscribe },
  completions: { snapshot: () => completions, subscribe: noSubscribe },
  inline: { snapshot: () => [], subscribe: noSubscribe },
};

it.each(["picker", "completion"])(
  "offers selected recipients through %s and validates removed mentions on first send",
  async (path) => {
    const t = setup();
    const owner = t.create();
    t.mount(owner, extensions);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await t.user.click(screen.getByRole("option", { name: "Zoe" }));
    const composer = () =>
      screen.getByRole<ComposerInputElement>("textbox", { name: /^Message / });
    const choices = async () => {
      if (path === "picker") {
        await t.user.click(
          screen.getByRole("button", { name: "Mention a member" }),
        );
        return within(
          screen.getByRole("dialog", { name: "Mention a member or agent" }),
        );
      }
      // jsdom has no caret hit testing; append after the existing mention.
      act(() => {
        const input = composer();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      await t.user.keyboard("@");
      return within(
        await screen.findByRole("listbox", { name: "Mention suggestions" }),
      );
    };
    const choiceRole = path === "picker" ? "button" : "option";
    const first = await choices();
    expect(
      first.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    ).toBeVisible();
    await t.user.click(
      first.getByRole(choiceRole, {
        name: /^Zoe/,
      }),
    );
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    // The provisional names are sufficient without warming the global profile cache.
    expect(owner.session.profiles.snapshot().size).toBe(0);
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
    const second = await choices();
    expect(
      second.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    ).toBeVisible();
    expect(
      second.queryByRole(choiceRole, { name: /^Zoe/ }),
    ).not.toBeInTheDocument();
    // Dismiss the suggestions without replacing the existing mention in jsdom.
    await t.user.keyboard("{Escape}");
    expect(composer()).toHaveTextContent("@Zoe");
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    await t.user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer a channel member",
    );
    expect(t.publish).not.toHaveBeenCalled();
    expect(composer()).toHaveTextContent("@Zoe");
    await t.user.clear(composer());
    const last = await choices();
    await t.user.click(
      last.getByRole(choiceRole, {
        name: /^Avery/,
      }),
    );
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const sent = t.publish.mock.calls[0]?.[0];
    expect(sent?.content).toBe("@Avery");
    expect(sent?.tags.filter(([name]) => name === "p")).toEqual([
      ["p", other.pubkey],
    ]);
  },
);

it.each(["", "Please review these fixes"])(
  "sends a staged session with caption %j and restores its exact event after receipt loss",
  async (caption) => {
    const t = setup();
    const link = "[Session: Fix](buzz://channel/session-id)";
    writeView(scope, "direct-message:new-draft", {
      text: caption,
      recipients: [],
      chatCards: [link],
    });
    t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
    const first = t.create();
    const page = t.mount(first);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await waitFor(() => expect(send()).toBeEnabled());
    await t.user.click(send());
    await waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    const original = t.publish.mock.calls[0]?.[0];
    assert.exists(original);
    expect(original.content).toBe([link, caption].filter(Boolean).join("\n\n"));
    await waitFor(() =>
      expect(t.records().find((item) => item.recovery)?.delivery).toBe(
        "unknown",
      ),
    );
    page.unmount();
    first.dispose();
    const second = t.create();
    t.mount(second);
    const retry = await screen.findByRole("button", { name: "Retry send" });
    expect(
      await screen.findByRole("region", { name: "Chat attachments" }),
    ).toHaveTextContent("Fix");
    expect(screen.getByRole("textbox")).toHaveValue(caption);
    await t.user.click(retry);
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
    expect(t.records().some((item) => item.recovery)).toBe(false);
    expect(readView(scope, "direct-message:new-draft", null)).toBeNull();
  },
);

it("loads matching DM history inline and keeps the draft while recipients change", async () => {
  const t = setup();
  t.events.unshift(
    message(other, channel, "Earlier conversation", 1_700_000_001),
  );
  const owner = t.create();
  const view = t.mount(owner);
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await screen.findByRole("region", { name: "Channel message history" });
  await waitFor(() =>
    expect(
      owner.session.channels.window(channel).rows.map((row) => row.content),
    ).toContain("Earlier conversation"),
  );
  expect(
    screen.queryByRole("button", { name: "Open conversation" }),
  ).not.toBeInTheDocument();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.type(screen.getByRole("textbox"), "Keep this draft");
  await t.user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
  expect(
    screen.queryByRole("region", { name: "Channel message history" }),
  ).not.toBeInTheDocument();
  expect(
    view.container.querySelector('[data-new-message-body] [title="Zoe"]'),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft");
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  await screen.findByRole("region", { name: "Channel message history" });
  await waitFor(() =>
    expect(
      owner.session.channels.window(channel).rows.map((row) => row.content),
    ).toContain("Earlier conversation"),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft");
});

/** A group DM with Avery and Zoe, plus one earlier message in each DM. */
function groupHistory(t: ReturnType<typeof setup>) {
  t.events.unshift(
    profile(third, { name: "Kai" }),
    signed(relay, {
      kind: 39000,
      tags: [
        ["d", group],
        ["hidden", ""],
        ["t", "dm"],
        ["private", ""],
      ],
      content: JSON.stringify({ name: "Avery, Zoe", channel_type: "dm" }),
    }),
    roster(relay, group, [viewer.pubkey, other.pubkey, another.pubkey]),
    message(other, channel, "Earlier conversation", 1_700_000_001),
    message(another, group, "Group history", 1_700_000_002),
  );
}
/** The DM whose timeline the page shows; rows stay virtual in jsdom. */
const previewed = () =>
  screen
    .queryByRole("region", { name: "Channel message history" })
    ?.getAttribute("data-channel-timeline");
async function showsHistory(
  owner: ReturnType<ReturnType<typeof setup>["create"]>,
  id: string,
  content: string,
) {
  await waitFor(() => expect(previewed()).toBe(id));
  expect(
    owner.session.channels.window(id).rows.map((row) => row.content),
  ).toContain(content);
}
async function addRecipient(t: ReturnType<typeof setup>, name: string) {
  await t.user.click(
    screen.getByRole("combobox", { name: "Message recipients" }),
  );
  await t.user.click(await screen.findByRole("option", { name }));
}

it("previews locally and relay-hidden DMs without restoring them until Send", async () => {
  const t = setup();
  groupHistory(t);
  t.events.unshift(
    signed(relay, {
      kind: 30622,
      tags: [
        ["d", viewer.pubkey],
        ["p", viewer.pubkey],
        ["h", group],
      ],
      content: "",
    }),
  );
  const owner = t.create();
  // The sidebar's owner of local hides, mounted beside the page as in Messages.
  let sidebar: ReturnType<typeof useHiddenDms> | undefined;
  function Sidebar() {
    sidebar = useHiddenDms(
      scope,
      owner.session,
      useChannelList(owner.session.channels),
    );
    return null;
  }
  render(<Sidebar />);
  await owner.session.channelLifecycle.refreshVisibility();
  expect(owner.session.channelLifecycle.snapshot().hidden).toEqual([group]);
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  act(() => sidebar?.hide(channel));
  // Settle the hide's own history baseline before anything previews the DM.
  await waitFor(() =>
    expect(readView(scope, "hidden-dms", [])).toEqual([
      expect.objectContaining({ id: channel, knownIds: expect.any(Array) }),
    ]),
  );
  t.mount(owner);
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await showsHistory(owner, channel, "Earlier conversation");
  await addRecipient(t, "Zoe");
  await showsHistory(owner, group, "Group history");
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  await showsHistory(owner, channel, "Earlier conversation");
  // Neither preview restored its row or opened the DM.
  expect(sidebar?.hiddenIds).toEqual(new Set([channel]));
  expect(owner.session.channelLifecycle.snapshot().hidden).toEqual([group]);
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  // Send keeps the existing confirmed open, which restores the row.
  await t.user.type(screen.getByRole("textbox"), "Back again");
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.openDirectMessage).toHaveBeenCalledOnce();
  expect(t.openDirectMessage.mock.calls[0]?.[0]).toEqual([other.pubkey]);
  expect(sidebar?.hiddenIds).toEqual(new Set());
});

it("previews only the DM whose participants exactly match, in any order", async () => {
  const t = setup();
  groupHistory(t);
  const owner = t.create();
  const view = t.mount(owner);
  const introduces = (name: string) =>
    view.container.querySelector(`[data-new-message-body] [title="${name}"]`);
  // Zoe alone is a subset of the group and has no 1:1 DM.
  await t.user.click(await screen.findByRole("option", { name: "Zoe" }));
  expect(previewed()).toBeUndefined();
  expect(introduces("Zoe")).toBeInTheDocument();
  await addRecipient(t, "Avery");
  await showsHistory(owner, group, "Group history");
  // A superset leaves the group as soon as it is chosen.
  await addRecipient(t, "Kai");
  expect(previewed()).toBeUndefined();
  expect(introduces("Kai")).toBeInTheDocument();
  await t.user.click(screen.getByRole("button", { name: "Remove Kai" }));
  await showsHistory(owner, group, "Group history");
  // Avery alone, also a subset of the group, matches the separate 1:1 DM.
  await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  expect(previewed()).not.toBe(group);
  await showsHistory(owner, channel, "Earlier conversation");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("never shows a previous match's history that finishes loading after an edit", async () => {
  const t = setup();
  groupHistory(t);
  const read = t.query.getMockImplementation();
  assert.exists(read);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  let answered = false;
  t.query.mockImplementation(async (filters) => {
    if (
      !filters.some(
        (filter) => filter.kinds?.includes(9) && filter["#h"]?.includes(group),
      )
    )
      return read(filters);
    started = true;
    await held;
    try {
      return await read(filters);
    } finally {
      answered = true;
    }
  });
  const owner = t.create();
  t.mount(owner);
  try {
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await showsHistory(owner, channel, "Earlier conversation");
    await addRecipient(t, "Zoe");
    await waitFor(() => expect(started).toBe(true));
    // The new match loads in place of the 1:1 timeline, never beside it.
    expect(previewed()).toBeUndefined();
    expect(screen.getByText("Loading messages…")).toBeVisible();
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
    await showsHistory(owner, channel, "Earlier conversation");
  } finally {
    release();
  }
  await waitFor(() => expect(answered).toBe(true));
  // Let the store apply or retire the late page before checking the page.
  await act(async () => {});
  expect(previewed()).toBe(channel);
  expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
  // Matching the group again shows its own history.
  await addRecipient(t, "Zoe");
  await showsHistory(owner, group, "Group history");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});

it("matches the recipients chosen by the time the DM roster loads", async () => {
  const t = setup();
  groupHistory(t);
  const read = t.query.getMockImplementation();
  assert.exists(read);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  t.query.mockImplementation(async (filters) => {
    if (
      filters.some(
        (filter) =>
          filter.kinds?.includes(39002) && filter["#p"] && !filter["#d"],
      )
    ) {
      started = true;
      await held;
    }
    return read(filters);
  });
  const owner = t.create();
  t.mount(owner);
  try {
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await addRecipient(t, "Zoe");
    await waitFor(() => expect(started).toBe(true));
    expect(owner.session.channels.list().status).not.toBe("ready");
    expect(previewed()).toBeUndefined();
    await t.user.click(screen.getByRole("button", { name: "Remove Zoe" }));
  } finally {
    release();
  }
  await showsHistory(owner, channel, "Earlier conversation");
  await addRecipient(t, "Zoe");
  await showsHistory(owner, group, "Group history");
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});

it("still previews history when this connection cannot start DMs", async () => {
  const t = setup();
  t.events.unshift(
    message(other, channel, "Earlier conversation", 1_700_000_001),
  );
  const live = t.create();
  const owner = {
    ...live,
    session: {
      ...live.session,
      directMessages: { ...live.session.directMessages, available: false },
    },
  };
  t.mount(owner);
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await showsHistory(owner, channel, "Earlier conversation");
  expect(
    screen.getByText(
      "Starting direct messages is unavailable on this connection.",
    ),
  ).toBeVisible();
  await t.user.type(screen.getByRole("textbox"), "Hello");
  expect(send()).toBeDisabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([40003, 5])(
  "shows and dismisses a restored failed message update (%i) in the preview",
  async (kind) => {
    const t = setup();
    const original = message(
      viewer,
      channel,
      "Original message",
      1_700_000_001,
    );
    t.events.unshift(original);
    const event = signed(viewer, {
      kind,
      tags: [
        ["h", channel],
        ["e", original.id],
        ...(kind === 5 ? [["k", "9"]] : []),
      ],
      content: kind === 40003 ? "Recovered edit" : "",
    });
    t.storage.load = async () => [
      { event, signed: event, delivery: "failed", error: "Rejected update" },
    ];
    const owner = t.create();
    await owner.session.outbox?.ready();
    t.mount(owner);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await screen.findByRole("region", { name: "Channel message history" });
    expect(
      screen.getByRole("button", { name: "Retry message update" }),
    ).toBeVisible();
    await t.user.click(
      screen.getByRole("button", { name: "Discard failed update" }),
    );
    await waitFor(() =>
      expect(owner.session.outbox?.snapshot()).toHaveLength(0),
    );
    expect(
      screen.queryByRole("button", { name: "Retry message update" }),
    ).not.toBeInTheDocument();
  },
);

it.each([false, true])(
  "preserves draft and retry focus without stealing moved focus (%s)",
  async (moveFocus) => {
    const t = setup();
    t.events.unshift(
      message(other, channel, "Recovered history", 1_700_000_001),
    );
    const read = t.query.getMockImplementation();
    assert.exists(read);
    let broken = true;
    let pending: Promise<void> | undefined;
    let started = false;
    t.query.mockImplementation(async (filters) => {
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        started = true;
        await pending;
      }
      const result = await read(filters);
      return broken && filters.some((filter) => filter.kinds?.includes(9))
        ? result.filter((event) => event.kind === 9)
        : result;
    });
    const owner = t.create();
    t.mount(owner);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    await waitFor(() =>
      expect(owner.session.channels.window(channel).status).toBe("error"),
    );
    await t.user.type(screen.getByRole("textbox"), "Keep this draft");
    const retry = screen.getByRole("button", { name: "Retry messages" });
    const recipients = screen.getByRole("combobox", {
      name: "Message recipients",
    });
    const historyReads = () =>
      t.query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(9)),
      ).length;
    for (const fail of [true, false]) {
      broken = fail;
      started = false;
      let release = () => {};
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        act(() => retry.focus());
        await t.user.keyboard("{Enter}");
        await waitFor(() => expect(started).toBe(true));
        expect(retry).toHaveFocus();
        expect(retry).toHaveAttribute("aria-busy", "true");
        const reads = historyReads();
        await t.user.keyboard("{Enter}");
        expect(historyReads()).toBe(reads);
        if (!fail && moveFocus) {
          await t.user.click(recipients);
          expect(recipients).toHaveFocus();
        }
      } finally {
        release();
      }
      await waitFor(() =>
        expect(owner.session.channels.window(channel).status).toBe(
          fail ? "error" : "ready",
        ),
      );
      if (fail) {
        expect(retry).toHaveFocus();
        expect(retry).not.toHaveAttribute("aria-busy", "true");
      }
    }
    expect(retry).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        moveFocus ? recipients : screen.getByRole("textbox"),
      ).toHaveFocus(),
    );
    expect(
      owner.session.channels.window(channel).rows.map((row) => row.content),
    ).toContain("Recovered history");
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this draft");
    expect(t.publish).not.toHaveBeenCalled();
  },
);

const photo = {
  name: "photo.png",
  url: `https://relay.example/media/${"f".repeat(64)}.png`,
  type: "image/png",
  size: 5,
  sha256: "f".repeat(64),
};
function attachable(t: ReturnType<typeof setup>) {
  const live = t.create();
  const uploadForNewChat = vi.fn(async () => photo);
  const owner = {
    ...live,
    session: {
      ...live.session,
      attachments: {
        prepare: async (file: File) => file,
        upload: vi.fn(),
        uploadForNewChat,
      },
    },
  };
  const view = t.mount(owner);
  const attach = () =>
    t.user.upload(
      screen.getByLabelText("Choose attachments"),
      new File(["photo"], "photo.png", { type: "image/png" }),
    );
  return {
    owner,
    get files() {
      return attachmentDraft(
        owner.session,
        `${scope}:direct-message:new-draft`,
        channel,
        true,
      );
    },
    view,
    uploadForNewChat,
    attach,
  };
}

it.each(["", "See attached"])(
  "sends a photo with caption %j and clears files on delivery",
  async (caption) => {
    const t = setup();
    const f = attachable(t);
    await t.user.click(await screen.findByRole("option", { name: "Avery" }));
    if (caption) await t.user.type(screen.getByRole("textbox"), caption);
    await f.attach();
    await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
    expect(t.openDirectMessage).not.toHaveBeenCalled();
    expect(send()).toBeEnabled();
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const event = t.publish.mock.calls[0]?.[0];
    expect(event?.content).toContain(`![photo.png](<${photo.url}>)`);
    if (caption) expect(event?.content).toContain(caption);
    expect(event?.tags).toContainEqual(
      expect.arrayContaining(["imeta", `x ${photo.sha256}`]),
    );
    expect(f.files.snapshot()).toEqual([]);
    f.view.unmount();
    t.mount(f.owner);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(
      screen.queryByRole("button", { name: "Remove photo.png" }),
    ).not.toBeInTheDocument();
    expect(send()).toBeDisabled();
  },
);

it("waits for uploads before opening a DM and reports failure only on the chip", async () => {
  const t = setup();
  const f = attachable(t);
  let rejectUpload = (_reason: Error) => {};
  f.uploadForNewChat.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectUpload = reject;
      }),
  );
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await f.attach();
  await waitFor(() => expect(f.uploadForNewChat).toHaveBeenCalledOnce());
  try {
    await t.user.click(send());
    expect(await screen.findByText("Uploading files…")).toBeVisible();
    expect(t.openDirectMessage).not.toHaveBeenCalled();
  } finally {
    await act(async () =>
      rejectUpload(new Error("Upload failed. Retry or remove this file.")),
    );
  }
  expect(
    await screen.findByRole("button", { name: "Retry photo.png" }),
  ).toBeEnabled();
  expect(
    await screen.findByText(
      "A file couldn’t upload. Retry or remove it, then send again.",
    ),
  ).toHaveAttribute("role", "status");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(send()).toBeDisabled();
  expect(t.openDirectMessage).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(screen.getByRole("button", { name: "Retry photo.png" }));
  await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
  await t.user.click(send());
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
});

it.each(["remove", "replace", "rename", "unchanged"])(
  "uses the visible files after a failed send: %s",
  async (change) => {
    const t = setup();
    t.publish.mockRejectedValueOnce(new PublishRejected("Not sent"));
    const f = attachable(t);
    await t.compose();
    await f.attach();
    await t.user.click(send());
    await screen.findByRole("alert");
    expect(f.files.snapshot()).toHaveLength(1);
    const original = t.publish.mock.calls[0]?.[0];
    if (change !== "unchanged") {
      await t.user.click(
        screen.getByRole("button", { name: "Remove photo.png" }),
      );
      if (change === "replace") {
        f.uploadForNewChat.mockResolvedValue({
          ...photo,
          sha256: "e".repeat(64),
          url: `https://relay.example/media/${"e".repeat(64)}.png`,
        });
        await f.attach();
      } else if (change === "rename") {
        f.uploadForNewChat.mockResolvedValue({ ...photo, name: "renamed.png" });
        await t.user.upload(
          screen.getByLabelText("Choose attachments"),
          new File(["photo"], "renamed.png", { type: "image/png" }),
        );
      }
    }
    await t.user.click(send());
    await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
    const retried = t.publish.mock.calls[1]?.[0];
    if (change === "unchanged") expect(retried).toEqual(original);
    else {
      expect(retried?.id).not.toBe(original?.id);
      if (change === "rename") {
        expect(retried?.content).toContain(`![renamed.png](<${photo.url}>)`);
        expect(retried?.tags).toContainEqual(
          expect.arrayContaining(["imeta", "filename renamed.png"]),
        );
      } else expect(retried?.content).not.toContain(photo.url);
      expect(retried?.tags.filter(([name]) => name === "imeta")).toHaveLength(
        change === "remove" ? 0 : 1,
      );
    }
  },
);

it("confirms a photo-only uncertain send after session restart without files or a replacement event", async () => {
  const t = setup();
  t.publish.mockRejectedValueOnce(new Error("Receipt lost"));
  const f = attachable(t);
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  await f.attach();
  await t.user.click(send());
  await screen.findByRole("alert");
  const original = t.publish.mock.calls[0]?.[0];
  f.view.unmount();
  f.owner.dispose();
  const passThrough = vi.fn<PageNavigation["passThrough"]>(() => () => {});
  t.mount(t.create(), undefined, { passThrough } as unknown as PageNavigation);
  const retry = await screen.findByRole("button", { name: "Retry send" });
  // The held photo keeps the retry page in Back history.
  expect(passThrough.mock.lastCall?.[0]()).toBe(false);
  await t.user.click(retry);
  await waitFor(() => expect(t.onStarted).toHaveBeenCalledOnce());
  expect(t.publish.mock.calls[1]?.[0]).toEqual(original);
});

it("drops files on the recipient header into the new DM composer", async () => {
  const t = setup();
  const f = attachable(t);
  await t.user.click(await screen.findByRole("option", { name: "Avery" }));
  const header = screen.getByRole("combobox");
  const dataTransfer = {
    types: ["Files"],
    files: [new File(["photo"], "photo.png", { type: "image/png" })],
    dropEffect: "uninitialized",
  };
  fireEvent.dragEnter(header, { dataTransfer });
  const overlay = await screen.findByText("Drop files into this conversation");
  expect(overlay.parentElement?.parentElement).toBe(
    screen.getByRole("region", { name: "New message" }),
  );
  fireEvent.drop(header, { dataTransfer });
  await waitFor(() => expect(f.files.snapshot()[0]?.status).toBe("ready"));
  expect(t.openDirectMessage).not.toHaveBeenCalled();
});
