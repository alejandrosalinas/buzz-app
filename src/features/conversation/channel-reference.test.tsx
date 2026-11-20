// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PREVIEW_REST_MS } from "../../shared/design-system/ui/hoverIntent";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MessageLink } from "./MessageLink";
import { apply as registerLinks } from "../../bundled/links";
import type { LinkRenderer } from "./contracts";
import { LinkThreadTabContext } from "./LinkLabelContext";
import type { ChannelList, ChannelReference } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

/** Presentation only: the store's lookup rules are tested against the real
 * store in relay/channel-references.test.ts. */
function fixture(status: ChannelList["status"] = "ready") {
  let list: ChannelList = { status, channels: [] };
  const answers = new Map<string, ChannelReference>();
  const listeners = new Set<() => void>();
  const notify = () => {
    list = { ...list };
    for (const listener of listeners) listener();
  };
  const refer = vi.fn();
  const session = {
    unread: undefined,
    channels: {
      list: () => list,
      get: () => undefined,
      describe: (id: string) => answers.get(id) ?? { state: "unknown" },
      refer,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    refer,
    answer(id: string, reference: ChannelReference) {
      answers.set(id, reference);
      act(notify);
    },
    ready() {
      list = { status: "ready", channels: [] };
      act(notify);
    },
  };
}

let inlineLink: LinkRenderer | undefined;
registerLinks({
  conversation: { registerLink: (value: LinkRenderer) => (inlineLink = value) },
} as never);
if (!inlineLink) throw new Error("Expected the bundled link renderer");
const renderers = [
  {
    ...inlineLink,
    pluginId: "buzz.links",
    key: "buzz.links/links",
    revision: "1",
  },
];
const registry = { snapshot: () => renderers, subscribe: () => () => {} };

const link = (
  session: RelaySession,
  id: string,
  label: string | null = "#authored",
  interactive = true,
  withRenderer = false,
) => (
  <MessageLink
    key={`${id}:${label}`}
    url={`buzz://channel/${id}`}
    registry={withRenderer ? registry : undefined}
    onOpenLink={() => true}
    session={session}
    interactive={interactive}
    label={label ?? undefined}
  >
    {label ?? undefined}
  </MessageLink>
);

const crew: ChannelReference = {
  state: "found",
  name: "crew-open",
  description: "Where the crew meets.",
  channelType: "stream",
  private: false,
  hidden: false,
  archived: true,
  joined: false,
};

it("preserves an unavailable chat's authored inline label and ordinary access explanation", () => {
  const t = fixture();
  render(
    link(t.session, "private-session", "Session: PR 45 fixes", true, true),
  );
  t.answer("private-session", { state: "withheld" });
  const anchor = screen.getByRole("link", { name: "Session: PR 45 fixes" });
  expect(anchor.textContent).toBe("Session: PR 45 fixes");
  expect(anchor.getAttribute("title")).toContain("aren’t a member");
  expect(anchor.querySelector("svg.tabler-icon-lock")).not.toBeNull();
});

it("names an open channel and shows its hover card", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  const rich = (key: string, children: ReactNode) => (
    <MessageLink
      key={key}
      url="buzz://channel/open"
      registry={undefined}
      onOpenLink={() => true}
      session={t.session}
      label="#authored"
    >
      {children}
    </MessageLink>
  );
  render(
    <>
      {link(t.session, "open")}
      {link(t.session, "open", null)}
      {link(t.session, "open", "#crew lounge (old)")}
      {link(t.session, "open", `#${"🛠".repeat(120)}`)}
      {link(t.session, "open", "the crew room")}
      {link(t.session, "open", "## crew")}
      {link(t.session, "open", "#crew ")}
      {link(t.session, "open", `#${"a".repeat(121)}`)}
      {rich("formatted", <strong>#authored</strong>)}
      {rich("mixed", ["#authored", <img key="image" alt="" />])}
    </>,
  );
  await act(async () => {});
  expect(t.refer).toHaveBeenCalledWith("open");
  // Until the channel is known, a `#` label shows as written.
  expect(screen.getAllByRole("link")[0]?.textContent).toBe("#authored");
  t.answer("open", crew);
  const links = screen.getAllByRole("link");
  const raw = links[1];
  // Text that is `#` and a channel name, spaces included and up to 120
  // characters, takes the channel's name, as a raw link does, and copies with it.
  for (const chip of links.slice(0, 4))
    expect(chip.textContent).toBe("#crew-open");
  expect(links[0]?.getAttribute("aria-label")).toBe("#crew-open");
  expect(links[0]?.getAttribute("data-link-label")).toBe("#crew-open");
  // Other text stays: no `#`, no channel name after it, or more than text.
  expect(links.slice(4).map((link) => link.innerHTML)).toEqual([
    "the crew room",
    "## crew",
    "#crew ",
    `#${"a".repeat(121)}`,
    "<strong>#authored</strong>",
    '#authored<img alt="">',
  ]);
  expect(links[8]?.getAttribute("data-link-label")).toBe("#authored");
  fireEvent.mouseEnter(raw as HTMLElement);
  fireEvent.mouseMove(raw as HTMLElement);
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  const card = screen.getByLabelText("Channel preview");
  expect(card.textContent).toContain("crew-open");
  expect(card.textContent).toContain("Public channel · Archived · Not joined");
  expect(card.textContent).toContain("Where the crew meets.");
});

it("says Joined from membership, with the member count", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  render(link(t.session, "mine", null));
  t.answer("mine", { ...crew, archived: false, joined: true, members: 3 });
  fireEvent.mouseEnter(screen.getByRole("link"));
  fireEvent.mouseMove(screen.getByRole("link"));
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  expect(screen.getByLabelText("Channel preview").textContent).toContain(
    "Public channel · Joined · 3 members",
  );
});

it("marks a withheld channel private and keeps an authored label beside the lock", async () => {
  const t = fixture();
  render(
    <>
      {link(t.session, "secret", null)}
      {link(t.session, "secret")}
    </>,
  );
  t.answer("secret", { state: "withheld" });
  const [raw, authored] = screen.getAllByRole("link");
  expect(raw?.textContent).toBe("Private channel");
  expect(raw?.getAttribute("aria-label")).toBe("Private channel");
  expect(raw?.getAttribute("href")).toBe("buzz://channel/secret");
  expect(raw?.getAttribute("title")).toContain("aren’t a member");
  // Copy returns the authored text, so the link shows it too.
  expect(authored?.textContent).toBe("#authored");
  expect(authored?.getAttribute("title")).toContain("aren’t a member");
});

it("does not open a withheld channel link, and keeps its href for copying", () => {
  const t = fixture();
  const open = vi.fn(() => true);
  render(
    <MessageLink
      url="buzz://channel/secret"
      registry={undefined}
      onOpenLink={open}
      session={t.session}
      directoryLabel="Stale chat title"
    />,
  );
  t.answer("secret", { state: "withheld" });
  const raw = screen.getByRole("link", { name: "Private channel" });
  expect(raw.getAttribute("aria-disabled")).toBe("true");
  expect(raw.getAttribute("href")).toBe("buzz://channel/secret");
  fireEvent.click(raw);
  fireEvent(raw, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("does not open a message or thread link into a withheld channel until access returns", async () => {
  const t = fixture();
  const open = vi.fn(() => true);
  const openThreadTab = vi.fn(() => true);
  const id = "a".repeat(64);
  const root = "b".repeat(64);
  const urls = [
    `buzz://message?channel=secret&id=${id}`,
    `buzz://message?channel=secret&id=${id}&thread=${root}`,
  ];
  render(
    <LinkThreadTabContext value={openThreadTab}>
      {urls.map((url, index) => (
        <MessageLink
          key={url}
          url={url}
          label={`link ${index}`}
          registry={undefined}
          onOpenLink={open}
          session={t.session}
        >
          {`link ${index}`}
        </MessageLink>
      ))}
    </LinkThreadTabContext>,
  );
  await act(async () => {});
  // The channel is looked up for its access, even though it isn't shown.
  expect(t.refer.mock.calls).toEqual([["secret"], ["secret"]]);
  t.answer("secret", { state: "withheld" });
  const links = screen.getAllByRole("link");
  expect(links.map((element) => element.textContent)).toEqual([
    "link 0",
    "link 1",
  ]);
  for (const [index, element] of links.entries()) {
    expect(element.getAttribute("aria-disabled")).toBe("true");
    expect(element.getAttribute("aria-description")).toContain(
      "aren’t a member",
    );
    expect(element.getAttribute("href")).toBe(urls[index]);
    fireEvent.click(element);
    fireEvent(
      element,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
  }
  fireEvent.contextMenu(screen.getByRole("link", { name: "link 0" }));
  const item = await screen.findByRole("menuitem", { name: "Open link" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item);
  expect(open).not.toHaveBeenCalled();
  expect(openThreadTab).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.keyDown(item, { key: "Escape" });
  // A recheck that admits the reader makes the links live without a reload.
  t.answer("secret", { ...crew, private: true, joined: true });
  for (const element of screen.getAllByRole("link")) {
    expect(element.getAttribute("aria-disabled")).toBeNull();
    expect(element.getAttribute("aria-description")).toBeNull();
    fireEvent.click(element);
  }
  expect(open.mock.calls).toEqual([[urls[0]], [urls[1]]]);
});

it("keeps the authored label while the answer is unknown", async () => {
  const t = fixture();
  render(link(t.session, "flaky"));
  await act(async () => {});
  expect(screen.getByRole("link").textContent).toBe("#authored");
  expect(screen.queryByText("Private channel")).toBeNull();
});

it("holds a readable channel's demand too, without the store looking it up", async () => {
  const t = fixture();
  t.answer("open", crew);
  render(link(t.session, "open"));
  await act(async () => {});
  expect(t.refer.mock.calls).toEqual([["open"]]);
});

it("asks only once the list is ready, and never from a composer decoration", async () => {
  const t = fixture("loading");
  render(
    <>
      {link(t.session, "later")}
      {link(t.session, "draft", "#draft", false)}
    </>,
  );
  await act(async () => {});
  expect(t.refer).not.toHaveBeenCalled();
  t.ready();
  await act(async () => {});
  expect(t.refer.mock.calls).toEqual([["later"]]);
  // Even a withheld answer leaves the writer's own draft text alone.
  t.answer("draft", { state: "withheld" });
  expect(screen.getByText("#draft")).toBeTruthy();
  expect(screen.queryByText("Private channel")).toBeNull();
});

it("shows a withheld message link's card as an explanation, not a second link", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  const url = `buzz://message?channel=secret&id=${"a".repeat(64)}`;
  render(
    <MessageLink
      url={url}
      label="the plan"
      registry={undefined}
      onOpenLink={() => true}
      session={t.session}
    >
      the plan
    </MessageLink>,
  );
  await act(async () => {});
  t.answer("secret", { state: "withheld" });
  const trigger = screen.getByRole("link", { name: "the plan" });
  act(() => trigger.focus());
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  const card = screen.getByLabelText("Message preview");
  expect(card.textContent).toContain("aren’t a member");
  expect(card.textContent).not.toContain("Open link");
  expect(card.getAttribute("role")).toBe("tooltip");
  expect(card.getAttribute("href")).toBeNull();
  expect(card.getAttribute("tabindex")).toBeNull();
  expect(screen.getAllByRole("link")).toEqual([trigger]);
  // Access restores the card's destination.
  t.answer("secret", { ...crew, private: true, joined: true });
  const restored = screen.getByLabelText("Message preview");
  expect(restored.getAttribute("role")).toBe("link");
  expect(restored.getAttribute("href")).toBe(url);
});

it("returns focus to a message link when its focused card learns the channel is withheld", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  render(
    <MessageLink
      url={`buzz://message?channel=slow&id=${"a".repeat(64)}`}
      label="the plan"
      registry={undefined}
      onOpenLink={() => true}
      session={t.session}
    >
      the plan
    </MessageLink>,
  );
  await act(async () => {});
  t.answer("slow", { state: "looking" });
  const trigger = screen.getByRole("link", { name: "the plan" });
  act(() => trigger.focus());
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  // While the lookup is pending the card is the link's destination, a tab
  // stop of its own.
  const card = screen.getByLabelText("Message preview");
  expect(card.getAttribute("role")).toBe("link");
  act(() => card.focus());
  expect(document.activeElement).toBe(card);
  t.answer("slow", { state: "withheld" });
  expect(screen.getByLabelText("Message preview").getAttribute("role")).toBe(
    "tooltip",
  );
  expect(document.activeElement).toBe(trigger);
});

it("keeps a link focused while its name resolves, then opens its card", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  render(link(t.session, "open", null));
  await act(async () => {});
  const focused = screen.getByRole("link");
  act(() => focused.focus());
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  expect(screen.queryByLabelText("Channel preview")).toBeNull();
  t.answer("open", crew);
  // The same node, still focused, now named. (The open card is a link too.)
  expect(screen.getAllByRole("link")[0]).toBe(focused);
  expect(document.activeElement).toBe(focused);
  expect(focused.textContent).toBe("#crew-open");
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  expect(screen.getByLabelText("Channel preview").textContent).toContain(
    "crew-open",
  );
});

it("renders an accessible private Solo chat with the ordinary authored link label", () => {
  const t = fixture();
  render(link(t.session, "shared-chat", "Chat: Work", true, true));
  t.answer("shared-chat", {
    state: "found",
    name: "Work",
    channelType: "solo",
    private: true,
    hidden: false,
    archived: false,
    joined: true,
  });
  const card = screen.getByRole("link", { name: "Chat: Work" });
  expect(card.querySelector("svg.tabler-icon-message-circle")).not.toBeNull();
  expect(card.querySelector("svg.tabler-icon-chevron-right")).toBeNull();
  expect(card.querySelector("svg.tabler-icon-lock")).toBeNull();
});
