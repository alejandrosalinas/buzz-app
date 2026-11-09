import { npubEncode } from "nostr-tools/nip19";
import { expect, it, vi } from "vitest";
import type { ComposerSession } from "../../features/messages/composer-session";
import { fetchMentionDirectoryPage } from "./useMentionDirectory";

it("keeps a verified person when a refined query matches only their verified full name", async () => {
  const fake = { pubkey: "a".repeat(64), name: "Fake" };
  const other = { pubkey: "b".repeat(64), name: "Fake" };
  const shared = new Map([
    [
      fake.pubkey,
      {
        name: "fname",
        verified: { displayName: "fname", fullName: "Fake Name" },
      },
    ],
  ]);
  const people = vi.fn(async () => ({
    people: [fake, other],
    hasMore: false,
  }));
  const session = {
    directMessages: { people },
    profiles: { snapshot: () => shared },
  } as unknown as ComposerSession;
  const signal = new AbortController().signal;
  await fetchMentionDirectoryPage(session, "fake", signal);
  // The complete page for "fake" answers "fake n" without another read.
  const refined = await fetchMentionDirectoryPage(session, "fake n", signal);
  expect(people).toHaveBeenCalledOnce();
  expect(refined.people).toEqual([fake]);
});

const avery = { pubkey: "a".repeat(64), name: "Avery" };
it.each([
  ["npub", npubEncode(avery.pubkey)],
  ["nostr: npub", `nostr:${npubEncode(avery.pubkey)}`],
  ["uppercase hex key", avery.pubkey.toUpperCase()],
])(
  "reads the person a pasted %s names, not a cached name-prefix page",
  async (_case, key) => {
    const people = vi.fn(async (query: string) => ({
      people: [query === key ? avery : { pubkey: "b".repeat(64), name: "B" }],
      hasMore: false,
    }));
    const session = {
      directMessages: { people },
      profiles: { snapshot: () => new Map() },
    } as unknown as ComposerSession;
    const signal = new AbortController().signal;
    await fetchMentionDirectoryPage(session, key.slice(0, 8), signal);
    // A complete page for the start of a key cannot answer its author lookup.
    expect(await fetchMentionDirectoryPage(session, key, signal)).toEqual({
      people: [avery],
      more: false,
    });
    expect(people).toHaveBeenCalledTimes(2);
  },
);
