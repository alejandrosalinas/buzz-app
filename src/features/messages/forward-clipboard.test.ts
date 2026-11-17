// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import {
  forwardClipboard,
  pastedForward,
  forwardReference,
} from "./forward-clipboard";
import { mentionDraft, hasDraftContent } from "./mention-draft";
import { writeClipboardRichText } from "../../shared/clipboard";
import { invoke, isTauri } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  isTauri: vi.fn().mockReturnValue(true),
}));
const reference = {
  version: 1 as const,
  origin: "https://relay.example",
  channelId: "private-source",
  id: "a".repeat(64),
};
it("round trips only an explicit forward locator, keeping fallback text inert", () => {
  const payload = forwardClipboard(reference, '<img src=x onerror="bad">');
  expect(payload.html).not.toContain("<img");
  expect(
    pastedForward({
      getData: (type) => (type === "text/html" ? payload.html : payload.text),
    }),
  ).toEqual(reference);
  expect(
    pastedForward({
      getData: () => `buzz://message?channel=source&id=${reference.id}`,
    }),
  ).toBeUndefined();
  expect(
    pastedForward({ getData: () => payload.html + payload.html }),
  ).toBeUndefined();
  expect(forwardReference({ ...reference, version: 2 })).toBeUndefined();
});
it("persists the locator as draft content and removes it explicitly", () => {
  const draft = mentionDraft({ text: "", recipients: [], forward: reference });
  expect(mentionDraft(JSON.parse(JSON.stringify(draft))).forward).toEqual(
    reference,
  );
  expect(hasDraftContent(draft)).toBe(true);
  expect(hasDraftContent(mentionDraft({ ...draft, forward: null }))).toBe(
    false,
  );
  expect(
    mentionDraft({ ...draft, forward: { ...reference, authorName: "forged" } })
      .forward,
  ).toEqual(reference);
});
it("uses the native clipboard with both representations", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  await writeClipboardRichText("quoted fallback", "<p>rich</p>");
  expect(invoke).toHaveBeenCalledWith("clipboard_write_text", {
    text: "quoted fallback",
    html: "<p>rich</p>",
  });
});

it("carries an editable note separately from the source locator", () => {
  const payload = forwardClipboard(
    reference,
    "fallback",
    "Please keep my review note",
  );
  expect(pastedForward({ getData: () => payload.html })).toEqual({
    ...reference,
    note: "Please keep my review note",
  });
  expect(forwardReference({ ...reference, note: "not source data" })).toEqual(
    reference,
  );
});
