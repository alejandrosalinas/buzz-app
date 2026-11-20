import { expect, it } from "vitest";
import { keypair, message, signed } from "../../features/relay/testing";
import { conversationHistory } from "./history";

it("keeps each context message's meaningful tags, not its bookkeeping", async () => {
  const alice = keypair();
  const tags = [
    ["p", alice.pubkey],
    ["t", "release"],
  ];
  const earlier = message(alice, "c", "Earlier", 10, [
    ["auth", alice.pubkey, "kind=9", "8".repeat(128)],
    ...tags,
    ["audience", "agents"],
    ["model", alice.pubkey, "m"],
  ]);
  const history = await conversationHistory(
    message(alice, "c", "Now", 20),
    { channelId: "c", name: "c" },
    async (filters) => (filters[0]?.kinds?.includes(40003) ? [] : [earlier]),
  );
  expect(history).toContain(
    `"content":"Earlier","tags":${JSON.stringify(tags)}`,
  );
  expect(history).not.toContain("8".repeat(128));
});

it("shows an edited message's files as its edit leaves them", async () => {
  const alice = keypair();
  const earlier = message(alice, "c", "Earlier", 10, [
    ["imeta", "url https://relay.test/media/old.png"],
  ]);
  const edit = signed(alice, {
    kind: 40003,
    content: "Edited",
    created_at: 15,
    tags: [
      ["h", "c"],
      ["e", earlier.id],
      ["imeta", "url https://relay.test/media/new.png"],
    ],
  });
  const history = await conversationHistory(
    message(alice, "c", "Now", 20),
    { channelId: "c", name: "c" },
    async (filters) =>
      filters[0]?.kinds?.includes(40003) ? [edit] : [earlier],
  );
  expect(history).toContain(
    `"content":"Edited","tags":${JSON.stringify([
      ["imeta", "url https://relay.test/media/new.png"],
    ])}`,
  );
});

it("shows no files for an edited message whose edit cleared them", async () => {
  const alice = keypair();
  const earlier = message(alice, "c", "Earlier", 10, [
    ["imeta", "url https://relay.test/media/old.png"],
  ]);
  const edit = signed(alice, {
    kind: 40003,
    content: "Cleared",
    created_at: 15,
    tags: [
      ["h", "c"],
      ["e", earlier.id],
    ],
  });
  const history = await conversationHistory(
    message(alice, "c", "Now", 20),
    { channelId: "c", name: "c" },
    async (filters) =>
      filters[0]?.kinds?.includes(40003) ? [edit] : [earlier],
  );
  expect(history).toContain(`"content":"Cleared"}`);
  expect(history).not.toContain("old.png");
});
