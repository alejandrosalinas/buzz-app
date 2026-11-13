// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { EmojiSnapshot } from "../../features/relay/emoji-directory";
import { relayGifRequests } from "../../features/relay/gifs";
import { createGifShortcut } from "./gif-shortcut";
import { EmojiPicker } from "./EmojiPicker";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses the supplied window owner for GIF discovery, search, retry and selection", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const direct = vi
    .spyOn(relayGifRequests, "supports")
    .mockRejectedValue(new Error("Native ACL denies child relay access"));
  const directSearch = vi.spyOn(relayGifRequests, "search");
  const asset = {
    url: "https://example.test/hello.gif",
    width: 100,
    height: 100,
    size: 20,
  };
  const supports = vi.fn(async () => true);
  const search = vi
    .fn()
    .mockRejectedValueOnce(new Error("Search offline"))
    .mockResolvedValue([
      { id: 1, slug: "hello", title: "Hello", preview: asset, original: asset },
    ]);
  const insert = vi.fn();
  const owner = createRelaySession(null);
  try {
    render(
      <EmojiPicker
        session={owner.session}
        scope={`https://example.test:${"ab".repeat(32)}`}
        disabled={false}
        insert={insert}
        gifRequests={{ supports, search }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Emoji and GIFS" }));
    fireEvent.click(await screen.findByRole("tab", { name: "GIF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search offline",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    expect(
      screen.getByRole("searchbox", { name: "Search GIFs" }),
    ).toHaveFocus();
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Hello" }),
    );
    expect(supports).toHaveBeenCalledWith(
      "https://example.test",
      expect.any(AbortSignal),
    );
    expect(search).toHaveBeenCalledWith(
      "https://example.test",
      "",
      expect.any(AbortSignal),
    );
    expect(search).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenCalledWith(
      "![Hello](https://example.test/hello.gif)",
    );
    expect(direct).not.toHaveBeenCalled();
    expect(directSearch).not.toHaveBeenCalled();
  } finally {
    owner.dispose();
  }
});

it("shows a recovering catalog as loading and keeps Retry for deterministic failures", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const owner = createRelaySession(null);
  const listeners = new Set<() => void>();
  let snapshot: EmojiSnapshot = Object.freeze({
    status: "error",
    entries: [],
    mine: [],
    error: "ReadError: Relay read timed out",
    transient: true,
  });
  const publish = (next: EmojiSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const refresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
    emoji: {
      ...owner.session.emoji,
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      ensure: vi.fn(async () => {}),
      refresh,
    },
  };
  try {
    render(
      <EmojiPicker
        session={session}
        scope="a"
        disabled={false}
        insert={vi.fn()}
        reaction
      />,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    // Loading feedback stays silent for a fast read, then announces.
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Loading community emoji…")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading community emoji…",
    );
    expect(screen.queryByText(/timed out/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry emoji" })).toBeNull();
    // A recovery attempt in flight keeps the same loading state.
    act(() =>
      publish({
        ...snapshot,
        status: "loading",
        error: undefined,
        transient: undefined,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading community emoji…",
    );
    act(() => publish({ ...snapshot, status: "ready", entries: [], mine: [] }));
    expect(screen.queryByText("Loading community emoji…")).toBeNull();
    // A loaded catalog that recovers a failed refresh stays quiet and usable.
    act(() =>
      publish({
        ...snapshot,
        error: "ReadError: Relay read timed out",
        transient: true,
      }),
    );
    expect(screen.queryByText("Loading community emoji…")).toBeNull();
    expect(screen.queryByText(/timed out/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry emoji" })).toBeNull();
    act(() => publish({ ...snapshot, error: undefined, transient: undefined }));
    act(() =>
      publish({
        ...snapshot,
        status: "error",
        error: "Community emoji exceeds the catalog budget.",
      }),
    );
    expect(screen.queryByText("Loading community emoji…")).toBeNull();
    expect(
      screen.getByText("Community emoji exceeds the catalog budget."),
    ).toHaveAttribute("role", "alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry emoji" }));
    expect(refresh).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});

it("searches GIFs only from two characters and shows the default GIFs for one", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const asset = {
    url: "https://example.test/hello.gif",
    width: 100,
    height: 100,
    size: 20,
  };
  const search = vi.fn(async (_community: string, query: string) => [
    {
      id: 1,
      slug: query ? "found" : "hello",
      title: query ? "Found" : "Hello",
      preview: asset,
      original: asset,
    },
  ]);
  const owner = createRelaySession(null);
  try {
    render(
      <EmojiPicker
        session={owner.session}
        scope={`https://example.test:${"ab".repeat(32)}`}
        disabled={false}
        insert={vi.fn()}
        gifRequests={{ supports: vi.fn(async () => true), search }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Emoji and GIFS" }));
    fireEvent.click(await screen.findByRole("tab", { name: "GIF" }));
    await screen.findByRole("button", { name: "Choose Hello" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const input = screen.getByRole("searchbox", { name: "Search GIFs" });
    fireEvent.change(input, { target: { value: "h" } });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(search).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Choose Hello" })).toBeVisible();
    fireEvent.change(input, { target: { value: "he" } });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(search).toHaveBeenLastCalledWith(
      "https://example.test",
      "he",
      expect.any(AbortSignal),
    );
    expect(search).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    expect(
      await screen.findByRole("button", { name: "Choose Found" }),
    ).toBeVisible();
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});

it.each(["metaKey", "ctrlKey"])(
  "opens GIF search from the owning composer with %s+G",
  async (modifier) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(
      modifier === "metaKey" ? "MacIntel" : "Linux",
    );
    const owner = createRelaySession(null);
    let resolveSupport!: (supported: boolean) => void;
    const supports = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSupport = resolve;
        }),
    );
    const search = vi.fn(async () => []);
    try {
      render(
        <form>
          <input aria-label="Draft" />
          <EmojiPicker
            session={owner.session}
            scope={`https://example.test:${"ab".repeat(32)}`}
            disabled={false}
            insert={vi.fn()}
            gifRequests={{ supports, search }}
          />
        </form>,
      );
      const draft = screen.getByRole("textbox", { name: "Draft" });
      draft.focus();
      fireEvent.keyDown(draft, { key: "g", [modifier]: true });
      expect(
        await screen.findByRole("searchbox", { name: "Search GIFs" }),
      ).toHaveFocus();
      expect(search).not.toHaveBeenCalled();
      resolveSupport(true);
      expect(screen.getByRole("tab", { name: "GIF" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      owner.dispose();
    }
  },
);

it.each([false, "error"])(
  "keeps GIF discovery feedback visible: %s",
  async (result) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const owner = createRelaySession(null);
    const supports =
      result === false
        ? vi.fn().mockResolvedValue(false)
        : vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue(true);
    const search = vi.fn(async () => []);
    try {
      render(
        <form>
          <input aria-label="Draft" />
          <EmojiPicker
            session={owner.session}
            scope={`https://example.test:${"ab".repeat(32)}`}
            disabled={false}
            insert={vi.fn()}
            gifRequests={{ supports, search }}
          />
        </form>,
      );
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), {
        key: "g",
        ctrlKey: true,
      });
      expect(
        await screen.findByText(
          result === false
            ? "GIFs are not available in this community."
            : "Could not check GIF availability.",
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("searchbox", { name: "Search GIFs" }),
      ).toHaveFocus();
      expect(
        screen.getByRole("searchbox", { name: "Search GIFs" }),
      ).toHaveAccessibleDescription(
        result === false
          ? "GIFs are not available in this community."
          : "Could not check GIF availability.",
      );
      expect(search).not.toHaveBeenCalled();
      if (result === "error") {
        const retry = screen.getByRole("button", {
          name: "Retry GIF availability",
        });
        retry.focus();
        fireEvent.click(retry);
        expect(
          screen.getByRole("searchbox", { name: "Search GIFs" }),
        ).toHaveFocus();
        await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
      }
    } finally {
      owner.dispose();
    }
  },
);

it("honors companion shortcut overrides and cross-window changes", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const key = "buzz-shortcut-bindings.v1";
  localStorage.setItem(
    key,
    JSON.stringify({ "buzz.emoji/gif-picker": { key: "j", mod: true } }),
  );
  const owner = createRelaySession(null);
  try {
    render(
      <form>
        <input aria-label="Draft" />
        <EmojiPicker
          session={owner.session}
          scope={`https://example.test:${"ab".repeat(32)}`}
          disabled={false}
          insert={vi.fn()}
          gifRequests={{
            supports: vi.fn(async () => true),
            search: vi.fn(async () => []),
          }}
        />
      </form>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.keyDown(draft, { key: "g", ctrlKey: true });
    expect(screen.queryByRole("searchbox", { name: "Search GIFs" })).toBeNull();
    localStorage.setItem(
      key,
      JSON.stringify({ "buzz.emoji/gif-picker": { key: "k", mod: true } }),
    );
    fireEvent(
      window,
      new StorageEvent("storage", { key, storageArea: localStorage }),
    );
    fireEvent.keyDown(draft, { key: "j", ctrlKey: true });
    expect(screen.queryByRole("searchbox", { name: "Search GIFs" })).toBeNull();
    localStorage.setItem(
      key,
      JSON.stringify({
        "buzz.emoji/gif-picker": { key: "k", mod: true, alt: true },
      }),
    );
    fireEvent(
      window,
      new StorageEvent("storage", { key, storageArea: localStorage }),
    );
    const altGraph = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
    });
    Object.defineProperty(altGraph, "getModifierState", {
      value: (modifier: string) => modifier === "AltGraph",
    });
    fireEvent(draft, altGraph);
    expect(screen.queryByRole("searchbox", { name: "Search GIFs" })).toBeNull();
    fireEvent.keyDown(draft, { key: "k", ctrlKey: true, altKey: true });
    expect(
      await screen.findByRole("searchbox", { name: "Search GIFs" }),
    ).toHaveFocus();
  } finally {
    owner.dispose();
  }
});

it("keeps the newest composer shortcut target when older discovery completes", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const owner = createRelaySession(null);
  const shortcut = createGifShortcut();
  let settle!: (value: boolean) => void;
  const olderSupports = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
  );
  const newerSupports = vi.fn(async () => true);
  const search = vi.fn(async () => []);
  try {
    render(
      <>
        <button type="button">Outside</button>
        {[
          { key: "old", supports: olderSupports },
          { key: "new", supports: newerSupports },
        ].map(({ key, supports }) => (
          <form key={key} aria-label={key}>
            <EmojiPicker
              session={owner.session}
              scope={`https://example.test:${"ab".repeat(32)}`}
              disabled={false}
              insert={vi.fn()}
              gifShortcut={shortcut}
              gifRequests={{ supports, search }}
            />
          </form>
        ))}
      </>,
    );
    fireEvent.pointerEnter(
      within(screen.getByRole("form", { name: "old" })).getByRole("button", {
        name: "Emoji and GIFS",
      }),
    );
    expect(olderSupports).toHaveBeenCalledOnce();
    await act(async () => settle(true));
    screen.getByRole("button", { name: "Outside" }).focus();
    act(() => shortcut.run());
    await screen.findByRole("searchbox", { name: "Search GIFs" });
    expect(newerSupports).toHaveBeenCalledOnce();
  } finally {
    owner.dispose();
  }
});
