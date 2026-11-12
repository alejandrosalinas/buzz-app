// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { AnnotationMenu } from "../messages/AnnotationMenu";
import { EditableInput } from "../messages/EditableInput";
import type {
  AnnotationMenuRequest,
  ComposerInputElement,
} from "../messages/composer-dom";
import type { ComposerSession } from "../messages/composer-session";
import { composerDOMFixture } from "../messages/composer-testing";
import { mentionDraft } from "../messages/mention-draft";
import { ComposerAnnotators } from "./ComposerAnnotators";
import type {
  AnnotationObservation,
  ComposerAnnotation,
  ComposerAnnotatorProps,
  ComposerReplacement,
} from "./contracts";
import { ConversationService } from "./service";

composerDOMFixture();
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** An annotator registered through the real runtime and conversation service.
 * The test publishes for the observations it saw, unless `fixture.immediate`
 * answers each observation from the annotator's own effect. */
async function annotatorPlugin() {
  const root = new Context();
  const seen: ComposerAnnotatorProps[] = [];
  const fixture: {
    crash: boolean;
    redraw(): void;
    immediate?: (
      observation: AnnotationObservation,
    ) => ComposerAnnotation[] | undefined;
  } = { crash: false, redraw: () => {} };
  function Fixture(props: ComposerAnnotatorProps) {
    const [, redraw] = useReducer((count: number) => count + 1, 0);
    fixture.redraw = redraw;
    if (fixture.crash) throw new Error("Annotator failed");
    const { observation, publish } = props;
    // biome-ignore lint/correctness/useExhaustiveDependencies: One record per observation and publisher.
    useEffect(() => {
      seen.push(props);
      const answer = fixture.immediate?.(observation);
      if (!answer) return;
      const withdraw = publish(answer);
      return withdraw || undefined;
    }, [observation, publish]);
    return null;
  }
  const runtime = new PluginRuntime(root, async () => ({
    inject: ["conversation"],
    apply(ctx) {
      ctx.conversation.registerAnnotator({
        id: "fixture",
        title: "Fixture annotator",
        component: Fixture,
      });
    },
  }));
  const service = new ConversationService(root);
  onTestFinished(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  const plugin = {
    manifest: {
      id: "example.annotator",
      name: "Annotator",
      apiVersion: 1 as const,
    },
    enabled: true,
    source: "external" as const,
    revision: "one",
    previous: null,
    reloadable: true,
    error: null,
  };
  const enable = async (enabled: boolean) => {
    await act(async () => {
      runtime.reconcile(enabled ? [plugin] : []);
      await vi.waitFor(() =>
        expect(service.annotators.snapshot()).toHaveLength(enabled ? 1 : 0),
      );
    });
  };
  await enable(true);
  const latest = () => {
    const props = seen.at(-1);
    if (!props) throw new Error("The annotator has not observed a draft");
    return props;
  };
  return { service, seen, latest, enable, fixture };
}

type Props = { enabled: boolean; epoch: string; disabled: boolean };

/** The composer's wiring: one editor, its annotators and menu. */
function mount(
  service: ConversationService,
  initial = "",
  props: Partial<Props> = {},
) {
  const input: { current: ComposerInputElement | null } = { current: null };
  function Composer({ enabled, epoch, disabled }: Props) {
    const [draft, setDraft] = useState(() => mentionDraft(initial));
    const [menu, setMenu] = useState<AnnotationMenuRequest>();
    const close = useCallback(() => setMenu(undefined), []);
    return (
      <div lang="en-GB">
        <EditableInput
          ref={input}
          draft={draft}
          value={draft.text}
          disabled={disabled}
          placeholder="Draft"
          maxLength={16000}
          decorationsFor={() => []}
          onFormatsChange={() => {}}
          onEditLink={() => {}}
          onDraftChange={setDraft}
          onAnnotationMenu={setMenu}
        />
        <ComposerAnnotators
          registry={service.annotators}
          input={input}
          enabled={enabled}
          epoch={epoch}
          session={session}
          scope="test"
          channelId="channel"
        />
        {menu && (
          <AnnotationMenu
            key={menu.revision}
            request={menu}
            input={input}
            onClose={close}
          />
        )}
      </div>
    );
  }
  let current: Props = {
    enabled: true,
    epoch: "channel",
    disabled: false,
    ...props,
  };
  const view = render(<Composer {...current} />);
  const element = input.current as ComposerInputElement | null;
  if (!element) throw new Error("Editor did not mount");
  act(() => {
    element.focus();
    element.setSelectionRange(initial.length, initial.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  return {
    input: element,
    /** Types at the caret as one editor transaction. */
    type(text: string) {
      act(() => {
        element.insertText(text);
      });
    },
    rerender(next: Partial<Props>) {
      current = { ...current, ...next };
      view.rerender(<Composer {...current} />);
    },
    unmount: view.unmount,
  };
}

const session = {} as ComposerSession;
/** Runs the publication frame. */
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
const underlined = (input: HTMLElement) =>
  [...input.querySelectorAll("[data-annotation]")].map(
    (node) => node.textContent,
  );
const choices = (...texts: string[]): ComposerReplacement[] =>
  texts.map((text) => ({ text }));
const issue = (
  observation: AnnotationObservation,
  word: string,
  replacements = choices("the"),
): ComposerAnnotation[] => {
  const start = observation.text.indexOf(word);
  return [
    {
      start,
      end: start + word.length,
      text: word,
      label: "Possible misspelling",
      kind: "spelling",
      replacements,
    },
  ];
};
/** Publishes from inside React, as an annotator's effect would. */
const publish = (
  props: ComposerAnnotatorProps,
  annotations: readonly ComposerAnnotation[],
) => {
  let result = false as ReturnType<ComposerAnnotatorProps["publish"]>;
  act(() => {
    result = props.publish(annotations);
  });
  return result;
};
/** A key on whatever has focus, as the menu receives it. */
const press = (key: string) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
/** Presses Ctrl+. (Command-. on Apple platforms); true when the editor handled it. */
const modPeriod = (input: HTMLElement) => {
  let handled = false;
  act(() => {
    handled = !fireEvent.keyDown(input, { key: ".", ctrlKey: true });
  });
  return handled;
};

it("shows a registered annotator's marks and applies a replacement in its own undo step", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "👍🏽 say");
  h.type(" teh ");
  const props = latest();
  // The editable prose, in UTF-16 offsets, with the composer's context.
  expect(props.observation).toEqual({
    revision: expect.any(Number),
    text: "👍🏽 say teh ",
    prose: [{ start: 0, end: 13 }],
  });
  expect(props).toMatchObject({ session, scope: "test", channelId: "channel" });
  expect(
    publish(props, issue(props.observation, "teh", choices("the", "ten"))),
  ).toBeTypeOf("function");
  await flush();
  expect(underlined(h.input)).toEqual(["teh"]);

  act(() => h.input.setSelectionRange(10, 10));
  expect(modPeriod(h.input)).toBe(true);
  const menu = screen.getByRole("menu", {
    name: "Possible misspelling: “teh”",
  });
  await flush();
  // Keyboard discovery: focus moves into the menu, so keys choose.
  expect(menu.contains(document.activeElement)).toBe(true);
  press("ArrowDown");
  press("Enter");
  expect(h.input.value).toBe("👍🏽 say the ");
  await flush();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(h.input).toHaveFocus();
  // The caret was inside the word: it lands after the replacement.
  expect(h.input.selectionStart).toBe(12);
  expect(underlined(h.input)).toEqual([]);
  h.type("!");
  expect(h.input.value).toBe("👍🏽 say the! ");
  act(() => h.input.undo(false));
  expect(h.input.value).toBe("👍🏽 say the ");
  act(() => h.input.undo(false));
  expect(h.input.value).toBe("👍🏽 say teh ");
  act(() => h.input.undo(true));
  act(() => h.input.undo(true));
  expect(h.input.value).toBe("👍🏽 say the! ");
});

it("names each annotation's kind for assistive technology", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh cat sat");
  const props = latest();
  const at = (word: string, kind?: "spelling" | "grammar") => {
    const start = props.observation.text.indexOf(word);
    return {
      start,
      end: start + word.length,
      text: word,
      label: "Note",
      kind,
    };
  };
  publish(props, [at("teh", "spelling"), at("cat", "grammar"), at("sat")]);
  await flush();
  // Away from the word being typed, which stays unmarked.
  act(() => h.input.setSelectionRange(0, 0));
  expect(
    [...h.input.querySelectorAll("[data-annotation]")].map((node) => [
      node.textContent,
      node.getAttribute("aria-invalid"),
    ]),
  ).toEqual([
    ["teh", "spelling"],
    ["cat", "grammar"],
    ["sat", "true"],
  ]);
});

it("opens from a right-click on the mark only, and Escape returns focus", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh cat");
  publish(latest(), issue(latest().observation, "teh"));
  await flush();
  const word = h.input.querySelector("[data-annotation]");
  if (!word) throw new Error("no mark");
  // Elsewhere the native menu stays.
  expect(fireEvent.contextMenu(h.input.querySelector("p") as Element)).toBe(
    true,
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(fireEvent.contextMenu(word)).toBe(false);
  expect(screen.getByRole("menuitem", { name: "the" })).toBeInTheDocument();
  press("Escape");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(h.input).toHaveFocus();
  expect(h.input.value).toBe("teh cat");
  // An annotation without replacements shows only its label.
  h.type("!");
  publish(latest(), issue(latest().observation, "cat", []));
  await flush();
  act(() => h.input.setSelectionRange(5, 5));
  expect(modPeriod(h.input)).toBe(true);
  expect(screen.getByText("Possible misspelling")).toBeInTheDocument();
  expect(screen.queryByRole("menuitem")).toBeNull();
});

it("refuses publications for an outdated or unacceptable draft, and the disposer withdraws only its own", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh");
  const first = latest();
  h.type(" cat");
  const second = latest();
  expect(second.observation).not.toBe(first.observation);
  // The draft moved on: a late answer for the old one is refused.
  expect(publish(first, issue(first.observation, "teh"))).toBe(false);
  expect(publish(second, { not: "a list" } as never)).toBe(false);
  await flush();
  act(() => h.input.setSelectionRange(0, 0));
  expect(underlined(h.input)).toEqual([]);

  const withdraw = publish(second, issue(second.observation, "teh"));
  if (typeof withdraw !== "function") throw new Error("publish refused");
  const replace = publish(second, issue(second.observation, "cat"));
  if (typeof replace !== "function") throw new Error("publish refused");
  await flush();
  // A later publication replaces the lane; the superseded disposer is inert.
  expect(underlined(h.input)).toEqual(["cat"]);
  act(() => withdraw());
  await flush();
  expect(underlined(h.input)).toEqual(["cat"]);
  act(() => replace());
  await flush();
  expect(underlined(h.input)).toEqual([]);
});

it("closes the menu once its annotation is withdrawn or replaced for the same draft", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh cat");
  const props = latest();
  const both = () => [
    ...issue(props.observation, "teh"),
    ...issue(props.observation, "cat", choices("car")),
  ];
  const withdraw = publish(props, both());
  if (typeof withdraw !== "function") throw new Error("publish refused");
  await flush();
  act(() => h.input.setSelectionRange(1, 1));
  expect(modPeriod(h.input)).toBe(true);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  act(() => withdraw());
  await flush();
  expect(screen.queryByRole("menu")).toBeNull();

  publish(props, both());
  await flush();
  act(() => h.input.setSelectionRange(1, 1));
  expect(modPeriod(h.input)).toBe(true);
  // A new publication without the annotation replaces the one the menu shows.
  publish(props, issue(props.observation, "cat", choices("car")));
  await flush();
  expect(screen.queryByRole("menu")).toBeNull();
  act(() => h.input.setSelectionRange(0, 0));
  expect(underlined(h.input)).toEqual(["cat"]);
});

it("keeps earlier underlines while the annotator withdraws its answer for an earlier draft", async () => {
  const { service, fixture } = await annotatorPlugin();
  let first: number | undefined;
  // Answers only the first draft, as a checker still working on the next would.
  fixture.immediate = (observation) => {
    first ??= observation.revision;
    return observation.revision === first
      ? issue(observation, "teh")
      : undefined;
  };
  const h = mount(service, "teh cat");
  await flush();
  expect(underlined(h.input)).toEqual(["teh"]);
  h.type("!");
  await flush();
  expect(underlined(h.input)).toEqual(["teh"]);
  expect(h.input.shownAnnotations).toEqual([]);
});

it("hands out a new observation after a same-text structural change", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh cat");
  const before = latest();
  publish(before, issue(before.observation, "teh"));
  await flush();
  expect(h.input.shownAnnotations.map((mark) => mark.text)).toEqual(["teh"]);
  act(() => {
    h.input.setSelectionRange(4, 7);
    h.input.toggleFormat("bold");
  });
  expect(h.input.value).toBe("teh cat");
  expect(h.input.shownAnnotations).toEqual([]);
  // The old marks are no longer actionable, and the annotator sees the change.
  act(() => h.input.setSelectionRange(1, 1));
  expect(modPeriod(h.input)).toBe(false);
  expect(latest().observation.revision).not.toBe(before.observation.revision);
  expect(latest().observation.text).toBe("teh cat");
});

it.each([
  ["turned off", { enabled: false }],
  ["moved to another destination", { epoch: "thread" }],
] as const)(
  "clears marks, closes the menu and revokes publishers once annotations are %s",
  async (_label, next) => {
    const { service, latest } = await annotatorPlugin();
    const h = mount(service, "teh cat");
    const props = latest();
    publish(props, issue(props.observation, "teh"));
    await flush();
    act(() => h.input.setSelectionRange(1, 1));
    expect(modPeriod(h.input)).toBe(true);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => h.rerender(next));
    await flush();
    expect(underlined(h.input)).toEqual([]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(publish(props, issue(props.observation, "teh"))).toBe(false);
    await flush();
    expect(underlined(h.input)).toEqual([]);
  },
);

it("lets an annotator that answers at once publish again after a destination change keeps the draft", async () => {
  const { service, fixture } = await annotatorPlugin();
  fixture.immediate = (observation) => issue(observation, "teh");
  const h = mount(service, "teh cat");
  await flush();
  act(() => h.input.setSelectionRange(0, 0));
  expect(underlined(h.input)).toEqual(["teh"]);
  act(() => h.rerender({ epoch: "thread" }));
  await flush();
  expect(underlined(h.input)).toEqual(["teh"]);
});

it("clears marks, closes the menu and revokes publishers when the plugin is removed", async () => {
  const { service, latest, enable } = await annotatorPlugin();
  const h = mount(service, "teh cat");
  const props = latest();
  publish(props, issue(props.observation, "teh"));
  await flush();
  act(() => h.input.setSelectionRange(1, 1));
  modPeriod(h.input);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  await enable(false);
  await flush();
  expect(underlined(h.input)).toEqual([]);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(publish(props, issue(props.observation, "teh"))).toBe(false);
});

it("contains an annotator that fails to render and revokes its publisher", async () => {
  const { service, fixture, latest } = await annotatorPlugin();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => quiet.mockRestore());
  const h = mount(service, "teh cat");
  const props = latest();
  publish(props, issue(props.observation, "teh"));
  await flush();
  act(() => h.input.setSelectionRange(1, 1));
  expect(modPeriod(h.input)).toBe(true);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  // The draft is unchanged, so only the failure can revoke the publisher.
  fixture.crash = true;
  act(() => fixture.redraw());
  await flush();
  expect(underlined(h.input)).toEqual([]);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(publish(props, issue(props.observation, "teh"))).toBe(false);
  act(() => h.input.setSelectionRange(7, 7));
  h.type("!");
  expect(h.input.value).toBe("teh cat!");
});

it("leaves an IME composition alone and observes once it ends", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh cat");
  const props = latest();
  publish(props, issue(props.observation, "teh"));
  await flush();
  act(() => h.input.setSelectionRange(1, 1));
  modPeriod(h.input);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  act(() => fireEvent.compositionStart(h.input));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(h.input.annotationObservation()).toBeNull();
  expect(modPeriod(h.input)).toBe(false);
  const tail = h.input.querySelector("p")?.lastChild;
  if (!(tail instanceof Text)) throw new Error("No text after the word");
  await act(async () => {
    // The IME commits its text and ends the composition in one task.
    tail.nodeValue = " cats";
    fireEvent.compositionEnd(h.input);
  });
  await flush();
  expect(latest().observation.text).toBe("teh cats");
});

it("offers no observation and refuses replacements in a disabled or read-only editor", async () => {
  const { service, seen, latest } = await annotatorPlugin();
  const disabled = mount(service, "teh", { disabled: true });
  expect(seen).toHaveLength(0);
  disabled.unmount();

  const h = mount(service, "teh cat");
  const props = latest();
  publish(props, issue(props.observation, "teh"));
  await flush();
  const { revision } = props.observation;
  act(() => {
    h.input.readOnly = true;
  });
  expect(h.input.annotationObservation()).toBeNull();
  act(() => h.input.setSelectionRange(1, 1));
  expect(modPeriod(h.input)).toBe(false);
  const [mark] = issue(props.observation, "teh");
  act(() => {
    expect(
      h.input.replaceAnnotation(revision, mark as ComposerAnnotation, "the"),
    ).toBe(false);
  });
  expect(h.input.value).toBe("teh cat");
});

it("revokes publishers when the composer goes away", async () => {
  const { service, latest } = await annotatorPlugin();
  const h = mount(service, "teh");
  const props = latest();
  h.unmount();
  expect(publish(props, issue(props.observation, "teh"))).toBe(false);
});
