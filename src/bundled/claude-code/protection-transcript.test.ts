import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { protectionTranscript } from "./protection-transcript";
import { protectionHistoryEntry, protectionSources } from "./security";
import { isTextSource } from "../../features/agent-protection/json-stream";
import type { Spawn } from "./claude";
const native: Spawn = async (id, options = {}) => {
  expect(id).toBe("transcript-protected");
  const child = spawn(
    "/usr/bin/python3",
    ["-IS", "-c", ...(options.args ?? [])],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout
    .setEncoding("utf8")
    .on("data", (data) => options.onStdout?.(data));
  child.stderr
    .setEncoding("utf8")
    .on("data", (data) => options.onStderr?.(data));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  return {
    write: async (data) => {
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      );
    },
    end: async () => {
      child.stdin.end();
    },
    kill: async () => {
      child.kill();
      await exited;
    },
    exited,
  };
};
it("replays an immutable transcript snapshot in bounded pieces", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-transcript-test-"));
  const path = join(root, "history.jsonl");
  const lifetime = new AbortController();
  const piece =
      JSON.stringify({ role: "user", content: "😀".repeat(16384) }) + "\n",
    expected = createHash("sha256");
  try {
    const file = await open(path, "w");
    // Several 64 KiB sections, past the threshold that selects replay.
    for (let i = 0; i < 8; i++) {
      await file.write(piece);
      expected.update(piece);
    }
    await file.close();
    const source = await protectionTranscript(
      native,
      root,
      path,
      lifetime.signal,
      { readOnlyPaths: [], hiddenPaths: [] },
    );
    expect(isTextSource(source)).toBe(true);
    if (!isTextSource(source)) throw new Error("Missing source");
    const retained = source as typeof source & {
      retain(): () => void;
      dispose(): void;
    };
    const release = retained.retain();
    retained.dispose(); // A newer hook replaces the current snapshot before this check reads it.
    await writeFile(path, "changed after snapshot");
    const digest = expected.digest("hex");
    for (let replay = 0; replay < 2; replay++) {
      const actual = createHash("sha256");
      let size = 0;
      for await (const part of source.read()) {
        expect(Buffer.byteLength(part)).toBeLessThanOrEqual(65536);
        actual.update(part);
        size += Buffer.byteLength(part);
      }
      expect(size).toBe(Buffer.byteLength(piece) * 8);
      expect(actual.digest("hex")).toBe(digest);
    }
    release();
    await expect(
      source.read()[Symbol.asyncIterator]().next(),
    ).rejects.toThrow();
  } finally {
    lifetime.abort();
    await rm(root, { recursive: true, force: true });
  }
});
it("streams each record under the phase a small history gives it", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-transcript-test-"));
  const path = join(root, "history.jsonl");
  const lifetime = new AbortController();
  const records = [
    { type: "user", message: { role: "user", content: "x".repeat(70000) } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    },
  ];
  try {
    await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n"));
    const source = await protectionTranscript(
      native,
      root,
      path,
      lifetime.signal,
      { readOnlyPaths: [], hiddenPaths: [] },
    );
    if (Array.isArray(source)) throw new Error("Expected a streamed history");
    const small = records.flatMap((record) =>
      protectionSources(protectionHistoryEntry(record)),
    );
    for (const kind of ["context", "tool-result"] as const) {
      let text = "";
      for await (const part of source.phase(kind).read()) text += part;
      const streamed = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const expected = small.filter((input) => input.kind === kind);
      expect(expected.length).toBeGreaterThan(0);
      expect(streamed).toEqual(expected.map((input) => input.content));
    }
    source.dispose();
  } finally {
    lifetime.abort();
    await rm(root, { recursive: true, force: true });
  }
});
it("retains ordinary small transcript projection and reports missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-transcript-test-"));
  const lifetime = new AbortController();
  try {
    const path = join(root, "history");
    await writeFile(
      path,
      '{"type":"user","message":{"role":"user","content":"hello"}}\n{"partial":',
    );
    expect(
      await protectionTranscript(native, root, path, lifetime.signal, {
        readOnlyPaths: [],
        hiddenPaths: [],
      }),
    ).toEqual([{ type: "user", message: { role: "user", content: "hello" } }]);
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from('{"role":"user","content":"hello"}\n{"content":"'),
        Buffer.from("😀").subarray(0, 2),
      ]),
    );
    expect(
      await protectionTranscript(native, root, path, lifetime.signal, {
        readOnlyPaths: [],
        hiddenPaths: [],
      }),
    ).toEqual([{ role: "user", content: "hello" }]);
    await expect(
      protectionTranscript(
        native,
        root,
        join(root, "missing"),
        lifetime.signal,
        { readOnlyPaths: [], hiddenPaths: [] },
      ),
    ).rejects.toThrow(/No such file/);
  } finally {
    lifetime.abort();
    await rm(root, { recursive: true, force: true });
  }
});
