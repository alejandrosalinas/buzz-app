// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, AgentChange, Agents } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import { readView, writeView } from "../../shared/view-state";
import { setDefaultAgent } from "../../features/solo/default-agent";
import { onBestieMade } from "../agents/BestieChoice";
import { bestieTab, formerBestieTab } from "./BestieTab";
import { validateObject } from "../../features/agents/attention";
import { checkinHourly, memory, withFeature } from "./features";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const NO_CHANNELS = { channels: [] };
const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const member = (name: string, digit: string): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
    attention: {},
  }) as unknown as Agent;
const ada = member("Ada", "a");
const bea = member("Bea", "b");

/** Agents that save as a synced editor would: the agent's next config.
 * `listed` are the agents it finds, Ada and Bea, both on this device. */
function host(types = ["test/echo"], listed: Agent[] = [ada, bea]) {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = {
    save,
    hostedInstructions: () => undefined,
    types: () => types.map((key) => ({ key, adopt: () => ({}) })),
    find: (pubkey: string) => listed.find((each) => each.pubkey === pubkey),
  } as unknown as Pick<Agents, "save" | "types" | "find">;
  return { agents, save };
}

function community(saved: string | null | undefined, agents = [ada, bea]) {
  let record: string | null | undefined = saved;
  const choice = (agent: Agent) => ({
    pubkey: agent.pubkey,
    name: agent.name,
    managed: true,
  });
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: agents.map(choice),
    selectable: agents.map(choice),
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: vi.fn(async () => record),
    // None reads back as a saved none, as the account's reader does.
    write: vi.fn(async (agent: string | null) => {
      record = agent;
    }),
  };
  const connection = {
    status: "ready",
    scope: SCOPE,
    session: {
      viewer: OWNER,
      directMessages: { open: vi.fn(async () => DM) },
      channels: {
        list: () => NO_CHANNELS,
        subscribeList: () => () => {},
        ensureList: () => () => {},
      },
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  let current: unknown = connection;
  const relayListeners = new Set<() => void>();
  const relay = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => void relayListeners.delete(listener);
    },
  } as unknown as RelayData;
  /** Replaces the session, as a reconnection does. */
  const reconnect = (scope: string) => {
    current = {
      ...connection,
      scope,
      session: { ...connection.session, mainAgent: { ...mainAgent } },
    };
    for (const listener of relayListeners) listener();
  };
  return { relay, mainAgent, reconnect };
}

it("shows on the saved Bestie only, and moves when Change picks another", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  // Nothing shows before the account's choice is read.
  expect(tab.when?.(ada)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(tab.when?.(bea)).toBe(false);
  // The same agent in another community is not this one's Bestie.
  expect(tab.when?.({ ...ada, relay: "wss://other.example" })).toBe(false);

  const Tab = tab.component;
  render(<Tab agent={ada} />);
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  // A type without instructions has nothing to switch.
  expect(screen.getByText("Remembers you")).toBeVisible();
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  changed.mockClear();
  await user.click(screen.getByRole("button", { name: "Change" }));
  // Change offers every other agent you can make Bestie.
  expect(screen.queryByRole("menuitem", { name: "Ada" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(bea.pubkey);
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(true));
  expect(tab.when?.(ada)).toBe(false);
  // The host is told, so the tab moves without a reload.
  expect(changed).toHaveBeenCalled();
  stop?.();
});

const deviceChoice = () => readView(SCOPE, "solo:default-agent", null);

/** Opens Change and confirms Bea in place of Ada. */
async function switchToBea(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  return confirmation;
}

it("puts this device back on the account's Bestie when a failed Change is closed with the panel", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  const tab = bestieTab(relay, host([]).agents);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  const confirmation = await switchToBea(user);
  expect(await within(confirmation).findByRole("alert")).toBeVisible();
  expect(deviceChoice()).toBe(bea.pubkey);
  // Closing the side panel, not Keep.
  unmount();
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("puts this device back when a Change still saving fails after the panel closes", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  let fail = (_: Error) => {};
  mainAgent.write.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const tab = bestieTab(relay, host([]).agents);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  const Tab = tab.component;
  const { unmount } = render(<Tab agent={ada} />);
  await switchToBea(user);
  expect(deviceChoice()).toBe(bea.pubkey);
  unmount();
  await act(async () => fail(new Error("offline")));
  expect(deviceChoice()).toBe(ada.pubkey);
  stop?.();
});

it("offers a remote agent in Change, and says what it can't do before switching", async () => {
  const user = userEvent.setup();
  const cara = { ...member("Cara", "c"), place: "hosted" } as Agent;
  const { relay, mainAgent } = community(ada.pubkey, [ada, bea, cara]);
  const Tab = bestieTab(relay, host([], [ada, bea, cara]).agents).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  await user.click(screen.getByRole("button", { name: "Change" }));
  expect(await screen.findByRole("menuitem", { name: "Bea" })).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Cara" }));
  // One question: the replacement, with what a remote Bestie can't do.
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Cara your bestie?",
  });
  expect(confirmation).toHaveTextContent(
    "Your existing chats with Ada will still be available in your DMs. Some bestie features aren’t available with remote agents.",
  );
  expect(mainAgent.write).not.toHaveBeenCalled();
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Cara" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(cara.pubkey);
});

it("says nothing of remote agents when switching to one on this device", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const Tab = bestieTab(relay, host([]).agents).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  expect(confirmation).not.toHaveTextContent("remote");
});

it("shows a hosted Bestie's switches as unavailable when its provider has no instructions to edit, and saves nothing", async () => {
  const remote = {
    ...ada,
    place: "hosted",
    type: "block.builderlab/builderlab",
  } as Agent;
  const { relay } = community(ada.pubkey);
  const { agents, save } = host(["block.builderlab/builderlab"], [remote, bea]);
  const Tab = bestieTab(relay, agents).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  // Its instructions and timers are its provider's: nothing to switch here.
  expect(screen.getByText("Remembers you")).toBeVisible();
  expect(screen.queryAllByRole("switch")).toEqual([]);
  expect(
    screen.getAllByText("Not available with remote agents yet.").length,
  ).toBeGreaterThan(0);
  expect(save).not.toHaveBeenCalled();
  // It can still stop being Bestie.
  expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
});

/** A hosted Bestie whose provider holds `text`, read and replaced as its
 * provider's `get` and `set` do. */
const CHANGED_ELSEWHERE = "Its instructions were changed elsewhere.";
function hostedBestie(text: string) {
  let held = text;
  const get = vi.fn(async (_signal?: AbortSignal) => held);
  // As Agents does: replace only while the provider still holds `base`.
  const set = vi.fn(
    async (next: string, base: string, _signal?: AbortSignal) => {
      if (held !== base) throw new Error(CHANGED_ELSEWHERE);
      held = next;
    },
  );
  const remote = {
    ...ada,
    place: "hosted",
    type: "block.builderlab/builderlab",
  } as Agent;
  const { agents, save } = host(["block.builderlab/builderlab"], [remote, bea]);
  const hosted = { ...agents, hostedInstructions: () => ({ get, set }) };
  return {
    remote,
    agents: hosted,
    save,
    get,
    set,
    /** An edit saved through the provider's own settings or another device. */
    editElsewhere: (next: string) => {
      held = next;
    },
  };
}

it("shows a hosted Bestie's tab, not one on another device's", async () => {
  const { relay } = community(ada.pubkey);
  const tab = bestieTab(relay, host().agents);
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  stop?.();
  expect(tab.when?.({ ...ada, place: "hosted" } as Agent)).toBe(true);
  expect(tab.when?.({ ...ada, place: "elsewhere" } as Agent)).toBe(false);
});

it("turns a hosted Bestie's memory on and off through its provider, and never touches attention", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, save, get, set } = hostedBestie("Be brief.");
  const Tab = bestieTab(relay, agents).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  expect(get).toHaveBeenCalledTimes(1);
  expect(remembers).not.toBeChecked();
  await user.click(remembers);
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
  expect(set.mock.calls[0]?.[0]).toBe(withFeature("Be brief.", memory, true));
  // What the provider now holds is what the switch shows.
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
  expect(get).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
  expect(set.mock.calls[1]?.[0]).toBe("Be brief.");
  expect(save).not.toHaveBeenCalled();
  // Its timers never run here.
  expect(
    screen.queryByRole("switch", { name: "Every hour" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getAllByText("Not available with remote agents yet."),
  ).toHaveLength(1);
});

it("never replaces a hosted Bestie's instructions edited elsewhere since the tab read them", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, get, set, editElsewhere } = hostedBestie("Be brief.");
  const Tab = bestieTab(relay, agents).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  // The owner saves a restriction in the provider while the tab stays open.
  editElsewhere("Be brief. Never email anyone.");
  await user.click(remembers);
  expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeVisible();
  expect(set).toHaveBeenCalledTimes(1);
  expect(await get.mock.results.at(-1)?.value).toBe(
    "Be brief. Never email anyone.",
  );
  // The switch now saves from the newer copy, keeping the owner's edit.
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
  expect(set.mock.calls.at(-1)?.[0]).toBe(
    withFeature("Be brief. Never email anyone.", memory, true),
  );
});

it("says why a hosted Bestie's instructions can't be read or saved, and lets either be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { remote, agents, get, set } = hostedBestie("Be brief.");
  get.mockRejectedValueOnce(new Error("Builderlab is down."));
  const Tab = bestieTab(relay, agents).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  expect(await screen.findByText("Builderlab is down.")).toBeVisible();
  expect(screen.queryByRole("switch")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  const remembers = await screen.findByRole("switch", {
    name: "Remembers you",
  });
  set.mockRejectedValueOnce(new Error("Instructions are too long."));
  await user.click(remembers);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Instructions are too long.",
  );
  expect(
    screen.getByRole("switch", { name: "Remembers you" }),
  ).not.toBeChecked();
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked(),
  );
});

it("keeps Change unavailable while there is no other agent to choose", async () => {
  const { relay } = community(ada.pubkey, [ada]);
  const Tab = bestieTab(relay, host().agents).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
});

it("asks before making a remote former Bestie your Bestie again, and Cancel changes nothing", async () => {
  const user = userEvent.setup();
  // Saved none: there is no Bestie to replace.
  const { relay, mainAgent } = community(null);
  const remote = {
    ...ada,
    place: "elsewhere",
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const Tab = formerBestieTab(relay, host([], [bea, remote]).agents).component;
  await act(async () => {
    render(<Tab agent={remote} />);
  });
  const again = screen.getByRole("button", { name: "Make my Bestie again" });
  expect(again).toBeEnabled();
  await user.click(again);
  const ask = await screen.findByRole("alertdialog", {
    name: "Use Ada as your bestie?",
  });
  expect(ask).toHaveTextContent(
    "Some bestie features aren’t available with remote agents.",
  );
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mainAgent.write).not.toHaveBeenCalled();
  await user.click(again);
  await user.click(
    within(
      await screen.findByRole("alertdialog", {
        name: "Use Ada as your bestie?",
      }),
    ).getByRole("button", { name: "Use as bestie" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(ada.pubkey);
  await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("tells the host only when the Bestie or its community changes", async () => {
  const { relay, reconnect } = community(ada.pubkey);
  const tab = bestieTab(relay, host([]).agents);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  changed.mockClear();
  // Other view state in the community, such as a draft, isn't a change.
  writeView(SCOPE, "composer:draft", "hello");
  expect(changed).not.toHaveBeenCalled();
  // A new session in another community is.
  reconnect(`https://other.example:${OWNER}`);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(tab.when?.(ada)).toBe(false);
  stop?.();
});

it("turns memory on and off as a marked section of the instructions", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const base = { instructions: "head-1" };
  const agent = {
    ...ada,
    config: { model: "m", instructions: "Be brief." },
    configBase: base,
  } as Agent;
  const { rerender } = render(<Tab agent={agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).not.toBeChecked();
  expect(
    screen.getByText(/Nothing Bestie remembered is deleted/),
  ).toBeVisible();

  await user.click(remembers);
  const on = withFeature("Be brief.", memory, true);
  // Revises the head the tab showed, keeping the rest of the config.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { model: "m", instructions: on },
    base,
  });
  expect(on).toMatch(
    /^Be brief\.\n\n<!-- buzz:bestie\/memory v1 -->\n# Memory\n/,
  );

  // The saved instructions are what the switch shows.
  rerender(
    <Tab agent={{ ...agent, config: { model: "m", instructions: on } }} />,
  );
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { model: "m", instructions: "Be brief." },
    base,
  });
});

it("keeps memory on through the owner's edits, and offers Restore for edited markers", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const base = { instructions: "head-2" };
  const on = withFeature("Be brief.", memory, true);
  const close = "<!-- /buzz:bestie/memory -->";
  const shown = (instructions: string) =>
    ({ ...ada, config: { instructions }, configBase: base }) as Agent;
  // Typed below the section, which lands on its closing marker's line.
  const typed = `${on} Also French.`;
  const { rerender } = render(<Tab agent={shown(typed)} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  expect(remembers).toBeChecked();
  await user.click(remembers);
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { instructions: "Be brief.\n\nAlso French." },
    base,
  });

  // A closing marker edited by hand: no switch to add a second section.
  save.mockClear();
  const edited = on.replace(close, "<!-- /buzz:bestie/memory--> Also French.");
  rerender(<Tab agent={shown(edited)} />);
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  expect(screen.getByText(/edited where it starts or ends/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Restore" }));
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: `${on} Also French.` },
    base,
  });

  // With a marker gone, where the section ended is the owner's to say.
  rerender(<Tab agent={shown(on.replace(close, ""))} />);
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  expect(screen.getByText(/Fix its start and end lines there/)).toBeVisible();
  // Check-ins wait on memory.
  expect(screen.getByRole("switch", { name: "Every hour" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("says why a save failed and lets the switch be tried again", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  save.mockRejectedValueOnce(new Error("Connect to the community to save"));
  const Tab = bestieTab(relay, agents).component;
  render(<Tab agent={{ ...ada, config: {} } as Agent} />);
  const remembers = screen.getByRole("switch", { name: "Remembers you" });
  await user.click(remembers);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connect to the community to save",
  );
  expect(remembers).not.toBeChecked();
  expect(remembers).not.toHaveAttribute("aria-disabled", "true");
  // A config with no instructions yet gets the section alone.
  expect(save).toHaveBeenCalledWith(ada.key, {
    config: { instructions: withFeature("", memory, true) },
  });
});

it("offers no switch while the agent's instructions can't be read here", () => {
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  render(
    <Tab
      agent={
        {
          ...ada,
          config: {},
          configProblem: "This agent's instructions could not be read",
        } as Agent
      }
    />,
  );
  expect(screen.queryByRole("switch", { name: "Remembers you" })).toBeNull();
  // Each setting's row says why, check-ins too.
  expect(
    screen.getAllByText("This agent's instructions could not be read"),
  ).toHaveLength(2);
  expect(save).not.toHaveBeenCalled();
});

it("checks in every hour only while memory is on, with a timer in the owner's DM", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const base = { instructions: "head-1" };
  const remembering = withFeature("Be brief.", memory, true);
  const off = {
    ...ada,
    config: { instructions: "Be brief." },
    configBase: base,
  };
  const { rerender } = render(<Tab agent={off as Agent} />);
  const hourly = () => screen.getByRole("switch", { name: "Every hour" });
  // Memory is off, so check-ins can't be turned on.
  expect(hourly()).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Turn on Remembers you first.")).toBeVisible();

  const on = { ...off, config: { instructions: remembering } } as Agent;
  rerender(<Tab agent={on} />);
  expect(hourly()).not.toBeChecked();
  await user.click(hourly());
  // The timer first, then the instructions that say what it is for.
  expect(save).toHaveBeenCalledTimes(2);
  const [[, timers], [, instructions]] = save.mock.calls as [
    [string, AgentChange],
    [string, AgentChange],
  ];
  expect(instructions).toEqual({
    config: { instructions: withFeature(remembering, checkinHourly, true) },
    base,
  });
  // Turning it on lets the agent's Attention run.
  expect(timers.attentionEnabled).toBe(true);
  expect(timers.attention?.["watch/bestie-hourly-check-in"]).toMatchObject({
    type: "timer",
    interest_id: "bestie-hourly-check-in",
    interval_secs: 3600,
    max_occurrences: null,
    expires_at: null,
    channel: DM,
    enabled: true,
  });
  // The objects are ones Attention accepts.
  for (const [slug, value] of Object.entries(timers.attention ?? {}))
    expect(validateObject(slug, value)).toBeUndefined();

  // On means the section and the timer are both there.
  const checking = {
    ...on,
    config: { instructions: withFeature(remembering, checkinHourly, true) },
    attention: {
      "interest/bestie-hourly-check-in": { value: { type: "interest" } },
      "watch/bestie-hourly-check-in": {
        value: { type: "timer", enabled: true },
      },
    },
  } as unknown as Agent;
  rerender(<Tab agent={checking} />);
  expect(hourly()).toBeChecked();
  // With Attention not running here, as while Watching is off, it says so.
  expect(screen.getByText(/^Paused: watches aren't running/)).toBeVisible();
  rerender(<Tab agent={{ ...checking, attentionEnabled: true } as Agent} />);
  expect(screen.queryByText(/^Paused/)).toBeNull();
  rerender(<Tab agent={{ ...checking, attention: {} } as Agent} />);
  expect(hourly()).not.toBeChecked();
  rerender(<Tab agent={checking} />);

  const removed = {
    attention: {
      "interest/bestie-hourly-check-in": null,
      "watch/bestie-hourly-check-in": null,
    },
  };
  // Memory off takes check-ins with it, and leaves Attention's switch alone.
  save.mockClear();
  await user.click(screen.getByRole("switch", { name: "Remembers you" }));
  expect(save.mock.calls).toEqual([
    [ada.key, removed],
    [ada.key, { config: { instructions: "Be brief." }, base }],
  ]);

  // Check-ins off removes only their section and timer.
  save.mockClear();
  await user.click(hourly());
  expect(save.mock.calls).toEqual([
    [ada.key, removed],
    [ada.key, { config: { instructions: remembering.trimEnd() }, base }],
  ]);

  // Left on after memory went some other way, it can still be turned off.
  rerender(
    <Tab
      agent={
        {
          ...checking,
          config: {
            instructions: withFeature("Be brief.", checkinHourly, true),
          },
        } as Agent
      }
    />,
  );
  expect(hourly()).toBeChecked();
  expect(hourly()).not.toHaveAttribute("aria-disabled", "true");
});

/** Ada with memory on and check-ins off, ready to turn Every hour on. */
function remembering(attentionEnabled = false) {
  return {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
    attentionEnabled,
  } as Agent;
}
const TIMER = "watch/bestie-hourly-check-in";
const INTEREST = "interest/bestie-hourly-check-in";

it("undoes a failed check-in's timer, so none runs behind a switch that reads off", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  render(<Tab agent={remembering()} />);
  const hourly = screen.getByRole("switch", { name: "Every hour" });
  save
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Instructions changed elsewhere"));
  await user.click(hourly);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Instructions changed elsewhere",
  );
  // The timer and its Interest are removed again, and Attention, which this
  // turned on, goes back off.
  expect(save).toHaveBeenCalledTimes(3);
  expect(save.mock.calls[2]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null, [TIMER]: null }, attentionEnabled: false },
  ]);
  expect(hourly).not.toBeChecked();
  // Trying again saves it all again.
  save.mockClear();
  await user.click(hourly);
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("leaves Attention on after a failed check-in when it was already on", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  render(<Tab agent={remembering(true)} />);
  save
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Instructions changed elsewhere"));
  await user.click(screen.getByRole("switch", { name: "Every hour" }));
  await screen.findByRole("alert");
  expect(save.mock.calls[2]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null, [TIMER]: null } },
  ]);
});

it("offers to remove a timer left without its section when undoing fails too", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const { rerender } = render(<Tab agent={remembering()} />);
  save
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Instructions changed elsewhere"))
    .mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("switch", { name: "Every hour" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Instructions changed elsewhere Its timer may still be saved; remove it below.",
  );
  // The agent as saved: the timer is there, its section isn't.
  const [[, timers]] = save.mock.calls as [[string, AgentChange]];
  const left = {
    ...remembering(),
    attentionEnabled: true,
    attention: Object.fromEntries(
      Object.entries(timers.attention ?? {}).map(([slug, value]) => [
        slug,
        { slug, value, modifiedAt: 1 },
      ]),
    ),
  } as unknown as Agent;
  rerender(<Tab agent={left} />);
  expect(screen.getByRole("switch", { name: "Every hour" })).not.toBeChecked();
  save.mockClear();
  await user.click(
    screen.getByRole("button", {
      name: "Remove",
      description: "Every hour's timer is still saved",
    }),
  );
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null, [TIMER]: null } },
  ]);
});

it("says a check-in paused in Attention is paused, and how to restart it", async () => {
  const user = userEvent.setup();
  const { relay } = community(ada.pubkey);
  const { agents, save } = host();
  const Tab = bestieTab(relay, agents).component;
  const paused = {
    ...remembering(true),
    config: {
      instructions: withFeature(
        withFeature("Be brief.", memory, true),
        checkinHourly,
        true,
      ),
    },
    attention: {
      [INTEREST]: { value: { type: "interest" } },
      [TIMER]: { value: { type: "timer", enabled: false } },
    },
  } as unknown as Agent;
  render(<Tab agent={paused} />);
  const hourly = screen.getByRole("switch", { name: "Every hour" });
  // Still on, so Off still removes it.
  expect(hourly).toBeChecked();
  expect(
    screen.getByText(
      "Paused in Attention. Turn Every hour off and on again to restart it.",
    ),
  ).toBeVisible();
  await user.click(hourly);
  expect(save.mock.calls[0]).toEqual([
    ada.key,
    { attention: { [INTEREST]: null, [TIMER]: null } },
  ]);
});

it("shows a Former Bestie tab while a former Bestie has a setting on, with a way back", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(bea.pubkey);
  const tab = formerBestieTab(relay, host().agents);
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = tab.subscribe?.(() => {});
  // Nobody is former before the account's choice is read.
  expect(tab.when?.(remembering)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(remembering)).toBe(true));
  // Not on the Bestie, nor on an agent with nothing on.
  expect(tab.when?.(bea)).toBe(false);
  expect(tab.when?.(ada)).toBe(false);

  const made = vi.fn();
  const stopMade = onBestieMade(made);
  const Tab = tab.component;
  render(<Tab agent={remembering} />);
  expect(
    screen.getByText("Ada is no longer your Bestie. These are still on."),
  ).toBeVisible();
  expect(screen.getByRole("switch", { name: "Remembers you" })).toBeChecked();
  const hourly = screen.getByRole("switch", { name: "Every hour" });
  expect(hourly).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Only your Bestie checks in.")).toBeVisible();
  expect(screen.getByText("Private channels Ada can read")).toBeVisible();

  await user.click(
    screen.getByRole("button", { name: "Make my Bestie again" }),
  );
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Ada your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Ada" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(ada.pubkey);
  // This device made it Bestie, so the plugin hears of it.
  await vi.waitFor(() => expect(made).toHaveBeenCalledWith(ada.pubkey));
  await vi.waitFor(() => expect(tab.when?.(remembering)).toBe(false));
  stopMade();
  stop?.();
});

it("removes the Bestie after asking, and shows the agent as a Former Bestie", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const agents = host().agents;
  const tab = bestieTab(relay, agents);
  const former = formerBestieTab(relay, agents);
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = tab.subscribe?.(() => {});
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(former.when?.(remembering)).toBe(false);
  const Tab = tab.component;
  render(<Tab agent={remembering} />);
  // A failed save says so and keeps the Bestie.
  mainAgent.write.mockRejectedValueOnce(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Remove" }));
  let ask = await screen.findByRole("alertdialog", {
    name: "Remove Ada as your Bestie?",
  });
  expect(ask).toHaveTextContent("Ada stays in Agents");
  expect(ask).toHaveTextContent("Its check-ins stop.");
  expect(ask).toHaveTextContent("memory rules and private channels stay");
  await user.click(
    within(ask).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(await within(ask).findByRole("alert")).toHaveTextContent(
    "Removing your Bestie couldn't be saved to your account. Try again.",
  );
  expect(tab.when?.(ada)).toBe(true);
  await user.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();

  await user.click(screen.getByRole("button", { name: "Remove" }));
  ask = await screen.findByRole("alertdialog", {
    name: "Remove Ada as your Bestie?",
  });
  await user.click(
    within(ask).getByRole("button", { name: "Remove as Bestie" }),
  );
  expect(mainAgent.write).toHaveBeenLastCalledWith(null);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(false));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // With no Bestie known, the agent with memory on is a Former Bestie.
  expect(former.when?.(remembering)).toBe(true);
  expect(former.when?.(bea)).toBe(false);
  stop?.();
});

it("shows no Former Bestie tab while the account's choice is unread or unreadable", async () => {
  const { relay, mainAgent } = community(undefined);
  mainAgent.read.mockRejectedValueOnce(new Error("offline"));
  const former = formerBestieTab(relay, host().agents);
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  const stop = former.subscribe?.(() => {});
  await act(async () => {});
  expect(former.when?.(remembering)).toBe(false);
  stop?.();
});

it("shows a Former Bestie tab on an account that saved none, not on one with no record", async () => {
  const remembering = {
    ...ada,
    config: { instructions: withFeature("Be brief.", memory, true) },
  } as Agent;
  for (const [record, shows] of [
    [undefined, false],
    [null, true],
  ] as const) {
    const { relay, mainAgent } = community(record);
    const former = formerBestieTab(relay, host().agents);
    const stop = former.subscribe?.(() => {});
    await act(async () => {});
    expect(mainAgent.read).toHaveBeenCalled();
    expect(former.when?.(remembering)).toBe(shows);
    stop?.();
    cleanup();
  }
});

it("offers no Remove without an account to save none to", async () => {
  const { relay } = community(undefined);
  // A device-only session would pick another agent at once.
  delete (relay.snapshot() as { session: { mainAgent?: unknown } }).session
    .mainAgent;
  setDefaultAgent(SCOPE, ada.pubkey);
  const Tab = bestieTab(relay, host().agents).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

it("lets a former Bestie's leftover check-in be turned off", async () => {
  const user = userEvent.setup();
  const { relay } = community(bea.pubkey);
  const { agents, save } = host();
  const Tab = formerBestieTab(relay, agents).component;
  const checking = {
    ...ada,
    config: {
      instructions: withFeature(
        withFeature("Be brief.", memory, true),
        checkinHourly,
        true,
      ),
    },
    attention: {
      "interest/bestie-hourly-check-in": {},
      "watch/bestie-hourly-check-in": {},
    },
  } as unknown as Agent;
  render(<Tab agent={checking} />);
  const hourly = screen.getByRole("switch", { name: "Every hour" });
  expect(hourly).toBeChecked();
  expect(hourly).not.toHaveAttribute("aria-disabled", "true");
  await user.click(hourly);
  expect(save).toHaveBeenLastCalledWith(ada.key, {
    config: { instructions: withFeature("Be brief.", memory, true) },
  });
});
