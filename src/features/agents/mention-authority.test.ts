import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto } from "../relay/events";
import { createProfileDirectory } from "../relay/profile-directory";
import type { RelayReader } from "../relay/reader";
import { keypair, signed } from "../relay/testing";
import { mentionAuthority } from "./owner-attestation";

const relay = keypair(),
  owner = keypair(),
  sibling = keypair(),
  agent = keypair(),
  stranger = keypair();
const auth = (key: typeof sibling) => [
  "auth",
  owner.pubkey,
  "",
  bytesToHex(
    schnorr.sign(
      createHash("sha256").update(`nostr:agent-auth:${key.pubkey}:`).digest(),
      owner.secret,
    ),
  ),
];
const message = (key: typeof owner, tags: string[][] = []) =>
  eventDto(signed(key, { kind: 9, content: "@agent go", tags }));
const workflow = (creator: string, mention = true) =>
  message(relay, [
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", creator],
    ...(mention ? [["buzz:workflow-mention", agent.pubkey]] : []),
  ]);
const check = (read = vi.fn(async () => [] as never[])) => ({
  authority: relay.pubkey,
  agent: agent.pubkey,
  profiles: createProfileDirectory({ read } as unknown as RelayReader).queries,
});

it("accepts the owner and an attested sibling", async () => {
  expect(await mentionAuthority(message(owner), owner.pubkey, check())).toBe(
    "owner",
  );
  expect(
    await mentionAuthority(
      message(sibling, [auth(sibling)]),
      owner.pubkey,
      check(),
    ),
  ).toBe("owner");
});

it("refuses someone else's message with no reason", async () => {
  expect(
    await mentionAuthority(message(stranger), owner.pubkey, check()),
  ).toBeUndefined();
  // Without a workflow check, as plugin harnesses call it.
  expect(
    await mentionAuthority(workflow(owner.pubkey), owner.pubkey),
  ).toBeUndefined();
});

it("accepts the owner's workflow only when it names this agent", async () => {
  expect(
    await mentionAuthority(workflow(owner.pubkey), owner.pubkey, check()),
  ).toBe("owner");
  expect(
    await mentionAuthority(
      workflow(owner.pubkey, false),
      owner.pubkey,
      check(),
    ),
  ).toBe("workflow");
});

it("refuses someone else's workflow with no reason", async () => {
  expect(
    await mentionAuthority(workflow(stranger.pubkey), owner.pubkey, check()),
  ).toBeUndefined();
});

it("gives no reason while the creator's profile can't be read", async () => {
  const read = vi.fn(async () => {
    throw new Error("offline");
  });
  expect(
    await mentionAuthority(workflow(sibling.pubkey), owner.pubkey, check(read)),
  ).toBeUndefined();
});

it("gives no reason for a workflow whose creator's profile isn't read yet", async () => {
  const read = vi.fn(async () => [] as never[]);
  for (const creator of [sibling.pubkey, stranger.pubkey])
    expect(
      await mentionAuthority(
        workflow(creator, false),
        owner.pubkey,
        check(read),
      ),
    ).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it("names a sibling's workflow from its already-read profile", async () => {
  const profile = eventDto(
    signed(sibling, {
      kind: 0,
      created_at: 100,
      content: JSON.stringify({ owner: owner.pubkey, is_agent: true }),
      tags: [auth(sibling)],
    }),
  );
  const read = vi.fn(async () => [profile]);
  const siblingCheck = check(read as never);
  expect(
    await mentionAuthority(
      workflow(sibling.pubkey),
      owner.pubkey,
      siblingCheck,
    ),
  ).toBe("owner");
  expect(
    await mentionAuthority(
      workflow(sibling.pubkey, false),
      owner.pubkey,
      siblingCheck,
    ),
  ).toBe("workflow");
  expect(read).toHaveBeenCalledOnce();
});
