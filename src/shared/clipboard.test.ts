import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { writeClipboardRichText } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class CopyItem {
  static supports = () => true;
  readonly types: string[];
  constructor(private readonly data: Record<string, Blob>) {
    this.types = Object.keys(data);
  }
  async getType(type: string) {
    const value = this.data[type];
    if (!value) throw new Error("Missing clipboard flavor");
    return value;
  }
}

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.stubGlobal("ClipboardItem", CopyItem);
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    clipboard: {
      write: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("starts one browser write with both clipboard flavors inside the gesture", async () => {
  const copied = writeClipboardRichText(
    "Keep bold",
    "Keep <strong>bold</strong>",
  );
  expect(navigator.clipboard.write).toHaveBeenCalledOnce();
  const item = vi.mocked(navigator.clipboard.write).mock.calls[0]?.[0][0];
  expect(item?.types).toEqual(["text/plain", "text/html"]);
  expect(await (await item?.getType("text/plain"))?.text()).toBe("Keep bold");
  expect(await (await item?.getType("text/html"))?.text()).toBe(
    "Keep <strong>bold</strong>",
  );
  await copied;
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it.each(["item", "write", "html"])(
  "requires an explicit plain fallback when rich clipboard support lacks %s",
  async (missing) => {
    if (missing === "item") vi.stubGlobal("ClipboardItem", undefined);
    if (missing === "write") navigator.clipboard.write = undefined as never;
    if (missing === "html")
      vi.spyOn(CopyItem, "supports").mockReturnValue(false);
    await expect(
      writeClipboardRichText("Keep bold", "Keep <strong>bold</strong>"),
    ).rejects.toThrow("Rich clipboard copies are not supported.");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await writeClipboardRichText("Keep bold", "Keep <strong>bold</strong>", {
      fallbackToPlainText: true,
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
      "Keep bold",
    );
  },
);

it("passes both flavors to the desktop host without a browser activation dependency", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubGlobal("ClipboardItem", undefined);
  await writeClipboardRichText("Keep bold", "Keep <strong>bold</strong>");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("clipboard_write_text", {
    text: "Keep bold",
    html: "Keep <strong>bold</strong>",
  });
  expect(navigator.clipboard.write).not.toHaveBeenCalled();
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it("surfaces a refused rich write without silently replacing it with another write", async () => {
  const denied = new Error("Clipboard denied");
  vi.mocked(navigator.clipboard.write).mockRejectedValue(denied);
  await expect(
    writeClipboardRichText("Keep bold", "<strong>Keep bold</strong>"),
  ).rejects.toBe(denied);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});
