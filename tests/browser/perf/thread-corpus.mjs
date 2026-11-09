import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

// The long-thread workload in docs/channels.md#targets: a weekly-update thread
// filling the strict window's full history (10 initial replies plus nine pages
// of 50). Text, timestamps and structure are fixed; keys are ephemeral. Bodies
// mix plain prose, Markdown lists, mentions and links, and their lengths follow
// a real long thread's top-level reply heights (median ~280px in a 580px pane).
export const THREAD_CHANNEL = "22222222-2222-4222-8222-222222222222";
export const THREAD_REPLIES = 460;

const topics = ["platform", "growth", "infra", "mobile", "design", "support"];
const items = [
  "shipped the onboarding flow",
  "paired with design on the empty states",
  "cleaned up the flaky upload tests",
  "reviewed the relay migration plan",
  "wrote the launch FAQ",
  "met three customers about billing",
  "drafted next quarter's roadmap",
  "moved the nightly job to the new queue",
  "profiled the search index rebuild",
  "closed out the accessibility audit",
];
const extra = [
  "It took longer than planned because the staging data was stale, so most of the week went to rebuilding fixtures before the real work could start.",
  "The surprising part was how much the retry path mattered once traffic doubled; the happy path barely moved.",
  "Next week is mostly follow-through: two reviews, one design session and the write-up for the wider group.",
];

// Reply i's body. Every reply has a short heading and three to six items; one
// in three adds a longer paragraph, one in five a quote, one in seven is plain
// prose without Markdown.
export function threadBody(i, names) {
  const pick = (n) => items[(i * 7 + n * 3) % items.length];
  const mention = names[(i * 5) % names.length];
  if (i % 7 === 3)
    return [
      `Quick one from ${topics[i % topics.length]} this week.`,
      `Mostly ${pick(0)}, plus ${pick(1)}. Nothing blocked.`,
      extra[i % extra.length],
    ].join("\n\n");
  const count = 3 + (i % 4);
  const lines = [
    `**Week 45 update** from the ${topics[i % topics.length]} side`,
    "",
    `1. **Shipped:** ${pick(0)} and ${pick(1)} (see [the notes](https://example.com/notes/${i}))`,
    `2. **Learned:** ${pick(2)}; the \`retry()\` path mattered most`,
    `3. **Next:** ${pick(3)} with @${mention}`,
    ...(count > 3
      ? [
          `4. **Blockers:** ${i % 3 ? "none" : `waiting on @${names[(i + 3) % names.length]} for review`}`,
        ]
      : []),
    ...(count > 4 ? [`5. **Reading:** https://example.com/reading/${i}`] : []),
    ...(count > 5
      ? [`6. **Shoutout:** @${names[(i + 9) % names.length]}`]
      : []),
  ];
  if (i % 3 === 0) lines.push("", extra[i % extra.length]);
  if (i % 5 === 0) lines.push("", "> The numbers above are preliminary.");
  return lines.join("\n");
}

// Replace the fixture's strict-window thread (inboxThreadWindow) with the
// corpus. Every 25th reply answers the reply before it, forming a collapsed
// branch. Returns the root event.
export function populateThread(app, { replies = THREAD_REPLIES } = {}) {
  const authors = Array.from({ length: 40 }, (_, i) => {
    const key = generateSecretKey();
    app.serveProfile(key, { name: `Person ${i + 1}` });
    return key;
  });
  const names = authors.map((_, i) => `Person ${i + 1}`);
  const { root, replies: list, channelId } = app.inboxWindow;
  if (channelId !== THREAD_CHANNEL)
    throw new Error(`Thread corpus expects channel ${THREAD_CHANNEL}`);
  list.length = 0;
  app.histories.set(`primary/${channelId}`, [root]);
  for (let i = 0; i < replies; i++) {
    const nested = i % 25 === 7 && list.length > 0;
    list.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + 100 + i * 30,
          content: threadBody(i, names),
          tags: [
            ["h", channelId],
            ["p", getPublicKey(authors[(i * 5) % authors.length])],
            ...(nested
              ? [
                  ["e", root.id, "", "root"],
                  ["e", list.at(-1).id, "", "reply"],
                ]
              : [["e", root.id, "", "reply"]]),
          ],
        },
        authors[i % authors.length],
      ),
    );
  }
  return root;
}
