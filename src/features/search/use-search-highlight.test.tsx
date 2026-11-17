// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSearchHighlight } from "./use-search-highlight";

// jsdom lacks scrollIntoView; typed text reveals its highlighted row.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function Picker(props: {
  query: string;
  keys: readonly string[];
  pending: boolean;
  open?: boolean;
  onChoose: (key: string) => void;
  followFirst?: boolean;
}) {
  const highlight = useSearchHighlight(props);
  return (
    <>
      <input aria-label="Search" onKeyDown={highlight.keyDown} />
      <div data-testid="rows" {...highlight.listProps}>
        {props.keys.map((key) => (
          <button type="button" key={key} {...highlight.rowProps(key)}>
            {key}
          </button>
        ))}
      </div>
    </>
  );
}

it("chooses the first row once results stop pending after Enter", () => {
  const onChoose = vi.fn();
  const props = { query: "de", pending: true, onChoose };
  const { rerender } = render(<Picker {...props} keys={[]} />);
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })).toBe(
    false,
  );
  // A row that lands while a better one may still arrive is not chosen.
  rerender(<Picker {...props} keys={["message"]} />);
  expect(onChoose).not.toHaveBeenCalled();
  rerender(<Picker {...props} keys={["design", "message"]} pending={false} />);
  expect(onChoose).toHaveBeenCalledExactlyOnceWith("design");
  rerender(<Picker {...props} keys={["message"]} pending={false} />);
  expect(onChoose).toHaveBeenCalledOnce();
});

it("drops a waiting Enter once Enter chooses a row", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending keys={["more"]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onChoose).toHaveBeenCalledExactlyOnceWith("more");
  rerender(<Picker {...props} pending={false} keys={["design", "more"]} />);
  expect(onChoose).toHaveBeenCalledOnce();
});

it("drops a waiting Enter when the picker closes", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending open={false} keys={[]} />);
  rerender(
    <Picker {...props} pending={false} open={false} keys={["design"]} />,
  );
  expect(onChoose).not.toHaveBeenCalled();
});

it.each([
  ["an edit", () => {}, "des"],
  [
    "an arrow key",
    () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" }),
    "de",
  ],
  [
    "Escape",
    () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" }),
    "de",
  ],
  [
    "a row hover",
    () => {
      // The list sees the same move after the row does.
      const row = screen.getByText("more");
      fireEvent.pointerMove(row, { clientX: 1, clientY: 1 });
      fireEvent.pointerMove(row, { clientX: 2, clientY: 1 });
    },
    "de",
  ],
  [
    "Tab focusing a row",
    () => act(() => screen.getByText("message").focus()),
    "de",
  ],
] as const)("lets %s cancel a waiting Enter", (_, cancel, query) => {
  const onChoose = vi.fn();
  const props = { onChoose, keys: ["design", "message", "more"] };
  const { rerender } = render(
    <Picker {...props} query="de" pending keys={[]} />,
  );
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  // Rows that land while a better one may still arrive keep it waiting.
  rerender(<Picker {...props} query="de" pending keys={["message", "more"]} />);
  cancel();
  rerender(<Picker {...props} query={query} pending={false} />);
  // Returning to the text does not revive it either.
  rerender(<Picker {...props} query="de" pending={false} />);
  expect(onChoose).not.toHaveBeenCalled();
});

it("drops a waiting Enter when the results settle empty, and ignores Enter with nothing pending", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending={false} keys={[]} />);
  rerender(<Picker {...props} pending={false} keys={["design"]} />);
  expect(onChoose).not.toHaveBeenCalled();
  rerender(<Picker {...props} pending={false} keys={[]} />);
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })).toBe(
    true,
  );
});

it("keeps the highlight on the first row as results land, until it is moved", () => {
  const onChoose = vi.fn();
  const props = { query: "lau", pending: false, onChoose, followFirst: true };
  const { rerender } = render(<Picker {...props} keys={["chat"]} />);
  const field = screen.getByRole("textbox");
  // Messages land above the chat: untouched, Enter opens what now leads.
  rerender(<Picker {...props} keys={["message", "chat"]} />);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onChoose).toHaveBeenLastCalledWith("message");
  // Once moved, the highlight keeps its row wherever that row goes.
  fireEvent.keyDown(field, { key: "ArrowDown" });
  rerender(<Picker {...props} keys={["channel", "message", "chat"]} />);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onChoose).toHaveBeenLastCalledWith("chat");
});

it("counts a real pointer move on the first row as moving it", () => {
  const onChoose = vi.fn();
  const props = { query: "lau", pending: false, onChoose, followFirst: true };
  const { rerender } = render(<Picker {...props} keys={["chat", "dm"]} />);
  const chat = screen.getByRole("button", { name: "chat" });
  // The first event only records where the pointer rests.
  fireEvent.pointerMove(chat, { clientX: 5, clientY: 5 });
  fireEvent.pointerMove(chat, { clientX: 6, clientY: 5 });
  rerender(<Picker {...props} keys={["message", "chat", "dm"]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onChoose).toHaveBeenLastCalledWith("chat");
});

it("does not count rows moving under a resting pointer", () => {
  const onChoose = vi.fn();
  const props = { query: "lau", pending: false, onChoose, followFirst: true };
  const { rerender } = render(<Picker {...props} keys={["chat", "dm"]} />);
  const chat = screen.getByRole("button", { name: "chat" });
  fireEvent.pointerMove(chat, { clientX: 5, clientY: 5 });
  // WebKit replays the event at the same place when rows move.
  rerender(<Picker {...props} keys={["message", "chat", "dm"]} />);
  fireEvent.pointerMove(screen.getByRole("button", { name: "message" }), {
    clientX: 5,
    clientY: 5,
  });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onChoose).toHaveBeenLastCalledWith("message");
});
