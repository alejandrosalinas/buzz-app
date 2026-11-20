// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

import { renderToStaticMarkup } from "react-dom/server";
import type { Contribution } from "../../plugins/contributions";
import type { LinkRenderer } from "./contracts";
import { MessageLink, resolveLink } from "./MessageLink";
import { createRelaySession } from "../relay/session";
import { matchesEvent } from "../relay/projection";
import { keypair, signed } from "../relay/testing";
import { SOLO_NAMED_LABEL, SOLO_LABEL } from "../solo/labels";
import { soloChatLinkMessage } from "../solo/share";
import { MessageMarkdown } from "../messages/MessageMarkdown";
import { useReferenceDirectory } from "../messages/ReferenceText";
import { ConversationPresentation } from "./ConversationPresentation";
import { LinkThreadTabContext } from "./LinkLabelContext";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const entry: Contribution<LinkRenderer> = {
  id: "link",
  title: "Link",
  key: "test/link",
  pluginId: "test",
  revision: "one",
  matches: () => true,
  className: "link-style",
  component: () => <span>Link face</span>,
};
const url = "https://example.com/path?query=yes";
it("keeps anchor destination and host semantics with and without presentation", () => {
  const registry = { snapshot: () => [entry], subscribe: () => () => {} };
  const html = renderToStaticMarkup(
    <MessageLink url={url} registry={registry} onOpenLink={() => true} />,
  );
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('class="link-style"');
  expect(html).toContain("Link face");
  const fallback = renderToStaticMarkup(
    <MessageLink url={url} registry={undefined} onOpenLink={() => true} />,
  );
  expect(fallback).toContain(`>${url}</a>`);
  expect(fallback).not.toContain("data-link-renderer");
});
it("skips throwing and unmatched renderers and resolves by order, then key", () => {
  const broken = {
    ...entry,
    matches() {
      throw new Error("matcher failed");
    },
  };
  const miss = { ...entry, matches: () => false };
  expect(resolveLink(url, [broken, miss, entry])).toBe(entry);
  expect(resolveLink(url, [broken, miss])).toBeUndefined();
  // A catch-all loses to the default band whichever registered first.
  const fallback = { ...entry, key: "a/fallback", order: 100 };
  expect(resolveLink(url, [fallback, entry])).toBe(entry);
  expect(resolveLink(url, [entry, fallback])).toBe(entry);
  // Equal orders fall to the contribution key, not array position.
  const alpha = { ...entry, key: "a/link" };
  expect(resolveLink(url, [entry, alpha])).toBe(alpha);
  expect(resolveLink(url, [alpha, entry])).toBe(alpha);
  // One renderer can be specific on one URL and a catch-all on another.
  const github = "https://github.com/block/buzz/pull/1";
  const services = {
    ...entry,
    key: "a/services",
    order: (href: string) => (href.startsWith("https://github.com/") ? 0 : 100),
  };
  const web = { ...entry, key: "b/web", order: 10 };
  expect(resolveLink(github, [web, services])).toBe(services);
  expect(resolveLink(url, [web, services])).toBe(web);
  // A throwing order counts as the default band instead of dropping the renderer.
  const shaky = {
    ...entry,
    key: "a/shaky",
    order: () => {
      throw new Error("order failed");
    },
  };
  expect(resolveLink(url, [web, shaky])).toBe(shaky);
});

function mount(target = url, interactive = true) {
  const onOpenLink = vi.fn(() => true);
  render(
    <ToastProvider>
      <MessageLink
        url={target}
        registry={undefined}
        onOpenLink={onOpenLink}
        interactive={interactive}
        label="Message destination"
      />
    </ToastProvider>,
  );
  return {
    get anchor() {
      return screen.getByRole("link");
    },
    onOpenLink,
  };
}

it("opens a two-item context menu with the untouched external destination, not the pane", async () => {
  const user = userEvent.setup();
  const target = "https://github.com/block/buzz/pull/1?view=all#discussion_r1";
  const { anchor, onOpenLink } = mount(target);
  fireEvent.contextMenu(anchor);
  const external = await screen.findByRole("menuitem", {
    name: "Open in browser",
  });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Open in browser", "Copy link"]);
  expect(external).toHaveAttribute("href", target);
  expect(external).toHaveAttribute("target", "_blank");
  expect(external).toHaveAttribute("rel", "noopener noreferrer");
  expect(onOpenLink).not.toHaveBeenCalled();
  // Prevent jsdom navigation; real browser/desktop handoff is exercised separately.
  external.addEventListener("click", (event) => event.preventDefault());
  await user.click(external);
  expect(onOpenLink).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])(
  "supports keyboard invocation %s, copying, dismissal and focus return",
  async (keys) => {
    const user = userEvent.setup();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const { anchor, onOpenLink } = mount(`${url}#exact-fragment`);
    anchor.focus();
    await user.keyboard(keys);
    const copy = await screen.findByRole("menuitem", { name: "Copy link" });
    copy.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(`${url}#exact-fragment`),
    );
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    await waitFor(() => expect(anchor).toHaveFocus());
    expect(onOpenLink).not.toHaveBeenCalled();
    await user.keyboard(keys);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(anchor).toHaveFocus());
  },
);

it("reports a clipboard failure and allows an explicit retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue();
  const { anchor, onOpenLink } = mount();
  fireEvent.contextMenu(anchor);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(
    await screen.findByText(
      "Couldn’t copy the link. Try again from the link menu.",
    ),
  ).toBeInTheDocument();
  fireEvent.contextMenu(anchor);
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(await screen.findByText("Link copied")).toBeInTheDocument();
  expect(write).toHaveBeenCalledTimes(2);
  expect(onOpenLink).not.toHaveBeenCalled();
});

const messageId = "a".repeat(64);
const threadLink = `buzz://message?channel=alpha&id=${messageId}`;
it.each(["buzz://channel/alpha", threadLink])(
  "leaves non-HTTP(S) link context menus alone: %s",
  (target) => {
    const { anchor } = mount(target);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(anchor, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  },
);

it("opens a message link's thread in a tab from its context menu, else as a click would", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const openThreadTab = vi.fn(() => true);
  const onOpenLink = vi.fn(() => true);
  const rootId = "b".repeat(64);
  const tree = (target: string) => (
    <ToastProvider>
      <LinkThreadTabContext value={openThreadTab}>
        <MessageLink
          url={target}
          registry={undefined}
          onOpenLink={onOpenLink}
        />
      </LinkThreadTabContext>
    </ToastProvider>
  );
  const view = render(tree(threadLink));
  fireEvent.contextMenu(screen.getByRole("link"));
  await screen.findByRole("menu");
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Open link", "Copy link"]);
  await user.click(screen.getByRole("menuitem", { name: "Open link" }));
  expect(openThreadTab).toHaveBeenCalledWith("alpha", messageId, messageId);
  expect(onOpenLink).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  fireEvent.contextMenu(screen.getByRole("link"));
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(threadLink));
  // A reply's link names its root; a workspace that can't show it falls back.
  openThreadTab.mockReturnValue(false);
  const reply = `${threadLink}&thread=${rootId}`;
  view.rerender(tree(reply));
  fireEvent.contextMenu(screen.getByRole("link"));
  await user.click(await screen.findByRole("menuitem", { name: "Open link" }));
  expect(openThreadTab).toHaveBeenLastCalledWith("alpha", messageId, rootId);
  expect(onOpenLink).toHaveBeenCalledWith(reply);
});

it("leaves noninteractive message content without a menu or anchor", () => {
  mount(url, false);
  fireEvent.contextMenu(screen.getByText("Message destination"));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("preserves ordinary pane interception and modified or middle-click fallback", () => {
  const { anchor, onOpenLink } = mount();
  const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(anchor, ordinary);
  expect(ordinary.defaultPrevented).toBe(true);
  expect(onOpenLink).toHaveBeenCalledOnce();
  onOpenLink.mockClear();
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      [modifier]: true,
    });
    // Avoid jsdom trying to navigate; capture the component's prevention before that.
    let prevented: boolean | undefined;
    document.addEventListener(
      "click",
      (click) => {
        prevented = click.defaultPrevented;
        click.preventDefault();
      },
      { once: true },
    );
    fireEvent(anchor, event);
    expect(prevented).toBe(false);
  }
  fireEvent(
    anchor,
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }),
  );
  expect(onOpenLink).not.toHaveBeenCalled();
});

function desktopOpener() {
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  return invoke;
}

it.each([
  "https://github.com/block/buzz-app/pull/1?view=all#discussion_r1",
  "http://example.com/path?query=yes#section",
])(
  "opens desktop Command-click in the browser with the exact URL: %s",
  (target) => {
    const invoke = desktopOpener();
    const { anchor, onOpenLink } = mount(target);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    fireEvent(anchor, event);
    expect(event.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "plugin:opener|open_url",
      {
        url: target,
      },
      undefined,
    );
    expect(onOpenLink).not.toHaveBeenCalled();
  },
);

it("keeps ordinary desktop clicks in the pane", () => {
  const invoke = desktopOpener();
  const { anchor, onOpenLink } = mount();
  fireEvent.click(anchor);
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url);
  expect(invoke).not.toHaveBeenCalled();
});

it("reports a failed desktop browser open and clears the error on retry", async () => {
  const invoke = desktopOpener();
  invoke.mockRejectedValueOnce("Browser unavailable");
  const { anchor, onOpenLink } = mount();
  fireEvent.click(anchor, { metaKey: true });
  expect(
    await screen.findByText("Couldn’t open the link in your browser."),
  ).toBeInTheDocument();
  fireEvent.click(anchor, { metaKey: true });
  expect(
    screen.queryByRole("dialog", {
      name: "Couldn’t open the link in your browser.",
    }),
  ).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(onOpenLink).not.toHaveBeenCalled();
});

it("does not open a desktop browser from an inactive conversation", () => {
  const invoke = desktopOpener();
  const onOpenLink = vi.fn(() => true);
  render(
    <ConversationPresentation value={false}>
      <MessageLink url={url} registry={undefined} onOpenLink={onOpenLink} />
    </ConversationPresentation>,
  );
  fireEvent.click(screen.getByRole("link"), { metaKey: true });
  expect(invoke).not.toHaveBeenCalled();
  expect(onOpenLink).not.toHaveBeenCalled();
});

it("retires an external menu when its retained conversation becomes inactive", async () => {
  const onOpenLink = vi.fn(() => true);
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <MessageLink url={url} registry={undefined} onOpenLink={onOpenLink} />
    </ConversationPresentation>
  );
  const view = render(tree(true));
  fireEvent.contextMenu(screen.getByRole("link"));
  await screen.findByRole("menu");
  view.rerender(tree(false));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  const anchor = screen.getByRole("link");
  fireEvent.contextMenu(anchor);
  fireEvent.keyDown(anchor, { key: "F10", shiftKey: true });
  fireEvent.click(anchor);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(onOpenLink).not.toHaveBeenCalled();
  view.rerender(tree(true));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("link"));
  await screen.findByRole("menu");
});

it("does not present or replay copy feedback completed in an inactive conversation", async () => {
  const user = userEvent.setup();
  let complete!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const tree = (active: boolean) => (
    <ToastProvider>
      <ConversationPresentation value={active}>
        <MessageLink url={url} registry={undefined} onOpenLink={() => true} />
      </ConversationPresentation>
    </ToastProvider>
  );
  const view = render(tree(true));
  fireEvent.contextMenu(screen.getByRole("link"));
  await user.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  expect(write).toHaveBeenCalledWith(url);
  view.rerender(tree(false));
  await act(async () => complete());
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  view.rerender(tree(true));
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
});

it("a signed chosen rename repaints the session card without changing authored link bytes or focus", async () => {
  const id = "11111111-1111-4111-8111-111111111111",
    viewer = keypair(),
    relay = keypair();
  let clock = 100,
    name = "First prompt",
    labels: string[][] = [["t", SOLO_LABEL]],
    about = "";
  const record = (kind: number, tags: string[][]) =>
    signed(relay, {
      kind,
      created_at: clock,
      content: "",
      tags: [["d", id], ...tags],
    });
  const events = () => [
    record(39000, [
      ["name", name],
      ["t", "stream"],
      ...labels,
      ["private"],
      ["about", about],
    ]),
    record(39001, [["p", viewer.pubkey, "owner"]]),
    record(39002, [["p", viewer.pubkey, "", "owner"]]),
  ];
  const publish = vi.fn(async () => {});
  const owner = createRelaySession({
    channelIdentity: true,
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async (filters) =>
      events().filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
    channelDetails: {
      sign: async (template) => signed(viewer, template),
      publish: async (event) => {
        name = event.tags.find(([key]) => key === "name")?.[1] ?? name;
        about = event.tags.find(([key]) => key === "about")?.[1] ?? about;
        labels = event.tags.filter(([key]) => key === "t");
        clock++;
      },
    },
    writer: {
      kinds: [9, 9007],
      sign: async (template) => signed(viewer, template),
      publish,
    },
  });
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    render(
      <MessageLink
        session={owner.session}
        url={`buzz://channel/${id}`}
        registry={undefined}
        onOpenLink={() => true}
      />,
    );
    // Raw chat links resolve their current title without acquiring card chrome.
    const anchor = screen.getByRole("link", {
      name: "First prompt",
    });
    anchor.focus();
    const base = await owner.session.channelDetails.load(id);
    await act(async () =>
      owner.session.channelDetails.save(base, {
        ...base,
        name: "Accessible contrast",
      }),
    );
    expect(
      await screen.findByRole("link", {
        name: "Accessible contrast",
      }),
    ).toBe(anchor);
    expect(anchor).toHaveFocus();
    expect(owner.session.channels.list().channels[0]?.labels).toContain(
      SOLO_NAMED_LABEL,
    );
    expect(anchor).toHaveAttribute("data-link-label", "");
    expect(publish).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows a completed channel link's current name through a rename, keeping custom link text", async () => {
  const id = "22222222-2222-4222-8222-222222222222",
    viewer = keypair(),
    relay = keypair();
  let clock = 100,
    name = "launch";
  const events = () =>
    [
      [39000, ["name", name], ["t", "stream"], ["public"]],
      [39001, ["p", viewer.pubkey, "owner"]],
      [39002, ["p", viewer.pubkey, "", "owner"]],
    ].map(([kind, ...tags]) =>
      signed(relay, {
        kind: kind as number,
        created_at: clock,
        content: "",
        tags: [["d", id], ...(tags as string[][])],
      }),
    );
  const owner = createRelaySession({
    channelIdentity: true,
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async (filters) =>
      events().filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
    channelDetails: {
      sign: async (template) => signed(viewer, template),
      publish: async (event) => {
        name = event.tags.find(([key]) => key === "name")?.[1] ?? name;
        clock++;
      },
    },
  });
  // The first label was written under an earlier name.
  const content = `[\\#kickoff](buzz://channel/${id}) [the plan room](buzz://channel/${id}) [**#kickoff**](buzz://channel/${id})`;
  function Message({ interactive }: { interactive: boolean }) {
    return (
      <MessageMarkdown
        row={{
          id: "message",
          channelId: id,
          authorId: "author",
          content,
          createdAt: 1,
          mentions: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          participants: [],
        }}
        directory={useReferenceDirectory(owner.session)}
        session={owner.session}
        media={() => undefined}
        onOpenLink={() => true}
        interactive={interactive}
      />
    );
  }
  const shown = () =>
    screen.getAllByRole("link").map((link) => link.textContent);
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    const view = render(<Message interactive />);
    expect(shown()).toEqual(["#launch", "the plan room", "#kickoff"]);
    const base = await owner.session.channelDetails.load(id);
    await act(async () =>
      owner.session.channelDetails.save(base, { ...base, name: "liftoff" }),
    );
    expect(shown()).toEqual(["#liftoff", "the plan room", "#kickoff"]);
    const chip = screen.getByRole("link", { name: "#liftoff" });
    expect(chip).toHaveAttribute("href", `buzz://channel/${id}`);
    // A draft or preview names a joined channel the same way, without a lookup.
    view.rerender(<Message interactive={false} />);
    expect(view.container).toHaveTextContent("#liftoff the plan room #kickoff");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a completed channel link's written name while the channel is unnamed or a restored Solo chat", async () => {
  const id = "22222222-2222-4222-8222-222222222222",
    chat = "33333333-3333-4333-8333-333333333333",
    viewer = keypair(),
    relay = keypair();
  // The relay's roster arrives; its metadata, and so the name, never does.
  const events = [
    [39001, ["p", viewer.pubkey, "owner"]],
    [39002, ["p", viewer.pubkey, "", "owner"]],
  ].map(([kind, ...tags]) =>
    signed(relay, {
      kind: kind as number,
      created_at: 100,
      content: "",
      tags: [["d", id], ...(tags as string[][])],
    }),
  );
  const owner = createRelaySession({
    channelIdentity: true,
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async (filters) =>
      events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      ),
  });
  // A Solo chat downloaded before the relay confirmed its roster.
  const list = {
    status: "ready",
    channels: [
      { id: chat, name: "Release notes", channelType: "solo", cached: true },
    ],
  };
  const restored = {
    channels: { list: () => list, subscribeList: () => () => {} },
  } as unknown as typeof owner.session;
  function Message({
    session,
    to,
  }: {
    session: typeof owner.session;
    to: string;
  }) {
    return (
      <MessageMarkdown
        row={{
          id: "message",
          channelId: to,
          authorId: "author",
          content: `[\\#launch](buzz://channel/${to}) buzz://channel/${to}`,
          createdAt: 1,
          mentions: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
          participants: [],
        }}
        directory={useReferenceDirectory(session)}
        session={session}
        media={() => undefined}
        onOpenLink={() => true}
      />
    );
  }
  const shown = () =>
    screen.getAllByRole("link").map((link) => link.textContent);
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().channels).toHaveLength(1),
    );
    const view = render(<Message session={owner.session} to={id} />);
    await act(async () => {});
    // A raw link has only the placeholder to show.
    expect(shown()).toEqual(["#launch", "#22222222"]);
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "data-link-label",
      "#launch",
    );
    view.rerender(<Message session={restored} to={chat} />);
    expect(shown()).toEqual(["#launch", "#Release notes"]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["Session · 12345678", "Session: PR 45 fixes", "Chat: PR 45 fixes"])(
  "preserves legacy chat labels as ordinary inline links: %s",
  (label) => {
    render(
      <MessageLink
        url="buzz://channel/12345678"
        label={label}
        registry={undefined}
        onOpenLink={() => true}
      >
        {label}
      </MessageLink>,
    );
    const link = screen.getByRole("link", {
      name: label,
    });
    expect(link).toHaveTextContent(label);
    expect(link.querySelector("svg")).toBeNull();
    expect(link).not.toHaveAttribute("data-solo-link");
  },
);

it("shows escaped chosen names faithfully when only the sent label is available", () => {
  const name = "PR_45 & <fix> [draft] \\_notes";
  render(
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content: soloChatLinkMessage("session", name),
        createdAt: 1,
        mentions: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
        participants: [],
      }}
      media={() => undefined}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByRole("link", { name })).toHaveTextContent(name);
});

it("lets registered renderers own chat link presentation like other links", () => {
  const entries = [entry];
  const registry = { snapshot: () => entries, subscribe: () => () => {} };
  render(
    <MessageLink
      url="buzz://channel/session"
      label="Chat: Work"
      registry={registry}
      onOpenLink={() => true}
    />,
  );
  const link = screen.getByRole("link", { name: "Chat: Work" });
  expect(link).toHaveTextContent("Link face");
  expect(link).toHaveClass("link-style");
});
