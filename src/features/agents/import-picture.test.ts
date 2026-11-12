import { beforeEach, expect, it, vi } from "vitest";
import { emojiAvatar } from "../profiles/avatar-upload";
import { legacyEmojiPicture } from "../../shared/avatar-source";
import { importedEmojiPicture } from "./import-picture";

vi.mock("../profiles/avatar-upload", () => ({ emojiAvatar: vi.fn() }));
beforeEach(() => {
  vi.mocked(emojiAvatar).mockReset();
});

// The exact template produced by old Buzz's ProfileAvatarEditor.utils.ts.
const svg = (emoji = "🤙", color = "#c9d46a") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="${color}"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">${emoji}</text></svg>`;
const data = (value: string) =>
  `data:image/svg+xml,${encodeURIComponent(value)}`;

it.each(["🤙", "👩🏽‍💻", "🇵🇷", "❤️", "1️⃣"])(
  "preserves the old avatar's %s and custom background",
  (emoji) => {
    expect(legacyEmojiPicture(data(svg(emoji)))).toEqual({
      emoji,
      color: "#c9d46a",
    });
  },
);

it("decodes escaped text once without evaluating markup", () => {
  expect(legacyEmojiPicture(data(svg("&amp;lt;&gt;&amp;")))).toEqual({
    emoji: "&lt;>&",
    color: "#c9d46a",
  });
});

it.each([
  "data:image/svg+xml,%xx",
  "data:image/svg+xml;base64,PHN2Zz4=",
  data("<svg><script>alert(1)</script></svg>"),
  data(svg().replace("<text ", '<text onclick="alert(1)" ')),
  data(svg('<image href="https://example.test/track"/>')),
  data(svg("🤙", "url(https://example.test/track)")),
  data(svg("x".repeat(65))),
  data(svg("")),
  data(svg()).repeat(100),
  "https://example.test/avatar.png",
  "data:image/png;base64,iVBO",
])("leaves unsupported or ordinary artwork to native: %s", async (picture) => {
  expect(legacyEmojiPicture(picture)).toBeUndefined();
  expect(await importedEmojiPicture(picture)).toBeUndefined();
  expect(emojiAvatar).not.toHaveBeenCalled();
});

it("renders only parsed text/color and binds the PNG bytes to the original source", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  vi.mocked(emojiAvatar).mockResolvedValue(new File([bytes], "avatar.png"));
  const picture = data(svg());
  expect(await importedEmojiPicture(picture)).toEqual({
    source: picture,
    png: "data:image/png;base64,iVBORw0KGgo=",
  });
  expect(emojiAvatar).toHaveBeenCalledExactlyOnceWith("🤙", "#c9d46a");
});

it("reports conversion failure to the caller without supplying replacement art", async () => {
  vi.mocked(emojiAvatar).mockRejectedValue(new Error("Canvas unavailable"));
  await expect(importedEmojiPicture(data(svg()))).rejects.toThrow(
    "Canvas unavailable",
  );
});
