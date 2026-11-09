// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  ToastNotice,
  ToastProvider,
  useToastNotification,
  useToastDismiss,
} from "./Toast";
import { Button } from "./Button";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["expiry", "Escape", "repeated Escape"])(
  "cancels pending toast removal on host unmount after %s",
  async (trigger) => {
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const view = render(
      <ToastProvider>
        <ToastNotice title="Saved" timeout={1000} />
      </ToastProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const card = screen.getByRole("dialog", { name: "Saved" });
    const item = card.closest("[data-sonner-toast]");
    if (!item) throw new Error("Toast item missing");
    if (trigger === "expiry") {
      await act(() => vi.advanceTimersByTimeAsync(1000));
    } else {
      fireEvent.keyDown(card, { key: "Escape" });
      if (trigger === "repeated Escape")
        fireEvent.keyDown(item, { key: "Escape" });
    }
    expect(item).toHaveAttribute("data-removed", "true");
    view.unmount();
    // Flush queued dismissal notifications before emulating jsdom teardown,
    // but leave the 200ms exit-removal timer pending.
    await act(() => vi.advanceTimersByTimeAsync(20));
    vi.stubGlobal("window", undefined);
    try {
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("finishes toast removal after the exit animation while the host stays mounted", async () => {
  vi.useFakeTimers();
  const view = render(
    <StrictMode>
      <ToastProvider>
        <ToastNotice title="Saved" onDismiss={() => {}} />
      </ToastProvider>
    </StrictMode>,
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  const card = screen.getByRole("dialog", { name: "Saved" });
  const item = card.closest("[data-sonner-toast]");
  fireEvent.keyDown(card, { key: "Escape" });
  expect(item).toHaveAttribute("data-removed", "true");
  await act(() => vi.advanceTimersByTimeAsync(199));
  expect(item).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(item).not.toBeInTheDocument();
  view.unmount();
});

it("keeps notice navigation separate from its explicit actions", async () => {
  const open = vi.fn();
  const update = vi.fn();
  const dismiss = vi.fn();
  render(
    <ToastProvider>
      <ToastNotice
        title="Update Notes"
        navigation={{ label: "Manage update checks", open }}
        onDismiss={dismiss}
      >
        <Button onClick={update}>Update</Button>
      </ToastNotice>
    </ToastProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage update checks" }),
  );
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
  expect(open).toHaveBeenCalledTimes(1);
});

it("puts notice navigation first in the toast's Tab order and opens it with Enter or Space", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <ToastProvider>
      <ToastNotice
        title="Update Notes"
        navigation={{ label: "Manage update checks", open }}
        onDismiss={() => {}}
      >
        <Button>Update</Button>
      </ToastNotice>
    </ToastProvider>,
  );
  const body = await screen.findByRole("button", {
    name: "Manage update checks",
  });
  // WebKit Tabs past a button without an explicit tabindex unless the OS
  // enables full keyboard access.
  expect(body).toHaveAttribute("tabindex", "0");
  // user-event has no F6 in its key map; Sonner matches the hotkey by code.
  fireEvent.keyDown(document.body, { key: "F6", code: "F6" });
  expect(body.closest("[data-sonner-toaster]")).toHaveFocus();
  await user.tab();
  expect(body.closest("[data-sonner-toast]")).toHaveFocus();
  await user.tab();
  expect(body).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledTimes(1);
  await user.keyboard(" ");
  expect(open).toHaveBeenCalledTimes(2);
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Dismiss notification" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Update" })).toHaveFocus();
});

it("keeps startup notices inside the inert toast host", async () => {
  const host = document.createElement("div");
  host.id = "buzz-toast-root";
  host.setAttribute("inert", "");
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  try {
    render(
      <ToastProvider portalContainer={host}>
        <ToastNotice title="Ready to update" onDismiss={() => {}}>
          <Button>Update now</Button>
        </ToastNotice>
      </ToastProvider>,
    );
    expect(host).toContainElement(
      await screen.findByRole("button", { name: "Update now", hidden: true }),
    );
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
  } finally {
    cleanup();
    host.remove();
  }
});

it("StrictMode and rerenders keep one notice and the latest action; cleanup is not dismissal", async () => {
  const oldRetry = vi.fn();
  const retry = vi.fn();
  const dismiss = vi.fn();
  const content = (visible: boolean, action = oldRetry) => (
    <StrictMode>
      <ToastProvider>
        {visible && (
          <ToastNotice title="Save failed" onDismiss={dismiss}>
            <Button onClick={action}>Retry</Button>
          </ToastNotice>
        )}
      </ToastProvider>
    </StrictMode>
  );
  const view = render(content(true));
  expect(
    await screen.findAllByRole("dialog", { name: "Save failed" }),
  ).toHaveLength(1);
  view.rerender(content(true, retry));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(oldRetry).not.toHaveBeenCalled();
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(dismiss).not.toHaveBeenCalled();
});

it("keeps all unresolved recovery controls accessible, including after Escape and pointer swipes", async () => {
  render(
    <ToastProvider>
      {[0, 1, 2, 3, 4].map((i) => (
        <ToastNotice key={i} title={`Failure ${i}`}>
          <Button>Retry {i}</Button>
        </ToastNotice>
      ))}
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(5));
  expect(
    screen.queryByRole("button", { name: "Dismiss notification" }),
  ).not.toBeInTheDocument();
  const oldest = screen
    .getByRole("dialog", { name: "Failure 0" })
    .closest("[data-sonner-toast]") as HTMLElement;
  act(() => oldest.focus());
  fireEvent.keyDown(oldest, { key: "Escape" });
  fireEvent.pointerDown(oldest, { pointerId: 1, clientX: 1, clientY: 10 });
  fireEvent.pointerMove(oldest, { pointerId: 1, clientX: 400, clientY: 10 });
  fireEvent.pointerUp(oldest, { pointerId: 1, clientX: 400, clientY: 10 });
  expect(oldest).toHaveAttribute("data-dismissible", "false");
  expect(oldest).toHaveAttribute("data-removed", "false");
  expect(screen.getAllByRole("button", { name: /Retry/ })).toHaveLength(5);
});

it("explicit dismissal calls the source once", async () => {
  const dismiss = vi.fn();
  render(
    <ToastProvider>
      <ToastNotice title="Agent stopped" onDismiss={dismiss} />
    </ToastProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Dismiss notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(dismiss).toHaveBeenCalledOnce();
});

it("rerendering actions does not restart expiry", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const dismiss = vi.fn();
  const content = (description: string) => (
    <ToastProvider>
      <ToastNotice
        title="Saved"
        description={description}
        timeout={5000}
        onDismiss={dismiss}
      >
        <Button>Details</Button>
      </ToastNotice>
    </ToastProvider>
  );
  const view = render(content("First"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(4000));
  view.rerender(content("Updated"));
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(dismiss).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(dismiss).toHaveBeenCalledOnce();
});

it("changing timeout can make an existing notice persistent", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const content = (timeout: number) => (
    <ToastProvider>
      <ToastNotice title="Pending" timeout={timeout} />
    </ToastProvider>
  );
  const view = render(content(5000));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(4000));
  view.rerender(content(0));
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole("dialog", { name: "Pending" })).not.toHaveAttribute(
    "data-ending-style",
  );
  view.rerender(content(5000));
  await act(() => vi.advanceTimersByTimeAsync(1));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(
    screen.queryByRole("dialog", { name: "Pending" }),
  ).not.toBeInTheDocument();
});

it("keeps toast actions outside their source form's event tree", async () => {
  const sourceKey = vi.fn();
  const retry = vi.fn();
  render(
    <ToastProvider>
      <form onKeyDown={sourceKey}>
        <ToastNotice title="Upload failed">
          <Button onClick={retry}>Recover upload</Button>
        </ToastNotice>
      </form>
    </ToastProvider>,
  );
  const action = await screen.findByRole("button", { name: "Recover upload" });
  fireEvent.keyDown(action, { key: "Escape", code: "Escape" });
  expect(sourceKey).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(retry).toHaveBeenCalledOnce();
});

it("keeps completed feedback after its source leaves and dismisses by its returned id", async () => {
  let id = "";
  let dismiss!: ReturnType<typeof useToastDismiss>;
  function Source() {
    const notify = useToastNotification();
    const [visible, setVisible] = useState(true);
    dismiss = useToastDismiss();
    return (
      visible && (
        <Button
          onClick={() => {
            id = notify("Copied", "success");
            setVisible(false);
          }}
        >
          Copy
        </Button>
      )
    );
  }
  const view = render(
    <ToastProvider>
      <Source />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Copied")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  act(() => {
    dismiss(id);
  });
  await waitFor(() => expect(screen.queryByText("Copied")).toBeNull());
  view.unmount();
});

it("preserves a toast action's focus destination after the toast host leaves", async () => {
  function Host() {
    const [visible, setVisible] = useState(true);
    return (
      <>
        <Button>Previous page</Button>
        <Button id="toast-focus-destination">Channel row</Button>
        {visible && (
          <ToastProvider>
            <ToastNotice title="Mute failed">
              <Button
                onClick={() => {
                  document.getElementById("toast-focus-destination")?.focus();
                  setVisible(false);
                }}
              >
                Retry mute
              </Button>
            </ToastNotice>
          </ToastProvider>
        )}
      </>
    );
  }
  render(<Host />);
  const retry = await screen.findByRole("button", { name: "Retry mute" });
  act(() => screen.getByRole("button", { name: "Previous page" }).focus());
  act(() => retry.focus());
  expect(retry).toHaveFocus();
  fireEvent.click(retry);
  expect(screen.getByRole("button", { name: "Channel row" })).toHaveFocus();
  expect(
    screen.queryByRole("region", { name: "App notifications" }),
  ).toBeNull();
});

it("cancels a dismissed toast's pending removal when its host unmounts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = render(
    <ToastProvider>
      <ToastNotice title="Update ready" onDismiss={() => {}} />
    </ToastProvider>,
  );
  await act(() => vi.advanceTimersByTimeAsync(1));
  const notice = screen.getByRole("dialog", { name: "Update ready" });
  fireEvent.keyDown(notice, { key: "Escape", code: "Escape" });
  // Escape begins Sonner's delayed removal; tear down the host before it fires.
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
