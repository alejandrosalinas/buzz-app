// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import {
  AttentionSources,
  type AttentionSource,
} from "../../features/agents/attention-sources";
import type { Agent, AgentAttention } from "../../features/agents/service";
import type { AttentionValue } from "../../features/agents/attention";
import { GitHubError, type GitHubCli } from "./gh";
import { createPullStates } from "./pull-states";
import { POLL_MS, watchPulls } from "./watcher";
import { QUIET_MS, WAKE_LIMIT } from "./watch";
import { savePolicy } from "./authors";
import { AuthorSettings } from "./AuthorSettings";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

type Comment = { id: string; login: string; body: string };
type Pull = ReturnType<typeof answer>;
/** A pull request as GitHub holds it. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as Comment[],
  reviews = [] as (Comment & { inline: (Comment & { path: string })[] })[],
  state = "OPEN",
} = {}) => ({ head, checks, comments, reviews, state });

/** What gh answers the store for every pull request in `variables`, all
 * `pull`, or for the text of feedback `ids`. */
function respond(
  pull: Pull,
  query: string,
  variables: { ids?: string[] } & Record<string, unknown>,
) {
  if (variables.ids) {
    const all = [
      ...pull.comments.map((item) => ({ ...item, __typename: "IssueComment" })),
      ...pull.reviews.flatMap(({ inline, ...review }) => [
        { ...review, __typename: "PullRequestReview", state: "COMMENTED" },
        ...inline.map((item) => ({
          ...item,
          __typename: "PullRequestReviewComment",
        })),
      ]),
    ];
    return {
      nodes: variables.ids.map((id) => {
        const found = all.find((item) => item.id === id);
        if (!found) return null;
        const { login, ...node } = found;
        return { ...node, author: { login }, url: `${url}#${id}` };
      }),
    };
  }
  const { checks } = pull;
  const data: Record<string, unknown> = query.includes("viewer{login}")
    ? { viewer: { login: "baxen" } }
    : {};
  for (let i = 0; `n${i}` in variables; i++)
    data[`r${i}`] = {
      pullRequest: {
        state: pull.state,
        isDraft: false,
        mergeStateStatus: "CLEAN",
        headRefOid: pull.head,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: checks.some((check) => !check.conclusion)
                    ? "PENDING"
                    : "SUCCESS",
                  contexts: {
                    totalCount: checks.length,
                    nodes: checks.map(({ name, conclusion }) => ({
                      __typename: "CheckRun",
                      name,
                      status: conclusion ? "COMPLETED" : "IN_PROGRESS",
                      conclusion,
                    })),
                  },
                },
              },
            },
          ],
        },
        reviews: {
          nodes: pull.reviews.map((review) => ({
            id: review.id,
            comments: { nodes: review.inline.map(({ id }) => ({ id })) },
          })),
        },
        comments: { nodes: pull.comments.map(({ id }) => ({ id })) },
      },
    };
  return data;
}

/** Whether `query` is a membership read rather than the store's. */
const membershipRead = (query: string) => query.startsWith("query{\nu");

/** What gh answers a membership read, when `members` are in every
 * organization, or `login@org` in that one. */
function membership(members: readonly string[], query: string) {
  const users = [...query.matchAll(/(u\d+):user\(login:"([^"]+)"\)/g)];
  const orgs = [
    ...new Map(
      [...query.matchAll(/(o\d+):organization\(login:"([^"]+)"\)/g)].map(
        ([, alias, org]) => [alias, org],
      ),
    ),
  ];
  // GitHub has no user for a mannequin, which fails the whole read.
  if (users.some(([, , login]) => login === "mannequin"))
    throw new GitHubError("Could not resolve to a User", "NOT_FOUND");
  return Object.fromEntries(
    users.map(([, alias, login]) => [
      alias,
      Object.fromEntries(
        orgs.map(([org, name]) => [
          org,
          members.includes(login as string) ||
          members.includes(`${login}@${name}`)
            ? { id: "O" }
            : null,
        ]),
      ),
    ]),
  );
}

/** How many membership reads asked GitHub about `login`. */
const asks = (app: ReturnType<typeof setup>, login: string) =>
  app.github.mock.calls.filter(
    ([query]) => membershipRead(query) && query.includes(`login:"${login}"`),
  ).length;

function setup(
  initial: Pull | null = answer(),
  present?: AttentionSource["present"],
) {
  let gh = initial;
  let texts = true;
  let members: readonly string[] | null = [];
  /** GitHub through gh, as the store reads it. */
  const github = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      if (membershipRead(query)) {
        if (!members) throw new Error("gh did not answer");
        return membership(members, query);
      }
      if (!gh) throw new GitHubError("Could not resolve to a Repository");
      if (!texts && "ids" in variables)
        throw new GitHubError("Something went wrong");
      return respond(gh, query, variables);
    },
  );
  const states = createPullStates(github as unknown as GitHubCli);
  const woke = vi.fn();
  const records: Record<string, Record<string, AttentionValue>> = JSON.parse(
    localStorage.getItem("test.attention") ?? "{}",
  );
  const completed = new Set<string>();
  const listeners: (() => void)[] = [];
  let source: AttentionSource;
  let enabled = true;
  const objects = (key: string) =>
    Object.fromEntries(
      Object.entries(records[key] ?? {}).map(([slug, value]) => [
        slug,
        { slug, value },
      ]),
    );
  const snapshot = () =>
    Object.keys(records).map(
      (key) =>
        ({ key, attentionEnabled: enabled, attention: objects(key) }) as Agent,
    );
  const lifecycle = new AttentionSources({
    emit(key, object, text) {
      if (!runs) throw new Error("Delivery unavailable");
      const value = object.value;
      woke(key, {
        channel: value.channel,
        ...(value.root ? { root: value.root } : {}),
        text,
      });
    },
    completed: (key, object) => completed.has(`${key}/${object.slug}`),
    async finish(key, object) {
      completed.add(`${key}/${object.slug}`);
    },
  });
  const reconcile = () => {
    if (source) lifecycle.reconcile("attention/github-pr", source, snapshot());
  };
  const save = async (
    key: string,
    change: { attention: Record<string, AttentionValue | null> },
  ) => {
    records[key] ??= {};
    const record = records[key];
    for (const [slug, value] of Object.entries(change.attention)) {
      if (value) record[slug] = value;
      else delete record[slug];
      completed.delete(`${key}/${slug}`);
    }
    localStorage.setItem("test.attention", JSON.stringify(records));
    reconcile();
    for (const listener of listeners) listener();
  };
  const attention = (key: string) => {
    // As the real store does, a watch of another Interest is out of scope.
    const scope = (
      slug: string,
      value: AttentionValue | null,
      interest?: string,
    ) => {
      const owned = records[key]?.[slug] ?? value;
      if (interest && owned && owned.type !== "interest")
        if (owned.interest_id !== interest)
          throw new Error(
            `wrong-scope: Watch ${slug} belongs to Interest ${owned.interest_id}`,
          );
    };
    const show = async (slug: string, interest?: string) => {
      scope(slug, null, interest);
      const object = records[key]?.[slug];
      return {
        result: object ? "found" : "not-found",
        object: object
          ? {
              ...object,
              id: slug.split("/")[1],
              status: completed.has(`${key}/${slug}`) ? "completed" : "enabled",
            }
          : null,
        expected_state: JSON.stringify(object) ?? "absent",
      };
    };
    return {
      enabled: () => enabled,
      classifier: () => "available",
      show,
      async write(
        slug: string,
        value: AttentionValue | null,
        options: { expected: string; interest?: string },
      ) {
        scope(slug, value, options.interest);
        expect(options.expected).toBe(
          JSON.stringify(records[key]?.[slug]) ?? "absent",
        );
        await save(key, { attention: { [slug]: value } });
        return show(slug);
      },
    } as unknown as AgentAttention;
  };
  const addAttentionSource = vi.fn((value: AttentionSource) => {
    source = value;
    reconcile();
  });
  let runs = true;
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    agents: {
      addAttentionSource,
      snapshot: () => ({ running: snapshot() }),
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      save,
      addTool: (tool: AddedTool) => tools.push(tool),
      wake: (key: string, wake: unknown) => {
        if (!runs) throw new Error("This copy of Buzz does not run that agent");
        woke(key, wake);
      },
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx, states, github as unknown as GitHubCli, present);
  const tool = tools[0] as AddedTool;
  const call = (
    args: Record<string, unknown>,
    topLevel = false,
    key = agent,
  ) => {
    // The agent's own Interest, which every watch it adds names.
    records[key] ??= {};
    records[key]["interest/pr"] ??= {
      type: "interest",
      instructions: "Land the pull request",
    };
    return tool.call(
      { key, pubkey: agent, attention: attention(key) } as BuzzClient,
      topLevel ? { channel: "c", topLevel } : { channel: "c", root },
      { interest: "pr", ...args },
    );
  };
  return {
    call,
    records,
    save,
    attention: attention(agent),
    completed,
    attentionEnabled(value: boolean) {
      enabled = value;
      reconcile();
    },
    addAttentionSource,
    tool,
    woke,
    /** The text of each wake, in order. */
    texts: () =>
      woke.mock.calls.map(([, wake]) => (wake as { text: string }).text),
    github,
    /** GitHub's listings of pull requests, not feedback text. */
    listings: () =>
      github.mock.calls.filter(([, variables]) => !("ids" in variables)).length,
    states,
    gh: (value: Pull | null) => {
      gh = value;
    },
    /** Who is in every organization, or `login@org` in one, or null when
     * membership cannot be read. */
    members: (value: readonly string[] | null) => {
      members = value;
    },
    /** Whether reads of feedback text succeed, as a too-long answer cannot. */
    readsText: (value: boolean) => {
      texts = value;
    },
    runs: (value: boolean) => {
      runs = value;
    },
    dispose: () => {
      lifecycle.stop();
      for (const dispose of disposers) dispose();
    },
  };
}

describe("github_watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("registers PR watching as an Attention source with its presenter", () => {
    const present = vi.fn();
    const app = setup(answer(), present);
    expect(app.addAttentionSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "github-pr",
        run: expect.any(Function),
        present,
      }),
    );
    app.dispose();
  });

  it("keeps generic subscriptions for the same PR independent", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "First" },
        "interest/second": { type: "interest", instructions: "Second" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, {
      attention: { "watch/second": { ...source, interest_id: "second", root } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a generic subscription is deleted and recreated", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, { attention: { "watch/first": null } });
    await app.save(agent, { attention: { "watch/first": source } });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a subscription is edited to another PR", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const next = "https://github.com/block/buzz-app/pull/8";
    app.gh(
      answer({
        head: "2222222222",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await app.save(agent, {
      attention: { "watch/first": { ...source, config: { pr: next } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts().at(-1)).toBe(`CI passed on 222222222 for ${next}.`);
    app.dispose();
  });

  it("pauses polling with Attention and catches up when resumed", async () => {
    const app = setup();
    await app.call({ url });
    app.attentionEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    const count = app.github.mock.calls.length;
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(app.github).toHaveBeenCalledTimes(count);
    expect(app.woke).not.toHaveBeenCalled();
    await expect(app.call({ url })).rejects.toThrow(/Turn on Attention/);
    app.attentionEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.dispose();
  });

  it("moves a PR's watch from another Interest to the one named", async () => {
    const app = setup();
    await app.call({ url });
    const id = Object.keys(app.records[agent] ?? {}).find((slug) =>
      slug.startsWith("watch/"),
    );
    if (!id) throw new Error("Missing watch");
    const watch = app.records[agent]?.[id];
    if (watch?.type !== "source") throw new Error("Missing source");
    // As the shipped plugin saved it, under its own Interest.
    await app.save(agent, {
      attention: {
        "interest/github-pulls": { type: "interest", instructions: "Follow" },
        [id]: { ...watch, interest_id: "github-pulls" },
      },
    });
    expect(await app.call({ url }, true)).toContain(
      "The watch moved to Interest pr from Interest github-pulls, which gets no more wakes for this pull request.",
    );
    expect(app.records[agent]?.[id]).toEqual(
      expect.objectContaining({ interest_id: "pr", channel: "c" }),
    );
    expect(app.records[agent]?.[id]).not.toHaveProperty("root");
    app.dispose();
  });

  it("drops watches saved before Attention instead of importing them", async () => {
    localStorage.setItem(
      "buzz.github.pull-watches.v1",
      JSON.stringify([{ agent, url, channel: "c", root, wakes: 2 }]),
    );
    const app = setup();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(localStorage.getItem("buzz.github.pull-watches.v1")).toBeNull();
    expect(app.records).toEqual({});
    expect(app.github).not.toHaveBeenCalled();
    app.dispose();
  });

  it("adds the watch to the agent's Interest, and needs one that exists", async () => {
    const app = setup();
    await expect(app.call({ url, interest: undefined })).rejects.toThrow(
      /interest is required/,
    );
    await expect(app.call({ url, interest: "missing" })).rejects.toThrow(
      /Interest missing does not exist.*interest_set/,
    );
    expect(app.github).not.toHaveBeenCalled();
    await app.call({ url });
    const sources = () =>
      Object.entries(app.records[agent] ?? {}).filter(
        ([, value]) => value.type === "source",
      );
    expect(sources()).toEqual([
      [
        expect.stringMatching(/^watch\/github-/),
        expect.objectContaining({
          interest_id: "pr",
          provider: "attention/github-pr",
          channel: "c",
          root,
        }),
      ],
    ]);
    expect(Object.keys(app.records[agent] ?? {})).not.toContain(
      "interest/github-pulls",
    );
    // A second call updates the same watch, now at the top of a Solo chat.
    await app.call({ url }, true);
    expect(sources()).toHaveLength(1);
    expect(sources()[0]?.[1]).not.toHaveProperty("root");
    app.dispose();
  });

  it("starts fresh after the owner deletes a watch outside the tool", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const id = Object.keys(app.records[agent] ?? {}).find((id) =>
      id.startsWith("watch/"),
    );
    if (!id) throw new Error("Missing watch");
    await app.save(agent, { attention: { [id]: null } });
    const reply = await app.call({ url }, true);
    expect(reply).not.toContain("no longer in the conversation");
    const record = app.records[agent]?.[id];
    if (record?.type !== "source") throw new Error("Missing source");
    expect((record.config.initial as { wakes: number }).wakes).toBe(0);
    app.dispose();
  });

  it("finishes at the wake limit and a new call starts a fresh watch", async () => {
    const app = setup();
    await app.call({ url });
    for (let index = 0; index < WAKE_LIMIT; index++) {
      app.gh(
        answer({
          head: index.toString(16).padStart(10, "0"),
          checks: [{ name: "unit", conclusion: "SUCCESS" }],
        }),
      );
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    expect(app.texts()).toHaveLength(WAKE_LIMIT);
    expect(app.texts().at(-1)).toContain("this watch has ended");
    expect(app.completed.size).toBe(1);
    await app.call({ url });
    app.gh(
      answer({
        head: "abcdef0123",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toHaveLength(WAKE_LIMIT + 1);
    expect(app.texts().at(-1)).not.toContain("this watch has ended");
    app.dispose();
  });

  it("wakes the agent in its thread when CI finishes, naming the failed checks", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    expect(await app.call({ url })).toMatch(/^Watching https:/);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          root,
          text: `CI failed on 111111111 for ${url}: 1 check failed, as GitHub names them:\n> unit`,
        },
      ],
    ]);
    // Reported once per head commit.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("wakes the community whose membership set the watch, apart from the agent's other one", async () => {
    const other = `${agent}@other.example`;
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    await app.call({ url }, false, other);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls.map(([key]) => key).sort()).toEqual(
      [agent, other].sort(),
    );
    // Stopping one leaves the other's.
    await app.call({ url, stop: true }, false, other);
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "[]",
      ).map((watch: { agent: string }) => watch.agent),
    ).toEqual([agent]);
    app.dispose();
  });

  it("answers what is already there instead of waking, and wakes a Solo chat with what is new", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: "I1", login: "wes", body: "body-old" },
          { id: "I2", login: "wes", body: "body-new" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    // It wakes once the feedback read has been quiet long enough, not on a
    // later minute.
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          text: `New feedback on ${url}, quoted from GitHub:\n- comment by wes ${url}#I2:\n  > body-new`,
        },
      ],
    ]);
    app.dispose();
  });

  it("keeps news it could not send, and survives a restart", async () => {
    const app = setup();
    await app.call({ url });
    app.runs(false);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
    // The restarted app reads at once.
    const next = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.woke).toHaveBeenCalledTimes(1);
    next.dispose();
  });

  it("reads, after a restart, the text of only the feedback the watch has not seen", async () => {
    const before = [{ id: "R1", login: "wes", body: "Looks off", inline: [] }];
    const app = setup(answer({ reviews: before }));
    await app.call({ url });
    app.dispose();
    const next = setup(
      answer({
        reviews: [
          ...before,
          { id: "R2", login: "wes", body: "Still off", inline: [] },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(QUIET_MS + 2 * POLL_MS);
    expect(next.texts().join("\n")).toContain("Still off");
    expect(next.texts().join("\n")).not.toContain("Looks off");
    expect(
      [app, next].flatMap((one) =>
        one.github.mock.calls
          .map(([, variables]) => variables.ids)
          .filter(Boolean),
      ),
    ).toEqual([["R2"]]);
    next.dispose();
  });

  it("keeps watching when its progress cannot be saved, as when storage is full", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    const setItem = Storage.prototype.setItem;
    const full = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "buzz.github.attention-cursors.v1")
          throw new DOMException(
            "The quota has been exceeded.",
            "QuotaExceededError",
          );
        setItem.call(this, key, value);
      });
    try {
      app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
      await vi.advanceTimersByTimeAsync(POLL_MS);
      app.gh(
        answer({
          head: "2222222222",
          checks: [{ name: "unit", conclusion: "SUCCESS" }],
        }),
      );
      await vi.advanceTimersByTimeAsync(POLL_MS);
      app.gh(answer({ head: "2222222222", state: "MERGED" }));
      await vi.advanceTimersByTimeAsync(POLL_MS);
    } finally {
      full.mockRestore();
    }
    expect(app.texts()).toEqual([
      `CI passed on 111111111 for ${url}.`,
      `CI passed on 222222222 for ${url}.`,
      expect.stringMatching(
        new RegExp(`^${url} was merged, so this watch has ended`),
      ),
    ]);
    expect([...app.completed]).toHaveLength(1);
    app.dispose();
  });

  it("stops on request, when merged, and refuses unreadable pull requests", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url, stop: true })).toBe(
      `Stopped watching ${url}.`,
    );
    app.gh(null);
    // The refusal says what gh answered, so the agent can tell why.
    await expect(app.call({ url })).rejects.toThrow(
      /gh: Could not resolve to a Repository/,
    );
    await expect(app.call({ url: "https://example.com/x" })).rejects.toThrow(
      /pull request URL/,
    );
    app.gh(answer());
    await app.call({ url });
    app.gh(answer({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect([...app.completed]).toHaveLength(1);
    expect(app.texts()).toEqual([
      expect.stringMatching(
        new RegExp(`^${url} was merged, so this watch has ended`),
      ),
    ]);
    app.dispose();
  });

  it("ends a watch it cannot read for half an hour, telling the agent", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    // A good read in between starts the count again.
    app.gh(answer());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([
      expect.stringContaining(`Stopped watching ${url}`),
    ]);
    expect([...app.completed]).toHaveLength(1);
    app.dispose();
  });

  it("lets a read still in flight when the plugin stops do nothing", async () => {
    const old = setup();
    await old.call({ url });
    let finish: (value: unknown) => void = () => {};
    old.github.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>(
          (resolve) => (finish = (value) => resolve(value as never)),
        ),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    old.dispose();
    // Its replacement takes over the saved watch, then the agent stops it.
    const next = setup();
    await vi.advanceTimersByTimeAsync(0);
    await next.call({ url, stop: true });
    finish(
      respond(
        answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
        "viewer{login}",
        { o0: "block", n0: "buzz-app", p0: 7 },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(old.woke).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "",
      ),
    ).toEqual([]);
    next.dispose();
  });

  it("still reports CI while feedback text cannot be read, and tells the feedback once it can", async () => {
    const app = setup();
    await app.call({ url });
    app.readsText(false);
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "x".repeat(22_000) }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.readsText(true);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toMatch(
      new RegExp(`^New feedback on .+\\n- comment by wes ${url}#I1:`),
    );
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("wakes for a reply on an older thread, which comes with its own review", async () => {
    const old = Array.from({ length: 40 }, (_, i) => ({
      id: `R${i}`,
      login: "wes",
      body: "",
      inline: [
        { id: `C${i}`, login: "wes", body: `old ${i}`, path: "src/a.ts" },
      ],
    }));
    const app = setup(answer({ reviews: old }));
    await app.call({ url });
    app.gh(
      answer({
        reviews: [
          ...old,
          {
            id: "R40",
            login: "wes",
            body: "",
            inline: [
              {
                id: "C40",
                login: "wes",
                body: "Still broken",
                path: "src/a.ts",
              },
            ],
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toEqual([
      [
        `New feedback on ${url}, quoted from GitHub:`,
        `- inline comment by wes ${url}#C40, on:`,
        "  > src/a.ts",
        "  > Still broken",
      ].join("\n"),
    ]);
    // What was there when the watch started is never read in full; only the
    // new review and its comment are.
    expect(
      app.github.mock.calls
        .map(([, variables]) => variables.ids)
        .filter(Boolean),
    ).toEqual([["R40", "C40"]]);
    app.dispose();
  });

  it("reads a pull request both watched and shown once a minute, for both", async () => {
    const app = setup(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    const shown = vi.fn();
    const unwatch = app.states.watch(url, shown);
    await vi.advanceTimersByTimeAsync(0);
    const before = app.listings();
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    // The watch asks for the feedback the link does not need, and the one
    // read serves both: the link shows the checks, the agent is woken.
    expect(app.listings() - before).toBe(3);
    expect(app.states.get(url)).toMatchObject({ checks: "success" });
    expect(shown).toHaveBeenCalled();
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    unwatch();
    app.dispose();
  });

  it("reads newer feedback before rereading what it holds", async () => {
    savePolicy("allow author:wes\nallow org:block");
    const app = setup();
    await app.call({ url });
    app.members(null);
    const held = Array.from({ length: 50 }, (_, index) => ({
      id: `I${index}`,
      login: `stranger${index}`,
      body: `body-${index}`,
    }));
    app.gh(answer({ comments: held }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(
      answer({
        comments: [...held, { id: "I50", login: "wes", body: "body-wes" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).toContain("body-wes");
    app.dispose();
  });

  it("keeps holding feedback a poll did not reread, so it cannot crowd out what is new", async () => {
    savePolicy("allow author:wes\nallow org:block");
    const app = setup();
    await app.call({ url });
    app.members(null);
    const stranger = (index: number) => ({
      id: `I${index}`,
      login: `stranger${index}`,
      body: `body-${index}`,
      path: "a.ts",
    });
    app.gh(
      answer({
        reviews: [
          {
            ...stranger(100),
            inline: Array.from({ length: 60 }, (_, index) => stranger(index)),
          },
        ],
        comments: [
          ...Array.from({ length: 49 }, (_, index) => stranger(index + 60)),
          { id: "I109", login: "wes", body: "body-wes" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(4 * POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).toContain("body-wes");
    app.dispose();
  });

  it("tells only feedback from trusted authors, once their organization is known", async () => {
    savePolicy("allow author:wes\nallow org:block");
    const app = setup();
    await app.call({ url });
    app.members(null);
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "wes", body: "body-wes" },
          { id: "I2", login: "stranger", body: "body-stranger" },
          { id: "I3", login: "alice", body: "body-alice" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-wes");
    expect(app.texts()[0]).not.toContain("body-alice");
    // Membership read once it can be; strangers are never told.
    app.members(["alice"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toContain("body-alice");
    expect(app.texts().join("\n")).not.toContain("body-stranger");
    app.dispose();
  });

  it("tells waiting feedback only if the rules still allow it", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "wes", body: "body-wes" },
          { id: "I2", login: "stranger", body: "body-stranger" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    savePolicy("allow author:wes");
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-wes");
    expect(app.texts()[0]).not.toContain("body-stranger");
    app.dispose();
  });

  it("tells a running watch what rules saved in Settings allow", async () => {
    const app = setup();
    await app.call({ url });
    savePolicy("", "deny");
    render(createElement(AuthorSettings, { active: () => true }));
    const save = (rules: string) => {
      fireEvent.change(screen.getByRole("textbox", { name: /Rules/ }), {
        target: { value: rules },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    };
    save("allow author:wes");
    const wes = { id: "I1", login: "wes", body: "body-wes" };
    const stranger = { id: "I2", login: "stranger", body: "body-stranger" };
    app.gh(answer({ comments: [wes, stranger] }));
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-wes");
    expect(app.texts()[0]).not.toContain("body-stranger");
    save("allow author:stranger");
    const later = { id: "I3", login: "stranger", body: "body-later" };
    app.gh(answer({ comments: [wes, stranger, later] }));
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toContain("body-later");
    cleanup();
    app.dispose();
  });

  it("checks newly read feedback against rules saved while membership is read", async () => {
    savePolicy("allow org:block", "allow");
    const wes = { id: "I0", login: "wes", body: "body-wes" };
    const pending = [{ name: "ci", conclusion: null }];
    const app = setup(answer({ checks: pending, comments: [wes] }));
    await app.call({ url });
    let asked = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = app.github.getMockImplementation();
    app.github.mockImplementation(async (query, variables) => {
      if (membershipRead(query)) {
        asked = true;
        await gate;
      }
      return run?.(query, variables);
    });
    app.gh(
      answer({
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
        comments: [wes, { id: "I1", login: "stranger", body: "body-stranger" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(asked).toBe(true);
    savePolicy("deny author:stranger");
    release();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).toContain("CI passed");
    expect(app.texts().join("\n")).not.toContain("body-stranger");
    app.dispose();
  });

  it("tells CI while a membership read hangs", async () => {
    savePolicy("allow org:block");
    const pending = [{ name: "ci", conclusion: null }];
    const app = setup(answer({ checks: pending }));
    await app.call({ url });
    const run = app.github.getMockImplementation();
    app.github.mockImplementation(async (query, variables) =>
      membershipRead(query) ? new Promise(() => {}) : run?.(query, variables),
    );
    app.gh(
      answer({
        checks: [{ name: "ci", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "alice", body: "body-alice" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.dispose();
  });

  it("learns feedback already there on a first read, whatever membership it needs", async () => {
    savePolicy("allow org:block");
    const app = setup(
      answer({ comments: [{ id: "I1", login: "alice", body: "body-old" }] }),
    );
    app.members(["alice"]);
    // Another reader, such as the panel, already holds its text.
    await app.states.read(url, {
      maxAge: 0,
      level: "feedback",
      wantsText: () => true,
    });
    await app.call({ url });
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).not.toContain("body-old");
    app.dispose();
  });

  it("tells newly read feedback rules saved while membership is read allow", async () => {
    savePolicy("allow org:block");
    const app = setup();
    await app.call({ url });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = app.github.getMockImplementation();
    app.github.mockImplementation(async (query, variables) => {
      if (membershipRead(query)) await gate;
      return run?.(query, variables);
    });
    app.gh(
      answer({
        comments: [{ id: "I1", login: "stranger", body: "body-stranger" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    savePolicy("allow");
    release();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).toContain("body-stranger");
    app.dispose();
  });

  it("holds waiting feedback while the rules need a membership it cannot read", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(
      answer({ comments: [{ id: "I1", login: "wes", body: "body-wes" }] }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    savePolicy("allow org:block");
    app.members(null);
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(0);
    app.members(["wes"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-wes");
    app.dispose();
  });

  it("does not trust an expired membership it could not read again", async () => {
    savePolicy("allow org:block");
    const app = setup();
    await app.call({ url });
    app.members(["alice"]);
    const first = { id: "I1", login: "alice", body: "body-first" };
    app.gh(answer({ comments: [first] }));
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * POLL_MS);
    app.members(null);
    app.gh(
      answer({
        comments: [first, { id: "I2", login: "alice", body: "body-later" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    app.members(["alice"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toContain("body-later");
    app.dispose();
  });

  it("keeps each membership read under its size limit", async () => {
    const organizations = Array.from(
      { length: 8 },
      (_, index) => `organization-${index}-with-a-long-name`,
    );
    const logins = Array.from(
      { length: 30 },
      (_, index) => `commenter-${index}-with-a-long-login`,
    );
    savePolicy(organizations.map((org) => `allow org:${org}`).join("\n"));
    const app = setup();
    await app.call({ url });
    app.members(logins);
    app.gh(
      answer({
        comments: logins.map((login, index) => ({
          id: `I${index}`,
          login,
          body: `body-${index}`,
        })),
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    const reads = app.github.mock.calls
      .map(([query]) => query)
      .filter(membershipRead);
    expect(reads.length).toBeGreaterThan(1);
    for (const query of reads)
      expect(new TextEncoder().encode(query).length).toBeLessThanOrEqual(4096);
    expect(app.texts()[0]).toContain("30 new comments");
    app.dispose();
  });

  it("holds feedback while saved rules no longer parse, and tells it once they are fixed", async () => {
    localStorage.setItem(
      "buzz.github.author-policy.v2",
      JSON.stringify({
        version: 2,
        text: "allow author:/^(?!eve$)[a-z]+$/",
        fallback: "deny",
      }),
    );
    const app = setup();
    await app.call({ url });
    app.gh(
      answer({ comments: [{ id: "I1", login: "eve", body: "body-eve" }] }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + 3 * POLL_MS);
    expect(app.texts().join("\n")).not.toContain("body-eve");
    savePolicy("allow");
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).toContain("body-eve");
    app.dispose();
  });

  it("does not take anyone to be in no organization while GitHub cannot be asked", async () => {
    savePolicy("deny org:evil\nallow");
    const app = setup();
    await app.call({ url });
    app.members(null);
    app.gh(
      answer({
        comments: [{ id: "I1", login: "mallory", body: "body-mallory" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(15 * POLL_MS);
    app.members(["mallory@evil"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts().join("\n")).not.toContain("body-mallory");
    app.dispose();
  });

  it("asks alone after a login fails its batch, and gives up on that login", async () => {
    savePolicy("allow org:block");
    const app = setup();
    await app.call({ url });
    app.members(["alice"]);
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "mannequin", body: "body-mannequin" },
          { id: "I2", login: "alice", body: "body-alice" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-alice");
    // After ten polls it is taken to be in no organization, and is seen.
    await vi.advanceTimersByTimeAsync(12 * POLL_MS);
    const settled = asks(app, "mannequin");
    expect(settled).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(asks(app, "mannequin")).toBe(settled);
    expect(app.texts().join("\n")).not.toContain("body-mannequin");
    app.dispose();
  });

  it("gives up on a lone commenter GitHub cannot read, as it answers the viewer", async () => {
    savePolicy("allow org:block");
    const app = setup();
    await app.call({ url });
    app.gh(
      answer({
        comments: [{ id: "I1", login: "mannequin", body: "body-mannequin" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(12 * POLL_MS);
    const settled = asks(app, "mannequin");
    expect(settled).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(asks(app, "mannequin")).toBe(settled);
    expect(app.texts().join("\n")).not.toContain("body-mannequin");
    app.dispose();
  });

  it("counts a login's failed membership reads once a poll, however many watches read it", async () => {
    savePolicy("allow org:block");
    const app = setup();
    const urls = [7, 8, 9].map((pull) => url.replace(/\d+$/, `${pull}`));
    for (const pull of urls) await app.call({ url: pull });
    app.members(null);
    app.gh(
      answer({ comments: [{ id: "I1", login: "wes", body: "body-wes" }] }),
    );
    await vi.advanceTimersByTimeAsync(4 * POLL_MS);
    expect(app.texts()).toHaveLength(0);
    app.members(["wes"]);
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(3);
    for (const text of app.texts()) expect(text).toContain("body-wes");
    app.dispose();
  });

  it("stops asking each login alone once the watch stops", async () => {
    savePolicy("allow org:block");
    const app = setup();
    await app.call({ url });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = app.github.getMockImplementation();
    const asked: string[] = [];
    app.github.mockImplementation(async (query, variables) => {
      if (!membershipRead(query)) return run?.(query, variables);
      asked.push(query);
      await gate;
      throw new Error("gh did not answer");
    });
    app.gh(
      answer({
        comments: ["alice", "bob", "carol"].map((login, index) => ({
          id: `I${index}`,
          login,
          body: `body-${login}`,
        })),
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(asked).toHaveLength(1);
    app.attentionEnabled(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(1);
    app.dispose();
  });

  it("by default tells the viewer's comments but not its 🤖 ones", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "baxen", body: " 🤖 body-agent" },
          { id: "I2", login: "Baxen", body: "body-owner" },
          { id: "I3", login: "stranger", body: "🤖 body-stranger" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    expect(app.texts()[0]).toContain("body-owner");
    expect(app.texts()[0]).toContain("body-stranger");
    expect(app.texts()[0]).not.toContain("body-agent");
    // No membership is read when no rule names an organization.
    expect(
      app.github.mock.calls.filter(([query]) => membershipRead(query)),
    ).toEqual([]);
    app.dispose();
  });

  it("tells feedback rules allow by pattern and by each organization", async () => {
    savePolicy(`deny body:/^\\s*nit\\b/i
allow author:/^COPILOT/
allow org:block
allow org:example-org author:/^ada_/`);
    const app = setup();
    await app.call({ url });
    app.members(["alice@block", "ada_x@example-org", "bob@example-org"]);
    app.gh(
      answer({
        comments: [
          { id: "I1", login: "alice", body: "body-alice" },
          { id: "I2", login: "ada_x", body: "body-ada" },
          { id: "I3", login: "bob", body: "body-bob" },
          { id: "I4", login: "copilot-x", body: "body-copilot" },
          { id: "I5", login: "alice", body: "Nit: body-nit" },
          { id: "I6", login: "baxen", body: "body-owner" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + QUIET_MS + POLL_MS);
    expect(app.texts()).toHaveLength(1);
    const [text] = app.texts();
    for (const body of ["body-alice", "body-ada", "body-copilot"])
      expect(text).toContain(body);
    for (const body of ["body-bob", "body-nit", "body-owner"])
      expect(text).not.toContain(body);
    app.dispose();
  });

  it("needs a thread or a Solo chat to wake in", async () => {
    const app = setup();
    await expect(
      app.tool.call(
        { key: agent, pubkey: agent, attention: app.attention } as BuzzClient,
        { channel: "c" },
        { url, interest: "pr" },
      ),
    ).rejects.toThrow(/thread or a Solo chat/);
    app.dispose();
  });

  it("says when a watch moves to another conversation", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url }, true)).toContain(
      "no longer in the conversation that asked before",
    );
    app.dispose();
  });
});
