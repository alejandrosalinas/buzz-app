import { expect, it } from "vitest";
import { fileFormat } from "./formats";
import { decodeText, LoadError, readBytes } from "./load";
import { MAX_CELLS, MAX_COLUMNS, MAX_ROWS, parseTable } from "./table";
import { fileTarget, isCommunityMedia, parseFileTarget } from "./target";

const ORIGIN = "https://relay.example.org";
const MEDIA = `${ORIGIN}/media/${"a".repeat(64)}`;

it("reads files by name first and type second", () => {
  expect(fileFormat("plan.md", undefined)).toBe("markdown");
  expect(fileFormat("Report.PDF", "application/octet-stream")).toBe("pdf");
  expect(fileFormat("rows.csv", undefined)).toBe("csv");
  expect(fileFormat("rows.tsv", undefined)).toBe("tsv");
  expect(fileFormat("main.rs", undefined)).toBe("text");
  expect(fileFormat("Dockerfile", undefined)).toBe("text");
  expect(fileFormat("notes", "text/markdown; charset=utf-8")).toBe("markdown");
  expect(fileFormat(undefined, "application/pdf")).toBe("pdf");
  expect(fileFormat("photo.heic", "image/heic")).toBeUndefined();
  expect(fileFormat("deck.pptx", undefined)).toBeUndefined();
  expect(fileFormat(".env", undefined)).toBeUndefined();
});

it("round-trips file targets and rejects unreadable ones", () => {
  const target = fileTarget({
    url: MEDIA,
    name: "a b.md",
    mime: "text/markdown",
    time: 1_700_000_000,
  });
  expect(target.startsWith("buzz-file:?")).toBe(true);
  expect(parseFileTarget(target)).toEqual({
    url: MEDIA,
    name: "a b.md",
    mime: "text/markdown",
    time: 1_700_000_000,
    format: "markdown",
  });
  expect(parseFileTarget(`${target}x`)).not.toHaveProperty("time");
  // A sender-set time past what dates can show is dropped, not thrown on.
  expect(
    parseFileTarget(fileTarget({ url: MEDIA, name: "a.md", time: 1e17 })),
  ).not.toHaveProperty("time");
  expect(
    parseFileTarget(`buzz-file:?url=${encodeURIComponent(`${MEDIA}.pdf`)}`),
  ).toMatchObject({
    name: `${"a".repeat(64)}.pdf`,
    format: "pdf",
  });
  expect(
    parseFileTarget(fileTarget({ url: MEDIA, name: "x.zip" })),
  ).toBeUndefined();
  expect(
    parseFileTarget("buzz-file:?url=javascript%3Aalert(1)&name=a.md"),
  ).toBeUndefined();
  expect(parseFileTarget("https://example.org/a.md")).toBeUndefined();
});

it("opens only media shared in the current community", () => {
  expect(isCommunityMedia(MEDIA, ORIGIN)).toBe(true);
  expect(isCommunityMedia(MEDIA, undefined)).toBe(false);
  expect(isCommunityMedia(MEDIA, "https://other.example.org")).toBe(false);
  expect(isCommunityMedia(`${ORIGIN}/api/secret`, ORIGIN)).toBe(false);
  expect(
    isCommunityMedia(`https://user:pw@relay.example.org/media/x`, ORIGIN),
  ).toBe(false);
  expect(isCommunityMedia("not a url", ORIGIN)).toBe(false);
});

it("parses quoted CSV fields and caps rows and columns", () => {
  expect(
    parseTable('a,"b,1"\r\n"say ""hi""","two\nlines"\n', ",").rows,
  ).toEqual([
    ["a", "b,1"],
    ['say "hi"', "two\nlines"],
  ]);
  expect(parseTable("a\tb\n1\t2", "\t").rows).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  const wide = parseTable(
    `${Array(MAX_COLUMNS + 3)
      .fill("x")
      .join(",")}\n`,
    ",",
  );
  expect(wide.rows[0]).toHaveLength(MAX_COLUMNS);
  expect(wide.omittedColumns).toBe(3);
  const long = parseTable("r\n".repeat(MAX_ROWS + 7), ",");
  expect(long.rows).toHaveLength(MAX_ROWS);
  expect(long.omittedRows).toBe(7);
  const big = parseTable(
    `${Array(MAX_COLUMNS).fill("x").join(",")}\n`.repeat(300),
    ",",
  );
  expect(big.rows).toHaveLength(MAX_CELLS / MAX_COLUMNS);
  expect(big.omittedRows).toBe(300 - MAX_CELLS / MAX_COLUMNS);
});

const respond = (body: BodyInit, headers: HeadersInit = {}, status = 200) =>
  (async () => new Response(body, { status, headers })) as typeof fetch;

it("reads bytes within the limit", async () => {
  const signal = new AbortController().signal;
  const bytes = await readBytes("/x", 10, signal, respond("hello"));
  expect(decodeText(bytes)).toBe("hello");
  await expect(
    readBytes("/x", 4, signal, respond("hello")),
  ).rejects.toMatchObject({ reason: "too-large" });
  await expect(
    readBytes("/x", 4, signal, respond("hi", { "content-length": "99" })),
  ).rejects.toMatchObject({ reason: "too-large" });
  await expect(
    readBytes("/x", 9, signal, respond("no", {}, 404)),
  ).rejects.toMatchObject({ reason: "unavailable" });
  const offline = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await expect(readBytes("/x", 9, signal, offline)).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(() => decodeText(new Uint8Array([104, 0, 105]))).toThrow(LoadError);
});
