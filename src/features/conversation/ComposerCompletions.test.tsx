// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCompletions } from "./ComposerCompletions";
import type { CompletionEditor } from "./useCompletionEditor";
import type {
  CompletionResult,
  ComposerCompletion,
  ComposerCompletionProps,
  IdentityMark,
} from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import type { RelaySession } from "../relay/session";
import type { ComposerInputElement } from "../messages/composer-dom";
import type { ComposerSnapshot } from "../messages/mention-draft";
import { channelQuery } from "../../bundled/channels/channel-query";
import { bundledContribution } from "../../plugins/provenance";
import * as markdown from "../relay/message-content";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
const providers: Contribution<ComposerCompletion>[] = [
  {
    id: "channel-typeahead",
    key: "buzz.channels/channel-typeahead",
    pluginId: "buzz.channels",
    revision: "1",
    title: "Channel",
    match: ({ text, start }) => channelQuery(text, start),
    component: () => <span>Channel provider mounted</span>,
  },
];
function mount(text: string, caret = text.length, document?: ComposerSnapshot) {
  const editor = {
    observation: { revision: 1, text, start: caret, end: caret },
    valid: () => true,
    observe: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
  } as CompletionEditor;
  return render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: null as ComposerInputElement | null }}
      replace={() => true}
      resolved={{ text, recipients: [], ...(document ? { document } : {}) }}
      session={{} as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
}
it.each(["#", "prose #we", "## Heading #we", "> #we", "- #we"])(
  "allows prose: %s",
  (text) => {
    mount(text);
    expect(screen.queryByText("Channel provider mounted")).not.toBeNull();
  },
);
it.each([
  ["`code #we`", 9],
  ["```\n#we\n```", 7],
  ["    #we", 7],
  ["[label #we](https://example.test)", 10],
  ["![alt #we](https://example.test)", 9],
  ["[label #we][ref]\n\n[ref]: https://example.test", 10],
  ["<span>\n#we\n</span>", 10],
  ["[ref]: https://example.test (#we)", 30],
] as const)("does not mount inside raw code/links/HTML: %s", (text, caret) => {
  mount(text, caret);
  expect(screen.queryByText("Channel provider mounted")).toBeNull();
});
it.each(["code", "link", "literal"])(
  "does not mount in rich %s marks",
  (mark) => {
    mount("#we", 3, {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "#we",
                marks: [
                  {
                    type: mark,
                    ...(mark === "link"
                      ? { attrs: { href: "https://example.test" } }
                      : {}),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(screen.queryByText("Channel provider mounted")).toBeNull();
  },
);
it("does no additional Markdown parsing on ordinary typing", () => {
  const scan = vi.spyOn(markdown, "scanMarkdown");
  mount("An ordinary message without a channel trigger");
  expect(scan).not.toHaveBeenCalled();
});

function mountPeople(
  pluginId: string,
  {
    items = peopleItems,
    bundled = false,
    replace = () => true,
    tokens,
    identityMarks = [],
  }: {
    items?: readonly object[];
    bundled?: boolean;
    replace?: () => boolean;
    tokens?: readonly { start: number; end: number }[];
    identityMarks?: Contribution<IdentityMark>[];
  } = {},
) {
  // The open popup measures itself and keeps its selection in view.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const people = {
    id: "people",
    key: `${pluginId}/people`,
    pluginId,
    revision: "1",
    title: "People",
    match: ({ text, start }) =>
      text.startsWith("@") ? { start: 0, end: start, query: "h" } : null,
    component: function People({ publish }) {
      // One publication for this query lifetime, as providers do.
      const published = useRef(publish);
      useEffect(() => {
        const withdraw = published.current({ items } as CompletionResult);
        return withdraw || undefined;
      }, []);
      return null;
    },
  } satisfies Contribution<ComposerCompletion>;
  if (bundled) bundledContribution(people);
  const registered = [people];
  // The host reads only the input's attributes and position.
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = {
    observation: { revision: 1, text: "@h", start: 2, end: 2 },
    valid: () => true,
    observe: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
  } as CompletionEditor;
  return render(
    <ComposerCompletions
      registry={{ snapshot: () => registered, subscribe: () => () => {} }}
      identityMarks={{
        snapshot: () => identityMarks,
        subscribe: () => () => {},
      }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "@h", recipients: [], ...(tokens ? { tokens } : {}) }}
      session={{ profiles: { tag: "profiles" } } as unknown as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
}
const peopleItems = [
  {
    id: "a".repeat(64),
    label: "Honey",
    detail: "Managed by Wes",
    agent: true,
    edit: { mention: { pubkey: "a".repeat(64), name: "Honey" } },
  },
  {
    id: "b".repeat(64),
    label: "Hannah",
    edit: { mention: { pubkey: "b".repeat(64), name: "Hannah" } },
  },
];
it("marks and announces agents and shows their manager in mention completion", async () => {
  mountPeople("buzz.mentions");
  expect(
    await screen.findByRole("option", {
      name: /^Honey\s*Agent\s*Managed by Wes$/,
    }),
  ).not.toBeNull();
  expect(screen.getByRole("option", { name: /^Hannah$/ })).not.toBeNull();
});
it("draws identity marks after a mentioned person's name, containing a broken one", async () => {
  const mark = (id: string, component: IdentityMark["component"]) => ({
    id,
    key: `test.plugin/${id}`,
    pluginId: "test.plugin",
    revision: "1",
    title: id,
    component,
  });
  const seen: unknown[] = [];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mountPeople("buzz.mentions", {
    items: [
      ...peopleItems,
      {
        id: "team:helpers",
        label: "helpers",
        edit: { mentions: [{ pubkey: "b".repeat(64), name: "Hannah" }] },
      },
    ],
    identityMarks: [
      mark("broken", () => {
        throw new Error("broken mark");
      }),
      mark("check", ({ pubkey, profiles }) => {
        seen.push(profiles);
        return pubkey === "b".repeat(64) ? <span>verified</span> : null;
      }),
    ],
  });
  const hannah = await screen.findByRole("option", {
    name: /^Hannah\s*verified$/,
  });
  const name = hannah.querySelector("[data-completion-label] span span");
  expect(name?.textContent).toBe("Hannah");
  expect(
    screen.getByRole("option", { name: /^Honey\s*Agent\s*Managed by Wes$/ }),
  ).not.toBeNull();
  expect(seen).toContainEqual({ tag: "profiles" });
  expect(screen.getByRole("option", { name: /^helpers$/ })).not.toBeNull();
  error.mockRestore();
});
it("draws no identity marks for providers outside the bundled mentions", async () => {
  mountPeople("acme.people", {
    identityMarks: [
      {
        id: "check",
        key: "test.plugin/check",
        pluginId: "test.plugin",
        revision: "1",
        title: "check",
        component: () => <span>verified</span>,
      },
    ],
  });
  expect(
    await screen.findByRole("option", { name: /^Hannah$/ }),
  ).not.toBeNull();
});
it("ignores the agent flag from providers outside the bundled people providers", async () => {
  mountPeople("acme.people");
  expect(
    await screen.findByRole("option", { name: /^Honey\s*Managed by Wes$/ }),
  ).not.toBeNull();
});

const folder = { kind: "folder", id: "/notes", label: "@notes" };
it.each([true, false])(
  "hands a chip edit to the composer only from a bundled provider (bundled: %s)",
  async (bundled) => {
    const replace = vi.fn(() => true);
    mountPeople("buzz.mentions", {
      bundled,
      replace,
      items: [
        { id: "notes", label: "notes", edit: { token: folder } },
        { id: "text", label: "Text", edit: { text: "text" } },
      ],
    });
    await screen.findByRole("option", { name: "Text" });
    const option = screen.queryByRole("option", { name: "notes" });
    if (!bundled) {
      expect(option).toBeNull();
      return;
    }
    if (!option) throw new Error("Missing chip option");
    fireEvent.click(option);
    expect(replace).toHaveBeenCalledWith(
      { token: folder },
      { start: 0, end: 2, query: "h" },
      expect.anything(),
      "click",
    );
  },
);
it("opens no query at a trigger inside a resolved chip", () => {
  mountPeople("buzz.mentions", { tokens: [{ start: 0, end: 2 }] });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.queryByRole("option")).toBeNull();
});

const ENG_BOT = { pubkey: "e".repeat(64), name: "Eng Bot" };
const BOB = { pubkey: "b".repeat(64), name: "Bob" };
const ENG_LEAD = { pubkey: "f".repeat(64), name: "Eng Lead" };
type Source = Readonly<{
  id: string;
  order?: number;
  supplement?: true;
  title?: string;
  result?: CompletionResult | (() => never) | undefined;
  crashAfterPublish?: true;
}>;
function mountSources(
  sources: readonly Source[],
  replace = vi.fn((..._: unknown[]) => true),
) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const publishes = new Map<string, ComposerCompletionProps["publish"]>();
  let registered = sources.map((source) => {
    const contribution = {
      id: source.id,
      key: `test.${source.id}/${source.id}`,
      pluginId: source.id === "people" ? "buzz.mentions" : `test.${source.id}`,
      revision: "1",
      title: source.title ?? source.id,
      ...(source.order !== undefined ? { order: source.order } : {}),
      ...(source.supplement ? { supplement: true as const } : {}),
      match: ({ text, start }) =>
        text.startsWith("@") ? { start: 0, end: start, query: "eng" } : null,
      component: function Source({ publish }) {
        const result = source.result;
        if (typeof result === "function") result();
        publishes.set(source.id, publish);
        const [crashed, setCrashed] = useState(false);
        if (crashed) throw new Error("broken supplement");
        const published = useRef(publish);
        useEffect(() => {
          if (!result || typeof result === "function") return;
          const withdraw = published.current(result);
          if (!source.crashAfterPublish) return withdraw || undefined;
          setCrashed(true);
        }, []);
        return null;
      },
    } satisfies Contribution<ComposerCompletion>;
    if (source.id === "people") bundledContribution(contribution);
    return contribution;
  });
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = {
    observation: { revision: 1, text: "@eng", start: 4, end: 4 },
    valid: () => true,
    observe: () => {},
    invalidate: () => {},
    keys: { current: undefined },
    composing: { current: false },
  } as CompletionEditor;
  const listeners = new Set<() => void>();
  render(
    <ComposerCompletions
      registry={{
        snapshot: () => registered,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "@eng", recipients: [] }}
      session={{ profiles: {} } as unknown as RelaySession}
      scope="test"
      channelId="c"
    />,
  );
  const press = (key: string) =>
    editor.keys.current?.({
      key,
      nativeEvent: { isComposing: false, keyCode: 0 },
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as Parameters<
      NonNullable<CompletionEditor["keys"]["current"]>
    >[0]) ?? false;
  const unregister = (id: string) =>
    act(() => {
      registered = registered.filter((contribution) => contribution.id !== id);
      for (const listener of listeners) listener();
    });
  return { replace, press, publishes, unregister };
}
const people = (result: Partial<CompletionResult> = {}) =>
  ({
    id: "people",
    title: "Mention",
    order: -10,
    result: {
      items: [
        {
          id: "x",
          label: "Eng Bot",
          edit: { mention: ENG_BOT },
        },
      ],
      spaceId: "x",
      ...result,
    },
  }) satisfies Source;
const groups = (
  result: CompletionResult | (() => never) | undefined,
  order = -20,
) =>
  ({
    id: "groups",
    title: "Groups",
    order,
    supplement: true,
    result,
  }) satisfies Source;
const groupRow = {
  id: "x",
  label: "eng",
  edit: { mentions: [BOB] },
} as const;

const listed = () =>
  [...screen.getByRole("listbox").children].map((node) => node.textContent);
it("shows a supplement's rows under its title beside the winner, in provider order", async () => {
  mountSources([people(), groups({ items: [groupRow] })]);
  await screen.findByRole("option", { name: /^eng$/ });
  expect(listed()).toEqual(["Groups", "eng", "Mention", "Eng Bot"]);
  cleanup();
  mountSources([people(), groups({ items: [groupRow] }, 10)]);
  await screen.findByRole("option", { name: /^eng$/ });
  expect(listed()).toEqual(["Eng Bot", "Groups", "eng"]);
});
it("opens with a supplement's rows when the winner has none", async () => {
  const { replace, press } = mountSources([
    people({ items: [], spaceId: undefined }),
    groups({ items: [groupRow] }),
  ]);
  await screen.findByRole("option", { name: /^eng$/ });
  expect(listed()).toEqual(["Groups", "eng"]);
  press("Enter");
  expect(replace).toHaveBeenCalledWith(
    { mentions: [BOB] },
    expect.anything(),
    expect.anything(),
    "Enter",
  );
});
it("accepts each row through its own provider when their ids collide", async () => {
  const { replace, press } = mountSources([
    people(),
    groups({ items: [groupRow] }, 10),
  ]);
  fireEvent.click(await screen.findByRole("option", { name: /^eng$/ }));
  expect(replace).toHaveBeenLastCalledWith(
    { mentions: [BOB] },
    { start: 0, end: 4, query: "eng" },
    expect.anything(),
    "click",
  );
  expect(
    screen
      .getAllByRole("option")
      .map((row) => row.getAttribute("aria-selected")),
  ).toEqual(["true", "false"]);
  press("ArrowDown");
  await screen.findByRole("option", { name: /^eng$/, selected: true });
  press("Enter");
  expect(replace).toHaveBeenLastCalledWith(
    { mentions: [BOB] },
    expect.anything(),
    expect.anything(),
    "Enter",
  );
  cleanup();
  const fresh = mountSources([people(), groups({ items: [groupRow] }, 10)]);
  await screen.findByRole("option", { name: /^eng$/ });
  fresh.press("Enter");
  expect(fresh.replace).toHaveBeenLastCalledWith(
    { mention: ENG_BOT },
    expect.anything(),
    expect.anything(),
    "Enter",
  );
});
it("keeps Space from picking the winner's exact match while a supplement holds it", async () => {
  const { replace, press } = mountSources([
    people(),
    groups({ items: [groupRow], holdAutoSelect: true }),
  ]);
  await screen.findByRole("option", { name: /^Eng Bot$/ });
  expect(press(" ")).toBe(false);
  expect(replace).not.toHaveBeenCalled();
});
it.each([
  ["has not answered", undefined],
  ["publishes no rows", { items: [] }],
  [
    "fails",
    () => {
      throw new Error("broken supplement");
    },
  ],
] as const)(
  "leaves Space to the winner when a supplement %s",
  async (_, result) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { replace, press } = mountSources([people(), groups(result)]);
    await screen.findByRole("option", { name: /^Eng Bot$/ });
    expect(press(" ")).toBe(true);
    expect(replace).toHaveBeenCalledWith(
      { mention: ENG_BOT },
      expect.anything(),
      expect.anything(),
      " ",
    );
    error.mockRestore();
  },
);
it("drops a failed supplement's rows and refuses its later publications", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { replace, press, publishes } = mountSources([
    people(),
    {
      ...groups({ items: [groupRow], holdAutoSelect: true }),
      crashAfterPublish: true,
    },
  ]);
  await screen.findByRole("option", { name: /^Eng Bot$/ });
  expect(listed()).toEqual(["Eng Bot"]);
  let late: ReturnType<ComposerCompletionProps["publish"]> | undefined;
  act(() => {
    late = publishes.get("groups")?.({ items: [groupRow] });
  });
  expect(late).toBe(false);
  expect(listed()).toEqual(["Eng Bot"]);
  expect(press(" ")).toBe(true);
  expect(replace).toHaveBeenCalledWith(
    { mention: ENG_BOT },
    expect.anything(),
    expect.anything(),
    " ",
  );
  error.mockRestore();
});
it("drops a supplement removed while the menu is open, with its hold", async () => {
  const { replace, press, publishes, unregister } = mountSources([
    people({
      items: [
        { id: "x", label: "Eng Bot", edit: { mention: ENG_BOT } },
        { id: "y", label: "Eng Lead", edit: { mention: ENG_LEAD } },
      ],
    }),
    groups({ items: [groupRow], holdAutoSelect: true }, 10),
  ]);
  await screen.findByRole("option", { name: /^eng$/ });
  press("ArrowDown");
  await screen.findByRole("option", { name: /^Eng Lead$/, selected: true });
  const stale = publishes.get("groups");
  unregister("groups");
  expect(listed()).toEqual(["Eng Bot", "Eng Lead"]);
  press("Enter");
  expect(replace).toHaveBeenLastCalledWith(
    { mention: ENG_LEAD },
    expect.anything(),
    expect.anything(),
    "Enter",
  );
  let late: ReturnType<ComposerCompletionProps["publish"]> | undefined;
  act(() => {
    late = stale?.({ items: [groupRow] });
  });
  expect(late).toBe(false);
  expect(listed()).toEqual(["Eng Bot", "Eng Lead"]);
  expect(press(" ")).toBe(true);
  expect(replace).toHaveBeenCalledWith(
    { mention: ENG_BOT },
    expect.anything(),
    expect.anything(),
    " ",
  );
});
it.each([
  ["moves an untouched default to it", [], { mentions: [BOB] }],
  ["keeps a row the user moved to", ["ArrowDown"], { mention: ENG_BOT }],
])(
  "for a late supplement with a lower order, %s",
  async (_, keys, accepted) => {
    const { replace, press, publishes } = mountSources([
      people(),
      groups(undefined),
    ]);
    await screen.findByRole("option", { name: /^Eng Bot$/ });
    for (const key of keys) press(key);
    act(() => {
      publishes.get("groups")?.({ items: [groupRow] });
    });
    expect(listed()).toEqual(["Groups", "eng", "Mention", "Eng Bot"]);
    press("Enter");
    expect(replace).toHaveBeenCalledWith(
      accepted,
      expect.anything(),
      expect.anything(),
      "Enter",
    );
  },
);
it("keeps the winner's rows when a supplement's preview throws", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("broken preview");
  }
  mountSources([
    people(),
    groups({ items: [{ ...groupRow, preview: <Broken /> }] }),
  ]);
  await screen.findByRole("option", { name: /^Eng Bot$/ });
  expect(listed()).toEqual(["Eng Bot"]);
  error.mockRestore();
});
it("keeps Escape for a supplement that publishes a hold beside an empty winner, and not for a silent one", () => {
  const empty = people({ items: [], spaceId: undefined });
  expect(
    mountSources([empty, groups({ items: [], holdAutoSelect: true })]).press(
      "Escape",
    ),
  ).toBe(true);
  cleanup();
  expect(mountSources([empty, groups(undefined)]).press("Escape")).toBe(false);
});
it("holds a pending exact match too while a supplement holds it", async () => {
  const resolve = vi.fn();
  const pending = {
    items: [],
    spaceId: undefined,
    spacePending: { name: "eng", resolve },
  };
  const held = mountSources([
    people(pending),
    groups({ items: [groupRow], holdAutoSelect: true }),
  ]);
  await screen.findByRole("option", { name: /^eng$/ });
  expect(held.press(" ")).toBe(false);
  expect(held.replace).not.toHaveBeenCalled();
  cleanup();
  const free = mountSources([people(pending), groups({ items: [groupRow] })]);
  await screen.findByRole("option", { name: /^eng$/ });
  expect(free.press(" ")).toBe(true);
  expect(free.replace).toHaveBeenCalledWith(
    { pending: { name: "eng", resolve } },
    expect.anything(),
    expect.anything(),
    " ",
  );
});
it("ignores a supplement's own exact match and agent mark, and retries it alone", async () => {
  const retry = vi.fn();
  const peopleRetry = vi.fn();
  const { replace, press } = mountSources([
    people({ spaceId: undefined, retry: peopleRetry }),
    groups({
      items: [{ ...groupRow, agent: true }],
      spaceId: "x",
      retry,
    }),
  ]);
  expect(await screen.findByRole("option", { name: /^eng$/ })).not.toBeNull();
  expect(press(" ")).toBe(false);
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("option", { name: "Retry Groups suggestions" }),
  );
  expect(retry).toHaveBeenCalledOnce();
  expect(peopleRetry).not.toHaveBeenCalled();
});
