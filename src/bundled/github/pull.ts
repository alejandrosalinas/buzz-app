// A pull request as one checklist, read and changed through `gh`: the state
// someone needs to decide whether to merge, without the comments and logs
// their agents read for them.
import {
  summarizeRollup,
  type CheckSummary,
  type RollupContext,
} from "./checks";
import { branchLink, type GitHubDetails } from "./data";
import type { GitHubCli } from "./gh";
import type { GitHubReference } from "./references";

export type MergeMethod = "SQUASH" | "MERGE" | "REBASE";
export const mergeLabels: Record<MergeMethod, string> = {
  SQUASH: "Squash and merge",
  MERGE: "Create a merge commit",
  REBASE: "Rebase and merge",
};

export type PullChecklist = Readonly<{
  /** GitHub's node id, which every change names. */
  id: string;
  head: string;
  base: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: CheckSummary;
  review: Readonly<{
    decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    approved: readonly string[];
    changes: readonly string[];
    waiting: readonly string[];
  }>;
  /** Unresolved review threads among the latest 100. */
  unresolved: number;
  /** Older threads beyond those 100 went unread. */
  moreThreads: boolean;
  /** GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, … */
  merge: string;
  canUpdate: boolean;
  canUpdateBranch: boolean;
  /** The viewer opened it, so GitHub only lets them comment on it. */
  authored: boolean;
  /** The viewer may merge past branch rules. */
  canBypass: boolean;
  /** The target branch requires GitHub’s merge queue. */
  queueRequired: boolean;
  queued: boolean;
  methods: readonly MergeMethod[];
  method: MergeMethod;
  canEnableAutoMerge: boolean;
  canDisableAutoMerge: boolean;
  autoMerge?:
    | Readonly<{ method: MergeMethod; by?: string | undefined }>
    | undefined;
}>;

export type PullView = Readonly<{
  details: GitHubDetails;
  checklist: PullChecklist;
}>;

/** What the panel reads of a pull request's repository, beside the pull
 * request, in the store's query. */
export const PANEL_REPOSITORY_FIELDS =
  "viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed";
/** What the panel reads of the pull request itself. */
export const PANEL_PULL_FIELDS = `id title body bodyHTML createdAt updatedAt mergedAt
      author{login avatarUrl} mergedBy{login}
      baseRefName headRefName
      headRepository{nameWithOwner} headRepositoryOwner{login} baseRepository{nameWithOwner}
      additions deletions changedFiles
      reviewDecision viewerDidAuthor viewerCanUpdate viewerCanUpdateBranch viewerCanMergeAsAdmin
      isMergeQueueEnabled isInMergeQueue
      viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      autoMergeRequest{mergeMethod enabledBy{login}}
      reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login} ... on Team{name} ... on Bot{login} ... on Mannequin{login}}}}
      latestOpinionatedReviews(first:50){nodes{author{login} state}}
      reviewThreads(last:100){totalCount nodes{isResolved}}
      commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){totalCount nodes{__typename
        ... on CheckRun{name status conclusion detailsUrl title}
        ... on StatusContext{context state description targetUrl}}}}}}}`;

type Login = { login?: string } | null | undefined;
export type PullData = {
  repository: {
    viewerDefaultMergeMethod?: MergeMethod;
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
    pullRequest: {
      id: string;
      title: string;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft: boolean;
      body?: string;
      bodyHTML?: string;
      createdAt?: string;
      updatedAt?: string;
      mergedAt?: string | null;
      author?: (Login & { avatarUrl?: string }) | null;
      mergedBy?: Login;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      headRepository?: { nameWithOwner: string } | null;
      headRepositoryOwner?: Login;
      baseRepository?: { nameWithOwner: string } | null;
      additions?: number;
      deletions?: number;
      changedFiles?: number;
      mergeStateStatus?: string;
      reviewDecision?: PullChecklist["review"]["decision"];
      isMergeQueueEnabled?: boolean;
      isInMergeQueue?: boolean;
      viewerDidAuthor?: boolean;
      viewerCanUpdate?: boolean;
      viewerCanUpdateBranch?: boolean;
      viewerCanMergeAsAdmin?: boolean;
      viewerCanEnableAutoMerge?: boolean;
      viewerCanDisableAutoMerge?: boolean;
      autoMergeRequest?: {
        mergeMethod: MergeMethod;
        enabledBy?: Login;
      } | null;
      reviewRequests?: {
        nodes?: ({
          requestedReviewer?: { login?: string; name?: string } | null;
        } | null)[];
      };
      latestOpinionatedReviews?: {
        nodes?: ({ author?: Login; state?: string } | null)[];
      };
      reviewThreads?: {
        totalCount?: number;
        nodes?: ({ isResolved?: boolean } | null)[];
      };
      commits?: {
        nodes?: ({
          commit?: {
            statusCheckRollup?: {
              contexts?: {
                totalCount?: number;
                nodes?: (RollupContext | null)[];
              };
            } | null;
          };
        } | null)[];
      };
    } | null;
  } | null;
};

const login = (value: Login) => value?.login || "ghost";
const userUrl = (name: string | undefined) =>
  name && /^[a-z0-9-]+$/i.test(name)
    ? `https://github.com/${encodeURIComponent(name)}`
    : undefined;
const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value)) ? value : undefined;

export function parsePull(
  data: PullData,
  reference: GitHubReference,
): PullView {
  const repository = data.repository;
  const pull = repository?.pullRequest;
  if (!repository || !pull) throw new Error("GitHub did not return it.");
  const state =
    pull.state === "MERGED"
      ? "merged"
      : pull.state === "CLOSED"
        ? "closed"
        : pull.isDraft
          ? "draft"
          : "open";
  const author = pull.author?.login;
  const headOwner = pull.headRepositoryOwner?.login;
  const facts: GitHubDetails["facts"] = [
    [
      "Branch",
      {
        head: branchLink(
          {
            label: headOwner
              ? `${headOwner}:${pull.headRefName}`
              : pull.headRefName,
            ref: pull.headRefName,
            repo: pull.headRepository
              ? { full_name: pull.headRepository.nameWithOwner }
              : null,
          },
          reference.repository,
        ),
        base: branchLink(
          {
            label: pull.baseRefName,
            ref: pull.baseRefName,
            repo: pull.baseRepository
              ? { full_name: pull.baseRepository.nameWithOwner }
              : null,
          },
          reference.repository,
        ),
      },
    ],
  ];
  if (pull.changedFiles !== undefined)
    facts.push(["Files changed", pull.changedFiles]);
  if (pull.additions !== undefined && pull.deletions !== undefined)
    facts.push([
      "Changes",
      { additions: pull.additions, deletions: pull.deletions },
    ]);
  const details: GitHubDetails = {
    title: pull.title,
    body: pull.body ?? "",
    bodyHtml: pull.bodyHTML || undefined,
    state: { merged: "Merged", closed: "closed", draft: "Draft", open: "open" }[
      state
    ],
    author: author ?? "ghost",
    authorUrl: userUrl(author),
    authorAvatar:
      pull.author?.avatarUrl &&
      /^https:\/\/avatars\.githubusercontent\.com\//.test(pull.author.avatarUrl)
        ? pull.author.avatarUrl
        : undefined,
    headSha: pull.headRefOid,
    createdAt: time(pull.createdAt),
    updatedAt: time(pull.updatedAt),
    mergedAt: state === "merged" ? time(pull.mergedAt) : undefined,
    mergedBy: pull.mergedBy?.login,
    mergedByUrl: userUrl(pull.mergedBy?.login),
    facts,
  };
  const contexts =
    pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const nodes = (contexts?.nodes ?? []).filter(
    (node): node is RollupContext => !!node,
  );
  const reviews = (pull.latestOpinionatedReviews?.nodes ?? []).filter(
    (review) => !!review,
  );
  const threads = pull.reviewThreads?.nodes ?? [];
  const methods = (
    [
      ["SQUASH", repository.squashMergeAllowed],
      ["MERGE", repository.mergeCommitAllowed],
      ["REBASE", repository.rebaseMergeAllowed],
    ] as const
  )
    .filter(([, allowed]) => allowed)
    .map(([method]) => method);
  const preferred = repository.viewerDefaultMergeMethod;
  return {
    details,
    checklist: {
      id: pull.id,
      head: pull.headRefOid,
      base: pull.baseRefName,
      state,
      checks: summarizeRollup(
        nodes,
        nodes.length >= (contexts?.totalCount ?? 0),
      ),
      review: {
        decision: pull.reviewDecision ?? null,
        approved: reviews
          .filter((review) => review.state === "APPROVED")
          .map((review) => login(review.author)),
        changes: reviews
          .filter((review) => review.state === "CHANGES_REQUESTED")
          .map((review) => login(review.author)),
        waiting: (pull.reviewRequests?.nodes ?? [])
          .map(
            (request) =>
              request?.requestedReviewer?.login ??
              request?.requestedReviewer?.name,
          )
          .filter((reviewer): reviewer is string => !!reviewer),
      },
      unresolved: threads.filter((thread) => thread && !thread.isResolved)
        .length,
      moreThreads: (pull.reviewThreads?.totalCount ?? 0) > threads.length,
      merge: pull.mergeStateStatus ?? "UNKNOWN",
      canUpdate: !!pull.viewerCanUpdate,
      canUpdateBranch: !!pull.viewerCanUpdateBranch,
      authored: !!pull.viewerDidAuthor,
      canBypass: !!pull.viewerCanMergeAsAdmin,
      queueRequired: !!pull.isMergeQueueEnabled,
      queued: !!pull.isInMergeQueue,
      methods,
      method:
        preferred && methods.includes(preferred)
          ? preferred
          : (methods[0] ?? "MERGE"),
      canEnableAutoMerge: !!pull.viewerCanEnableAutoMerge,
      canDisableAutoMerge: !!pull.viewerCanDisableAutoMerge,
      autoMerge: pull.autoMergeRequest
        ? {
            method: pull.autoMergeRequest.mergeMethod,
            by: pull.autoMergeRequest.enabledBy?.login,
          }
        : undefined,
    },
  };
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type PullAction =
  | { type: "merge"; method: MergeMethod }
  | { type: "enqueue" }
  | { type: "review"; event: ReviewEvent; body: string }
  | { type: "auto-merge"; method: MergeMethod }
  | { type: "cancel-auto-merge" }
  | { type: "ready" }
  | { type: "draft" }
  | { type: "update-branch" };

function mutationOf(
  pull: Pick<PullChecklist, "id" | "head">,
  action: PullAction,
): [string, Record<string, unknown>] {
  const id = { pullRequestId: pull.id };
  const head = { ...id, expectedHeadOid: pull.head };
  switch (action.type) {
    case "enqueue":
      return ["enqueuePullRequest", head];
    case "merge":
      return ["mergePullRequest", { ...head, mergeMethod: action.method }];
    case "auto-merge":
      return [
        "enablePullRequestAutoMerge",
        { ...head, mergeMethod: action.method },
      ];
    case "cancel-auto-merge":
      return ["disablePullRequestAutoMerge", id];
    case "ready":
      return ["markPullRequestReadyForReview", id];
    case "draft":
      return ["convertPullRequestToDraft", id];
    case "update-branch":
      return ["updatePullRequestBranch", head];
    case "review":
      return [
        "addPullRequestReview",
        {
          ...id,
          commitOID: pull.head,
          event: action.event,
          ...(action.body.trim() && { body: action.body }),
        },
      ];
  }
}

/** Changes the pull request. Merging and updating name the head this
 * checklist showed, so a push that arrived since is never merged unseen; a
 * review names it too, as the commit the review pertains to. */
export async function changePull(
  gh: GitHubCli,
  pull: Pick<PullChecklist, "id" | "head">,
  action: PullAction,
  signal?: AbortSignal,
) {
  const [mutation, input] = mutationOf(pull, action);
  const type = `${mutation[0]?.toUpperCase()}${mutation.slice(1)}Input`;
  await gh(
    `mutation($input:${type}!){${mutation}(input:$input){clientMutationId}}`,
    { input },
    signal,
  );
}
