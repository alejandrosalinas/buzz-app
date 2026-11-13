// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { IdentityNameView } from "../../features/identity-names/service";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import { WorkflowChannelPicker } from "./WorkflowChannelPicker";

afterEach(cleanup);

type TestProfileQueries = ProfileQueries & {
  setSnapshot(profiles: ReadonlyMap<string, Profile>): void;
};

function profileQueries(
  initial: ReadonlyMap<string, Profile> = new Map(),
  ensure: ProfileQueries["ensure"] = async () => {},
): TestProfileQueries {
  let profiles = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => profiles,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: vi.fn(ensure),
    setSnapshot(next: ReadonlyMap<string, Profile>) {
      profiles = next;
      for (const listener of listeners) listener();
    },
  } as unknown as TestProfileQueries;
}

it("shows and selects a DM by its participant label without changing its ID", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const alice = "a".repeat(64);
  render(
    <WorkflowChannelPicker
      channels={[
        {
          id: "dm-id",
          name: "private-conversation",
          channelType: "dm",
          participants: [alice],
        },
      ]}
      profiles={profileQueries(new Map([[alice, { name: "Alice" }]]))}
      onSelect={onSelect}
    />,
  );

  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.click(input);
  const option = await screen.findByRole("option", { name: "Alice" });
  expect(option).toBeVisible();
  await user.click(option);

  expect(input).toHaveValue("Alice");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("dm-id");
});

it("searches for a DM by its participant label", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const alice = "a".repeat(64);
  render(
    <WorkflowChannelPicker
      channels={[
        {
          id: "dm-id",
          name: "private-conversation",
          channelType: "dm",
          participants: [alice],
        },
        { id: "channel-id", name: "general" },
      ]}
      profiles={profileQueries(new Map([[alice, { name: "Alice" }]]))}
      onSelect={onSelect}
    />,
  );

  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.type(input, "Alice");
  const option = await screen.findByRole("option", { name: "Alice" });
  expect(option).toHaveAttribute("data-highlighted");
  await user.keyboard("{Enter}");

  expect(onSelect).toHaveBeenCalledExactlyOnceWith("dm-id");
});

it("uses the shared identity name when it differs from the profile name", async () => {
  const user = userEvent.setup();
  const participant = "d".repeat(64);
  const names = {
    resolve: (id: string, fallback?: string) =>
      id === participant ? "Friendly Name" : fallback,
    snapshot: () => 0,
    subscribe: () => () => {},
  } as unknown as IdentityNameView;
  const onSelect = vi.fn();
  render(
    <WorkflowChannelPicker
      channels={[
        {
          id: "named-dm-id",
          name: "raw-dm-name",
          channelType: "dm",
          participants: [participant],
        },
      ]}
      profiles={profileQueries(
        new Map([[participant, { name: "Profile Name" }]]),
      )}
      names={names}
      onSelect={onSelect}
    />,
  );

  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.type(input, "Friendly Name");
  expect(
    await screen.findByRole("option", { name: "Friendly Name" }),
  ).toHaveAttribute("data-highlighted");
  await user.keyboard("{Enter}");

  expect(onSelect).toHaveBeenCalledExactlyOnceWith("named-dm-id");
});

it("disambiguates and searches DM names across all eligible choices", async () => {
  const user = userEvent.setup();
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  const names = {
    resolve: (
      id: string,
      fallback?: string,
      candidates?: readonly string[],
    ) => {
      if (id === first || id === second) {
        const other = id === first ? second : first;
        return candidates?.includes(other)
          ? `Alex · ${id.slice(-4)}`
          : (fallback ?? "Alex");
      }
      return fallback;
    },
    snapshot: () => 0,
    subscribe: () => () => {},
  } as unknown as IdentityNameView;
  const onSelect = vi.fn();

  render(
    <WorkflowChannelPicker
      channels={[
        {
          id: "first-dm-id",
          name: "raw-first-name",
          channelType: "dm",
          participants: [first],
        },
        {
          id: "second-dm-id",
          name: "raw-second-name",
          channelType: "dm",
          participants: [second],
        },
      ]}
      profiles={profileQueries(
        new Map([
          [first, { name: "Alex" }],
          [second, { name: "Alex" }],
        ]),
      )}
      names={names}
      onSelect={onSelect}
    />,
  );

  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  expect(
    await screen.findByRole("option", { name: "Alex · aaaa" }),
  ).toBeVisible();
  expect(
    await screen.findByRole("option", { name: "Alex · bbbb" }),
  ).toBeVisible();

  await user.type(input, "Alex · bbbb");
  expect(
    await screen.findByRole("option", { name: "Alex · bbbb" }),
  ).toHaveAttribute("data-highlighted");
  await user.keyboard("{Enter}");

  expect(input).toHaveValue("Alex · bbbb");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("second-dm-id");
});

it("shows fallbacks during profile loading and keeps them searchable", async () => {
  const user = userEvent.setup();
  const missing = "c".repeat(64);
  let releaseFetch!: () => void;
  let startFetch!: () => void;
  const pendingFetch = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const fetchStarted = new Promise<void>((resolve) => {
    startFetch = resolve;
  });
  const queries = profileQueries(new Map(), async () => {
    startFetch();
    await pendingFetch;
  });
  const onSelect = vi.fn();
  try {
    render(
      <WorkflowChannelPicker
        channels={
          [
            {
              id: "missing-profile-dm",
              name: "raw-dm-name",
              channelType: "dm",
              participants: [missing],
              hidden: true,
            },
            {
              id: "self-dm",
              name: "raw-self-name",
              channelType: "dm",
              participants: [],
            },
            {
              id: "hidden-channel",
              name: "hidden-stream",
              channelType: "stream",
              hidden: true,
            },
          ] satisfies readonly ChannelSummary[]
        }
        profiles={queries}
        onSelect={onSelect}
      />,
    );

    await fetchStarted;
    expect(
      await screen.findByRole("option", { name: missing.slice(0, 10) }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Notes to self" })).toBeVisible();
    expect(screen.getByRole("option", { name: "hidden-stream" })).toBeVisible();

    const input = screen.getByRole("combobox", { name: "Choose a channel" });
    await user.type(input, missing.slice(0, 10));
    expect(
      await screen.findByRole("option", { name: missing.slice(0, 10) }),
    ).toHaveAttribute("data-highlighted");
    await user.clear(input);

    releaseFetch();
    await pendingFetch;
    expect(
      await screen.findByRole("option", { name: missing.slice(0, 10) }),
    ).toBeVisible();
    await user.type(input, missing.slice(0, 10));
    expect(
      await screen.findByRole("option", { name: missing.slice(0, 10) }),
    ).toHaveAttribute("data-highlighted");
    await user.clear(input);

    act(() => queries.setSnapshot(new Map([[missing, { name: "Casey" }]])));
    expect(await screen.findByRole("option", { name: "Casey" })).toBeVisible();

    await user.type(input, "Notes to self");
    expect(
      await screen.findByRole("option", { name: "Notes to self" }),
    ).toHaveAttribute("data-highlighted");
    await user.clear(input);

    await user.type(input, "Casey");
    expect(
      await screen.findByRole("option", { name: "Casey" }),
    ).toHaveAttribute("data-highlighted");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Casey");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("missing-profile-dm");
  } finally {
    releaseFetch();
    await pendingFetch;
  }
});

it("picks the first matching channel with Enter, without an arrow key", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const channel = (id: string, name: string): ChannelSummary => ({ id, name });
  render(
    <WorkflowChannelPicker
      channels={[
        channel("1", "general"),
        channel("2", "design-reviews"),
        channel("3", "design"),
      ]}
      profiles={profileQueries()}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.type(input, "des");
  expect(
    await screen.findByRole("option", { name: "design-reviews" }),
  ).toHaveAttribute("data-highlighted");
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("2");
});

it("ranks an exact name before a longer one that contains it", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <WorkflowChannelPicker
      channels={[
        { id: "1", name: "dev-general" },
        { id: "2", name: "general" },
      ]}
      profiles={profileQueries()}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.type(input, "general");
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["general", "dev-general"]);
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("2");
});

it("does not pick a channel with Enter before anything is typed", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <WorkflowChannelPicker
      channels={[{ id: "1", name: "general" }]}
      profiles={profileQueries()}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.click(input);
  expect(screen.queryByRole("option", { name: "general" })).not.toHaveAttribute(
    "data-highlighted",
  );
  await user.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
});
