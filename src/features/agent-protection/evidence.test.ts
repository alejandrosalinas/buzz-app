import { expect, it } from "vitest";
import { EvidenceTransfer } from "./evidence";

async function collect(parts: AsyncIterable<string>) {
  let value = "";
  for await (const part of parts) value += part;
  return value;
}
it("acknowledges only consumed chunks and validates complete byte counts", async () => {
  const source = new EvidenceTransfer(16);
  const iterator = source.read();
  const next = iterator.next();
  let acknowledged = false;
  const push = source.push(0, new TextEncoder().encode('"😀"')).then(() => {
    acknowledged = true;
  });
  expect(await next).toEqual({ value: '"😀"', done: false });
  expect(acknowledged).toBe(false);
  const end = iterator.next();
  await push;
  source.finish(1, 6);
  expect(await end).toEqual({ value: undefined, done: true });
});

it("preserves UTF-8 split across chunks and denies a truncated scalar", async () => {
  const source = new EvidenceTransfer(3);
  const result = collect(source.read());
  const bytes = new TextEncoder().encode('"😀"');
  await source.push(0, bytes.slice(0, 3));
  await source.push(1, bytes.slice(3));
  source.finish(2, bytes.length);
  expect(await result).toBe('"😀"');
  const bad = new EvidenceTransfer();
  const reading = collect(bad.read());
  void reading.catch(() => {});
  await bad.push(0, new Uint8Array([0xf0]));
  expect(() => bad.finish(1, 1)).toThrow();
  bad.fail(new Error("truncated"));
  await expect(reading).rejects.toThrow("truncated");
});

it("cancellation releases blocked producers; duplicate and missing pieces cannot finish", async () => {
  const source = new EvidenceTransfer();
  const held = source.push(0, new Uint8Array([1]));
  await expect(source.push(0, new Uint8Array([2]))).rejects.toThrow(
    "Invalid evidence chunk",
  );
  expect(() => source.finish(0, 0)).toThrow("Incomplete evidence");
  source.fail(new Error("cancelled"));
  await expect(held).rejects.toThrow("cancelled");
  await expect(source.read().next()).rejects.toThrow("cancelled");
});
