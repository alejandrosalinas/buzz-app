// Every pull request the app reads: one store, and the only place that reads
// pull requests from GitHub. Links and the Solo sidebar, the panel, agents'
// watches and agents' own lookups each ask it for a level of detail; it reads
// each pull request once for all of them, at every level asked of it, and
// holds what it read only while someone still wants it. Links read issues'
// state from it too, the same way.
import { loadGitHubChecks, type CheckSummary } from "./checks";
import {
  GitHubRateLimited,
  loadGitHubDetails,
  type GitHubDetails,
} from "./data";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import {
  PANEL_PULL_FIELDS,
  PANEL_REPOSITORY_FIELDS,
  parsePull,
  type PullChecklist,
  type PullData,
} from "./pull";
import { parseGitHubReference } from "./references";

/** How often shown pull requests that can change are read again. */
export const PULL_REFRESH_MS = 60_000;
/** How often one open in the panel is, where someone decides on it. */
export const PANEL_REFRESH_MS = 30_000;
/** Without `gh`, GitHub allows 60 public reads an hour. A pull request that
 * could not be read is tried again this often, as is one read from the
 * public API, and a closed one, which rarely reopens. */
export const PULL_SLOW_REFRESH_MS = 5 * 60_000;
/** How many public reads can be spent at once, as on a channel of links
 * first shown; the rest wait their turn. */
export const PUBLIC_READS_PER_POLL = 10;
/** How many public reads an hour are spent after that, however many pull
 * requests are shown. No hour spends more than 40 of GitHub's 60, so the
 * panel keeps the rest. */
export const PUBLIC_READS_PER_HOUR = 30;
/** How often one of them is earned back. */
const PUBLIC_READ_EARNED_MS = (60 * 60_000) / PUBLIC_READS_PER_HOUR;
/** How long a pull request nobody shows or has asked for is kept. */
export const PULL_RETAIN_MS = 15 * 60_000;
/** The feedback text one read asks for at most, GitHub's limit for one
 * `nodes` lookup; the rest waits for the next. */
export const FEEDBACK_READ = 100;
/** Characters of each feedback body kept. */
export const BODY_CHARS = 1_000;

/** What a reader wants of a pull request. Every level has its state:
 * - `state`: its title, draft, merged or closed, checks and conflicts, as
 *   links show; the only level an issue has;
 * - `feedback`: its reviews and comments with their text, for agents'
 *   watches, read whether or not the window is visible;
 * - `details`: everything the panel shows and acts on: details, review,
 *   threads, merge state and what the viewer may do.
 * A pull request is read with every level its readers ask for. */
export type PullLevel = "state" | "feedback" | "details";

/** A review, inline comment or comment on a pull request. */
export type Feedback = Readonly<{
  /** `review/…`, `inline/…` or `comment/…`, then GitHub's node id. */
  id: string;
  author: string;
  /** Whether the author is a GitHub App, whose login GitHub gives without
   * `[bot]`. */
  bot?: true | undefined;
  url: string;
  /** Clipped to one more than BODY_CHARS. */
  body: string;
  /** A review's verdict, such as `CHANGES_REQUESTED`. */
  state?: string | undefined;
  /** The file an inline comment is on. */
  path?: string | undefined;
}>;

/** A pull request's details: what the panel shows and acts on. */
export type PullDetails = Readonly<{
  details: GitHubDetails;
  /** Read with `gh` only. */
  checklist?: PullChecklist | undefined;
  /** The head's checks, read from the public API without `gh`. */
  publicChecks?: CheckSummary | undefined;
  /** Read with `gh`, so with the person's own access. */
  signedIn: boolean;
}>;

export type PullState = Readonly<{
  /** An issue is only open or closed. */
  state: "open" | "draft" | "merged" | "closed";
  /** Why an issue was closed: completed, or not planned, as a duplicate is
   * too. */
  reason?: "completed" | "not planned" | undefined;
  /** Read with the state, so a renamed one is renamed where it is shown. */
  title?: string | undefined;
  /** The head commit's combined checks, when read with `gh`. */
  checks?: "success" | "failure" | "pending" | undefined;
  conflicts?: boolean | undefined;
  /** The head commit, when read with `gh`, as are `settled` and `failed`. */
  head?: string | undefined;
  /** Whether every check on the head is done, and none is still expected. */
  settled?: boolean | undefined;
  /** The names of the head's checks that failed. */
  failed?: readonly string[] | undefined;
  /** At `feedback`, with `gh`: the signed-in account, which agents use too,
   * every feedback id listed, newest reviews and comments, and the text of
   * those read so far. */
  feedback?:
    | Readonly<{
        viewer: string;
        ids: readonly string[];
        items: readonly Feedback[];
      }>
    | undefined;
  /** At `details`. */
  details?: PullDetails | undefined;
}>;

/** A pull request's latest state and when it was read, and why the last
 * read failed, when it did. */
export type PullRead = Readonly<{
  state: PullState | "failed";
  readAt: number;
  /** Why the last read failed, when it did: the state is then what was read
   * before, or `"failed"` when nothing was. */
  error?: Error | undefined;
}>;

/** How often a reader wants a pull request read again, given what the store
 * holds of it and when; Infinity for not again. The store reads one as often
 * as the most eager of its readers wants. */
export type Polling = (
  state: PullState | "failed" | undefined,
  when: Readonly<{
    /** The window is hidden. */
    hidden: boolean;
    /** It is read from the public API, within GitHub's limit. */
    public: boolean;
    /** GitHub could not read it, rather than answering for none. */
    failing: boolean;
  }>,
) => number;

const isState = (
  state: PullState | "failed" | undefined,
  ...names: PullState["state"][]
) => typeof state === "object" && names.includes(state.state);

/** Links and the Solo sidebar: every minute while the window is visible;
 * every few minutes for a closed one, issue or pull request, which rarely
 * reopens, one that could not be read, or one read from the public API;
 * never once merged. */
export const LINK_POLLING: Polling = (
  state,
  { hidden, public: publicly, failing },
) =>
  hidden || isState(state, "merged")
    ? Infinity
    : state === "failed" || failing || publicly || isState(state, "closed")
      ? PULL_SLOW_REFRESH_MS
      : PULL_REFRESH_MS;
/** The panel: twice a minute while the window is visible and it is open or a
 * draft, where someone decides on it. Not from the public API, whose hourly
 * limit that would spend in half an hour: there it is read when opened, and
 * when links read it. */
export const PANEL_POLLING: Polling = (state, { hidden, public: publicly }) =>
  !hidden && !publicly && isState(state, "open", "draft")
    ? PANEL_REFRESH_MS
    : Infinity;
/** An agent's watch: every minute, also while the window is hidden, until
 * the watch ends; while `gh` is unavailable only as often as `gh` is tried
 * again, since public data has no feedback. */
export const WATCH_POLLING: Polling = (_, { public: publicly }) =>
  publicly ? PULL_SLOW_REFRESH_MS : PULL_REFRESH_MS;
/** How each level's reader polls unless it says otherwise. */
const POLLING: Readonly<Record<PullLevel, Polling>> = {
  state: LINK_POLLING,
  feedback: WATCH_POLLING,
  details: PANEL_POLLING,
};

/** Which feedback a reader wants the text of, by id; by default all. A
 * watch wants only what it has not seen. */
export type WantsText = (id: string) => boolean;

export type PullStates = Readonly<{
  /** Keeps `url`'s state current at `level` while subscribed, read again as
   * often as `polling` wants, or its readers wanting it more often do; by
   * default as that level's reader polls. A level not held yet is read at
   * once. Feedback text is read only where some reader `wantsText`. A URL
   * that is not a pull request's, or at `state` an issue's, is not watched. */
  watch(
    url: string,
    listener: () => void,
    level?: PullLevel,
    options?: Readonly<{ polling?: Polling; wantsText?: WantsText }>,
  ): () => void;
  /** Its latest state, kept when a later read fails; `"failed"` when it was
   * never read or `url` is neither a pull request's nor an issue's, or
   * undefined before the first read. */
  get(url: string): PullState | "failed" | undefined;
  /** When its state was read, and why the last read failed, if it did. */
  readAt(url: string): Omit<PullRead, "state"> | undefined;
  /** Its state as read within `maxAge` ms at `level`: what is held, or else
   * read now with whatever else is due, shown or not. When it could not be
   * read again, what is held, with why. Throws when `url` is not a pull
   * request's, or at `state` an issue's, or it could not be read and nothing
   * is held. */
  read(
    url: string,
    options: {
      maxAge: number;
      level?: PullLevel;
      wantsText?: WantsText;
      /** Someone in the app asked for it and waits: it is read apart from
       * the links' public share, with its public checks, also while GitHub
       * holds public reads for its limit. */
      interactive?: boolean;
    },
  ): Promise<PullRead>;
}>;

type Rollup = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
type Node = Record<string, unknown>;
type Ids = { nodes?: ({ id?: string } | null)[] };
type StateData = {
  state: "OPEN" | "CLOSED" | "MERGED";
  title?: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  headRefOid?: string;
  commits?: {
    nodes?: ({
      commit?: {
        statusCheckRollup?: {
          state?: Rollup;
          contexts?: { totalCount?: number; nodes?: (Node | null)[] };
        } | null;
      };
    } | null)[];
  };
  reviews?: { nodes?: ({ id?: string; comments?: Ids } | null)[] };
  comments?: Ids;
};
type IssueData = {
  state: "OPEN" | "CLOSED";
  stateReason?: string | null;
  title?: string;
};
type RepositoryData =
  | (NonNullable<PullData["repository"]> & {
      pullRequest?: (StateData & Node) | null;
      issue?: IssueData | null;
    })
  | null;

const checksOf = (rollup: Rollup | undefined): PullState["checks"] =>
  rollup === "SUCCESS"
    ? "success"
    : rollup === "FAILURE" || rollup === "ERROR"
      ? "failure"
      : rollup
        ? "pending"
        : undefined;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

const STATE = `state title isDraft mergeStateStatus headRefOid
commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount nodes{
__typename
... on CheckRun{name status conclusion}
... on StatusContext{context state}}}}}}}`;
const ISSUE = "state stateReason title";
// Every inline comment, a reply on an old thread too, comes with a newly
// submitted review; pending ones are not yet sent.
const FEEDBACK = `reviews(last:50,states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){nodes{id comments(first:100){nodes{id}}}}
comments(last:50){nodes{id}}`;
const TEXT = `query($ids:[ID!]!){nodes(ids:$ids){__typename id
... on PullRequestReview{author{__typename login} state body url}
... on IssueComment{author{__typename login} body url}
... on PullRequestReviewComment{author{__typename login} body path url}}}`;

/** The feedback ids `pull` lists, reviews with their inline comments, then
 * comments. */
function idsOf(pull: StateData) {
  const ids = (list: Ids | undefined, kind: string) =>
    (list?.nodes ?? []).flatMap((node) =>
      node?.id ? [`${kind}/${node.id}`] : [],
    );
  return [
    ...(pull.reviews?.nodes ?? []).flatMap((review) =>
      review?.id
        ? [`review/${review.id}`, ...ids(review.comments, "inline")]
        : [],
    ),
    ...ids(pull.comments, "comment"),
  ];
}

/** The state in `pull`, an alias's answer, without its feedback or details. */
function stateOf(pull: StateData): PullState {
  const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contexts = (rollup?.contexts?.nodes ?? []).filter(
    (node): node is Node => !!node && typeof node === "object",
  );
  const checks = contexts.map((node) =>
    node.__typename === "StatusContext"
      ? {
          name: str(node.context),
          done: !["PENDING", "EXPECTED"].includes(str(node.state)),
          failed: FAILED.has(str(node.state)),
        }
      : {
          name: str(node.name),
          done: node.status === "COMPLETED",
          failed: FAILED.has(str(node.conclusion)),
        },
  );
  return {
    state:
      pull.state === "MERGED"
        ? "merged"
        : pull.state === "CLOSED"
          ? "closed"
          : pull.isDraft
            ? "draft"
            : "open",
    title: pull.title,
    checks: checksOf(rollup?.state),
    conflicts: pull.mergeStateStatus === "DIRTY",
    ...(pull.headRefOid && {
      head: pull.headRefOid,
      settled:
        checks.length > 0 &&
        checks.every((check) => check.done) &&
        // More than one page of checks, or ones still expected, are not all
        // here.
        rollup?.contexts?.totalCount === contexts.length &&
        !["PENDING", "EXPECTED"].includes(str(rollup?.state)),
      failed: checks
        .filter((check) => check.failed)
        .map((check) => check.name || "unnamed check"),
    }),
  };
}

/** An issue's state, as either API gives it: closed as completed when GitHub
 * gives no reason, as for one closed before it kept them. */
const issueOf = (
  closed: boolean,
  reason: string | null | undefined,
  title: string | undefined,
): PullState =>
  closed
    ? {
        state: "closed",
        reason: /^(?:not_planned|duplicate)$/i.test(reason ?? "")
          ? "not planned"
          : "completed",
        title,
      }
    : { state: "open", title };

const KINDS: Record<string, string> = {
  PullRequestReview: "review",
  IssueComment: "comment",
  PullRequestReviewComment: "inline",
};
const login = (node: Node) =>
  str((node.author as { login?: unknown } | null)?.login) || "ghost";

/** The feedback in a `nodes` answer, each body clipped. An empty COMMENTED
 * review, only its inline comments' wrapper, is given with no text so it is
 * known to have been read. */
export function parseFeedback(found: unknown): Feedback[] {
  if (!Array.isArray(found)) return [];
  return found.flatMap((node): Feedback[] => {
    if (!node || typeof node !== "object") return [];
    const item = node as Node;
    const kind = KINDS[str(item.__typename)];
    if (!kind) return [];
    const body = str(item.body);
    return [
      {
        id: `${kind}/${str(item.id)}`,
        author: login(item),
        ...((item.author as { __typename?: unknown } | null)?.__typename ===
        "Bot"
          ? { bot: true as const }
          : {}),
        url: str(item.url),
        body:
          body.length > BODY_CHARS + 1 ? body.slice(0, BODY_CHARS + 1) : body,
        ...(kind === "review" ? { state: str(item.state) } : {}),
        ...(kind === "inline" ? { path: str(item.path) } : {}),
      },
    ];
  });
}

/** What one read asks of each pull request. */
type Asked = Readonly<{
  feedback: boolean;
  details: boolean;
  /** Someone wants what the public API can read: its state or details. */
  publicly: boolean;
  /** Which public checks to read, at two or more requests each time: `again`
   * for a read someone in the app asked for; `missing`, for another read apart
   * from the links' share, when none are held for its head; `held` keeps only
   * those held for its head, so a read the links' share counts spends one. */
  checks: "again" | "missing" | "held";
  /** Whether a reader wants the text of feedback `id`. */
  wantsText: WantsText;
  /** The feedback held already, so only new text is read. */
  held: readonly Feedback[];
  /** Ids listed before, so text for what is new is read first. */
  listed: readonly string[];
}>;

/** All of `urls`, canonical pull request and issue URLs, in one GitHub
 * request, and the text of feedback not yet held in another: each one's
 * state, or an error for one GitHub could not read, as is an issue's URL
 * that numbers a pull request. Throws when it answered for none. */
async function readStates(
  gh: GitHubCli,
  urls: readonly string[],
  asks: (url: string) => Asked,
  signal: AbortSignal,
): Promise<(PullState | Error)[]> {
  const variables: Record<string, string | number> = {};
  const fields = urls.map((url, i) => {
    const reference = parseGitHubReference(url);
    const [owner = "", name = ""] = reference?.repository.split("/") ?? [];
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    variables[`p${i}`] = Number(url.split("/").at(-1));
    if (reference?.kind === "issue")
      return `r${i}:repository(owner:$o${i},name:$n${i}){issue(number:$p${i}){${ISSUE}}}`;
    const { feedback, details } = asks(url);
    return `r${i}:repository(owner:$o${i},name:$n${i}){${details ? PANEL_REPOSITORY_FIELDS : ""}
      pullRequest(number:$p${i}){${STATE}${feedback ? `\n${FEEDBACK}` : ""}${details ? `\n${PANEL_PULL_FIELDS}` : ""}}}`;
  });
  const declared = urls
    .map((_, i) => `$o${i}:String!,$n${i}:String!,$p${i}:Int!`)
    .join(",");
  const followed = urls.some((url) => asks(url).feedback);
  let data: Record<string, RepositoryData>;
  let failure: GitHubError | undefined;
  try {
    data = await gh<Record<string, RepositoryData>>(
      `query(${declared}){${followed ? "viewer{login}\n" : ""}${fields.join("\n")}}`,
      variables,
      signal,
    );
  } catch (error) {
    // A missing pull request is an error for its alias alone; GitHub still
    // answers the rest.
    if (!(error instanceof GitHubError) || typeof error.data !== "object")
      throw error;
    failure = error;
    data = error.data as Record<string, RepositoryData>;
  }
  const viewer = str((data as { viewer?: Node }).viewer?.login);
  const states = urls.map((url, i): PullState | Error => {
    const repository = data[`r${i}`];
    const issue = repository?.issue;
    if (issue)
      return issueOf(issue.state === "CLOSED", issue.stateReason, issue.title);
    const pull = repository?.pullRequest;
    if (!repository || !pull)
      return failure?.type === "NOT_FOUND" || !failure
        ? new Error(
            "GitHub couldn’t find this, or your GitHub account can’t see it.",
          )
        : new Error(failure.message);
    const state = stateOf(pull);
    const reference = parseGitHubReference(url);
    const { feedback, details, held } = asks(url);
    return {
      ...state,
      ...(feedback && {
        feedback: { viewer, ids: idsOf(pull), items: held },
      }),
      ...(details &&
        reference && {
          details: {
            ...parsePull({ repository } as PullData, reference),
            signedIn: true,
          },
        }),
    };
  });
  await readText(gh, urls, states, asks, signal);
  return states;
}

/** Reads the text of feedback listed in `states` and not yet held, new
 * since the last listing first. Text is read apart, so CI results still
 * arrive when it cannot be. */
async function readText(
  gh: GitHubCli,
  urls: readonly string[],
  states: (PullState | Error)[],
  asks: (url: string) => Asked,
  signal: AbortSignal,
) {
  const wanted: string[] = [];
  for (const [i, url] of urls.entries()) {
    const state = states[i];
    if (!state || state instanceof Error || !state.feedback) continue;
    const { held, listed, wantsText } = asks(url);
    const have = new Set(held.map((item) => item.id));
    const before = new Set(listed);
    const missing = state.feedback.ids.filter(
      (id) => !have.has(id) && wantsText(id),
    );
    wanted.push(
      ...missing.filter((id) => !before.has(id)),
      ...missing.filter((id) => before.has(id)).reverse(),
    );
  }
  const asking = wanted.slice(0, FEEDBACK_READ);
  if (!asking.length) return;
  let found: Feedback[];
  try {
    const answer = await gh<{ nodes?: unknown }>(
      TEXT,
      { ids: asking.map((id) => id.slice(id.indexOf("/") + 1)) },
      signal,
    );
    found = parseFeedback(answer.nodes);
  } catch {
    return;
  }
  const text = new Map(found.map((item) => [item.id, item]));
  for (const [i, state] of states.entries()) {
    if (state instanceof Error || !state.feedback) continue;
    const listed = new Set(state.feedback.ids);
    const items = [
      ...state.feedback.items.filter((item) => listed.has(item.id)),
      ...state.feedback.ids.flatMap((id) => {
        const item = text.get(id);
        return item ? [item] : [];
      }),
    ];
    states[i] = { ...state, feedback: { ...state.feedback, items } };
  }
}

/** `url` from the public API, with its details when `withDetails`, and its
 * public checks as `checks` says. An issue's URL that numbers a pull request
 * is not read as either. */
async function readPublicState(
  url: string,
  withDetails: boolean,
  checks: Asked["checks"],
  held: PullDetails | undefined,
  signal: AbortSignal,
): Promise<PullState> {
  const reference = parseGitHubReference(url);
  if (!reference) throw new Error("Not a GitHub pull request URL");
  const details = await loadGitHubDetails(reference, signal);
  if (reference.kind === "issue") {
    if (details.pullRequest)
      throw new Error(
        "GitHub has a pull request, not an issue, at this number.",
      );
    return issueOf(
      details.state === "closed",
      details.stateReason,
      details.title,
    );
  }
  const sha = details.headSha;
  return {
    state:
      details.state === "Merged"
        ? "merged"
        : details.state === "closed"
          ? "closed"
          : details.state === "Draft"
            ? "draft"
            : "open",
    title: details.title,
    ...(withDetails && {
      details: {
        details,
        signedIn: false,
        publicChecks: !sha
          ? undefined
          : checks !== "again" &&
              held?.publicChecks &&
              !held.signedIn &&
              held.details.headSha === sha
            ? held.publicChecks
            : checks === "held"
              ? undefined
              : await loadGitHubChecks(reference.repository, sha, signal),
      },
    }),
  };
}

const sameList = (a?: readonly string[], b?: readonly string[]) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((item, i) => item === b[i]));
/** Whether `b`, read now, is what `a` already shows. */
const same = (a: PullState | "failed" | undefined, b: PullState | "failed") =>
  a === b ||
  (typeof a === "object" &&
    typeof b === "object" &&
    a.state === b.state &&
    a.reason === b.reason &&
    a.title === b.title &&
    a.checks === b.checks &&
    a.conflicts === b.conflicts &&
    a.head === b.head &&
    a.settled === b.settled &&
    sameList(a.failed, b.failed) &&
    JSON.stringify(a.feedback) === JSON.stringify(b.feedback) &&
    JSON.stringify(a.details) === JSON.stringify(b.details));

/** Whether `state` has what `level` asks for. */
const holds = (state: PullState | "failed" | undefined, level: PullLevel) =>
  !!state &&
  (state === "failed" ||
    level === "state" ||
    (level === "feedback" ? !!state.feedback : !!state.details));

/** The pull request `url` names, as the store keys it: its canonical URL, so
 * a link pasted with a query string or trailing slash shares the entry, and
 * the read, of the plain one. Undefined for a URL that is not a pull request's,
 * or an issue's at `state`, the only level an issue has; an issue and a pull
 * request with one number keep their own. */
/** GitHub names are not case-sensitive, so one key holds every casing a
 * link, the panel or a watch gives. */
const keyOf = (url: string, level: PullLevel = "state") => {
  const reference = parseGitHubReference(url);
  return reference?.kind === "pull" ||
    (reference?.kind === "issue" && level === "state")
    ? reference.url.toLowerCase()
    : undefined;
};

type Listener = Readonly<{
  notify: () => void;
  level: PullLevel;
  polling: Polling;
  wantsText: WantsText;
}>;
const allText: WantsText = () => true;

/** The app's pull request store, read with `gh` when there is one.
 *
 * Every pull request that is due is read in one request, once for every
 * reader that appears together, at every level its readers ask for. Each
 * watched one is due when the most eager of its readers' `Polling` says,
 * after it was last polled; only those watched are polled. Without `gh`, or
 * while it is unavailable, they are read from the public API within its own
 * share of GitHub's limit, the longest unpolled first; the panel's reads are
 * not counted against it. While GitHub holds that limit only the panel's own
 * reads try it.
 *
 * A read asked for joins the next one, shown or not, unless what is held is
 * recent enough. What a level adds is held while someone asks for it; a pull
 * request nobody watches or asks for is forgotten after a while. */
export function createPullStates(gh: GitHubCli | undefined): PullStates {
  const listeners = new Map<string, Set<Listener>>();
  const states = new Map<string, PullState | "failed">();
  /** Why each that could not be read last time could not. */
  const errors = new Map<string, Error>();
  /** Those GitHub could not read, while it answered for others. */
  const unreadable = new Set<string>();
  /** When each state held was read. */
  const readAt = new Map<string, number>();
  /** When each was last polled, read or not, so it is due again its
   * readers' interval after, and a public poll takes the longest unpolled. */
  const polledAt = new Map<string, number>();
  /** Not polled again before then: after GitHub answered for none, or while
   * a public read is not yet earned. */
  const notBefore = new Map<string, number>();
  /** Those to read at once, for a level they do not hold yet. */
  const needed = new Set<string>();
  /** The reads readers wait for, by pull request. */
  const requests = new Map<
    string,
    {
      levels: Set<PullLevel>;
      /** Whose feedback text the feedback readers waiting want. */
      wantsText: WantsText[];
      /** Whether someone in the app asked for it. */
      interactive: boolean;
      waiting: {
        resolve: (read: PullRead) => void;
        reject: (error: unknown) => void;
      }[];
    }
  >();
  /** Until when to read public data instead, after `gh` was unavailable. */
  let publicUntil = 0;
  const readsPublic = () => !gh || Date.now() < publicUntil;
  /** Until when GitHub refuses public reads, once it has refused one. */
  let publicHeldUntil = 0;
  /** The public reads that can be spent now, and up to when they were
   * earned. */
  let publicReads = PUBLIC_READS_PER_POLL;
  let publicEarnedTo = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let scheduled = false;
  /** How many pull requests readers asked for the read in flight has. */
  let asking = 0;
  /** Tells whoever watches `urls` that their states were recorded. */
  const notify = (urls: readonly string[]) => {
    // One reader that throws neither fails the read nor keeps it from
    // the rest.
    for (const url of urls)
      for (const listener of listeners.get(url) ?? [])
        try {
          listener.notify();
        } catch (error) {
          console.warn("A pull request reader failed", error);
        }
  };
  const watchedAt = (url: string, level: PullLevel) =>
    [...(listeners.get(url) ?? [])].some(
      (listener) => listener.level === level,
    );
  /** How often `url`'s readers want it read now: the most often any does. */
  const interval = (url: string) => {
    const state = states.get(url);
    const when = {
      hidden: document.visibilityState !== "visible",
      public: readsPublic(),
      failing: unreadable.has(url),
    };
    return Math.min(
      ...[...(listeners.get(url) ?? [])].map(({ polling }) =>
        polling(state, when),
      ),
    );
  };
  /** When watched `url` is next due: at once when never polled or lacking a
   * level, else its readers' interval after it was last polled. */
  const dueAt = (url: string) => {
    const polled = polledAt.get(url);
    return Math.max(
      polled === undefined || needed.has(url) ? 0 : polled + interval(url),
      notBefore.get(url) ?? 0,
    );
  };
  /** The details held of `url`, as the panel shows them. */
  const held = (url: string) => {
    const state = states.get(url);
    return typeof state === "object" ? state.details : undefined;
  };
  /** Forgets the pull requests nobody has watched or asked for in a while. */
  const forget = (now: number) => {
    for (const url of new Set([...polledAt.keys(), ...states.keys()]))
      if (
        !listeners.has(url) &&
        !requests.has(url) &&
        (polledAt.get(url) ?? 0) <= now - PULL_RETAIN_MS
      ) {
        states.delete(url);
        errors.delete(url);
        unreadable.delete(url);
        readAt.delete(url);
        polledAt.delete(url);
        notBefore.delete(url);
        needed.delete(url);
      }
  };
  /** The next poll, when a watched pull request is next due. Public reads
   * wait out GitHub's limit, or until `gh` is tried again, whichever is
   * first. */
  const later = () => {
    clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    const due = Math.min(...[...listeners.keys()].map(dueAt));
    if (due === Infinity) return;
    const held = readsPublic()
      ? Math.min(publicHeldUntil, gh ? publicUntil : Infinity)
      : 0;
    timer = setTimeout(
      () => void refresh(),
      Math.max(due - now, held - now, 0),
    );
  };
  /** Hidden or shown, what readers want read changes. */
  const returned = () => {
    if (!controller) later();
  };
  /** Reads every watched pull request that is due, and those readers asked
   * for. A read in flight is left to finish; it picks up what became due
   * meanwhile. */
  async function refresh() {
    if (controller) return;
    const current = new AbortController();
    controller = current;
    clearTimeout(timer);
    timer = undefined;
    const signal = AbortSignal.any([
      current.signal,
      AbortSignal.timeout(30_000),
    ]);
    const now = Date.now();
    forget(now);
    const asked = new Map(requests);
    requests.clear();
    asking = asked.size;
    // A read someone waits for tries gh again; polls wait for its retry.
    if (asked.size) publicUntil = 0;
    // Public reads cannot stand in for feedback, which needs gh.
    if (readsPublic())
      for (const [url, request] of asked)
        if (
          request.levels.size === 1 &&
          request.levels.has("feedback") &&
          !listeners.has(url)
        ) {
          asked.delete(url);
          for (const { reject } of request.waiting)
            reject(new GhUnavailable("Reading feedback needs gh"));
        }
    // A public poll reads only as many as it can spend: those asked for go
    // first, then the longest unpolled, so those that keep failing cannot
    // keep one never read waiting.
    const due = [
      ...asked.keys(),
      ...[...listeners.keys()]
        .filter((url) => !asked.has(url) && dueAt(url) <= now)
        .sort((a, b) => (polledAt.get(a) ?? 0) - (polledAt.get(b) ?? 0)),
    ];
    const at = (url: string, level: PullLevel) =>
      !!asked.get(url)?.levels.has(level) || watchedAt(url, level);
    const interactive = (url: string) => !!asked.get(url)?.interactive;
    // Reads someone in the app asked for are their own, not the links'
    // share, and so are an open panel's polls; an agent's lookup is not.
    const own = (url: string) =>
      asked.has(url) ? interactive(url) : watchedAt(url, "details");
    // What each is asked for is fixed when the read starts, so what is parsed
    // is what was queried; a level asked for meanwhile is read next.
    const plan = new Map<string, Asked>();
    const asks = (url: string): Asked => {
      const planned = plan.get(url);
      if (planned) return planned;
      const held = states.get(url);
      const feedback = typeof held === "object" ? held.feedback : undefined;
      const asking: Asked = {
        feedback: at(url, "feedback"),
        details: at(url, "details"),
        publicly: at(url, "state") || at(url, "details"),
        checks: interactive(url) ? "again" : own(url) ? "missing" : "held",
        wantsText: (id) =>
          [
            ...[...(listeners.get(url) ?? [])]
              .filter((listener) => listener.level === "feedback")
              .map((listener) => listener.wantsText),
            ...(asked.get(url)?.wantsText ?? []),
          ].some((wants) => wants(id)),
        held: feedback?.items ?? [],
        listed: feedback?.ids ?? [],
      };
      plan.set(url, asking);
      return asking;
    };
    const free = due.filter(own).length;
    // While GitHub holds public reads for its limit, only reads someone in
    // the app asked for try it again.
    const reading =
      readsPublic() && now < publicHeldUntil ? due.filter(interactive) : due;
    /** Whether this read asked for every level its readers want; a level
     * asked for once it started is read next. */
    const plannedAll = (url: string) => {
      const planned = asks(url);
      return [...(listeners.get(url) ?? [])].every(
        ({ level }) => level === "state" || planned[level],
      );
    };
    /** Why a reader's read not answered was not. */
    let reason: unknown = new Error("The read was given up on");
    try {
      if (!reading.length) {
        if (due.length) reason = new GitHubRateLimited(publicHeldUntil);
        return;
      }
      for (const url of reading) asks(url);
      const found = await readAll(
        // Their own first, so they are the free ones.
        reading.sort((a, b) => Number(own(b)) - Number(own(a))),
        asks,
        Math.min(free, reading.length),
        signal,
      );
      // One that timed out still records what it read, and what it could not.
      if (current.signal.aborted) return;
      const changed: string[] = [];
      for (const [i, url] of reading.entries()) {
        // Those a public poll could not afford wait for the next read earned,
        // all together, so the longest unread of them takes it whenever each
        // was shown. One GitHub holds waits for the hold.
        if (found[i] === undefined) {
          notBefore.set(url, publicEarnedTo + PUBLIC_READ_EARNED_MS);
          continue;
        }
        const result = found[i];
        const error =
          result instanceof Error
            ? result
            : !result
              ? new Error("GitHub did not answer")
              : undefined;
        const prior = states.get(url);
        // A failed read keeps what was last read, and when, with why it
        // failed: readers show the latest data the store has.
        const state = !error
          ? (result as PullState)
          : typeof prior === "object"
            ? prior
            : "failed";
        if (!error || state === "failed") readAt.set(url, now);
        polledAt.set(url, now);
        notBefore.delete(url);
        if (plannedAll(url)) needed.delete(url);
        if (error) {
          errors.set(url, error);
          unreadable.add(url);
        } else {
          errors.delete(url);
          unreadable.delete(url);
        }
        const at = readAt.get(url) ?? now;
        for (const { resolve } of asked.get(url)?.waiting ?? [])
          resolve({ state, readAt: at, error });
        asked.delete(url);
        // An unchanged state keeps its object, so whoever shows it is left be.
        if (same(states.get(url), state)) continue;
        states.set(url, state);
        changed.push(url);
      }
      notify(changed);
      reason = new GitHubRateLimited(publicEarnedTo + PUBLIC_READ_EARNED_MS);
    } catch (error) {
      reason = error;
      // GitHub answered for none, not in time, or refused for its limit: keep
      // what is held, with why, and read again as its readers want; public
      // reads wait for the limit to lift.
      if (current.signal.aborted) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const url of reading) {
        errors.set(url, failure);
        polledAt.set(url, now);
        if (plannedAll(url)) needed.delete(url);
      }
    } finally {
      // A reader not answered gets what is held, with why it was not read
      // again; only one with nothing held is refused.
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      for (const [url, request] of asked) {
        const state = states.get(url);
        const at = readAt.get(url);
        for (const { resolve, reject } of request.waiting)
          if (typeof state === "object" && at !== undefined)
            resolve({ state, readAt: at, error });
          else reject(reason);
      }
      if (controller === current) {
        asking = 0;
        controller = undefined;
        if (requests.size) schedule();
        else if (listeners.size) later();
      }
    }
  }
  /** Reads `urls`, or from the public API the first `free` of them and as
   * many more as can be spent: each one's state, or an error for one GitHub
   * could not read. Throws when it answered for none, or refused a public
   * read for its limit. */
  async function readAll(
    urls: readonly string[],
    asks: (url: string) => Asked,
    free: number,
    signal: AbortSignal,
  ): Promise<readonly (PullState | Error | undefined)[]> {
    let publicly = urls;
    if (gh && !readsPublic())
      try {
        return await readStates(gh, urls, asks, signal);
      } catch (error) {
        // Offline or signed out for now; gh is tried again next public read.
        if (!(error instanceof GhUnavailable)) throw error;
        publicUntil = Date.now() + PULL_SLOW_REFRESH_MS;
        // GitHub may still be refusing public reads from the last time: only
        // those someone in the app asked for try it.
        if (Date.now() < publicHeldUntil)
          publicly = urls.filter((url) => asks(url).checks === "again");
      }
    // Whole reads only, so nothing drifts; a clock set back earns none, and
    // its time is earned again once the clock passes where it was.
    const earned = Math.floor(
      Math.max(0, Date.now() - publicEarnedTo) / PUBLIC_READ_EARNED_MS,
    );
    publicReads = Math.min(PUBLIC_READS_PER_POLL, publicReads + earned);
    publicEarnedTo += earned * PUBLIC_READ_EARNED_MS;
    // Public data has no feedback, so a read for feedback alone is not spent.
    const reading = publicly
      .filter((url) => asks(url).publicly)
      .slice(0, free + publicReads);
    publicReads -= reading.length - Math.min(free, reading.length);
    const read = await Promise.all(
      reading.map((url) =>
        readPublicState(
          url,
          asks(url).details,
          asks(url).checks,
          held(url),
          signal,
        ).catch((error: unknown) => {
          if (!(error instanceof GitHubRateLimited))
            return error instanceof Error ? error : new Error(String(error));
          // Over the limit: nothing more is read until GitHub says it resets.
          publicHeldUntil = Math.max(publicHeldUntil, error.resetAt);
          throw error;
        }),
      ),
    );
    return urls.map((url) =>
      asks(url).publicly
        ? read[reading.indexOf(url)]
        : new GhUnavailable("Reading feedback needs gh"),
    );
  }
  /** Reads soon, once for every reader that starts together. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (listeners.size || requests.size) void refresh();
    });
  }
  return {
    watch(raw, notify, level = "state", options = {}) {
      const url = keyOf(raw, level);
      if (!url) return () => {};
      const listener = {
        notify,
        level,
        polling: options.polling ?? POLLING[level],
        wantsText: options.wantsText ?? allText,
      };
      let set = listeners.get(url);
      if (!set) {
        set = new Set();
        if (!listeners.size)
          document.addEventListener("visibilitychange", returned);
        listeners.set(url, set);
      }
      set.add(listener);
      // What was polled within its readers' interval is kept, unless it lacks
      // what this level adds.
      if (!holds(states.get(url), level)) needed.add(url);
      if (dueAt(url) <= Date.now()) schedule();
      else if (!controller) later();
      return () => {
        set.delete(listener);
        if (set.size) return;
        listeners.delete(url);
        if (listeners.size) return;
        document.removeEventListener("visibilitychange", returned);
        clearTimeout(timer);
        timer = undefined;
        // A reader's read in flight still wants its answer.
        if (requests.size || asking) return;
        controller?.abort();
        controller = undefined;
      };
    },
    get(url) {
      const key = keyOf(url);
      return key ? states.get(key) : "failed";
    },
    readAt(url) {
      const key = keyOf(url);
      const at = key ? readAt.get(key) : undefined;
      return key && at !== undefined
        ? { readAt: at, error: errors.get(key) }
        : undefined;
    },
    read(
      raw,
      { maxAge, level = "state", wantsText = allText, interactive = false },
    ) {
      const url = keyOf(raw, level);
      if (!url)
        return Promise.reject(new Error("Not a GitHub pull request URL"));
      const state = states.get(url);
      const at = readAt.get(url);
      if (
        state &&
        at !== undefined &&
        Date.now() - at < maxAge &&
        holds(state, level)
      )
        return Promise.resolve({ state, readAt: at, error: errors.get(url) });
      return new Promise((resolve, reject) => {
        let request = requests.get(url);
        if (!request) {
          request = {
            levels: new Set(),
            wantsText: [],
            interactive: false,
            waiting: [],
          };
          requests.set(url, request);
        }
        request.levels.add(level);
        request.interactive ||= interactive;
        if (level === "feedback") request.wantsText.push(wantsText);
        request.waiting.push({ resolve, reject });
        schedule();
      });
    },
  };
}
