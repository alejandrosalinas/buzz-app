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
import { MessageLink } from "./MessageLink";
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

const link = (
  session: RelaySession,
  id: string,
  label: string | null = "#authored",
  interactive = true,
) => (
  <MessageLink
    key={`${id}:${label}`}
    url={`buzz://channel/${id}`}
    registry={undefined}
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

it("keeps an unavailable chat's bubble card, lock, sent name and accessible explanation", () => {
  const t = fixture();
  render(link(t.session, "private-session", "Session: PR 45 fixes"));
  t.answer("private-session", { state: "withheld" });
  const card = screen.getByRole("link", {
    name: "Chat: PR 45 fixes, unavailable",
  });
  expect(card.getAttribute("title")).toContain(
    "You don’t have access, or it no longer exists.",
  );
  expect(card.getAttribute("aria-description")).toContain("Chat unavailable");
  expect(card.querySelector("svg.tabler-icon-message-circle")).not.toBeNull();
  expect(card.querySelector("svg.tabler-icon-lock")).not.toBeNull();
  expect(card.querySelector("svg.tabler-icon-chevron-right")).toBeNull();
});

it("names an open channel and shows its hover card", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const t = fixture();
  render(
    <>
      {link(t.session, "open")}
      {link(t.session, "open", null)}
    </>,
  );
  await act(async () => {});
  expect(t.refer).toHaveBeenCalledWith("open");
  t.answer("open", crew);
  // The authored label stays; a raw link takes the channel's name.
  const [authored, raw] = screen.getAllByRole("link");
  expect(authored?.textContent).toBe("#authored");
  expect(raw?.textContent).toBe("#crew-open");
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

it("shows an accessible private Solo chat as Chat with a navigation chevron, not a privacy lock", () => {
  const t = fixture();
  render(link(t.session, "shared-chat", "Chat: Work"));
  t.answer("shared-chat", {
    state: "found",
    name: "Work",
    channelType: "solo",
    private: true,
    hidden: false,
    archived: false,
    joined: true,
  });
  const card = screen.getByRole("link", { name: "Open Chat: Work" });
  expect(card.querySelector("svg.tabler-icon-message-circle")).not.toBeNull();
  expect(card.querySelector("svg.tabler-icon-chevron-right")).not.toBeNull();
  expect(card.querySelector("svg.tabler-icon-lock")).toBeNull();
});
