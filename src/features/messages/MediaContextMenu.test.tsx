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
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import { copyImageToClipboard } from "./image-copy";
import { MediaContextMenu } from "./MediaContextMenu";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/clipboard", () => ({ writeClipboardText: vi.fn() }));
vi.mock("./image-copy", () => ({
  copyImageToClipboard: vi.fn(),
  supportsImageCopy: () => true,
}));

const url = `https://relay.test/media/${"a".repeat(64)}.png`;
const source = `buzz-media://localhost/${encodeURIComponent(url)}`;
const proxy = `/api/relay/primary/media?url=${encodeURIComponent(url)}`;
const props = { url, source, name: "photo.png", kind: "image" as const };

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeClipboardText).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyImageToClipboard).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function menu(
  overrides: Partial<ComponentProps<typeof MediaContextMenu>> = {},
  active = true,
) {
  return (
    <ToastProvider>
      <ConversationPresentation value={active}>
        <MediaContextMenu {...props} {...overrides}>
          {overrides.children ?? (
            <button type="button" aria-label="Preview">
              <img src={source} alt="Original" />
              <img src="thumbnail" data-thumbnail alt="Thumbnail" />
            </button>
          )}
        </MediaContextMenu>
      </ConversationPresentation>
    </ToastProvider>
  );
}
async function open() {
  fireEvent.contextMenu(screen.getByAltText("Thumbnail"), {
    clientX: 40,
    clientY: 50,
  });
  return screen.findByRole("menu");
}

it("copies the original native media URL rather than its private source", async () => {
  render(menu());
  await open();
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Copy image URL" }),
  );
  await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(url));
  expect(invoke).not.toHaveBeenCalled();
});

it.each([
  ["image", "saved"],
  ["video", "failed"],
] as const)(
  "announces a native %s download before it is %s and prevents duplicate starts",
  async (kind, result) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    vi.mocked(invoke).mockReturnValueOnce(pending);
    render(menu({ kind }));
    try {
      await open();
      await userEvent.click(
        screen.getByRole("menuitem", { name: `Download ${kind}` }),
      );
      expect(invoke).toHaveBeenCalledExactlyOnceWith("media_download", {
        source,
        name: "photo.png",
      });
      expect(await screen.findByText("Starting download…")).toBeVisible();
      expect(screen.queryByText("Saved to Downloads")).toBeNull();
      expect(screen.queryByText(/Couldn’t download/)).toBeNull();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await open();
      await userEvent.click(
        screen.getByRole("menuitem", { name: `Download ${kind}` }),
      );
      expect(invoke).toHaveBeenCalledOnce();
      expect(screen.getAllByText("Starting download…")).toHaveLength(1);

      await act(async () => {
        if (result === "saved") finish();
        else fail(new Error("offline"));
      });
      expect(
        await screen.findByText(
          result === "saved"
            ? "Saved to Downloads"
            : "Couldn’t download. Try again.",
        ),
      ).toBeVisible();
      await waitFor(() =>
        expect(screen.queryByText("Starting download…")).toBeNull(),
      );
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await open();
      await userEvent.click(
        screen.getByRole("menuitem", { name: `Download ${kind}` }),
      );
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      if (result === "failed") {
        expect(await screen.findByText("Saved to Downloads")).toBeVisible();
      }
    } finally {
      await act(async () => finish());
    }
  },
);

it("tracks pending downloads separately when the selected attachment changes", async () => {
  function deferredDownload() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const first = deferredDownload();
  const second = deferredDownload();
  vi.mocked(invoke)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const secondUrl = `https://relay.test/media/${"b".repeat(64)}.png`;
  const secondSource = `buzz-media://localhost/${encodeURIComponent(secondUrl)}`;
  const rendered = render(menu());
  const download = async () => {
    await open();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Download image" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  };
  try {
    await download();
    rendered.rerender(
      menu({ url: secondUrl, source: secondSource, name: "second.png" }),
    );
    await download();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["media_download", { source, name: "photo.png" }],
      ["media_download", { source: secondSource, name: "second.png" }],
    ]);

    await act(async () => first.resolve());
    await download();
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      first.resolve();
      second.resolve();
    });
  }
});

it("copies native image bytes through the host", async () => {
  render(menu());
  await open();
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("media_copy_image", { source }),
  );
});

it("copies the browser original, never the thumbnail under the press", async () => {
  render(menu({ source: proxy }));
  await open();
  await userEvent.click(screen.getByRole("menuitem", { name: "Copy image" }));
  expect(copyImageToClipboard).toHaveBeenCalledWith(
    screen.getByAltText("Original"),
  );
});

it("uses the browser download link for proxy media", async () => {
  render(menu({ source: proxy }));
  await open();
  expect(
    screen.getByRole("menuitem", { name: "Download image" }),
  ).toHaveAttribute("href", proxy);
  expect(
    screen.getByRole("menuitem", { name: "Download image" }),
  ).toHaveAttribute("download", "photo.png");
});

it("opens media actions over playback controls instead of bubbling to a message menu", async () => {
  const outer = vi.fn();
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: Observe whether media events escape to the outer message owner.
    <div onContextMenu={outer}>
      {menu({
        kind: "video",
        children: (
          <div>
            <div data-video-controls>
              <button type="button">Play video</button>
            </div>
          </div>
        ),
      })}
    </div>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "Play video" }));
  expect(
    await screen.findByRole("menuitem", { name: "Copy video URL" }),
  ).toBeVisible();
  expect(outer).not.toHaveBeenCalled();
});

it.each(["{Shift>}{F10}{/Shift}", "{ContextMenu}"])(
  "opens with %s and restores keyboard focus after Escape",
  async (key) => {
    render(menu());
    const preview = screen.getByRole("button", { name: "Preview" });
    preview.focus();
    await userEvent.keyboard(key);
    expect(await screen.findByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(preview).toHaveFocus());
  },
);

it("hands off to the gallery after its menu has closed", async () => {
  const view = vi.fn(() => {
    expect(
      screen.queryByRole("menu")?.hasAttribute("data-closed") ?? true,
    ).toBe(true);
  });
  render(menu({ onView: view }));
  await open();
  await userEvent.click(screen.getByRole("menuitem", { name: "Open image" }));
  await waitFor(() => expect(view).toHaveBeenCalledOnce());
});

it("retires an open menu on source change and does not revive it", async () => {
  const rendered = render(menu());
  await open();
  rendered.rerender(menu({ source: undefined }));
  expect(screen.queryByRole("menu")).toBeNull();
  rendered.rerender(menu());
  expect(screen.queryByRole("menu")).toBeNull();
  await open();
  rendered.rerender(menu({}, false));
  expect(screen.queryByRole("menu")).toBeNull();
  rendered.rerender(menu());
  expect(screen.queryByRole("menu")).toBeNull();
});

it.each([
  { source: "https://external.test/image.png" },
  { source: "blob:unsent-preview" },
  { url: "javascript:alert(1)" },
])("preserves native menus for unsupported media %j", (overrides) => {
  render(menu(overrides));
  expect(fireEvent.contextMenu(screen.getByAltText("Original"))).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("preserves a host's image-copy restriction and omits it for videos", async () => {
  const rendered = render(menu({ allowCopy: false }));
  await open();
  expect(screen.queryByRole("menuitem", { name: "Copy image" })).toBeNull();
  rendered.rerender(menu({ kind: "video" }));
  expect(screen.queryByRole("menuitem", { name: "Copy image" })).toBeNull();
});

it.each(["Copy image", "Copy image URL"])(
  "reports %s failures and permits a retry",
  async (action) => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
    vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error("denied"));
    render(menu());
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: action }));
    await screen.findByText(/Couldn’t/);
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: action }));
    await screen.findByText(
      action === "Copy image" ? "Image copied" : "Image URL copied",
    );
  },
);
