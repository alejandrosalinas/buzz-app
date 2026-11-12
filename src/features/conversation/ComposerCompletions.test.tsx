// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCompletions } from "./ComposerCompletions";
import type { CompletionEditor } from "./useCompletionEditor";
import type {
  CompletionResult,
  ComposerCompletion,
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
