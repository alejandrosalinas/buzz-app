import { expect, test } from "vitest";
import {
  populateThread,
  threadBody,
  THREAD_CHANNEL,
  THREAD_REPLIES,
} from "./thread-corpus.mjs";

const names = Array.from({ length: 40 }, (_, i) => `Person ${i + 1}`);
const bodies = Array.from({ length: THREAD_REPLIES }, (_, i) =>
  threadBody(i, names),
);

test("fills the strict window with 441 top-level replies and 19 nested", () => {
  const root = { id: "root", created_at: 1_700_000_100 };
  const app = {
    inboxWindow: { root, replies: [], channelId: THREAD_CHANNEL },
    histories: new Map(),
    serveProfile() {},
  };
  expect(populateThread(app)).toBe(root);
  const replies = app.inboxWindow.replies;
  const nested = replies.filter((event) =>
    event.tags.some(([, , , marker]) => marker === "root"),
  );
  expect(replies).toHaveLength(THREAD_REPLIES);
  expect(nested).toHaveLength(19);
  expect(replies.map((event) => event.content)).toEqual(bodies);
  expect(app.histories.get(`primary/${THREAD_CHANNEL}`)).toEqual([root]);
});

test("mixes plain prose, Markdown, mentions, links and quotes", () => {
  const share = (pattern) =>
    bodies.filter((body) => pattern.test(body)).length / bodies.length;
  expect(share(/^\*\*Week 45 update\*\*/)).toBeGreaterThan(0.8);
  expect(share(/^Quick one/)).toBeGreaterThan(0.1);
  expect(share(/@Person \d+/)).toBeGreaterThan(0.8);
  expect(share(/https:\/\/example\.com\//)).toBeGreaterThan(0.8);
  expect(share(/^> /m)).toBeGreaterThan(0.15);
  expect(share(/`retry\(\)`/)).toBeGreaterThan(0.8);
});
