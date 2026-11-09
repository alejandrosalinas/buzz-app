// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  profile,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "../../features/relay/testing";
import { ChannelSidebarItem } from "./ChannelSidebarItem";
import { formatTypingLabel } from "./DmTypingBadge";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = 1_800_000_000;
const ROOT = "f".repeat(64);

it("formats the exact base composer copy", () => {
  expect(formatTypingLabel(["A"])).toBe("A is typing...");
  expect(formatTypingLabel(["A", "B"])).toBe("A and B are typing...");
  expect(formatTypingLabel(["A", "B", "C"])).toBe("A, B, and C are typing...");
  expect(formatTypingLabel(["A", "B", "C", "D", "E"])).toBe(
    "A, B, and 3 others are typing...",
  );
});

/** Real session typing store, fed through live callbacks, rendered in real rows. */
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  const viewer = keypair(),
    relay = keypair(),
    alice = keypair(),
    bob = keypair(),
    bot = keypair(),
    carol = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  const channels: ChannelSummary[] = [
    {
      id: "dm",
      name: "Alice",
      channelType: "dm",
      participants: [alice.pubkey],
    },
    {
      id: "group",
      name: "Group",
      channelType: "dm",
      participants: [alice.pubkey, bob.pubkey, bot.pubkey, carol.pubkey],
    },
    {
      id: "other",
      name: "Other",
      channelType: "dm",
      participants: [bob.pubkey],
    },
    { id: "agent", name: "Bot", channelType: "dm", participants: [bot.pubkey] },
    { id: "stream", name: "Stream", channelType: "stream" },
  ];
  const commits = new Map<string, number>();
  const rows = (selected?: string) => (
    <div>
      {channels.map((channel) => (
        <div key={channel.id} data-testid={channel.id}>
          <Profiler
            id={channel.id}
            onRender={(id) => commits.set(id, (commits.get(id) ?? 0) + 1)}
          >
            <ChannelSidebarItem
              channel={channel}
              session={owner.session}
              // Stands in for the page's agent-activity working signal.
              working={channel.id === "agent"}
              selected={selected}
              onSelect={() => {}}
              onOpenThread={() => {}}
              onOpenMessage={() => {}}
            />
          </Profiler>
        </div>
      ))}
    </div>
  );
  const view = render(rows());
  live.state({ status: "connected", routes: [] });
  act(() =>
    live.receive(
      channels.map((channel) =>
        roster(relay, channel.id, [
          viewer.pubkey,
          alice.pubkey,
          bob.pubkey,
          bot.pubkey,
          carol.pubkey,
        ]),
      ),
    ),
  );
  const pulse = (
    key: Key,
    channelId: string,
    {
      at = NOW,
      root,
      kind = 20002,
    }: { at?: number; root?: string; kind?: number } = {},
  ) =>
    signed(key, {
      kind,
      content: kind === 9 ? "hi" : "",
      created_at: at,
      tags: [["h", channelId], ...(root ? [["e", root, "", "reply"]] : [])],
    });
  const receive = (...events: RelayEvent[]) => act(() => live.receive(events));
  /** Another consumer loads profiles; the badge itself never acquires them. */
  const loadProfiles = async (events: RelayEvent[]) => {
    const done = owner.session.profiles.ensure(events.map((e) => e.pubkey));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const read = wire.pending.findIndex((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(0)),
    );
    expect(read).toBeGreaterThanOrEqual(0);
    wire.pending.splice(read, 1)[0]?.respond(events);
    await act(() => done);
  };
  const typing = (row: string) =>
    within(screen.getByTestId(row)).queryByRole("img", {
      name: /typing\.\.\.$/,
    });
  const allTyping = () => screen.queryAllByRole("img", { name: /typing/ });
  return {
    keys: { viewer, alice, bob, bot, carol },
    live,
    owner,
    view,
    rows,
    commits,
    pulse,
    receive,
    loadProfiles,
    typing,
    allTyping,
  };
}
const name = (key: Key) => key.pubkey.slice(0, 10);

it("shows live remote typing on the matching 1:1 and group DM rows only", () => {
  const {
    keys,
    live,
    owner,
    view,
    rows,
    commits,
    pulse,
    receive,
    typing,
    allTyping,
  } = fixture();
  const { viewer, alice, bob } = keys;

  // Self events and regular channel rows never show sidebar typing.
  receive(pulse(viewer, "dm"), pulse(viewer, "group"), pulse(alice, "stream"));
  expect(allTyping()).toEqual([]);

  const idle = [commits.get("other"), commits.get("stream")];
  receive(pulse(alice, "dm"));
  // Only the affected row re-renders.
  expect([commits.get("other"), commits.get("stream")]).toEqual(idle);
  const badge = typing("dm");
  expect(badge).toHaveAttribute("aria-label", `${name(alice)} is typing...`);
  expect(badge).toHaveAttribute("title", `${name(alice)} is typing...`);
  expect(allTyping()).toHaveLength(1);
  // The dots replace the DM identity (avatar or count) while typing.
  const identity = (row: string) =>
    screen.getByTestId(row).querySelector("[data-dm-identity]");
  expect(identity("dm")).toBeNull();
  expect(identity("group")).not.toBeNull();

  // Switching the selected conversation keeps typing on its own row.
  view.rerender(rows("other"));
  expect(typing("dm")).toBeInTheDocument();
  expect(typing("other")).toBeNull();

  // Group DM: thread and top-level scopes combine; one signer appears once.
  receive(
    pulse(alice, "group"),
    pulse(alice, "group", { root: ROOT }),
    pulse(bob, "group", { root: ROOT }),
  );
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} and ${name(bob)} are typing...`,
  );
  // Each completion clears only its own scope: Alice's top-level message leaves
  // her thread scope (and thread-only Bob) visible.
  receive(pulse(alice, "group", { kind: 9 }));
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} and ${name(bob)} are typing...`,
  );
  // Bob's thread message clears thread-only Bob; Alice's thread scope remains.
  receive(pulse(bob, "group", { root: ROOT, kind: 9 }));
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `${name(alice)} is typing...`,
  );
  // Alice's thread message clears her last scope.
  receive(pulse(alice, "group", { root: ROOT, kind: 9 }));
  expect(typing("group")).toBeNull();
  expect(identity("group")).not.toBeNull();

  // Expiry: visible until eight seconds after the last signed pulse.
  act(() => vi.advanceTimersByTime(7_999));
  expect(typing("dm")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(allTyping()).toEqual([]);

  // Stale pulses are ignored; disconnect clears live typing.
  receive(pulse(alice, "dm"));
  expect(allTyping()).toEqual([]);
  receive(pulse(alice, "dm", { at: NOW + 8 }));
  expect(typing("dm")).toBeInTheDocument();
  act(() => live.state({ status: "retrying", routes: [] }));
  expect(allTyping()).toEqual([]);

  view.unmount();
  owner.dispose();
});

it("labels human typing only; known agents keep their DM avatar", async () => {
  const { keys, owner, view, pulse, receive, loadProfiles, typing } = fixture();
  const { alice, bot, carol } = keys;
  await loadProfiles([
    profile(bot, { name: "Bot", is_agent: true }),
    profile(alice, { name: "Alice" }),
  ]);

  // Agent-only typing never replaces the DM identity with a typing badge.
  receive(pulse(bot, "agent"));
  expect(typing("agent")).toBeNull();
  expect(
    screen
      .getByTestId("agent")
      .querySelector("[data-dm-identity] .buzz-avatar"),
  ).toBeInTheDocument();

  // Mixed group: the label names humans only.
  receive(pulse(bot, "group"), pulse(alice, "group"));
  expect(typing("group")).toHaveAttribute("aria-label", "Alice is typing...");

  // An unclassified signer keeps the pubkey fallback until its loaded profile
  // identifies an agent, then leaves the label reactively.
  receive(pulse(carol, "group", { root: ROOT }));
  expect(typing("group")).toHaveAttribute(
    "aria-label",
    `Alice and ${name(carol)} are typing...`,
  );
  await loadProfiles([profile(carol, { name: "Carol", is_agent: true })]);
  expect(typing("group")).toHaveAttribute("aria-label", "Alice is typing...");

  view.unmount();
  owner.dispose();
});
