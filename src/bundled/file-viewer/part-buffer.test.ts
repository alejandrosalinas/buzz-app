import { describe, expect, it } from "vitest";
import { type BufferedPart, reduceBuffer } from "./part-buffer";

const parts = (...indexes: number[]): BufferedPart<string>[] =>
  indexes.map((index) => ({ index, prepared: `part ${index}` }));
const indexes = (shown: readonly BufferedPart<string>[]) =>
  shown.map((part) => part.index);

describe("reduceBuffer", () => {
  it("extends only at either end", () => {
    const shown = parts(3, 4);
    const at = (index: number) =>
      indexes(
        reduceBuffer(
          shown,
          { type: "extend", index, prepared: `part ${index}` },
          10,
        ),
      );
    expect(at(5)).toEqual([3, 4, 5]);
    expect(at(2)).toEqual([2, 3, 4]);
    expect(at(7)).toEqual([3, 4]);
    expect(at(4)).toEqual([3, 4]);
  });

  it("drops only an end, never the only part", () => {
    const shown = parts(3, 4, 5);
    const drop = (index: number) =>
      indexes(reduceBuffer(shown, { type: "drop", index }, 10));
    expect(drop(3)).toEqual([4, 5]);
    expect(drop(5)).toEqual([3, 4]);
    expect(drop(4)).toEqual([3, 4, 5]);
    const one = parts(3);
    expect(reduceBuffer(one, { type: "drop", index: 3 }, 10)).toBe(one);
  });

  it("seeks to one part alone, and keeps a part that is already alone", () => {
    const shown = parts(3, 4);
    expect(
      indexes(
        reduceBuffer(shown, { type: "seek", index: 8, prepared: "" }, 10),
      ),
    ).toEqual([8]);
    expect(
      indexes(
        reduceBuffer(shown, { type: "seek", index: 4, prepared: "" }, 10),
      ),
    ).toEqual([4]);
    const alone = parts(4);
    expect(
      reduceBuffer(alone, { type: "seek", index: 4, prepared: "new" }, 10),
    ).toBe(alone);
  });

  it("ignores parts the file doesn't have", () => {
    const shown = parts(0);
    for (const index of [-1, 1.5, 10, Number.NaN])
      expect(
        reduceBuffer(shown, { type: "seek", index, prepared: "" }, 10),
      ).toBe(shown);
    expect(
      reduceBuffer(shown, { type: "extend", index: 10, prepared: "" }, 10),
    ).toBe(shown);
  });
});
