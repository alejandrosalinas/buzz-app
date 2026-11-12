/** A replayable text source. Reading is pull-based; consumers own model capacity. */
export type TextSource = Readonly<{ read(): AsyncIterable<string> }>;
export type ReviewText = string | TextSource;
// Bounds each transport piece, never the complete evidence or prompt.
export const TEXT_CHUNK_UNITS = 16 * 1024;
export const isTextSource = (value: unknown): value is TextSource =>
  !!value &&
  typeof value === "object" &&
  typeof (value as TextSource).read === "function";

export function* textPieces(text: string) {
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + TEXT_CHUNK_UNITS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    yield text.slice(at, end);
    at = end;
  }
}

/** JSON encoding without constructing a second whole serialized payload. A
 * TextSource is a JSON string, escaped piece by piece. Inputs are JSON values;
 * sources must emit complete Unicode scalars, as TextDecoder's streaming mode does. */
export async function* jsonPieces(value: unknown): AsyncGenerator<string> {
  if (typeof value === "string" || isTextSource(value)) {
    yield '"';
    const parts = typeof value === "string" ? textPieces(value) : value.read();
    for await (const part of parts) {
      if (typeof part !== "string") throw new Error("Invalid text source");
      for (const piece of textPieces(part))
        yield JSON.stringify(piece).slice(1, -1);
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let i = 0; i < value.length; i++) {
      if (i) yield ",";
      yield* jsonPieces(value[i] ?? null);
    }
    yield "]";
  } else if (value && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (!first) yield ",";
      first = false;
      yield* jsonPieces(key);
      yield ":";
      yield* jsonPieces(item);
    }
    yield "}";
  } else {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("Evidence must be JSON serializable");
    yield encoded;
  }
}

/** Coalesce tiny JSON tokens into bounded writes. */
export async function* jsonLines(value: unknown): AsyncGenerator<string> {
  let buffered = "";
  for await (const part of jsonPieces(value)) {
    if (buffered.length + part.length > TEXT_CHUNK_UNITS && buffered) {
      yield buffered;
      buffered = "";
    }
    buffered += part;
  }
  if (buffered) yield buffered;
  yield "\n";
}

type Writer = {
  write(data: string): Promise<void>;
  writeStream?(data: AsyncIterable<string>): Promise<void>;
};
const containsSource = (value: unknown): boolean =>
  isTextSource(value) ||
  (!!value &&
    typeof value === "object" &&
    Object.values(value).some(containsSource));

export async function writeJSON(process: Writer, value: unknown) {
  if (!containsSource(value)) {
    await process.write(`${JSON.stringify(value)}\n`);
    return;
  }
  const parts = jsonLines(value);
  if (!process.writeStream)
    throw new Error("The process cannot accept streamed JSON");
  await process.writeStream(parts);
}

/** Own object snapshots while keeping trusted replay sources out of JSON cloning. */
export function snapshotJSON(value: unknown): unknown {
  if (isTextSource(value)) return { read: value.read.bind(value) };
  if (Array.isArray(value)) return value.map(snapshotJSON);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, snapshotJSON(item)]),
    );
  return value;
}
