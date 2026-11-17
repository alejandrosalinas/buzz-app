export type LoadFailure = "too-large" | "unavailable" | "not-text";

export class LoadError extends Error {
  constructor(readonly reason: LoadFailure) {
    super(reason);
  }
}

export async function readBytes(
  source: string,
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetcher(source, { signal }).catch((error) => {
    if (signal.aborted) throw error;
    throw new LoadError("unavailable");
  });
  if (!response.ok) throw new LoadError("unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new LoadError("too-large");
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > limit) throw new LoadError("too-large");
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new LoadError("too-large");
      chunks.push(value);
    }
  } finally {
    if (total > limit || signal.aborted) void reader.cancel().catch(() => {});
  }
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new LoadError("not-text");
  return new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
}
