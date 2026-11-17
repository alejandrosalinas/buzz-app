// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityAddress } from "./CommunityAddress";
import type { CommunityReader } from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { HELPFUL_HINT_REST_MS } from "../shared/design-system/ui/hoverIntent";

const communities: CommunityReader = {
  subscribe: () => () => {},
  retained: () => undefined,
  snapshot: () => ({
    status: "ready",
    relayAvailable: false,
    profile: { name: "", picture: "" },
    memberships: [],
    selected: null,
    sync: { known: [], outbox: [] },
  }),
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("copies the resolved community URL and confirms only after clipboard success", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const writeText = vi.fn(() => pending);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <CommunityAddress
      communities={communities}
      community={{ id: "primary", name: "Friendly name" }}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, primary.example",
  });
  expect(button).not.toHaveAttribute("aria-current");
  fireEvent.click(button);
  expect(writeText).toHaveBeenCalledExactlyOnceWith("https://primary.example");
  expect(screen.queryByText("Community URL copied.")).toBeNull();
  try {
    await act(async () => finish());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Community URL copied.",
    );
    expect(button.querySelector(".tabler-icon-copy")).toBeNull();
    expect(button.querySelector(".tabler-icon-check")).toBeNull();
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    await act(async () => finish());
  }
});

it("reports clipboard refusal without claiming success and allows retry", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <ToastProvider>
      <CommunityAddress
        communities={communities}
        community={{ id: "https://community.example", name: "Community" }}
      />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, community.example",
  });
  fireEvent.click(button);
  expect(
    await screen.findByText("Couldn’t copy the community URL."),
  ).toBeVisible();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  fireEvent.click(button);
  expect(await screen.findByText("Community URL copied.")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledTimes(2);
});

it("a click before the hint rests confirms once, by toast", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  render(
    <ToastProvider>
      <CommunityAddress
        communities={communities}
        community={{ id: "https://community.example", name: "Community" }}
      />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, community.example",
  });
  fireEvent.mouseEnter(button);
  fireEvent.mouseMove(button);
  act(() => vi.advanceTimersByTime(100));
  fireEvent.pointerDown(button, { pointerType: "mouse" });
  fireEvent.mouseDown(button);
  fireEvent.pointerUp(button, { pointerType: "mouse" });
  fireEvent.mouseUp(button);
  await act(async () => fireEvent.click(button));
  // The pointer settles after the click, restarting the hint's rest.
  fireEvent.mouseMove(button);
  act(() => vi.advanceTimersByTime(HELPFUL_HINT_REST_MS));
  expect(screen.getAllByText("Community URL copied.")).toHaveLength(2);
  expect(screen.queryByRole("tooltip")).toBeNull();
  // Leaving ends that confirmation; the next resting hover offers Copy again.
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  fireEvent.mouseLeave(button);
  fireEvent.mouseEnter(button);
  fireEvent.mouseMove(button);
  act(() => vi.advanceTimersByTime(HELPFUL_HINT_REST_MS));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Copy");
});

it("a toast's hint suppression ends when focus leaves", async () => {
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  render(
    <ToastProvider>
      <button type="button">Elsewhere</button>
      <CommunityAddress
        communities={communities}
        community={{ id: "https://community.example", name: "Community" }}
      />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, community.example",
  });
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  act(() => button.focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
  fireEvent.keyDown(button, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  await act(async () => fireEvent.click(button));
  expect(screen.getByRole("status")).toHaveTextContent("Community URL copied.");
  fireEvent.keyDown(window, { key: "Tab" });
  act(() => elsewhere.focus());
  fireEvent.keyDown(window, { key: "Tab" });
  act(() => button.focus());
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy");
});

it("a copy that finishes after the pointer left does not hide the next hover's hint", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    },
  });
  render(
    <ToastProvider>
      <CommunityAddress
        communities={communities}
        community={{ id: "https://community.example", name: "Community" }}
      />
    </ToastProvider>,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, community.example",
  });
  fireEvent.mouseEnter(button);
  fireEvent.mouseMove(button);
  fireEvent.pointerDown(button, { pointerType: "mouse" });
  fireEvent.click(button);
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  fireEvent.mouseLeave(button);
  await act(async () => finish());
  expect(screen.getByRole("status")).toHaveTextContent("Community URL copied.");
  fireEvent.mouseEnter(button);
  fireEvent.mouseMove(button);
  act(() => vi.advanceTimersByTime(HELPFUL_HINT_REST_MS));
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
});

it("a later copy result wins and changing community clears the old confirmation", async () => {
  let first!: () => void;
  let second!: () => void;
  const writeText = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          first = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          second = resolve;
        }),
    );
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const view = render(
    <CommunityAddress
      communities={communities}
      community={{ id: "primary", name: "Primary" }}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Copy community URL, primary.example",
  });
  try {
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => first());
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    view.rerender(
      <CommunityAddress
        communities={communities}
        community={{ id: "secondary", name: "Secondary" }}
      />,
    );
    await act(async () => second());
    expect(
      screen.getByRole("button", {
        name: "Copy community URL, secondary.example",
      }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    await act(async () => {
      first?.();
      second?.();
    });
  }
});

it("uses saved community artwork instead of a generic globe", () => {
  render(
    <CommunityAddress
      communities={communities}
      community={{
        id: "primary",
        name: "Bee community",
        icon: "https://images.example/bee.png",
      }}
    />,
  );
  const row = screen.getByRole("button", {
    name: "Copy community URL, primary.example",
  });
  expect(row.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/bee.png",
  );
  expect(row.querySelector(".tabler-icon-world")).toBeNull();
});
