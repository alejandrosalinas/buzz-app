// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StrictMode,
  createRef,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useModalBoundary } from "./useModalBoundary";
import {
  MenuRoot,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Viewer({
  close,
  restoreFocus,
  children,
}: {
  close(): void;
  restoreFocus?: RefObject<HTMLElement | null> | undefined;
  children?: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useModalBoundary(backdrop, button, close, restoreFocus);
  return createPortal(
    <div ref={backdrop}>
      <button ref={button} type="button">
        Close viewer
      </button>
      {children}
    </div>,
    document.body,
  );
}
it("leaves Escape to an open menu before focus has moved into it", async () => {
  const close = vi.fn();
  const view = render(<Viewer close={close} />);
  const button = screen.getByRole("button", { name: "Close viewer" });
  view.rerender(
    <Viewer close={close}>
      <MenuRoot defaultOpen>
        <MenuPopup>
          <MenuItem>Copy image</MenuItem>
        </MenuPopup>
      </MenuRoot>
    </Viewer>,
  );
  await screen.findByRole("menu");
  button.focus();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});
describe.each([false, true])("explicit return: %s", (explicit) => {
  describe.each(["cleanup", "queued frame"] as const)(
    "%s restoration guard",
    (phase) => {
      it.each(
        explicit
          ? (["moved"] as const)
          : (["hidden", "inert", "aria-hidden", "moved"] as const),
      )("rejects restoration after %s changes", async (change) => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal(
          "requestAnimationFrame",
          (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
          },
        );
        const close = vi.fn();
        const restoreFocus = createRef<HTMLButtonElement>();
        const tree = (open: boolean) => (
          <>
            <div data-testid="source">
              <button ref={restoreFocus} type="button">
                Open viewer
              </button>
            </div>
            <button type="button">Retry</button>
            {open && (
              <Viewer
                close={close}
                restoreFocus={explicit ? restoreFocus : undefined}
              />
            )}
          </>
        );
        const view = render(tree(false));
        const opener = screen.getByRole("button", { name: "Open viewer" });
        const retry = screen.getByRole("button", { name: "Retry" });
        opener.focus();
        view.rerender(tree(true));
        fireEvent.keyDown(document, { key: "Escape" });
        expect(close).toHaveBeenCalledOnce();
        const focus = vi.spyOn(opener, "focus");
        const changeAvailability = () => {
          if (change === "moved") retry.focus();
          else
            screen
              .getByTestId("source")
              .setAttribute(change, change === "aria-hidden" ? "true" : "");
        };
        if (phase === "cleanup") changeAvailability();
        await act(async () => {
          view.rerender(tree(false));
        });
        expect(frames).toHaveLength(phase === "cleanup" ? 0 : 1);
        if (phase === "queued frame") changeAvailability();
        act(() => {
          for (const frame of frames) frame(0);
        });
        expect(focus).not.toHaveBeenCalled();
        fireEvent.keyDown(document, { key: "Escape" });
        expect(close).toHaveBeenCalledOnce();
      });
    },
  );
});
it("retains the opener through StrictMode replay without restoring into an open modal", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const tree = (open: boolean) => (
    <StrictMode>
      <button type="button">Open viewer</button>
      {open && <Viewer close={() => {}} />}
    </StrictMode>
  );
  const view = render(tree(false));
  const opener = screen.getByRole("button", { name: "Open viewer" });
  opener.focus();
  view.rerender(tree(true));
  const modalFocus = screen.getByRole("button", { name: "Close viewer" });
  expect(document.activeElement).toBe(modalFocus);
  // Replay cleaned up once, then setup hid the opener and focused the modal again.
  expect(frames).toHaveLength(1);
  expect(opener.closest('[aria-hidden="true"]')).not.toBeNull();
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(document.activeElement).toBe(modalFocus);
  view.rerender(tree(false));
  expect(modalFocus.isConnected).toBe(false);
  expect(frames).toHaveLength(1);
  act(() => {
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(document.activeElement).toBe(opener);
});

// Same mount-time focus owner as ThreadPanel's ThreadHeader, without session UI.
function RemountedThreadHeader() {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  return (
    <button ref={closeButton} type="button">
      Close thread
    </button>
  );
}

it.each([false, true])(
  "explicit return survives thread remount autofocus; later user move: %s",
  async (moveFocus) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    function Harness() {
      const [open, setOpen] = useState(false);
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={opener} type="button" onClick={() => setOpen(true)}>
            Review image
          </button>
          <button type="button">Retry</button>
          {!open && <RemountedThreadHeader />}
          {open && (
            <Viewer close={() => setOpen(false)} restoreFocus={opener} />
          )}
        </>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Review image" });
    opener.focus();
    await act(async () => {
      fireEvent.click(opener);
    });
    const modalFocus = screen.getByRole("button", { name: "Close viewer" });
    // StrictMode's cleanup frame must not restore while the modal is open.
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(document.activeElement).toBe(modalFocus);
    await act(async () => {
      fireEvent.keyDown(modalFocus, { key: "Escape" });
    });
    expect(modalFocus.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close thread" }),
    );
    expect(frames).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "Retry" });
    if (moveFocus) retry.focus();
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(document.activeElement).toBe(moveFocus ? retry : opener);
  },
);
