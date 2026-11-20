// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import { createRelayReader } from "../../features/relay/reader";
import type { RelaySession } from "../../features/relay/session";
import {
  keypair,
  profile,
  scriptedTransport,
} from "../../features/relay/testing";
import { ChannelMemberAvatars } from "./ChannelMemberAvatars";
import { ChannelMembersButton } from "./ChannelMembersDialog";

afterEach(cleanup);

const titles = (container: HTMLElement) =>
  [...container.querySelectorAll("[title]")].map((node) =>
    node.getAttribute("title"),
  );

const photo = (name: string) => ({
  name,
  picture: `https://example.test/${name.toLowerCase()}.png`,
});

it("holds shown people with photos in place and replaces only departures", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const publish = () => {
    for (const listener of listeners) listener();
  };
  let members = ["alice", "bob", "carol", "dana", "erin", "agent", "remote"];
  let list = { channels: [{ id: "channel", members }] };
  let profiles = new Map<
    string,
    { name: string; picture?: string; isAgent?: boolean }
  >([
    ["alice", photo("Alice")],
    ["bob", { name: "Bob" }],
    ["carol", photo("Carol")],
    ["dana", { name: "Dana" }],
    ["erin", { name: "Erin" }],
    ["remote", { name: "Remote agent", isAgent: true }],
  ]);
  const choices = { identities: [{ pubkey: "agent" }] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const { container } = render(
    <ChannelMemberAvatars session={session} channelId="channel" />,
  );
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    members,
    "background",
  );
  expect(titles(container)).toEqual(["Alice", "Carol", "Bob"]);
  expect(screen.getByText("+2")).toBeInTheDocument();

  // A photo fills the slot of a member not known to have one, after the
  // members already shown with photos.
  act(() => {
    profiles = new Map(profiles).set("erin", photo("Erin"));
    publish();
  });
  expect(titles(container)).toEqual(["Alice", "Carol", "Erin"]);
  expect(screen.getByTitle("Erin").querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/erin.png",
  );

  // Three shown photos hold the preview.
  act(() => {
    profiles = new Map(profiles).set("bob", photo("Bob"));
    publish();
  });
  expect(titles(container)).toEqual(["Alice", "Carol", "Erin"]);
  expect(screen.getByText("+2")).toBeInTheDocument();

  // A held member later found to be an agent is replaced at the end.
  act(() => {
    profiles = new Map(profiles).set("carol", {
      ...photo("Carol"),
      isAgent: true,
    });
    publish();
  });
  expect(titles(container)).toEqual(["Alice", "Erin", "Bob"]);
  expect(screen.getByText("+1")).toBeInTheDocument();

  act(() => {
    members = ["dana"];
    list = { channels: [{ id: "channel", members }] };
    publish();
  });
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    ["dana"],
    "background",
  );
  expect(titles(container)).toEqual(["Dana"]);
});

it("picks the preview again for each channel the header opens", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const members = ["alice", "bob", "carol", "dana"];
  const list = {
    channels: [
      { id: "first", members, viewerRole: "member" },
      { id: "second", members, viewerRole: "member" },
    ],
  };
  let profiles = new Map<string, { name: string; picture?: string }>([
    ["alice", photo("Alice")],
    ["bob", { name: "Bob" }],
    ["carol", photo("Carol")],
    ["dana", photo("Dana")],
  ]);
  const choices = { identities: [] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const header = (channelId: string) => (
    <ChannelMembersButton
      session={session}
      channelId={channelId}
      conversationName="General"
    />
  );
  const { rerender } = render(header("first"));
  act(() => {
    profiles = new Map(profiles).set("bob", photo("Bob"));
    for (const listener of listeners) listener();
  });
  expect(titles(screen.getByRole("button"))).toEqual([
    "Alice",
    "Carol",
    "Dana",
  ]);

  // Opening another channel starts from the profiles now known.
  rerender(header("second"));
  expect(titles(screen.getByRole("button"))).toEqual(["Alice", "Bob", "Carol"]);
});

it("rereads the names it shows after an access purge empties the directory", async () => {
  const viewer = keypair();
  const alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const subscribe = () => () => {};
  const list = { channels: [{ id: "channel", members: [alice.pubkey] }] };
  const choices = { identities: [] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: directory.queries,
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  try {
    render(<ChannelMemberAvatars session={session} channelId="channel" />);
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    wire.next().respond([profile(alice, { name: "Alice" })]);
    expect(await screen.findByTitle("Alice")).toBeInTheDocument();

    // Another channel's access loss drops every loaded profile.
    act(() => directory.clear());
    expect(screen.queryByTitle("Alice")).not.toBeInTheDocument();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const reread = wire.next();
    expect(reread.filters).toEqual([
      { kinds: [0], authors: [alice.pubkey], limit: 500 },
    ]);
    reread.respond([profile(alice, { name: "Alice" })]);
    expect(await screen.findByTitle("Alice")).toBeInTheDocument();
  } finally {
    cleanup();
    directory.dispose();
    reader.dispose();
  }
});

it("shows only participating agents in Solo and updates when one leaves", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let list = {
    channels: [
      {
        id: "solo",
        channelType: "solo",
        members: ["human", "included", "remote"],
      },
    ],
  };
  const choices = {
    identities: [
      {
        pubkey: "included",
        name: "Included agent",
        avatar: "https://example.test/agent.png",
      },
      { pubkey: "absent", name: "Not in this chat" },
    ],
  };
  const profiles = new Map([
    ["human", { name: "Human", isAgent: false }],
    ["remote", { name: "Remote agent", isAgent: true }],
  ]);
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  render(<ChannelMemberAvatars session={session} channelId="solo" />);
  expect(
    screen.getByTitle("Included agent").querySelector("img"),
  ).toHaveAttribute("src", "https://example.test/agent.png");
  expect(screen.getByTitle("Remote agent")).toBeInTheDocument();
  expect(screen.queryByTitle("Human")).not.toBeInTheDocument();
  expect(screen.queryByTitle("Not in this chat")).not.toBeInTheDocument();
  act(() => {
    list = {
      channels: [
        { id: "solo", channelType: "solo", members: ["human", "remote"] },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(screen.queryByTitle("Included agent")).not.toBeInTheDocument();
  expect(screen.getByTitle("Remote agent")).toBeInTheDocument();
});

it("holds Solo agents shown with library avatars when a profile picture arrives", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const list = {
    channels: [
      {
        id: "solo",
        channelType: "solo",
        members: ["first", "second", "third", "fourth"],
      },
    ],
  };
  const choices = {
    identities: ["First", "Second", "Third", "Fourth"].map((name) => ({
      pubkey: name.toLowerCase(),
      name,
      avatar: `https://example.test/${name.toLowerCase()}-library.png`,
    })),
  };
  let profiles = new Map<string, { name: string; picture?: string }>();
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const { container } = render(
    <ChannelMemberAvatars session={session} channelId="solo" />,
  );
  expect(titles(container)).toEqual(["First", "Second", "Third"]);

  act(() => {
    profiles = new Map([["fourth", photo("Fourth")]]);
    for (const listener of listeners) listener();
  });
  expect(titles(container)).toEqual(["First", "Second", "Third"]);
});

it("skips header renders on unrelated list publishes and updates on membership change", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const publish = (next: typeof list) => {
    list = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  const open = (members: string[], viewerRole: string) => ({
    id: "channel",
    members,
    viewerRole,
  });
  const other = { id: "other", members: [] as string[], preview: 0 };
  const channel = open(["alice"], "member");
  let list = { channels: [channel, other] };
  const profiles = new Map([
    ["alice", { name: "Alice" }],
    ["bob", { name: "Bob" }],
  ]);
  const choices = { identities: [] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const commits = vi.fn();
  render(
    <Profiler id="header" onRender={commits}>
      <ChannelMembersButton
        session={session}
        channelId="channel"
        conversationName="General"
      />
    </Profiler>,
  );
  expect(screen.getByTitle("Alice")).toBeInTheDocument();
  commits.mockClear();

  publish({
    channels: [channel, { ...other, preview: 1 }],
  });
  expect(commits).not.toHaveBeenCalled();

  publish({ channels: [open(["alice", "bob"], "guest"), other] });
  expect(
    screen.getByRole("button", { name: "Channel access for General" }),
  ).toBeInTheDocument();
  expect(screen.getByTitle("Bob")).toBeInTheDocument();
});

it("renders members of a channel missing from the list without rerendering on list publishes", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let list = { channels: [{ id: "other", members: [] as string[] }] };
  const members = ["alice"];
  const profiles = new Map([["alice", { name: "Alice" }]]);
  const choices = { identities: [] };
  const session = {
    channels: {
      subscribeList: subscribe,
      list: () => list,
      get: () => ({ id: "channel", members }),
    },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const commits = vi.fn();
  render(
    <Profiler id="header" onRender={commits}>
      <ChannelMemberAvatars session={session} channelId="channel" />
    </Profiler>,
  );
  expect(screen.getByTitle("Alice")).toBeInTheDocument();
  commits.mockClear();

  act(() => {
    list = { channels: [{ id: "other", members: [] }] };
    for (const listener of listeners) listener();
  });
  expect(commits).not.toHaveBeenCalled();
});
