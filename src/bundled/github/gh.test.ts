import { expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../../features/host/service";
import {
  GhUnavailable,
  GitHubError,
  gitHubCli,
  gitHubDiff,
  MAX_DIFF_CHARS,
  OutputTooLarge,
  parseAnswer,
} from "./gh";

type HostSpawn = NonNullable<Host["spawn"]>;

it("gives GitHub's data, GitHub's own error, or says gh is unavailable", () => {
  expect(parseAnswer('{"data":{"viewer":{"login":"baxen"}}}', "", 0)).toEqual({
    viewer: { login: "baxen" },
  });
  // gh exits 1 on a GraphQL error, but still prints the reason.
  const refused = () =>
    parseAnswer(
      '{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}',
      "gh: Could not resolve",
      1,
    );
  expect(refused).toThrow(GitHubError);
  expect(refused).toThrow(
    expect.objectContaining({
      type: "NOT_FOUND",
      message: "Could not resolve",
    }),
  );
  expect(() =>
    parseAnswer(
      "",
      "To get started with GitHub CLI, please run: gh auth login",
      4,
    ),
  ).toThrow(GhUnavailable);
  expect(() =>
    parseAnswer('{"message":"Bad credentials"}', "gh: HTTP 401", 1),
  ).toThrow(GhUnavailable);
  expect(() => parseAnswer('{"data":null}', "gh: HTTP 502", 1)).toThrow(
    new GitHubError("HTTP 502"),
  );
  // A gateway's error page in place of an answer, when GitHub's deadline
  // passed: GitHub failed, gh did not.
  const timedOut = () =>
    parseAnswer(
      "<html><head><title>504 Gateway Time-out</title></head></html>\n",
      "gh: HTTP 504",
      1,
    );
  expect(timedOut).toThrow(GitHubError);
  expect(timedOut).toThrow("HTTP 504");
  const failed = () =>
    parseAnswer('{"message":"Server Error"}', "gh: Server Error (HTTP 502)", 1);
  expect(failed).toThrow(GitHubError);
  expect(failed).toThrow("Server Error (HTTP 502)");
});

it("writes the request to gh and reads its answer, and has no client without processes", async () => {
  expect(gitHubCli({})).toBeUndefined();
  const writes: string[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number) => void;
    return {
      write: async () => {},
      end: async (data = "") => {
        writes.push(data);
        options?.onStdout?.('{"data":');
        options?.onStdout?.('{"ok":true}}');
        exit(0);
      },
      kill: vi.fn(async () => {}),
      exited: new Promise<number | null>((resolve) => {
        exit = resolve;
      }),
    };
  });
  const gh = gitHubCli({ spawn });
  expect(await gh?.("query{viewer{login}}", { a: 1 })).toEqual({ ok: true });
  expect(spawn).toHaveBeenCalledWith("graphql", expect.any(Object));
  expect(JSON.parse(writes[0] ?? "")).toEqual({
    query: "query{viewer{login}}",
    variables: { a: 1 },
  });
});

it("stops gh when the caller gives up", async () => {
  const kill = vi.fn(async () => {});
  let exit!: (code: number | null) => void;
  const spawn = vi.fn(async () => ({
    write: async () => {},
    end: async () => {},
    kill: vi.fn(async () => {
      await kill();
      exit(null);
    }),
    exited: new Promise<number | null>((resolve) => {
      exit = resolve;
    }),
  }));
  const controller = new AbortController();
  const answer = gitHubCli({ spawn })?.("query{}", {}, controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(answer).rejects.toThrow();
  expect(kill).toHaveBeenCalled();
});

it("stops gh at once when the caller gave up while it was starting", async () => {
  const kill = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  let started!: (process: Awaited<ReturnType<HostSpawn>>) => void;
  const spawn = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<HostSpawn>>>((resolve) => {
        started = resolve;
      }),
  );
  const controller = new AbortController();
  const answer = gitHubCli({ spawn })?.("query{}", {}, controller.signal);
  controller.abort();
  started({
    write: async () => {},
    end,
    kill,
    exited: new Promise<number | null>(() => {}),
  });
  await expect(answer).rejects.toThrow();
  expect(kill).toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it("treats a gh that cannot start as unavailable", async () => {
  const gh = gitHubCli({
    spawn: async () => {
      throw new Error("No such file");
    },
  });
  await expect(gh?.("query{}", {})).rejects.toThrow(GhUnavailable);
});

function diffSpawn(stdout: readonly string[], code: number, stderr = "") {
  const kill = vi.fn(async () => {});
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    kill.mockImplementation(async () => exit(null));
    return {
      write: async () => {},
      end: async () => {
        for (const piece of stdout) options?.onStdout?.(piece);
        if (stderr) options?.onStderr?.(stderr);
        exit(code);
      },
      kill,
      exited,
    };
  });
  return { spawn, kill };
}

it("reads the diff from the base branch to the head a review names", async () => {
  expect(gitHubDiff({})).toBeUndefined();
  const { spawn } = diffSpawn(["diff --git a/x b/x\n", "@@ -1 +1 @@\n"], 0);
  const diff = gitHubDiff({ spawn });
  expect(
    await diff?.({
      repository: "block/buzz",
      base: "release/1.0",
      head: "abc123",
    }),
  ).toBe("diff --git a/x b/x\n@@ -1 +1 @@\n");
  expect(spawn).toHaveBeenCalledWith("diff", {
    args: ["repos/block/buzz/compare/release/1.0...abc123"],
    onStdout: expect.any(Function),
    onStderr: expect.any(Function),
  });
  await expect(
    diff?.({ repository: "block/buzz", base: "main", head: "HEAD;rm" }),
  ).rejects.toThrow(GitHubError);
});

it("reads a merged pull request's own diff, since its head is in the base by then", async () => {
  const { spawn } = diffSpawn(["diff --git a/x b/x\n"], 0);
  const diff = gitHubDiff({ spawn });
  await diff?.({
    repository: "block/buzz",
    base: "main",
    head: "abc123",
    merged: 42,
  });
  expect(spawn).toHaveBeenCalledWith("diff", {
    args: ["repos/block/buzz/pulls/42"],
    onStdout: expect.any(Function),
    onStderr: expect.any(Function),
  });
  await expect(
    diff?.({
      repository: "block/buzz",
      base: "main",
      head: "abc123",
      merged: 0,
    }),
  ).rejects.toThrow(GitHubError);
});

it("gives GitHub's reason a diff was refused, and stops gh past the size the panel shows", async () => {
  const refused = gitHubDiff(
    diffSpawn(['{"message":"Not Found"}'], 1, "gh: Not Found (HTTP 404)"),
  );
  await expect(
    refused?.({ repository: "block/buzz", base: "main", head: "abc123" }),
  ).rejects.toThrow(new GitHubError("Not Found (HTTP 404)"));
  const escaped = gitHubDiff(
    diffSpawn(
      [],
      1,
      "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway",
    ),
  );
  await expect(
    escaped?.({ repository: "block/buzz", base: "main", head: "abc123" }),
  ).rejects.toThrow(GitHubError);
  const signedOut = gitHubDiff(diffSpawn([], 4, "gh auth login"));
  await expect(
    signedOut?.({ repository: "block/buzz", base: "main", head: "abc123" }),
  ).rejects.toThrow(GhUnavailable);
  const { spawn, kill } = diffSpawn(["x".repeat(MAX_DIFF_CHARS), "y"], 0);
  await expect(
    gitHubDiff({ spawn })?.({
      repository: "block/buzz",
      base: "main",
      head: "abc123",
    }),
  ).rejects.toThrow(OutputTooLarge);
  expect(kill).toHaveBeenCalled();
});
