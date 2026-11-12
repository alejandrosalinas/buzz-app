// @vitest-environment node
// Exact native CLI, local synthetic model responses, and real filesystem effects.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeProcess, type Spawn } from "./claude";
import type { ProtectionAction } from "../../features/agent-protection/service";

const binary = process.env.CLAUDE_PROTECTION_BIN;
it.skipIf(!binary)(
  "native Claude holds actions, denies writes and withholds denied model input",
  async () => {
    if (!binary)
      throw new Error("Set the pinned Claude runtime for this native fixture");
    const dir = await mkdtemp(join(tmpdir(), "buzz-claude-enforcement-"));
    const file = join(dir, "allowed.txt"),
      denied = join(dir, "denied.txt");
    let phase = "allow",
      calls = 0;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const toolEntered = new Promise<void>((r) => {
      entered = r;
    });
    let resumeEntered!: () => void, resumeRelease!: () => void;
    const resumedReview = new Promise<void>((r) => {
      resumeEntered = r;
    });
    const resumeHeld = new Promise<void>((r) => {
      resumeRelease = r;
    });
    const checks: ProtectionAction[] = [];
    const approvedInputs = new Set<string>();
    let promptAssessments = 0;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (req.url?.includes("count_tokens")) {
        res.end('{"input_tokens":1}');
        return;
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.end("{}");
        return;
      }
      const request = JSON.parse(raw);
      calls++;
      const output = request.messages?.some(
        (m: { content?: unknown }) =>
          Array.isArray(m.content) &&
          m.content.some((b: { type?: string }) => b.type === "tool_result"),
      );
      const command = phase.endsWith("output-deny")
        ? `printf '%s%s' RAW_ RESULT_7301${phase.startsWith("error") ? "; exit 3" : ""}`
        : `printf checked > ${JSON.stringify(phase === "allow" ? file : denied)}`;
      const content = output
        ? { type: "text", text: "done" }
        : {
            type: "tool_use",
            id: `call-${calls}`,
            name: "Bash",
            input: {
              command,
              description: "Run the authorized fixture command",
            },
          };
      res.setHeader("Content-Type", "text/event-stream");
      const emit = (event: Record<string, unknown>) =>
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({
        type: "message_start",
        message: {
          id: `msg-${calls}`,
          type: "message",
          role: "assistant",
          model: request.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      emit({
        type: "content_block_start",
        index: 0,
        content_block: output
          ? { type: "text", text: "" }
          : { ...content, input: {} },
      });
      emit({
        type: "content_block_delta",
        index: 0,
        delta: output
          ? { type: "text_delta", text: "done" }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(content.input),
            },
      });
      emit({ type: "content_block_stop", index: 0 });
      emit({
        type: "message_delta",
        delta: {
          stop_reason: output ? "end_turn" : "tool_use",
          stop_sequence: null,
        },
        usage: { output_tokens: 1 },
      });
      emit({ type: "message_stop" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    let stderr = "",
      stdout = "";
    const nativeSpawn: Spawn = async (id, options = {}) => {
      if (id === "platform") {
        options.onStdout?.("Darwin arm64\n");
        return {
          write: async () => {},
          end: async () => {},
          kill: async () => {},
          exited: Promise.resolve(0),
        };
      }
      const env = { ...process.env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === null) delete env[key];
        else env[key] = value;
      }
      const child = spawn(binary, options.args ?? [], {
        cwd: dir,
        env: {
          ...env,
          CLAUDE_CONFIG_DIR: dir,
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_AUTH_TOKEN: "fixture",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => {
        stdout = (stdout + data).slice(-12000);
        options.onStdout?.(String(data));
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4000);
        options.onStderr?.(String(data));
      });
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      );
      return {
        write: async (data) => {
          await new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (e) => (e ? reject(e) : resolve())),
          );
        },
        end: async () => {
          child.stdin.end();
        },
        kill: async () => {
          child.kill("SIGKILL");
        },
        exited,
      };
    };
    let optionalHookCalls = 0;
    const launch = {
      hook: async () => {
        optionalHookCalls++;
        return {};
      },
      cwd: dir,
      systemPrompt: "Do exactly the user's task.",
      model: "claude-sonnet-4-6",
      protection: {
        gate: {
          key: "fixture",
          stateKey: "fixture",
          processProtection: { readOnlyPaths: [], hiddenPaths: [] },
          spawn: async () => {
            throw new Error("Unused protected runtime");
          },
          assertAvailable() {},
          checkEvidence: async () => {
            throw new Error("Unexpected streamed check in this fixture");
          },
          async check(action: ProtectionAction, signal: AbortSignal) {
            checks.push(action);
            if (
              phase === "allow" &&
              action.kind !== "tool" &&
              JSON.stringify(action.content).includes(
                "Write the requested fixture file.",
              )
            ) {
              expect(action).toMatchObject({
                kind: "context",
                content: {
                  source: "message",
                  value: {
                    role: "user",
                    content: "Write the requested fixture file.",
                  },
                },
              });
              const key = JSON.stringify(action);
              if (!approvedInputs.has(key)) {
                approvedInputs.add(key);
                promptAssessments++;
              }
            }
            const input = action.content as {
              source?: string;
              value?: { prompt?: string };
            };
            const hook = input.source === "hook" ? input.value : undefined;
            if (hook)
              for (const key of [
                "session_id",
                "transcript_path",
                "cwd",
                "permission_mode",
                "hook_event_name",
              ])
                expect(hook).not.toHaveProperty(key);
            if (
              phase === "resume" &&
              input.source === "message" &&
              (input.value as { content?: unknown })?.content ===
                "Continue the reviewed conversation."
            ) {
              resumeEntered();
              await resumeHeld;
            }
            if (action.kind === "tool") {
              entered();
              if (phase === "allow") await held;
              else if (phase === "deny")
                throw new Error("Denied fixture write");
            }
            if (
              phase.endsWith("output-deny") &&
              action.kind === "tool-result" &&
              JSON.stringify(action.content).includes("RAW_RESULT_7301")
            )
              throw new Error("Denied raw output");
            if (phase === "input-deny") throw new Error("Denied model input");
            signal.throwIfAborted();
          },
        },
        history: async (path: string) =>
          (await readFile(path, "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
      },
    };
    const workers: ClaudeProcess[] = [];
    const start = async () => {
      const worker = await ClaudeProcess.start(nativeSpawn, launch);
      workers.push(worker);
      return worker;
    };
    const exists = (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      );
    try {
      const worker = await start();
      const turn = worker.send("Write the requested fixture file.");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        toolEntered,
        turn.then((result) => {
          throw new Error(
            `Turn ended before tool review: ${JSON.stringify(result)} ${stderr} ${stdout}`,
          );
        }),
        new Promise<never>((_r, reject) => {
          deadline = setTimeout(
            () =>
              reject(new Error(`Tool review not reached: ${stderr} ${stdout}`)),
            12_000,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      expect(await exists(file), stderr).toBe(false);
      release();
      expect(await turn, stderr).toEqual({ ok: true });
      expect(await readFile(file, "utf8")).toBe("checked");
      expect(promptAssessments).toBe(1);
      expect(
        checks.filter(
          (action) =>
            action.kind === "context" &&
            JSON.stringify(action.content).includes(
              "Write the requested fixture file.",
            ),
        ).length,
      ).toBeGreaterThan(1);
      expect(
        checks.some(
          (c) =>
            c.kind === "tool" &&
            JSON.stringify(c.content).includes(
              "Write the requested fixture file.",
            ),
        ),
      ).toBe(true);
      await worker.kill();
      await worker.exited;
      phase = "resume";
      if (!worker.sessionId)
        throw new Error("Claude did not report its native session");
      const resumedChecksStart = checks.length;
      const resumed = await ClaudeProcess.start(nativeSpawn, {
        ...launch,
        resume: worker.sessionId,
      });
      workers.push(resumed);
      const resumedTurn = resumed.send("Continue the reviewed conversation.");
      await Promise.race([
        resumedReview,
        resumedTurn.then(() => {
          throw new Error(
            `Resume did not hold input review: ${stderr} ${stdout}`,
          );
        }),
      ]);
      // Initialization returned before this hook, so its ACK deadline is gone.
      expect(resumed.running).toBe(true);
      const resumedEvidence = JSON.stringify(
        checks
          .slice(resumedChecksStart)
          .filter((action) => action.kind === "context"),
      );
      expect(resumedEvidence).toContain("Write the requested fixture file.");
      expect(resumedEvidence).toContain("Continue the reviewed conversation.");
      resumeRelease();
      expect(await resumedTurn, stderr).toEqual({ ok: true });
      phase = "deny";
      const second = await start();
      await second.send("Write the second fixture.");
      expect(await exists(denied)).toBe(false);
      for (const mode of ["output-deny", "error-output-deny"]) {
        phase = mode;
        const next = await start(),
          before = calls;
        expect(
          (await next.send("Run the authorized fixture command.")).ok,
        ).toBe(false);
        expect(calls).toBe(before + 1);
        expect(
          checks.some(
            (c) =>
              c.kind === "tool-result" &&
              JSON.stringify(c.content).includes("RAW_RESULT_7301"),
          ),
        ).toBe(true);
      }
      phase = "input-deny";
      const third = await start(),
        before = calls;
      await third.send("Blocked input.");
      expect(calls).toBe(before);
      expect(optionalHookCalls).toBe(0);
    } finally {
      release();
      resumeRelease();
      await Promise.all(
        workers.map(async (worker) => {
          await worker.kill();
          await worker.exited;
        }),
      );
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  40_000,
);
