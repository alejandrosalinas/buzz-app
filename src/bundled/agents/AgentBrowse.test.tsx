// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventData, RelayEvent } from "../../features/relay/events";
import { createRelayReader } from "../../features/relay/reader";
import type { RelayData } from "../../features/relay/service";
import type { ReadTransport } from "../../features/relay/transport";
import type {
  Agent,
  Agents,
  AgentsSnapshot,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Profile } from "../../features/relay/contracts";
import { useState } from "react";
import {
  AgentBrowse as Catalog,
  SharedAgentPanel,
  type SharedAgentSelection,
} from "./AgentBrowse";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
function AgentBrowse(
  props: ReturnType<typeof importing> & {
    relay: RelayData;
    onOpen?: (agent: Agent) => void;
    openSettings?: (section: string) => void;
  },
) {
  const [selection, setSelection] = useState<SharedAgentSelection>();
  return (
    <>
      <Catalog
        relay={props.relay}
        selectedId={selection?.agent.id}
        onSelect={setSelection}
      />
      {selection && (
        <section aria-label="Shared agent profile">
          <PanelWorkspace
            value={selection.agent.id}
            select={() => {}}
            items={[
              {
                id: selection.agent.id,
                label: selection.agent.name,
                close: () => setSelection(undefined),
                content: <SharedAgentPanel selection={selection} {...props} />,
              },
            ]}
          />
        </section>
      )}
    </>
  );
}

afterEach(cleanup);

const echo = {
  key: "test/echo",
  title: "Echo",
  defaults: () => ({ config: { model: "default" } }),
  importShared: (source: { model: string }) => ({ model: source.model }),
} as RegisteredAgentType;
const notes = { key: "test/notes", title: "Notes" } as RegisteredAgentType;
const imported = { pubkey: "e".repeat(64), name: "Shared helper" } as Agent;
/** Import's props: one type, and an `agents` in `status` (with `error`)
 * holding `own` whose `port` resolves. */
const importing = (
  types: readonly RegisteredAgentType[] = [echo],
  own: readonly Agent[] = [],
  status: AgentsSnapshot["status"] = "ready",
  error?: string,
) => {
  const snapshot = { status, error, agents: own };
  return {
    agents: {
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
      port: vi.fn(async () => ({ agent: imported, notes: [] })),
    } as unknown as Agents & { port: ReturnType<typeof vi.fn> },
    types,
    onImported: vi.fn(),
  };
};

const shared: EventData = {
  id: "ab".repeat(32),
  pubkey: "cd".repeat(32),
  created_at: 1,
  kind: 30175,
  tags: [
    ["d", "helper"],
    ["shared", "true"],
  ],
  content: JSON.stringify({
    display_name: "Shared helper",
    model: "test-model",
    system_prompt: "Help with tasks.",
  }),
};

/** A profile directory holding `known`, by pubkey. */
const directory = (known: Record<string, Profile> = {}) => {
  const snapshot = new Map(Object.entries(known));
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    ensure: vi.fn(async () => {}),
  };
};

/** A ready community whose session reads through `read`. */
const community = (read: unknown, profiles = directory()) => {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://relay.example",
    session: { read, media: () => undefined, profiles },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
};

it("browses shared agents and opens read-only details", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.getByText("test-model")).toBeVisible();
  expect(read).toHaveBeenCalledWith([{ kinds: [30175], limit: 200 }], {
    signal: expect.any(AbortSignal),
  });
  fireEvent.click(screen.getByRole("button", { name: "Shared helper" }));
  expect(
    await screen.findByRole("region", { name: "Shared agent profile" }),
  ).toBeVisible();
  expect(screen.getByText("Help with tasks.")).toBeVisible();
  // Unknown to the profile directory, the sharer shows as their short key.
  expect(screen.getByText("Shared by")).toBeVisible();
  expect(screen.getByText(/^npub…/)).toBeVisible();
});

it("scrolls to an agent selected from elsewhere, not one chosen here", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  try {
    const read = vi.fn().mockResolvedValue([shared]);
    const relay = community(read);
    const onSelect = vi.fn();
    const view = render(<Catalog relay={relay} onSelect={onSelect} />);
    const card = await screen.findByRole("button", { name: "Shared helper" });
    fireEvent.click(card);
    const [{ agent }] = onSelect.mock.calls[0] ?? [];
    view.rerender(
      <Catalog relay={relay} selectedId={agent.id} onSelect={onSelect} />,
    );
    expect(card).toHaveAttribute("aria-current", "true");
    expect(scrollIntoView).not.toHaveBeenCalled();
    // As View on a published agent selects it, before its page has loaded.
    view.unmount();
    render(<Catalog relay={relay} selectedId={agent.id} onSelect={onSelect} />);
    const listed = await screen.findByRole("button", { name: "Shared helper" });
    await vi.waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
        block: "center",
      }),
    );
    expect(scrollIntoView.mock.contexts[0]).toBe(listed);
  } finally {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

it("asks to connect while no community is ready", () => {
  const snapshot = { status: "disconnected", generation: 0 };
  render(
    <AgentBrowse
      relay={
        {
          snapshot: () => snapshot,
          subscribe: () => () => {},
        } as unknown as RelayData
      }
      {...importing()}
    />,
  );
  expect(
    screen.getByText("Connect to a community to browse shared agents."),
  ).toBeVisible();
});

it("allows retrying a failed read without claiming the community is empty", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  expect(
    screen.queryByText("No shared agents found in this community yet."),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText("No shared agents found in this community yet."),
  ).toBeVisible();
});

it("shrinks over-budget pages and preserves Load more and explicit retry", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 200 - index,
    tags: [
      ["d", `helper-${Math.floor(index / 100)}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: `Helper ${index}`,
      system_prompt: "x".repeat(48 * 1024),
    }),
  })) as RelayEvent[];
  let failNextPage = true;
  const query = vi.fn<ReadTransport["query"]>(async (filters) => {
    const filter = filters[0];
    if (!filter) throw new Error("Missing filter");
    if (filter.until !== undefined && failNextPage) {
      failNextPage = false;
      throw new Error("offline");
    }
    return events
      .filter(
        (event) =>
          filter.until === undefined || event.created_at < filter.until,
      )
      .slice(0, filter.limit);
  });
  const owned = createRelayReader({
    viewer: shared.pubkey,
    relayAuthor: "relay",
    media: () => undefined,
    query,
  });
  const view = render(
    <AgentBrowse relay={community(owned.reader.read)} {...importing()} />,
  );
  try {
    await screen.findByText("Helper 0");
    expect(
      query.mock.calls.slice(0, 2).map(([filters]) => filters[0]?.limit),
    ).toEqual([200, 100]);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Helper 100")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Helper / })).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(
      query.mock.calls.slice(2).map(([filters]) => filters[0]?.until),
    ).toEqual([101, 101]);
  } finally {
    view.unmount();
    owned.dispose();
  }
});

it("starts over from the first page in another community", async () => {
  const page = Array.from({ length: 200 }, (_, index) => ({
    ...shared,
    id: index.toString(16).padStart(64, "0"),
    created_at: 300 - index,
    tags: [
      ["d", `first-${index}`],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: `First ${index}` }),
  }));
  const first = vi.fn(async (filters: { until?: number }[]) =>
    filters[0]?.until === undefined ? page : [],
  );
  const second = vi.fn().mockResolvedValue([shared]);
  let snapshot = {
    status: "ready",
    generation: 1,
    origin: "https://one.example",
    session: { read: first, media: () => undefined, profiles: directory() },
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  render(<AgentBrowse relay={relay} {...importing()} />);
  await screen.findByText("First 0");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
  snapshot = {
    status: "ready",
    generation: 2,
    origin: "https://two.example",
    session: { read: second, media: () => undefined, profiles: directory() },
  };
  act(() => {
    for (const listener of listeners) listener();
  });
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(screen.queryByText("First 0")).not.toBeInTheDocument();
  expect(second).toHaveBeenCalledExactlyOnceWith(
    [{ kinds: [30175], limit: 200 }],
    { signal: expect.any(AbortSignal) },
  );
});

it("names the sharer by their profile, with their key on hover", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const profiles = directory({ [shared.pubkey]: { name: "Cora" } });
  render(<AgentBrowse relay={community(read, profiles)} {...importing()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(dialog).getByText("Cora")).toBeVisible();
  expect(within(dialog).queryByText(/^npub…/)).not.toBeInTheDocument();
  expect(profiles.ensure).toHaveBeenCalledWith([shared.pubkey]);
  expect(within(dialog).getByText("test-model")).toBeVisible();
});

it("imports a shared agent through the import path, then hands back", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        system_prompt: "Help with tasks.",
        avatar_url: "https://example.test/helper.png",
      }),
    },
  ]);
  const props = importing();
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  expect(within(dialog).queryByLabelText("Import as")).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  // Laid out as the Identity tab: the type it runs as is chosen in place.
  expect(
    within(confirmation).getByRole("combobox", { name: "Harness" }),
  ).toBeVisible();
  expect(
    within(confirmation).getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Help with tasks.");
  expect(props.agents.port).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Import" }));
  await vi.waitFor(() =>
    expect(props.onImported).toHaveBeenCalledExactlyOnceWith(imported),
  );
  expect(props.agents.port).toHaveBeenCalledExactlyOnceWith({
    source: "shared",
    type: "test/echo",
    name: "Shared helper",
    picture: "https://example.test/helper.png",
    instructions: "Help with tasks.",
    config: { model: "test-model" },
  });
});

it("says how to import, and undoes edits back to what was shared", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(dialog).toHaveAccessibleDescription(
    "Import it as is, or edit anything below first. Changes only affect your copy.",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Undo changes" }),
  ).not.toBeInTheDocument();
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  fireEvent.change(instructions, { target: { value: "Help with less." } });
  expect(dialog).toHaveAccessibleDescription(
    "Edited. Changes only affect your copy.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Undo changes" }));
  expect(instructions).toHaveValue("Help with tasks.");
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toHaveFocus();
  expect(
    within(dialog).queryByRole("button", { name: "Undo changes" }),
  ).not.toBeInTheDocument();
});

it("offers to open an agent you already have rather than copy it", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        runtime: "test/echo",
        system_prompt: "Help with tasks.",
      }),
    },
  ]);
  const mine = {
    pubkey: "f".repeat(64),
    name: "Shared helper",
    type: "test/echo",
    config: { model: "test-model" },
  } as unknown as Agent;
  const props = importing(
    [
      {
        ...echo,
        exportShared: () => ({ model: "test-model", runtime: "test/echo" }),
        carry: () => ({ instructions: "Help with tasks." }),
      } as unknown as RegisteredAgentType,
    ],
    [mine],
  );
  const onOpen = vi.fn();
  render(<AgentBrowse relay={community(read)} {...props} onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(dialog).toHaveAccessibleDescription("You already have this agent.");
  expect(
    within(dialog).queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Open Shared helper" }),
  );
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(mine);
  // A second copy stays a choice.
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Import a copy" }),
  );
  await vi.waitFor(() => expect(props.onImported).toHaveBeenCalledOnce());
});

it("refuses a shared agent whose instructions block/buzz would refuse", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        model: "test-model",
        system_prompt: "Help \u202Ewith tasks.",
      }),
    },
  ]);
  const props = importing();
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  const panel = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(panel).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  expect(within(confirmation).getByRole("alert")).toHaveTextContent(
    "Agent instructions contains prohibited invisible or formatting character U+202E",
  );
  const confirm = within(confirmation).getByRole("button", { name: "Import" });
  expect(confirm).toBeDisabled();
  fireEvent.click(confirm);
  expect(props.agents.port).not.toHaveBeenCalled();
});

it("imports as the chosen type, and keeps the panel open with the error when it fails", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([echo, notes]);
  props.agents.port.mockRejectedValueOnce(
    new Error("Connect to a community first"),
  );
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  const dialog = await screen.findByRole("region", {
    name: "Shared agent profile",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  const confirmation = screen.getByRole("dialog", {
    name: "Shared helper",
  });
  expect(
    within(confirmation).queryByRole("button", { name: "Change settings" }),
  ).not.toBeInTheDocument();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Import" }));
  expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
    "Connect to a community first",
  );
  expect(props.onImported).not.toHaveBeenCalled();
  expect(props.agents.port).toHaveBeenCalledWith(
    expect.objectContaining({ source: "shared", type: "test/echo" }),
  );
});

it("does not silently replace an unavailable shared runtime", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([{ ...echo, importShared: () => undefined }]);
  render(<AgentBrowse relay={community(read)} {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toBeVisible();
  expect(props.agents.port).not.toHaveBeenCalled();
});

/** Opens a shared agent's Import dialog with no type to import as, while
 * Agents is in `status`. */
async function noTypes(
  status: AgentsSnapshot["status"],
  openSettings = vi.fn(),
  error?: string,
) {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([], [], status, error);
  render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  return screen.getByRole("dialog", { name: "Shared helper" });
}

// Desktop where no plugin registered a type that runs agents here: every
// agent plugin off, or one on that failed to activate. The component cannot
// tell these apart, so it names what is missing, not why.
it("says why a shared agent can't be imported here, and links Manage plugins", async () => {
  const openSettings = vi.fn();
  const dialog = await noTypes("ready", openSettings);
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
  // Settings opens in place of the dialog, not over it.
  expect(
    screen.queryByRole("dialog", { name: "Shared helper" }),
  ).not.toBeInTheDocument();
});

// Only a hosted type is on, so Manage plugins shows a plugin enabled. The
// page keeps hosted types out of Import, since an imported agent needs a key
// here, and the dialog must not claim no plugin is on.
it("does not say no plugin is on when only a hosted type is", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing([], [], "ready");
  const hosted = [
    { ...echo, key: "test/cloud", title: "Cloud", remote: {} },
  ] as unknown as RegisteredAgentType[];
  props.agents.types = () => hosted;
  const openSettings = vi.fn();
  render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  expect(within(dialog).queryByText(/plugin is turned on/)).toBeNull();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
});

it("keeps Manage plugins plain text while a shared agent is still importing", async () => {
  const read = vi.fn().mockResolvedValue([shared]);
  const props = importing();
  let fail = () => {};
  props.agents.port.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error("Keychain access was denied"));
      }),
  );
  const openSettings = vi.fn();
  const view = render(
    <AgentBrowse
      relay={community(read)}
      {...props}
      openSettings={openSettings}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const dialog = screen.getByRole("dialog", { name: "Shared helper" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(props.agents.port).toHaveBeenCalledTimes(1);
  // The last agent plugin goes off while the import is still running.
  const gone = importing([]);
  view.rerender(
    <AgentBrowse
      relay={community(read)}
      {...props}
      agents={gone.agents}
      types={gone.types}
      openSettings={openSettings}
    />,
  );
  expect(
    within(dialog).getByText(/No harness that runs agents on this computer/),
  ).toHaveTextContent(
    "No harness that runs agents on this computer is available. Check Manage plugins.",
  );
  // Opening Settings would close the dialog over the import, which Close
  // may not do either, so the link waits as plain text.
  expect(
    within(dialog).queryByRole("button", { name: "Manage plugins" }),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
  await act(async () => {
    fail();
  });
  // The import's outcome still lands in the dialog, and the link is back.
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Manage plugins" }),
  );
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plugins");
  expect(
    screen.queryByRole("dialog", { name: "Shared helper" }),
  ).not.toBeInTheDocument();
});

it("tells a browser that shared agents import only in the desktop app", async () => {
  // Outside the desktop app Agents is unavailable and no type registers.
  const dialog = await noTypes("unavailable");
  expect(
    within(dialog).getByText(
      "Agents runs in the desktop app. Open Buzz there to import one.",
    ),
  ).toBeVisible();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("says a shared agent can't be imported while Agents could not load", async () => {
  const dialog = await noTypes("error", vi.fn(), "Keychain is locked.");
  expect(
    within(dialog).getByText("Agents could not load. Keychain is locked."),
  ).toBeVisible();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("waits for agent types to register instead of asking for a plugin", async () => {
  const dialog = await noTypes("loading");
  // Loading feedback is delayed a second, as LoadingRegion does everywhere.
  expect(
    await within(dialog).findByRole("status", undefined, { timeout: 2000 }),
  ).toHaveTextContent("Loading agent types…");
  expect(
    within(dialog).queryByText(/No harness that runs agents on this computer/),
  ).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/Manage plugins/)).not.toBeInTheDocument();
});

it("collapses long instructions and expands them on request", async () => {
  const read = vi.fn().mockResolvedValue([
    {
      ...shared,
      content: JSON.stringify({
        display_name: "Shared helper",
        system_prompt: "Long instructions. ".repeat(100),
      }),
    },
  ]);
  render(<AgentBrowse relay={community(read)} {...importing()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Shared helper" }));
  expect(screen.getByRole("region", { name: "Instructions" })).toHaveAttribute(
    "data-collapsed",
  );
  fireEvent.click(screen.getByRole("button", { name: "See more" }));
  expect(
    screen.getByRole("region", { name: "Instructions" }),
  ).not.toHaveAttribute("data-collapsed");
  expect(screen.getByRole("button", { name: "See less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("reloads a catalog refused while signed out once the organization signs in", async () => {
  const { createRecovery } = await import("../../features/relay/recovery");
  const recovery = createRecovery([]);
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Federated sign-in is required"))
    .mockResolvedValue([shared]);
  const relay = community(read);
  Object.assign(relay.snapshot().session, { recovery });
  render(<AgentBrowse relay={relay} {...importing()} />);
  expect(await screen.findByText("Couldn’t load shared agents.")).toBeVisible();
  act(() => recovery.retryAll());
  expect(await screen.findByText("Shared helper")).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
  recovery.dispose();
});
