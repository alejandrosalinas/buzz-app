import { animatedImage, prepareAttachment } from "./prepare-attachment";
import { expect, it } from "vitest";
import {
  cleanGif,
  cleanPng,
  cleanWebp,
  pngChunks,
  snapshotChunk,
  webpChunks,
  webpNeedsPixelTransform,
} from "./image-metadata";
const enc = (s: string) => new TextEncoder().encode(s);
function png(kind: string, payload: Uint8Array = new Uint8Array()) {
  const b = new Uint8Array(payload.length + 12);
  new DataView(b.buffer).setUint32(0, payload.length);
  b.set(enc(kind), 4);
  b.set(payload, 8);
  return b;
}
function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
it.each(["buzz_agent_snapshot", "buzz_team_snapshot"])(
  "preserves exact %s bytes before IDAT while removing other metadata",
  async (keyword) => {
    const manifest = png("tEXt", enc(`${keyword}\0EXACT_PAYLOAD`));
    const bytes = join([
      signature,
      png("IHDR", new Uint8Array(13)),
      png("tEXt", enc("Comment\0private")),
      png("IDAT", new Uint8Array([1, 2])),
      manifest,
      png("IEND"),
    ]);
    const result = new Uint8Array(
      await cleanPng(bytes, snapshotChunk(pngChunks(bytes))).arrayBuffer(),
    );
    const chunks = pngChunks(result);
    expect(chunks.map((c) => c.kind)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(chunks[1]?.raw).toEqual(manifest);
  },
);
it("preserves APNG rendering chunks and rejects ICC rather than silently recoloring", async () => {
  const frames = [
    png("acTL", new Uint8Array([1])),
    png("fcTL", new Uint8Array([2])),
    png("IDAT", new Uint8Array([3])),
    png("fdAT", new Uint8Array([4])),
  ];
  const bytes = join([
    signature,
    png("IHDR", new Uint8Array(13)),
    ...frames,
    png("tEXt", enc("Comment\0private")),
    png("IEND"),
  ]);
  const result = pngChunks(
    new Uint8Array(await cleanPng(bytes, undefined, true).arrayBuffer()),
  );
  expect(result.slice(1, 5).map((c) => c.raw)).toEqual(frames);
  const icc = join([
    signature,
    png("IHDR"),
    png("iCCP", enc("profile")),
    png("IEND"),
  ]);
  expect(() => cleanPng(icc, undefined, true)).toThrow(/ICC/);
});
function riff(kind: string, p: Uint8Array) {
  const b = new Uint8Array(8 + p.length + (p.length & 1));
  b.set(enc(kind));
  new DataView(b.buffer).setUint32(4, p.length, true);
  b.set(p, 8);
  return b;
}
function webp(chunks: Uint8Array[]) {
  const b = join([enc("RIFF\0\0\0\0WEBP"), ...chunks]);
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  return b;
}
it("cleans WebP flags, nested frame metadata and padding without changing frames", async () => {
  const pixels = new Uint8Array([1, 2, 3]);
  const frameHeader = new Uint8Array(16);
  frameHeader[12] = 90;
  const bytes = webp([
    riff("VP8X", new Uint8Array([0x2e, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    riff("ANIM", new Uint8Array(6)),
    riff(
      "ANMF",
      join([frameHeader, riff("JUNK", enc("secret")), riff("VP8 ", pixels)]),
    ),
    riff("EXIF", enc("not-oriented")),
  ]);
  const output = new Uint8Array(await cleanWebp(bytes, true).arrayBuffer());
  const chunks = webpChunks(output);
  expect(chunks.map((c) => c.kind)).toEqual(["VP8X", "ANIM", "ANMF"]);
  expect(chunks[0]?.payload[0]).toBe(2);
  expect(chunks[2]?.payload).toEqual(join([frameHeader, riff("VP8 ", pixels)]));
  expect(new DataView(output.buffer).getUint32(4, true)).toBe(
    output.length - 8,
  );
  const icc = webp([riff("ICCP", enc("profile")), riff("VP8 ", pixels)]);
  expect(webpNeedsPixelTransform(webpChunks(icc))).toBe(true);
  expect(() => cleanWebp(icc, true)).toThrow(/ICC/);
});
it("tells animated images from still ones", async () => {
  const header = png("IHDR", new Uint8Array(13));
  const frame = riff("VP8 ", new Uint8Array(3));
  const images = [
    [join([signature, header, png("IDAT"), png("IEND")]), false],
    [
      join([
        signature,
        header,
        png("acTL", new Uint8Array(8)),
        png("IDAT"),
        png("IEND"),
      ]),
      true,
    ],
    [webp([frame]), false],
    [
      webp([
        riff("VP8X", new Uint8Array(10)),
        riff("ANIM", new Uint8Array(6)),
        riff("ANMF", join([new Uint8Array(16), frame])),
      ]),
      true,
    ],
    [enc("GIF89a"), true],
  ] as const;
  for (const [bytes, animated] of images)
    expect(await animatedImage(new Blob([bytes]))).toBe(animated);
});
it("preserves GIF loop, delay and image blocks but drops comment/trailer junk", async () => {
  const header = join([enc("GIF89a"), new Uint8Array([1, 0, 1, 0, 0, 0, 0])]);
  const loop = join([
    new Uint8Array([0x21, 0xff, 11]),
    enc("NETSCAPE2.0"),
    new Uint8Array([3, 1, 0, 0, 0]),
  ]);
  const frame = new Uint8Array([
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44,
    1, 0,
  ]);
  const clean = join([header, loop, frame, new Uint8Array([0x3b])]);
  const dirty = join([
    header,
    loop,
    new Uint8Array([0x21, 0xfe, 3, 65, 66, 67, 0]),
    frame,
    new Uint8Array([0x3b, 1, 2]),
  ]);
  expect(new Uint8Array(await cleanGif(dirty).arrayBuffer())).toEqual(clean);
  expect(() => cleanGif(dirty.subarray(0, 15))).toThrow(/malformed/);
});

it("avatar-purpose preparation removes nested snapshot metadata before upload", async () => {
  const bytes = join([
    signature,
    png("IHDR", new Uint8Array(13)),
    png("tEXt", enc("buzz_agent_snapshot\0NESTED_PRIVATE_MEMORY")),
    png("IDAT", new Uint8Array([1, 2])),
    png("IEND"),
  ]);
  const prepared = await prepareAttachment(
    new File([bytes], "avatar.png", { type: "image/png" }),
    new AbortController().signal,
    true,
  );
  const result = pngChunks(new Uint8Array(await prepared.arrayBuffer()));
  expect(result.map((chunk) => chunk.kind)).toEqual(["IHDR", "IDAT", "IEND"]);
  expect(result[1]?.payload).toEqual(new Uint8Array([1, 2]));
});
