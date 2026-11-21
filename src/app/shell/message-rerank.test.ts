// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DecisionRequest,
  DecisionResult,
  Decisions,
} from "../../features/decisions/service";
import { checkRequest } from "../../features/decisions/service";
import { useMessageRerank } from "./message-rerank";
import type { SearchMessage } from "./useSearchMessages";

const message = (id: string) =>
  ({
    id,
    channelId: "c",
    authorId: "a",
    createdAt: 0,
    preview: id,
    text: id,
  }) as SearchMessage;
const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `m${index}`);
const facts = () => ({
  where: "#c",
  author: "A",
  mine: false,
  agent: false,
  member: false,
});
/** Answers each question with the probability `score` gives its candidate,
 * leaving out candidates it gives none. */
const answered = (
  request: DecisionRequest,
  score: (text: string) => number | undefined,
): DecisionResult => {
  const { candidates } = JSON.parse(request.state) as {
    candidates: { n: number; text: string }[];
  };
  return {
    outcome: "answered",
    backend: "test",
    model: "test",
    answers: Object.fromEntries(
      candidates.flatMap(({ n, text }) => {
        const probability = score(text);
        return probability === undefined
          ? []
          : [[`m${n}`, { type: "yes_no", probability }]];
      }),
    ),
  };
};
const decisionsOf = (decide: Decisions["decide"]) =>
  ({ decide, status: () => "ready" }) as unknown as Decisions;

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the hook over `messages` and lets the settle delay pass. */
const settle = async (
  messages: readonly SearchMessage[],
  decide: Decisions["decide"],
  community?: string,
) => {
  vi.useFakeTimers();
  const decisions = decisionsOf(decide);
  const { result } = renderHook(() =>
    useMessageRerank({
      decisions,
      community,
      query: "q",
      messages,
      enabled: true,
      facts,
      held: false,
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  return result;
};

it("orders by the provider's probability, keeping relay order on ties and gaps", async () => {
  // No answer for d: it sorts below every answered hit.
  const scores: Record<string, number> = { a: 0.2, b: 0.9, c: 0.2 };
  const result = await settle(
    ["a", "b", "c", "d"].map(message),
    async (request) => answered(request, (text) => scores[text]),
  );
  expect(result.current.messages.map(({ id }) => id)).toEqual([
    "b",
    "a",
    "c",
    "d",
  ]);
});

it("sends each candidate's searcher and agent facts only when they hold", async () => {
  vi.useFakeTimers();
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, () => 0.5),
  );
  const decisions = decisionsOf(decide);
  renderHook(() =>
    useMessageRerank({
      decisions,
      community: undefined,
      query: "q",
      messages: [message("plain"), { ...message("all"), mentionsViewer: true }],
      enabled: true,
      facts: ({ id }) => ({
        ...facts(),
        mine: id === "all",
        agent: id === "all",
        member: id === "all",
      }),
      held: false,
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  const [request] = decide.mock.calls[0] ?? [];
  const { candidates } = JSON.parse(request?.state ?? "{}");
  expect(candidates).toEqual([
    { n: 1, where: "#c", author: "A", date: "1970-01-01", text: "plain" },
    {
      n: 2,
      where: "#c",
      author: "A",
      written_by_searcher: true,
      from_agent: true,
      mentions_searcher: true,
      searcher_in_conversation: true,
      date: "1970-01-01",
      text: "all",
    },
  ]);
});

it.each([
  { count: 2, sizes: [2] },
  { count: 32, sizes: [32] },
  { count: 33, sizes: [17, 16] },
  { count: 60, sizes: [30, 30] },
  { count: 80, sizes: [30, 30] },
])(
  "asks about the first $count hits in calls the provider accepts",
  async ({ count, sizes }) => {
    const decide = vi.fn(async (request: DecisionRequest) =>
      answered(request, () => 0.5),
    );
    await settle(ids(count).map(message), decide, "wss://relay.example.org");
    const requests = decide.mock.calls.map(([request]) => request);
    expect(
      requests.map((request) => Object.keys(request.questions).length),
    ).toEqual(sizes);
    for (const request of requests) {
      expect(checkRequest(request)).toBeUndefined();
      expect(request.community).toBe("wss://relay.example.org");
    }
  },
);

it("reorders the first hits across every call's answers", async () => {
  vi.useFakeTimers();
  const messages = ids(60).map(message);
  // The last hit is the most wanted, the first the least.
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, (text) => Number(text.slice(1)) / 100),
  );
  const decisions = decisionsOf(decide);
  const { result } = renderHook(() =>
    useMessageRerank({
      decisions,
      community: undefined,
      query: "q",
      messages,
      enabled: true,
      facts,
      held: false,
    }),
  );
  expect(result.current.messages[0]?.id).toBe("m0");
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).toHaveBeenCalledTimes(2);
  expect(result.current.reranked).toBe(true);
  expect(result.current.messages.map(({ id }) => id)).toEqual(
    ids(60).reverse(),
  );
});

it("keeps the relay order when any call fails", async () => {
  vi.useFakeTimers();
  const messages = ids(60).map(message);
  let calls = 0;
  const decide = vi.fn(async (request: DecisionRequest) =>
    calls++
      ? ({
          outcome: "failed",
          backend: "test",
          reason: "timeout",
        } as DecisionResult)
      : answered(request, () => 0.5),
  );
  const decisions = decisionsOf(decide);
  const { result } = renderHook(() =>
    useMessageRerank({
      decisions,
      community: undefined,
      query: "q",
      messages,
      enabled: true,
      facts,
      held: false,
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).toHaveBeenCalledTimes(2);
  expect(result.current.reranked).toBe(false);
  expect(result.current.messages).toBe(messages);
});

it("drops an answer that lands after the person moved, keeping the relay order", async () => {
  vi.useFakeTimers();
  let answer: (result: DecisionResult) => void = () => {};
  let asked: DecisionRequest | undefined;
  const decide = vi.fn(
    (request: DecisionRequest) =>
      new Promise<DecisionResult>((resolve) => {
        asked = request;
        answer = resolve;
      }),
  );
  const decisions = decisionsOf(decide);
  const messages = ["a", "b"].map(message);
  const { result, rerender } = renderHook(
    ({ held }) =>
      useMessageRerank({
        decisions,
        community: undefined,
        query: "q",
        messages,
        enabled: true,
        facts,
        held,
      }),
    { initialProps: { held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).toHaveBeenCalledOnce();
  rerender({ held: true });
  await act(async () => {
    answer(
      answered(asked as DecisionRequest, (text) => (text === "b" ? 0.9 : 0.1)),
    );
  });
  expect(result.current.reranked).toBe(false);
  expect(result.current.messages.map(({ id }) => id)).toEqual(["a", "b"]);
});

it("sends nothing once the person moves during the settle", async () => {
  vi.useFakeTimers();
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, () => 0.5),
  );
  const decisions = decisionsOf(decide);
  const messages = ["a", "b"].map(message);
  const { rerender } = renderHook(
    ({ held }) =>
      useMessageRerank({
        decisions,
        community: undefined,
        query: "q",
        messages,
        enabled: true,
        facts,
        held,
      }),
    { initialProps: { held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
  rerender({ held: true });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).not.toHaveBeenCalled();
});

it("asks a provider still checking its setup only once it answers", async () => {
  vi.useFakeTimers();
  let status = "checking";
  const listeners = new Set<() => void>();
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, (text) => (text === "b" ? 0.9 : 0.1)),
  );
  const decisions = {
    decide,
    status: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } as unknown as Decisions;
  const messages = ["a", "b"].map(message);
  const { result } = renderHook(() =>
    useMessageRerank({
      decisions,
      community: undefined,
      query: "q",
      messages,
      enabled: true,
      facts,
      held: false,
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(2_000);
  });
  expect(decide).not.toHaveBeenCalled();
  await act(async () => {
    status = "ready";
    for (const listener of listeners) listener();
  });
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(decide).toHaveBeenCalledOnce();
  expect(result.current.messages.map(({ id }) => id)).toEqual(["b", "a"]);
});

it("keeps an applied order while a later page extends the hits", async () => {
  vi.useFakeTimers();
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, (text) => (text === "b" ? 0.9 : 0.1)),
  );
  const decisions = decisionsOf(decide);
  const { result, rerender } = renderHook(
    ({ messages, held }) =>
      useMessageRerank({
        decisions,
        community: undefined,
        query: "q",
        messages,
        enabled: true,
        facts,
        held,
      }),
    { initialProps: { messages: ["a", "b"].map(message), held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(result.current.messages.map(({ id }) => id)).toEqual(["b", "a"]);
  // The person moves, then loads the next page.
  rerender({ messages: ["a", "b", "c"].map(message), held: true });
  expect(result.current.reranked).toBe(true);
  expect(result.current.messages.map(({ id }) => id)).toEqual(["b", "a", "c"]);
});

it("keeps an applied order for the hits that stay when one leaves", async () => {
  vi.useFakeTimers();
  const scores: Record<string, number> = { a: 0.1, b: 0.5, c: 0.9 };
  const decide = vi.fn(async (request: DecisionRequest) =>
    answered(request, (text) => scores[text]),
  );
  const decisions = decisionsOf(decide);
  const { result, rerender } = renderHook(
    ({ messages, held }) =>
      useMessageRerank({
        decisions,
        community: undefined,
        query: "q",
        messages,
        enabled: true,
        facts,
        held,
      }),
    { initialProps: { messages: ["a", "b", "c"].map(message), held: false } },
  );
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  expect(result.current.messages.map(({ id }) => id)).toEqual(["c", "b", "a"]);
  // The person moves, then a's conversation leaves the list.
  rerender({ messages: ["b", "c"].map(message), held: true });
  expect(result.current.reranked).toBe(true);
  expect(result.current.messages.map(({ id }) => id)).toEqual(["c", "b"]);
  // Different hits for the same text aren't ordered by the old answer.
  rerender({ messages: ["d", "e"].map(message), held: true });
  expect(result.current.reranked).toBe(false);
});
