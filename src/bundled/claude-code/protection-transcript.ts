import {
  jsonPieces,
  type TextSource,
} from "../../features/agent-protection/json-stream";
import type { ProcessProtection } from "../../features/host/service";
import type { Spawn } from "./claude";
import { protectionHistoryEntry, protectionSources } from "./security";
import reader from "./protection-transcript.py?raw";

/** A large transcript snapshot, replayable whole or one review phase at a time. */
export type TranscriptSource = TextSource & {
  dispose(): void;
  retain(): () => void;
  phase(kind: "context" | "tool-result"): TextSource;
};

/** Keeps one private native snapshot; each replay pulls one bounded chunk. */
export async function protectionTranscript(
  spawn: Spawn,
  cwd: string,
  path: string,
  signal: AbortSignal,
  protection: ProcessProtection,
): Promise<unknown[] | TranscriptSource> {
  signal.throwIfAborted();
  let output = "",
    error = "",
    stopped = false,
    next = 0;
  type Reply = { id: number; data: string; offset: number; done: boolean };
  let ready!: (size: number) => void, failed!: (error: unknown) => void;
  const initialized = new Promise<number>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  void initialized.catch(() => {});
  const pending = new Map<
    number,
    { resolve(value: Reply): void; reject(error: unknown): void }
  >();
  let process: Awaited<ReturnType<Spawn>> | undefined;
  const stop = (reason = new Error("Transcript reader stopped")) => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", abort);
    failed(reason);
    for (const call of pending.values()) call.reject(reason);
    pending.clear();
    void process?.kill();
  };
  const abort = () => stop(new Error("Transcript read cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    process = await spawn("transcript-protected", {
      cwd,
      args: [reader, path],
      protection,
      onStdout(data) {
        if (stopped) return;
        output += data;
        for (
          let end = output.indexOf("\n");
          end >= 0;
          end = output.indexOf("\n")
        ) {
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (
              Object.keys(value).join() === "bytes" &&
              Number.isSafeInteger(value.bytes) &&
              value.bytes >= 0
            )
              ready(value.bytes);
            else {
              const call = pending.get(value.id);
              if (!call) throw new Error("Unexpected transcript response");
              pending.delete(value.id);
              call.resolve(value);
            }
          } catch {
            stop(new Error("Invalid transcript response"));
          }
        }
        if (output.length > 90000)
          stop(new Error("Invalid transcript response"));
      },
      onStderr(data) {
        error = (error + data).slice(-2000);
      },
    });
    void process.exited.then(() =>
      stop(new Error(error.trim() || "Transcript reader stopped")),
    );
    if (stopped || signal.aborted) {
      await process.kill();
      signal.throwIfAborted();
      throw new Error("Transcript reader stopped");
    }
    const child = process;
    const size = await initialized;
    async function* readSnapshot() {
      let offset = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (;;) {
        signal.throwIfAborted();
        if (stopped) throw new Error("Transcript reader stopped");
        const id = next++;
        const answer = new Promise<Reply>((resolve, reject) =>
          pending.set(id, { resolve, reject }),
        );
        void answer.catch(() => {});
        await child.write(JSON.stringify({ id, offset }) + "\n");
        const value = await answer;
        const bytes = Uint8Array.from(atob(value.data), (char) =>
          char.charCodeAt(0),
        );
        if (
          bytes.length > 65536 ||
          value.offset !== offset + bytes.length ||
          value.offset > size ||
          value.done !== (value.offset === size) ||
          (!bytes.length && !value.done)
        )
          throw new Error("Invalid transcript section");
        offset = value.offset;
        const text = decoder.decode(bytes, { stream: true });
        if (text) yield text;
        if (value.done) {
          // The snapshot can end halfway through a scalar in Claude's last
          // unfinished record; complete records still require valid UTF-8.
          try {
            const tail = decoder.decode();
            if (tail) yield tail;
          } catch {
            /* Incomplete append. */
          }
          return;
        }
      }
    }
    // Project one native record at a time using the same source rules as small
    // histories. The runtime owns record parsing; transport never holds the
    // complete transcript and repeated tool catalogues do not reach reviewers.
    let readers = 0,
      retired = false;
    const retain = () => {
      if (stopped) throw new Error("Transcript reader stopped");
      readers++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        readers--;
        if (retired && !readers) stop();
      };
    };
    async function* records() {
      const release = retain();
      try {
        let line = "";
        for await (const part of readSnapshot()) {
          line += part;
          for (
            let end = line.indexOf("\n");
            end >= 0;
            end = line.indexOf("\n")
          ) {
            const row = line.slice(0, end);
            line = line.slice(end + 1);
            if (row.trim()) yield protectionHistoryEntry(JSON.parse(row));
          }
        }
        if (line.trim()) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return;
          } // Claude can still be appending its last record.
          yield protectionHistoryEntry(value);
        }
      } finally {
        release();
      }
    }
    const source: TranscriptSource = {
      retain,
      dispose: () => {
        retired = true;
        if (!readers) stop();
      },
      read: async function* () {
        for await (const record of records()) {
          yield* jsonPieces(record);
          yield "\n";
        }
      },
      // Routes each record's sources as a small history would, so a policy's
      // phases apply the same on both sides of the buffering threshold.
      phase: (kind) => ({
        read: async function* () {
          for await (const record of records())
            for (const input of protectionSources(record))
              if (input.kind === kind) {
                yield* jsonPieces(input.content);
                yield "\n";
              }
        },
      }),
    };
    // Small projected histories retain their per-message cache identities.
    // Crossing this buffering threshold selects replay, never rejects evidence.
    let text = "";
    for await (const part of source.read()) {
      text += part;
      if (text.length > 65536) return source;
    }
    try {
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } finally {
      source.dispose();
    }
  } catch (error) {
    stop();
    throw error;
  }
}
