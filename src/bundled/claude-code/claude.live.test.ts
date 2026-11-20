// @vitest-environment node
// Drives a real `claude` with the owner's sign-in: run with
// CLAUDE_LIVE_BIN=/path/to/claude. It spends a few small turns.
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeProcess, type Spawn } from "./claude";

const BIN = process.env.CLAUDE_LIVE_BIN;
/** Every line `claude` wrote, to check how a turn ended. */
const lines: string[] = [];

const spawn: Spawn = async (_id, options: HostProcessOptions = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild(BIN ?? "claude", options.args ?? [], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    lines.push(...data.split("\n").filter(Boolean));
    options.onStdout?.(data);
  });
  child.stderr
    .setEncoding("utf8")
    .on("data", (data: string) => options.onStderr?.(data));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    end: async (data) => {
      child.stdin.end(data);
    },
    kill: async () => {
      child.kill();
    },
    exited,
  };
};

describe.skipIf(!BIN)("claude", () => {
  it("sees a second conversation's message while the first task is open", {
    timeout: 120_000,
  }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "buzz-claude-steering-"));
    const release = join(cwd, "release");
    const started = join(cwd, "started");
    const claude = await ClaudeProcess.start(spawn, {
      cwd,
      model: "haiku",
      systemPrompt:
        "Follow the test instructions. A second user message can arrive while you work. Answer it immediately in a text block, then continue the first task until the file gate opens.",
    });
    const output = () =>
      lines
        .flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === "assistant"
              ? event.message.content
                  .filter((part: { type: string }) => part.type === "text")
                  .map((part: { text: string }) => part.text)
              : [];
          } catch {
            return [];
          }
        })
        .join("\n");
    try {
      const first = claude.send(
        `Channel request: use Bash to touch ${started}. Poll for ${release} with short Bash calls (sleep 1 then test -f). Only finish once it exists. Then say CHANNEL_DONE.`,
      );
      await expect
        .poll(() => existsSync(started), { timeout: 30_000 })
        .toBe(true);
      const second = claude.send(
        "Solo request: say SOLO_NOW in an intermediate text block and keep checking the channel task's gate afterward.",
      );
      await expect.poll(output, { timeout: 40_000 }).toContain("SOLO_NOW");
      expect(existsSync(release)).toBe(false);
      writeFileSync(release, "go");
      await expect(first).resolves.toMatchObject({ ok: true });
      await expect(second).resolves.toMatchObject({ ok: true });
      expect(output()).toContain("CHANNEL_DONE");
    } finally {
      writeFileSync(release, "go");
      await claude.kill();
    }
  });

  it("stops the running turn, and takes the next message", {
    timeout: 180_000,
  }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "buzz-claude-"));
    const claude = await ClaudeProcess.start(spawn, {
      cwd,
      systemPrompt: "Answer briefly.",
      model: "haiku",
    });
    try {
      const steps: string[] = [];
      const started = Date.now();
      const settled = claude.send(
        "Run the shell command `sleep 60` with the Bash tool, then say done.",
        { step: (tool) => steps.push(tool) },
      );
      await expect
        .poll(() => steps.includes("Bash"), { timeout: 60_000, interval: 200 })
        .toBe(true);
      await claude.interrupt();
      await expect(settled).resolves.toEqual({ ok: true, stopped: true });
      expect(Date.now() - started).toBeLessThan(55_000);
      expect(claude.busy).toBe(false);
      // Claude ends it as a failed execution, which is reported as stopped.
      expect(
        lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((message) => message.type === "result")
          .at(-1)?.terminal_reason,
      ).toBe("aborted_tools");
      await expect(claude.send("Say the word again.")).resolves.toEqual({
        ok: true,
      });
    } finally {
      await claude.kill();
    }
  });
});
