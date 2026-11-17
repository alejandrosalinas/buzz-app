// GitHub through the person's own `gh` sign-in. The plugin never sees the
// token: each call starts `gh api graphql --hostname github.com --input -`
// (the manifest's `graphql` process; the hostname keeps an enterprise
// `GH_HOST` from answering for github.com links), writes the request to it and
// reads GitHub's answer back. A process rather than a host command because
// `gh` exits non-zero on a GraphQL error, and the answer it still prints is
// the only place the reason is.
import type { Host } from "../../features/host/service";

/** `gh` cannot be used here: no desktop, not installed, or not signed in. */
export class GhUnavailable extends Error {}
/** GitHub refused or failed the request; `type` is GitHub's, such as NOT_FOUND.
 * `data` is what GitHub still answered, as for the aliases it could read. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly type?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type GitHubCli = <T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

const DEADLINE_MS = 20_000;

type Spawn = NonNullable<Host["spawn"]>;
type Output = { stdout: string; stderr: string; code: number | null };

/** Runs one of the manifest's `gh` processes to its end. Past `maxOutput`
 * characters it stops `gh` and rejects with {@link OutputTooLarge}. */
async function runGh(
  spawn: Spawn,
  id: string,
  {
    args,
    input,
    signal,
    maxOutput = Number.POSITIVE_INFINITY,
  }: {
    args?: readonly string[];
    input?: string;
    signal?: AbortSignal | undefined;
    maxOutput?: number;
  },
): Promise<Output> {
  signal?.throwIfAborted();
  let stdout = "";
  let stderr = "";
  const overflow = new AbortController();
  let process: Awaited<ReturnType<Spawn>>;
  try {
    process = await spawn(id, {
      ...(args && { args }),
      onStdout: (data) => {
        stdout += data;
        if (stdout.length > maxOutput) overflow.abort(new OutputTooLarge());
      },
      onStderr: (data) => {
        stderr += data;
      },
    });
  } catch (error) {
    throw new GhUnavailable(
      error instanceof Error ? error.message : String(error),
    );
  }
  const limit = AbortSignal.timeout(DEADLINE_MS);
  const stop = () => void process.kill();
  const abort = AbortSignal.any(
    signal ? [signal, limit, overflow.signal] : [limit, overflow.signal],
  );
  abort.addEventListener("abort", stop, { once: true });
  try {
    // The caller may have given up while gh was starting.
    if (abort.aborted) {
      stop();
      abort.throwIfAborted();
    }
    await process.end(input);
    const code = await process.exited;
    abort.throwIfAborted();
    return { stdout, stderr, code };
  } finally {
    abort.removeEventListener("abort", stop);
  }
}

/** A GraphQL client for `host`, or undefined where processes cannot run. */
export function gitHubCli(host: Pick<Host, "spawn">): GitHubCli | undefined {
  const spawn = host.spawn?.bind(host);
  if (!spawn) return undefined;
  return async <T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    const { stdout, stderr, code } = await runGh(spawn, "graphql", {
      input: JSON.stringify({ query, variables }),
      signal,
    });
    return parseAnswer<T>(stdout, stderr, code);
  };
}

/** The diff is more than the panel shows. */
export class OutputTooLarge extends Error {
  constructor() {
    super("This diff is too large to show here.");
  }
}

/** A pull request's unified diff, as GitHub's Files changed tab shows it,
 * for exactly `head`. */
export type GitHubDiff = (
  pull: Readonly<{
    repository: string;
    base: string;
    head: string;
    /** A merged pull request's number. Its head is in the base by then, so
     * comparing the two would show nothing. */
    merged?: number | undefined;
  }>,
  signal?: AbortSignal,
) => Promise<string>;

/** About 20,000 lines: as far as the panel renders a diff. */
export const MAX_DIFF_CHARS = 1_000_000;

/** Reads diffs through the manifest's `diff` process, or undefined where
 * processes cannot run. Comparing the base branch with the head commit, not
 * the pull request, pins the diff to the head a review will name. */
export function gitHubDiff(host: Pick<Host, "spawn">): GitHubDiff | undefined {
  const spawn = host.spawn?.bind(host);
  if (!spawn) return undefined;
  return async ({ repository, base, head, merged }, signal) => {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !/^[0-9a-f]{1,64}$/i.test(head) ||
      (merged !== undefined && !(Number.isSafeInteger(merged) && merged > 0))
    )
      throw new GitHubError("Unsupported pull request");
    const range = `${base.split("/").map(encodeURIComponent).join("/")}...${head}`;
    const { stdout, stderr, code } = await runGh(spawn, "diff", {
      args: [
        merged === undefined
          ? `repos/${repository}/compare/${range}`
          : `repos/${repository}/pulls/${merged}`,
      ],
      signal,
      maxOutput: MAX_DIFF_CHARS,
    });
    if (code === 0) return stdout;
    const reason = stderr.trim().replace(/^gh: /, "");
    // gh refuses to print a response with a raw ESC byte. Its flag to allow
    // one is too new to rely on every installed gh having.
    if (/escape sequences/.test(reason))
      throw new GitHubError(
        "This diff contains terminal control characters, so it can’t be shown here.",
      );
    if (!stdout.trim()) throw new GhUnavailable(reason || "gh did not answer");
    throw new GitHubError(reason || "GitHub did not answer");
  };
}

/** GitHub's `data`, or the first error GitHub or `gh` gave. */
export function parseAnswer<T>(
  stdout: string,
  stderr: string,
  code: number | null,
): T {
  let answer:
    | { data?: T; errors?: { message?: unknown; type?: unknown }[] }
    | undefined;
  try {
    answer = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch {}
  const error = answer?.errors?.find(
    (item) => typeof item?.message === "string",
  );
  if (error)
    throw new GitHubError(
      error.message as string,
      typeof error.type === "string" ? error.type : undefined,
      answer?.data ?? undefined,
    );
  if (code === 0 && answer?.data) return answer.data;
  const reason = stderr.trim().replace(/^gh: /, "");
  // GitHub failed, as when a request outlasts its deadline and a gateway's
  // error page stands in for the answer (`HTTP 502`), or GitHub says why
  // (`Server Error (HTTP 502)`): gh itself works.
  if (/\bHTTP 5\d\d\b/.test(reason)) throw new GitHubError(reason);
  // No GraphQL answer: `gh` is missing, signed out or offline, or its
  // sign-in no longer works ("Bad credentials").
  if (!answer || !("data" in answer || "errors" in answer))
    throw new GhUnavailable(reason || "gh did not answer");
  throw new GitHubError(reason || "GitHub did not answer");
}
