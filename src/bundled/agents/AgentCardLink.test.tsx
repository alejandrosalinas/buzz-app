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
import type { AgentCardDraft } from "../../features/agents/agent-card";
import type { LinkRenderer } from "../../features/conversation/contracts";
import { MessageLink } from "../../features/conversation/MessageLink";
import type { RelaySession } from "../../features/relay/session";
import type { Contribution } from "../../plugins/contributions";
import { agentCardShares } from "../../features/agents/agent-card";
import {
  AgentCardLink,
  agentCardLinkId,
  createAgentCardReads,
  type AgentCardReads,
} from "./AgentCardLink";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});

const share = "https://app.builderlab.xyz/a/av_Q430oIuy2pHC345U08CVjg";
const laggo: AgentCardDraft = {
  name: "Laggo",
  picture: "https://cdn.example/av_Q430oIuy2pHC345U08CVjg/avatar.png",
  instructions: "",
};

it("recognizes only this build's Builderlab share pages", () => {
  expect(agentCardLinkId(share)).toBe("av_Q430oIuy2pHC345U08CVjg");
  expect(agentCardLinkId(`${share}/`)).toBe("av_Q430oIuy2pHC345U08CVjg");
  expect(agentCardLinkId(`${share}?ref=x#top`)).toBe(
    "av_Q430oIuy2pHC345U08CVjg",
  );
  const staging = agentCardShares("https://app.builderlabstaging.xyz");
  expect(
    agentCardLinkId("https://app.builderlabstaging.xyz/a/av_x", staging),
  ).toBe("av_x");
  // Add to Buzz reads this build's cards, so another environment's link
  // stays a web link.
  expect(agentCardLinkId(share, staging)).toBeNull();
  expect(agentCardLinkId("https://builderlab.xyz/agents/tinker")).toBe(
    "tinker",
  );
  for (const other of [
    "http://app.builderlab.xyz/a/av_x",
    "https://app.builderlab.xyz:8443/a/av_x",
    "https://app.builderlab.xyz/agents/av_x",
    "https://builderlab.xyz/a/tinker",
    "https://evil.app.builderlab.xyz/a/av_x",
    "https://app.builderlab.xyz.evil/a/av_x",
    "https://app.builderlab.xyz/a/av_x/edit",
    "https://app.builderlab.xyz/a/",
    "https://app.builderlab.xyz/a/av%2Fx",
    "https://app.builderlabstaging.xyz/a/av_x",
    "https://constructor/a/av_x",
    "not a url",
  ])
    expect(agentCardLinkId(other), other).toBeNull();
});

it("reads each card once, and a failed one again only after a minute", async () => {
  let now = 0;
  const read = vi.fn<(id: string) => Promise<AgentCardDraft>>(() =>
    Promise.reject(new Error("offline")),
  );
  const reads = createAgentCardReads(read, () => now);
  const listener = vi.fn();
  const stop = reads.watch("av_x", listener);
  reads.watch("av_x", () => {});
  expect(read).toHaveBeenCalledOnce();
  await waitFor(() => expect(reads.get("av_x")?.state).toBe("failed"));
  expect(listener).toHaveBeenCalled();
  stop();
  now = 59_999;
  reads.watch("av_x", () => {});
  expect(read).toHaveBeenCalledOnce();
  now = 60_000;
  read.mockResolvedValueOnce(laggo);
  reads.watch("av_x", () => {});
  expect(read).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(reads.get("av_x")).toEqual({
      state: "read",
      card: { name: laggo.name, picture: laggo.picture },
    }),
  );
  reads.watch("av_x", () => {});
  expect(read).toHaveBeenCalledTimes(2);
});

it("stops a read that hangs, so a later link can retry it", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(
      (_id: string, signal: AbortSignal) =>
        new Promise<AgentCardDraft>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    let now = 0;
    const reads = createAgentCardReads(read, () => now);
    reads.watch("av_x", () => {});
    await vi.advanceTimersByTimeAsync(14_999);
    expect(reads.get("av_x")?.state).toBe("reading");
    await vi.advanceTimersByTimeAsync(1);
    expect(reads.get("av_x")?.state).toBe("failed");
    now = 60_000;
    reads.watch("av_x", () => {});
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps only the newest cards that no link shows", async () => {
  const reads = createAgentCardReads(async () => laggo);
  const shown = reads.watch("av_shown", () => {});
  for (let i = 0; i < 150; i++) reads.watch(`av_${i}`, () => {})();
  await waitFor(() => expect(reads.get("av_149")?.state).toBe("read"));
  expect(reads.get("av_shown")?.state).toBe("read");
  expect(reads.get("av_49")).toBeUndefined();
  expect(reads.get("av_51")?.state).toBe("read");
  shown();
});

it("keeps a pending read past eviction, so a remounted link joins it", async () => {
  let fail = () => {};
  const read = vi.fn(
    (id: string) =>
      new Promise<AgentCardDraft>((resolve, reject) => {
        if (id !== "av_slow") return resolve(laggo);
        fail = () => reject(new Error("offline"));
      }),
  );
  const reads = createAgentCardReads(read);
  reads.watch("av_slow", () => {})();
  for (let i = 0; i < 150; i++) reads.watch(`av_${i}`, () => {})();
  await waitFor(() => expect(reads.get("av_149")?.state).toBe("read"));
  expect(reads.get("av_slow")?.state).toBe("reading");
  // The link comes back while its first read is still pending: no second one.
  reads.watch("av_slow", () => {});
  expect(read.mock.calls.filter(([id]) => id === "av_slow")).toHaveLength(1);
  fail();
  await waitFor(() => expect(reads.get("av_slow")?.state).toBe("failed"));
});

function setup(read: (id: string) => Promise<AgentCardDraft>) {
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const reads: AgentCardReads = createAgentCardReads(read);
  const renderer: Contribution<LinkRenderer> = {
    id: "agent-card",
    title: "Agent card links",
    key: "buzz.agents/agent-card",
    pluginId: "buzz.agents",
    revision: "one",
    matches: (url) => agentCardLinkId(url) !== null,
    component: ({ url }) => <AgentCardLink url={url} reads={reads} />,
  };
  const renderers = [renderer];
  const registry = { snapshot: () => renderers, subscribe: () => () => {} };
  const list = { channels: [] };
  const session = {
    unread: undefined,
    channels: { list: () => list, subscribeList: () => () => {} },
  } as unknown as RelaySession;
  return { registry, session, reads };
}

it("shows the card's name and picture, and its hover card opens Add to Buzz", async () => {
  const user = userEvent.setup();
  const { registry, session } = setup(async () => laggo);
  const onOpenLink = vi.fn(() => true);
  render(
    <>
      <button type="button">Before</button>
      <MessageLink
        url={share}
        registry={registry}
        onOpenLink={onOpenLink}
        session={session}
      />
    </>,
  );
  const link = await screen.findByRole("link", { name: "Laggo" });
  expect(link).toHaveAttribute("href", share);
  expect(link.querySelector("[data-avatar-shape='squircle']")).not.toBeNull();
  // Keyboard focus opens the card at once.
  await user.tab();
  await user.tab();
  const card = await screen.findByRole("dialog", {
    name: "Laggo agent card",
  });
  expect(card).toHaveTextContent("Laggo");
  expect(card).not.toHaveAttribute("href");
  await user.click(screen.getByRole("button", { name: "Add to Buzz" }));
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
    "buzz://agent/new?card=av_Q430oIuy2pHC345U08CVjg",
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("says so when the host can't open Add to Buzz", async () => {
  const user = userEvent.setup();
  const { registry, session } = setup(async () => laggo);
  const onOpenLink = vi.fn(() => false);
  render(
    <MessageLink
      url={share}
      registry={registry}
      onOpenLink={onOpenLink}
      session={session}
    />,
  );
  await screen.findByRole("link", { name: "Laggo" });
  await user.tab();
  await user.click(
    within(
      await screen.findByRole("dialog", { name: "Laggo agent card" }),
    ).getByRole("button", { name: "Add to Buzz" }),
  );
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
    "buzz://agent/new?card=av_Q430oIuy2pHC345U08CVjg",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "This Buzz link couldn’t be opened here.",
  );
});

it("opens the card for a link still focused when its read finishes", async () => {
  const user = userEvent.setup();
  let finish = (_: AgentCardDraft) => {};
  const { registry, session } = setup(
    () => new Promise<AgentCardDraft>((resolve) => (finish = resolve)),
  );
  render(
    <MessageLink
      url={share}
      registry={registry}
      onOpenLink={() => true}
      session={session}
    />,
  );
  await user.tab();
  const link = screen.getByRole("link");
  expect(link).toHaveFocus();
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => finish(laggo));
  expect(
    await screen.findByRole("dialog", { name: "Laggo agent card" }),
  ).toHaveTextContent("Add to Buzz");
  expect(link).toHaveAccessibleName("Laggo");
  expect(link).toHaveFocus();
});

it("keeps a plain click on the link opening the page", async () => {
  const user = userEvent.setup();
  const { registry, session } = setup(async () => laggo);
  const onOpenLink = vi.fn(() => false);
  render(
    <MessageLink
      url={share}
      registry={registry}
      onOpenLink={onOpenLink}
      session={session}
    />,
  );
  const link = await screen.findByRole("link", { name: "Laggo" });
  // Prevent jsdom navigation; the host's external handoff is its own.
  link.addEventListener("click", (event) => event.preventDefault());
  await user.click(link);
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(share);
});

it("keeps an authored label, and a card that can't be read stays a plain link", async () => {
  const { registry, session, reads } = setup(async (id) => {
    if (id === "tinker") throw new Error("missing");
    return laggo;
  });
  render(
    <>
      <MessageLink
        url={share}
        label="my agent"
        registry={registry}
        onOpenLink={() => true}
        session={session}
      >
        my agent
      </MessageLink>
      <MessageLink
        url="https://builderlab.xyz/agents/tinker"
        registry={registry}
        onOpenLink={() => true}
        session={session}
      />
    </>,
  );
  const authored = screen.getByRole("link", { name: "my agent" });
  await waitFor(() =>
    expect(
      authored.querySelector("[data-avatar-shape='squircle']"),
    ).not.toBeNull(),
  );
  expect(authored).toHaveTextContent(/^my agent$/);
  const missing = screen.getByRole("link", {
    name: "https://builderlab.xyz/agents/tinker",
  });
  await waitFor(() => expect(reads.get("tinker")?.state).toBe("failed"));
  expect(missing).toHaveTextContent("https://builderlab.xyz/agents/tinker");
  expect(missing.querySelector("[data-avatar-shape]")).toBeNull();
});

it("reads nothing for a composer decoration", () => {
  const read = vi.fn(async () => laggo);
  const { registry, session } = setup(read);
  render(
    <MessageLink
      url={share}
      registry={registry}
      onOpenLink={() => false}
      session={session}
      interactive={false}
    />,
  );
  expect(read).not.toHaveBeenCalled();
});
