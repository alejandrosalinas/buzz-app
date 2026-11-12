import type { TextSource } from "./json-stream";

/** One pull-driven transfer. At most one chunk can wait for the consumer.
 * An acknowledgement means the consumer requested the next piece. */
export class EvidenceTransfer implements TextSource {
  private pending:
    | { data: string; resolve(): void; reject(error: unknown): void }
    | undefined;
  private wake?: () => void;
  private failure?: Error;
  private ended = false;
  private inFlight = false;
  private bytes = 0;
  private sequence = 0;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(readonly chunkBytes = 64 * 1024) {}
  fail(error: unknown) {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.pending?.reject(this.failure);
    this.pending = undefined;
    this.wake?.();
  }
  async push(sequence: number, data: Uint8Array) {
    if (this.failure) throw this.failure;
    if (
      this.ended ||
      this.inFlight ||
      sequence !== this.sequence ||
      !data.length ||
      data.length > this.chunkBytes
    )
      throw new Error("Invalid evidence chunk");
    this.inFlight = true;
    try {
      this.bytes += data.length;
      const text = this.decoder.decode(data, { stream: true });
      await new Promise<void>((resolve, reject) => {
        this.pending = { data: text, resolve, reject };
        this.wake?.();
      });
      this.sequence++;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
  finish(sequence: number, bytes: number) {
    if (this.failure) throw this.failure;
    if (
      this.ended ||
      this.inFlight ||
      sequence !== this.sequence ||
      bytes !== this.bytes
    )
      throw new Error("Incomplete evidence transfer");
    // Reject a truncated UTF-8 sequence before exposing EOF.
    this.decoder.decode();
    this.ended = true;
    this.wake?.();
  }
  async *read(): AsyncGenerator<string> {
    try {
      for (;;) {
        if (this.failure) throw this.failure;
        if (this.pending) {
          const item = this.pending;
          yield item.data;
          this.pending = undefined;
          item.resolve();
        } else if (this.ended) return;
        else
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
      }
    } finally {
      if (!this.ended || this.pending)
        this.fail(new Error("Evidence was not consumed completely"));
    }
  }
}
