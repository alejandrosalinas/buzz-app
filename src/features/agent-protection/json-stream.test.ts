import { expect, it, vi } from "vitest";
import {
  jsonLines,
  jsonPieces,
  writeJSON,
  type TextSource,
} from "./json-stream";

async function collect(parts: AsyncIterable<string>) {
  let value = "";
  for await (const part of parts) value += part;
  return value;
}

it("rejects streamed evidence before writing when the process lacks an atomic writer", async () => {
  const write = vi.fn(async (_data: string) => {});
  const read = vi.fn(async function* () {
    yield "evidence";
  });
  await expect(writeJSON({ write }, { input: { read } })).rejects.toThrow(
    "The process cannot accept streamed JSON",
  );
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("encodes streamed strings and nested JSON exactly, without splitting Unicode", async () => {
  const text = '"\\\n😀'.repeat(10000);
  const source: TextSource = {
    read: async function* () {
      yield text;
      yield "tail";
    },
  };
  const value = { empty: [], nested: { text: source }, none: null };
  const expected =
    JSON.stringify({ ...value, nested: { text: text + "tail" } }) + "\n";
  let output = "",
    largest = 0;
  for await (const piece of jsonLines(value)) {
    output += piece;
    largest = Math.max(largest, piece.length);
  }
  expect(output).toBe(expected);
  expect(largest).toBeLessThanOrEqual(6 * 16384);
  expect(
    await collect(
      jsonPieces({ omitted: undefined, list: [undefined, 1, true] }),
    ),
  ).toBe('{"list":[null,1,true]}');
});
