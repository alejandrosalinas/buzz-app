import { describe, expect, it } from "vitest";
import { previewLinks } from "./preview-links";

describe("previewLinks", () => {
  it("lists bare and labeled HTTPS links once each, in order", () => {
    expect(
      previewLinks(
        "See https://example.com/a, [docs](https://docs.example.com/) and https://example.com/a again.",
      ),
    ).toEqual(["https://example.com/a", "https://docs.example.com/"]);
  });

  it("skips angle links, code, images, other schemes and attachments", () => {
    expect(
      previewLinks(
        [
          "<https://quiet.example.com>",
          "`https://code.example.com`",
          "```\nhttps://block.example.com\n```",
          "![img](https://img.example.com/a.png)",
          "http://plain.example.com buzz://channel/abc",
          "https://files.example.com/a.pdf",
          "https://kept.example.com",
        ].join("\n\n"),
        ["https://files.example.com/a.pdf"],
      ),
    ).toEqual(["https://kept.example.com/"]);
  });

  it("keeps spoiler links hidden and shows the ones around them", () => {
    expect(
      previewLinks(
        [
          "||[twist](https://plot.example.com/twist)|| and https://after.example.com",
          "before ||https://bare.example.com/hidden|| https://shown.example.com",
          "*||https://emphasis.example.com||* https://also.example.com",
          "|| unclosed https://open.example.com",
        ].join("\n\n"),
      ),
    ).toEqual([
      "https://after.example.com/",
      "https://shown.example.com/",
      "https://also.example.com/",
      "https://open.example.com/",
    ]);
  });

  it("resolves reference links through their definitions", () => {
    expect(
      previewLinks(
        "[docs][guide], [Guide] and [missing][nope]\n\n[guide]: https://example.org/docs",
      ),
    ).toEqual(["https://example.org/docs"]);
  });

  it("reads the HTTPS scheme in any case", () => {
    expect(previewLinks("HTTPS://example.org/docs")).toEqual([
      "https://example.org/docs",
    ]);
  });

  it("finds nothing in prose without links", () => {
    expect(previewLinks("hello there")).toEqual([]);
  });
});
