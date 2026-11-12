// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { renderQrCode } from "../../shared/QrCode";
import { canShareInvite, shareInvite } from "./shareInvite";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("../../shared/QrCode", () => ({ renderQrCode: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("exports a fully revealed light PNG and opens sharing with its link and anchor", async () => {
  vi.mocked(renderQrCode).mockResolvedValue(
    "<svg><style>animation</style><circle/></svg>",
  );
  const sources: string[] = [];
  vi.stubGlobal(
    "Image",
    class {
      set src(value: string) {
        sources.push(value);
      }
      decode = vi.fn().mockResolvedValue(undefined);
    },
  );
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/png;base64,cG5n");
  await shareInvite(
    "https://example.org/invite/code",
    new DOMRect(10, 20, 70, 30),
  );
  expect(renderQrCode).toHaveBeenCalledWith(
    "https://example.org/invite/code",
    "light",
  );
  expect(decodeURIComponent(sources[0] ?? "")).toBe(
    "data:image/svg+xml,<svg><circle/></svg>",
  );
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 720, 720);
  expect(encode).toHaveBeenCalledWith("image/png");
  expect(invoke).toHaveBeenCalledWith("share_image", {
    png: "cG5n",
    url: "https://example.org/invite/code",
    x: 10,
    y: 20,
    width: 70,
    height: 30,
  });
});

it("does not open the native menu when rendering fails", async () => {
  vi.mocked(renderQrCode).mockRejectedValue(new Error("render failed"));
  await expect(
    shareInvite("https://example.org", new DOMRect(0, 0, 1, 1)),
  ).rejects.toThrow("render failed");
  expect(invoke).not.toHaveBeenCalled();
});

it("offers the native action only on macOS", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(canShareInvite()).toBe(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(canShareInvite()).toBe(false);
});
