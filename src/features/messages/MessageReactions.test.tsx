// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";
import { PREVIEW_REST_MS } from "../../shared/design-system/ui/hoverIntent";
import { createRelaySession } from "../relay/session";
import {
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
  ReactionToolProps,
} from "../conversation/contracts";
import { PublishRejected } from "../relay/outbox";
import { useSyncExternalStore } from "react";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  // jsdom hides [popover] but does not implement showPopover. Model opening
  // for content assertions; browser tests cover top-layer painting and clipping.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
const registry = <T,>(
  entries: ReturnType<ContributionReader<T>["snapshot"]>,
): ContributionReader<T> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const inline = registry<InlineRenderer>([]);
const tools = registry<ComposerTool>([
  {
    key: "picker",
    pluginId: "picker",
    revision: "one",
    id: "picker",
    title: "Picker",
    component: () => null,
    reactionComponent: ({ select, disabled }: ReactionToolProps) => (
      <button type="button" disabled={disabled} onClick={() => select("👍")}>
        Choose reaction
      </button>
    ),
  },
]);
const root = message(other, "c", "Message", 1);
const react = (key = viewer, time = 2) =>
  signed(key, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
  });
const customReaction = (key: typeof viewer, code: string, url: string) =>
  signed(key, {
    kind: 7,
    content: `:${code}:`,
    created_at: 2,
    tags: [
      ["h", "c"],
      ["e", root.id],
      ["emoji", code, url],
    ],
  });
function harness(
  events: RelayEvent[] = [],
  publish = vi.fn(async (_event: RelayEvent) => {}),
  pickerTools = tools,
  media?: (url: string, size?: "small") => string | undefined,
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(media ? { media } : {}),
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, ...events]);
  function Controls({
    disabled = false,
    onFocusedRemoval,
    audience,
  }: {
    audience?: "agents";
    disabled?: boolean;
    onFocusedRemoval?: () => void;
  }) {
    const state = useSyncExternalStore(
      (fn) => owner.session.channels.subscribeWindow("c", fn),
      () => owner.session.channels.window("c"),
    );
    const row = state.rows[0];
    return (
      row && (
        <>
          <div data-testid="reaction-controls">
            <MessageReactionControls
              row={audience ? { ...row, audience } : row}
              session={owner.session}
              scope="test"
              disabled={disabled}
              tools={pickerTools}
              inline={inline}
            />
          </div>
          <MessageReactions
            {...(onFocusedRemoval ? { onFocusedRemoval } : {})}
            row={audience ? { ...row, audience } : row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={pickerTools}
            inline={inline}
          />
        </>
      )
    );
  }
  return { ...owner, live, wire, publish, Controls };
}
it("shows one bubble per emoji, counts unique people, and removes all my duplicate events", async () => {
  const mine = react(),
    duplicate = react(viewer, 3),
    theirs = react(other);
  const h = harness([mine, duplicate, theirs]);
  render(<h.Controls />);
  expect(
    screen.queryAllByRole("button", { name: /React with|Remove/ }),
  ).toHaveLength(0);
  expect(
    screen.getByTestId("reaction-row").querySelectorAll("[data-reaction]"),
  ).toHaveLength(1);
  const own = screen.getByRole("button", {
    name: "👍: 2 people",
  });
  expect(own.getAttribute("aria-pressed")).toBe("true");
  // The pill's highlight follows whether I am among its reactors.
  expect(own.closest("[data-mine]")).not.toBeNull();
  expect(own.textContent).toBe("👍2");
  fireEvent.mouseEnter(own);
  fireEvent.mouseMove(own);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.textContent).toContain("You");
  expect(preview.textContent).toContain(other.pubkey.slice(0, 10));
  fireEvent.click(own);
  const deletions = h.session.outbox?.snapshot().map((item) => item.event);
  expect(deletions?.every((event) => event.kind === 5)).toBe(true);
  expect(
    deletions?.map((event) => event.tags.filter(([name]) => name === "e")),
  ).toEqual([[["e", mine.id]], [["e", duplicate.id]]]);
  const remaining = screen.getByRole("button", {
    name: `👍: ${other.pubkey.slice(0, 10)}`,
  });
  expect(remaining.getAttribute("aria-pressed")).toBe("false");
  expect(remaining.closest("[data-mine]")).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
});
it("keeps one bubble and focus when the count crosses the former grouping threshold", async () => {
  const others = Array.from({ length: 8 }, () => keypair());
  const h = harness(others.map((person) => react(person)));
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const pills = () =>
    screen.getByTestId("reaction-row").querySelectorAll("[data-reaction]");
  expect(pills()).toHaveLength(1);
  // A second event from one person must not increase the count.
  act(() => h.live.receive([react(others[0], 3)]));
  expect(pills()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "👍: 8 people" }).textContent).toBe(
    "👍8",
  );
  act(() => h.live.receive([react()]));
  expect(pills()).toHaveLength(1);
  const group = screen.getByRole("button", { name: "👍: 9 people" });
  expect(group.textContent).toBe("👍9");
  expect(group.getAttribute("aria-pressed")).toBe("true");
  act(() => group.focus());
  const preview = await screen.findByRole("tooltip");
  expect(preview.textContent).toContain("You");
  for (const person of others)
    expect(preview.textContent).toContain(person.pubkey.slice(0, 10));
  expect(preview.textContent).not.toContain("others");
  fireEvent.click(group);
  expect(pills()).toHaveLength(1);
  expect(document.activeElement).toBe(group);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.event.kind).toBe(5);
  await act(async () => {
    await flush();
    await flush();
  });
});

it.each([3, 4, 5])("shows all %i reactors in the preview", async (count) => {
  const people = Array.from({ length: count }, () => keypair());
  const h = harness(people.map((person) => react(person)));
  render(<h.Controls />);
  act(() =>
    screen.getByRole("button", { name: `👍: ${count} people` }).focus(),
  );
  const preview = await screen.findByRole("tooltip");
  for (const person of people)
    expect(preview.textContent).toContain(person.pubkey.slice(0, 10));
  expect(
    within(preview).getByRole("region", { name: "Everyone who reacted" })
      .tabIndex,
  ).toBe(-1);
});

it("opening a large preview preserves unrelated cached profiles", async () => {
  const h = harness([react(other)]);
  const unrelated = profile(other, { name: "Existing colleague" });
  act(() =>
    h.live.receive([
      unrelated,
      ...Array.from({ length: 63 }, (_, index) =>
        profile(keypair(), { name: `Cached colleague ${index}` }),
      ),
    ]),
  );
  const people = Array.from({ length: 1025 }, () => keypair());
  const events = new Map(
    people.map((person, index) => [
      person.pubkey,
      profile(person, { name: `Reactor ${index}` }),
    ]),
  );
  const row = h.session.channels.window("c").rows[0];
  const first = people[0],
    last = people.at(-1);
  if (!row || !first || !last) throw new Error("Missing fixture data");
  const completed = new Set();
  const settleReads = async () => {
    await flush();
    let pending = h.wire.pending.find((entry) => !completed.has(entry));
    while (pending) {
      completed.add(pending);
      pending.respond(
        pending.filters.flatMap((filter) =>
          filter.kinds?.includes(0)
            ? (filter.authors ?? []).flatMap((id) =>
                events.get(id) ? [events.get(id) as RelayEvent] : [],
              )
            : [],
        ),
      );
      await flush();
      pending = h.wire.pending.find((entry) => !completed.has(entry));
    }
  };
  await act(settleReads);
  render(
    <MessageReactions
      row={{
        ...row,
        reactions: [
          {
            content: "👍",
            events: people.map((person, index) => ({
              id: String(index),
              authorId: person.pubkey,
            })),
          },
        ],
      }}
      session={h.session}
      scope="test"
      disabled={false}
      tools={tools}
      inline={inline}
    />,
  );
  const pill = screen.getByRole("button", { name: "👍: 1025 people" });
  fireEvent.mouseEnter(pill);
  // Pointer transit must not start profile enrichment before opening.
  expect(h.session.profiles.snapshot().get(first.pubkey)).toBeUndefined();
  act(() => pill.focus());
  const preview = await screen.findByRole("tooltip");
  await act(settleReads);
  expect(preview.textContent).toContain("Reactor 0");
  expect(h.session.profiles.snapshot().get(other.pubkey)?.name).toBe(
    "Existing colleague",
  );
  // Names outside the first visible page remain readable as identity fallbacks.
  expect(preview.textContent).toContain(last.pubkey.slice(0, 10));
  expect(h.session.profiles.snapshot().has(last.pubkey)).toBe(false);
});

it("keeps custom emoji URLs separate and updates a grouped count when I join", async () => {
  const people = Array.from({ length: 9 }, () => keypair());
  const first = "https://a.test/first.gif";
  const second = "https://a.test/second.gif";
  const h = harness([
    ...people.map((person) => customReaction(person, "party", first)),
    customReaction(other, "party", second),
  ]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const group = screen.getByRole("button", { name: ":party:: 9 people" });
  expect(group.getAttribute("aria-pressed")).toBe("false");
  expect(group.querySelector("img")?.getAttribute("src")).toBe(first);
  expect(
    screen
      .getByRole("button", { name: `:party:: ${other.pubkey.slice(0, 10)}` })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe(second);
  fireEvent.click(group);
  const joined = screen.getByRole("button", { name: ":party:: 10 people" });
  expect(joined).toBe(group);
  expect(joined.textContent).toBe("10");
  expect(joined.getAttribute("aria-pressed")).toBe("true");
  expect(h.session.outbox?.snapshot()[0]?.event.tags).toContainEqual([
    "emoji",
    "party",
    first,
  ]);
  await act(async () => {
    await flush();
    await flush();
  });
  act(() => joined.focus());
  fireEvent.click(joined);
  expect(screen.getByRole("button", { name: ":party:: 9 people" })).toBe(
    joined,
  );
  expect(document.activeElement).toBe(joined);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  await act(async () => {
    await flush();
    await flush();
  });
});

it("keeps the same bubble and focus through single and multiple reactor transitions", async () => {
  const others = [other];
  const h = harness([react(other)]);
  render(
    <>
      <button type="button">Elsewhere</button>
      <h.Controls />
    </>,
  );
  const individual = screen.getByRole("button", { name: /^👍:/ });
  if (!individual) throw new Error("Expected an individual reaction");
  act(() => individual.focus());
  fireEvent.click(individual);
  const group = screen.getByRole("button", { name: "👍: 2 people" });
  expect(group).toBe(individual);
  expect(document.activeElement).toBe(group);
  await act(async () => {
    await flush();
    await flush();
  });
  // A live removal takes the count back to one without replacing the control.
  const removedPerson = others[0];
  if (!removedPerson) throw new Error("Expected another reactor");
  const removed = react(removedPerson);
  act(() =>
    h.live.receive([
      signed(removedPerson, {
        kind: 5,
        content: "",
        created_at: 3,
        tags: [["e", removed.id]],
      }),
    ]),
  );
  expect(document.activeElement).toBe(
    screen.getAllByRole("button", { name: /^👍:/ })[0],
  );
  // A live second reactor updates the same focused control.
  act(() => h.live.receive([react(keypair(), 4)]));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "👍: 2 people" }),
  );
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  act(() => h.live.receive([react(keypair(), 5)]));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Elsewhere" }),
  );
});

it("keeps failed first-reaction delivery visible and retries the same event", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([], publish);
  render(<h.Controls />);
  fireEvent.click(
    within(screen.getByTestId("reaction-controls")).getByRole("button", {
      name: "Choose reaction",
    }),
  );
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.queryByRole("button", { name: "❤️: You" })).toBeNull();
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
});
it("prevents duplicate submissions and unavailable-message actions", async () => {
  const h = harness();
  const view = render(<h.Controls disabled />);
  fireEvent.click(
    within(screen.getByTestId("reaction-controls")).getByRole("button", {
      name: "Choose reaction",
    }),
  );
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  view.rerender(<h.Controls />);
  const button = within(screen.getByTestId("reaction-controls")).getByRole(
    "button",
    { name: "Choose reaction" },
  );
  fireEvent.click(button);
  fireEvent.click(button);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    await flush();
    await flush();
  });
});

it.each(["hover", "focus"] as const)(
  "shows who reacted on %s to someone who cannot react",
  async (reveal) => {
    const h = harness([react(other)]);
    render(<h.Controls disabled />);
    const pill = screen.getByRole("button", {
      name: `👍: ${other.pubkey.slice(0, 10)}`,
    });
    // A disabled button drops hover, focus and keys, and the preview with them.
    expect(pill.hasAttribute("disabled")).toBe(false);
    expect(pill.hasAttribute("data-disabled")).toBe(false);
    expect(pill.getAttribute("aria-disabled")).toBe("true");
    if (reveal === "hover") {
      fireEvent.mouseEnter(pill);
      fireEvent.mouseMove(pill);
    } else act(() => pill.focus());
    const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
    expect(preview.textContent).toContain(other.pubkey.slice(0, 10));
  },
);

it("does not let someone who cannot react toggle, and leaves keys to ancestors", async () => {
  const h = harness([react(other)]);
  const keys: string[] = [];
  render(
    // Thread Escape, the message menu and timeline scrolling skip prevented keys.
    // biome-ignore lint/a11y/noStaticElementInteractions: Observes bubbling keys.
    <div
      onKeyDown={(event) => {
        if (!event.defaultPrevented) keys.push(event.key);
      }}
    >
      <h.Controls disabled />
    </div>,
  );
  const pill = screen.getByRole("button", {
    name: `👍: ${other.pubkey.slice(0, 10)}`,
  });
  act(() => pill.focus());
  await screen.findByRole("tooltip");
  // Enter and Space activate a native button by dispatching this click.
  fireEvent.click(pill);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  expect(pill.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
  for (const key of ["F10", "ContextMenu", "ArrowUp", "PageUp"])
    fireEvent.keyDown(pill, { key, shiftKey: key === "F10" });
  // The open preview is a nested surface: Escape dismisses only it first.
  fireEvent.keyDown(pill, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.keyDown(pill, { key: "Escape" });
  expect(keys).toEqual(["F10", "ContextMenu", "ArrowUp", "PageUp", "Escape"]);
});

it("keeps emojis visually active but rejects another click while delivery is pending or failed", async () => {
  let release!: () => void;
  const publish = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const h = harness([react(other)], publish);
  render(<h.Controls />);
  fireEvent.click(
    screen.getByRole("button", { name: `👍: ${other.pubkey.slice(0, 10)}` }),
  );
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  const pill = screen.getByRole("button", {
    name: "👍: 2 people",
  });
  expect(pill.getAttribute("aria-disabled")).toBe("true");
  expect(pill.hasAttribute("disabled")).toBe(false);
  fireEvent.click(pill);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  // Fresh hover still keeps the preview off delivery recovery controls.
  vi.useFakeTimers();
  try {
    fireEvent.mouseEnter(pill);
    fireEvent.mouseMove(pill);
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
  await act(async () => {
    release();
    await flush();
    await flush();
  });
  expect(pill.getAttribute("aria-disabled")).toBe("false");
  // Only delivery held back the preview that the hover opened.
  expect(screen.getByRole("tooltip").textContent).toContain("You");

  const failed = harness(
    [react(other)],
    vi.fn(async () => {
      throw new PublishRejected("Nope");
    }),
  );
  const failedView = render(<failed.Controls />);
  fireEvent.click(
    within(failedView.container).getByRole("button", {
      name: `👍: ${other.pubkey.slice(0, 10)}`,
    }),
  );
  await act(async () => {
    await flush();
    await flush();
  });
  const failedPill = within(failedView.container)
    .getByTestId("reaction-row")
    .querySelector("button[data-reaction]");
  if (!failedPill) throw new Error("Reaction missing");
  expect(failedPill.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(failedPill);
  expect(failed.session.outbox?.snapshot()).toHaveLength(1);
});

it("uses the picker catalog URL even when an old URL has my reaction", async () => {
  const oldUrl = "https://a.test/old.png";
  const newUrl = "https://a.test/new.png";
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select }: ReactionToolProps) => (
        <button type="button" onClick={() => select(":party:")}>
          Choose party
        </button>
      ),
    },
  ]);
  const h = harness(
    [customReaction(viewer, "party", oldUrl)],
    undefined,
    pickerTools,
  );
  h.live.receive([
    signed(other, {
      kind: 30030,
      content: "",
      created_at: 3,
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", newUrl],
      ],
    }),
  ]);
  render(<h.Controls />);
  fireEvent.click(
    within(screen.getByTestId("inline-add-reaction")).getByRole("button", {
      name: "Choose party",
    }),
  );
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event.kind).toBe(7);
  expect(operation?.event.tags).toContainEqual(["emoji", "party", newUrl]);
  const parties = screen.getAllByRole("button", {
    name: ":party:: You",
  });
  expect(parties).toHaveLength(2);
  expect(parties[0]?.querySelector("img")?.getAttribute("src")).toBe(oldUrl);
  expect(parties[1]?.querySelector("img")?.getAttribute("src")).toBe(newUrl);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("uses the original animated emoji in reaction emojis and previews", async () => {
  const url = "https://a.test/eyes-intensifies.gif";
  const media = vi.fn((source: string, size?: "small") =>
    size === "small" ? source.replace(/\.gif$/, ".thumb.jpg") : source,
  );
  const h = harness(
    [customReaction(other, "eyes-intensifies", url)],
    undefined,
    tools,
    media,
  );
  render(<h.Controls />);
  const pill = screen.getByRole("button", {
    name: `:eyes-intensifies:: ${other.pubkey.slice(0, 10)}`,
  });
  expect(pill.querySelector("img")?.getAttribute("src")).toBe(url);
  fireEvent.mouseEnter(pill);
  fireEvent.mouseMove(pill);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.querySelector("img")?.getAttribute("src")).toBe(url);
  expect(media).not.toHaveBeenCalledWith(url, "small");
});

it("loads names for people who only reacted after a preview opens", async () => {
  const people = Array.from({ length: 5 }, () => keypair());
  const h = harness(people.map((person) => react(person)));
  render(<h.Controls />);
  // Complete startup reads so the scheduler can admit background reactor names.
  await act(async () => {
    const completed = new Set();
    await flush();
    let pending = h.wire.pending.find((entry) => !completed.has(entry));
    while (pending) {
      completed.add(pending);
      pending.respond([]);
      await flush();
      pending = h.wire.pending.find((entry) => !completed.has(entry));
    }
  });
  const pill = screen.getByRole("button", {
    name: "👍: 5 people",
  });
  fireEvent.mouseEnter(pill);
  fireEvent.mouseMove(pill);
  const preview = await screen.findByRole("tooltip");
  const profileReads = () =>
    h.wire.pending.filter((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(0)),
    );
  await waitFor(() => {
    const requested = profileReads().flatMap((entry) =>
      entry.filters.flatMap((filter) => filter.authors ?? []),
    );
    for (const person of people) expect(requested).toContain(person.pubkey);
  });
  await act(async () => {
    for (const entry of profileReads()) {
      const requested = entry.filters.flatMap((filter) => filter.authors ?? []);
      entry.respond(
        people.flatMap((person, index) =>
          requested.includes(person.pubkey)
            ? [profile(person, { name: `Fresh Reactor ${index + 1}` })]
            : [],
        ),
      );
    }
    await flush();
  });
  await waitFor(() => {
    for (let index = 1; index <= people.length; index++)
      expect(preview.textContent).toContain(`Fresh Reactor ${index}`);
  });
});

it("shows custom shortcodes in emojis and previews when media is refused or fails", async () => {
  const h = harness(
    [
      customReaction(other, "denied", "https://a.test/denied.png"),
      customReaction(other, "broken", "https://a.test/broken.png"),
    ],
    undefined,
    tools,
    (url) => (url.includes("denied") ? undefined : url),
  );
  render(<h.Controls />);
  const denied = screen.getByRole("button", {
    name: `:denied:: ${other.pubkey.slice(0, 10)}`,
  });
  const broken = screen.getByRole("button", {
    name: `:broken:: ${other.pubkey.slice(0, 10)}`,
  });
  expect(denied.textContent).toContain(":denied:");
  const image = broken.querySelector("img");
  if (!image) throw new Error("Custom reaction image missing");
  fireEvent.error(image);
  expect(broken.textContent).toContain(":broken:");
  fireEvent.mouseEnter(denied);
  fireEvent.mouseMove(denied);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.textContent).toContain(":denied:");
  fireEvent.mouseLeave(denied, { relatedTarget: broken });
  fireEvent.mouseEnter(broken, { relatedTarget: denied });
  fireEvent.mouseMove(broken);
  await waitFor(
    () =>
      expect(
        screen
          .queryAllByRole("tooltip")
          .some((item) => item.textContent?.includes(":broken:")),
      ).toBe(true),
    { timeout: 2500 },
  );
});

it("forwards the contributed picker into true toggles and releases confirmed writes without an echo", async () => {
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select, disabled }: ReactionToolProps) => (
        <button type="button" disabled={disabled} onClick={() => select("👍")}>
          Choose from picker
        </button>
      ),
    },
  ]);
  const h = harness([react()], undefined, pickerTools);
  render(<h.Controls />);
  const picker = screen.getAllByRole("button", {
    name: "Choose from picker",
  })[0];
  if (!picker) throw new Error("Picker control missing");
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot()[0]?.event.kind).toBe(5);
  await act(async () => {
    await flush();
    await flush();
  });
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot().map((item) => item.event.kind)).toEqual([
    5, 7,
  ]);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("rolls back a failed last-reaction removal and retries it after remount", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([react()], publish);
  const view = render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "👍: You" }));
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.getByRole("button", { name: "👍: You" })).toBeTruthy();
  view.unmount();
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: "Retry reaction" }),
  ).toHaveLength(1);
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
});

it("retires reaction previews while retaining the reaction delivery owner", async () => {
  const h = harness([react(other)]);
  vi.useFakeTimers();
  try {
    const tree = (active: boolean) => (
      <ConversationPresentation value={active}>
        <div hidden={!active} inert={!active}>
          <h.Controls />
        </div>
      </ConversationPresentation>
    );
    const view = render(tree(true));
    const pill = screen.getByRole("button", {
      name: `👍: ${other.pubkey.slice(0, 10)}`,
    });
    fireEvent.mouseEnter(pill);
    fireEvent.mouseMove(pill);
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS - 1));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    const reactions = screen.getByTestId("reaction-row");
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(screen.getByTestId("reaction-row")).toBe(reactions);
    view.rerender(tree(true));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps focus on the bubble when my reaction is removed and another person remains", async () => {
  const h = harness([react(), react(other)]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const own = screen.getByRole("button", { name: "👍: 2 people" });
  act(() => own.focus());
  fireEvent.click(own);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(own);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  expect(
    screen.getByRole("button", { name: `👍: ${other.pubkey.slice(0, 10)}` }),
  ).toBeTruthy();
  await act(async () => {
    await flush();
    await flush();
  });
});
it("hands focus back when the last reaction is removed", async () => {
  const h = harness([react()]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const own = screen.getByRole("button", { name: "👍: You" });
  act(() => own.focus());
  fireEvent.click(own);
  expect(onFocusedRemoval).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
});
it.each([false, true])(
  "hides inline add on coordination while retaining existing reactions (%s)",
  (populated) => {
    const pickerTools = registry<ComposerTool>([
      {
        key: "picker",
        pluginId: "picker",
        revision: "one",
        id: "picker",
        title: "Picker",
        component: () => null,
        reactionComponent: ({ select }: ReactionToolProps) => (
          <button type="button" onClick={() => select("👍")}>
            Choose reaction
          </button>
        ),
      },
    ]);
    const h = harness(populated ? [react(other)] : [], undefined, pickerTools);
    const view = render(<h.Controls audience="agents" />);
    expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
    if (populated)
      expect(
        screen.getByRole("button", {
          name: `👍: ${other.pubkey.slice(0, 10)}`,
        }),
      ).toBeTruthy();
    view.rerender(<h.Controls audience="agents" disabled />);
    expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
    view.rerender(<h.Controls />);
    if (populated)
      expect(
        within(screen.getByTestId("inline-add-reaction")).getByRole("button", {
          name: "Choose reaction",
        }),
      ).toBeTruthy();
    else expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
  },
);
