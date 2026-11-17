import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import { eventDto, type RelayEvent } from "../relay/events";
import { createProfileDirectory } from "../relay/profile-directory";
import type { RelayReader } from "../relay/reader";
import { keypair, signed } from "../relay/testing";
import { fromOwner } from "./service";

const relay = keypair(),
  owner = keypair(),
  creator = keypair(),
  target = keypair(),
  stranger = keypair();
const auth = (key = creator, human = owner, conditions = "") => [
  "auth",
  human.pubkey,
  conditions,
  bytesToHex(
    schnorr.sign(
      createHash("sha256")
        .update(`nostr:agent-auth:${key.pubkey}:${conditions}`)
        .digest(),
      human.secret,
    ),
  ),
];
const profile = (tags = [auth()], key = creator) =>
  eventDto(
    signed(key, {
      kind: 0,
      created_at: 100,
      content: JSON.stringify({ owner: owner.pubkey, is_agent: true }),
      tags,
    }),
  );
const prompt = (
  tags = [["buzz:workflow-mention", target.pubkey]],
  key = relay,
) =>
  eventDto(
    signed(key, {
      kind: 9,
      content: "@target workflow",
      tags: [
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", creator.pubkey],
        ...tags,
      ],
    }),
  );
function directory(read = vi.fn(async () => [profile()])) {
  const profiles = createProfileDirectory({ read } as unknown as RelayReader);
  return {
    profiles,
    read,
    context: {
      authority: relay.pubkey,
      agent: target.pubkey,
      profiles: profiles.queries,
    },
  };
}

it("authorizes an agent-owned workflow through the community's signed profile directory", async () => {
  const f = directory();
  try {
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(true);
    expect(
      await fromOwner(
        prompt([["buzz:workflow-mention", creator.pubkey]]),
        owner.pubkey,
        { ...f.context, agent: creator.pubkey },
      ),
    ).toBe(true);
    expect(f.read).toHaveBeenCalledWith(
      [{ kinds: [0], authors: [creator.pubkey], limit: 500 }],
      expect.anything(),
    );
    expect(await fromOwner(prompt(), stranger.pubkey, f.context)).toBe(false);
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(true);
    expect(f.read).toHaveBeenCalledOnce();
  } finally {
    f.profiles.dispose();
  }
});

it.each([
  { name: "unsigned workflow copy", event: { ...prompt() } },
  { name: "wrong relay signer", event: prompt(undefined, stranger) },
  { name: "legacy routing only", event: prompt([["p", target.pubkey]]) },
])("does not read profiles for $name", async ({ event }) => {
  const f = directory();
  try {
    expect(await fromOwner(event, owner.pubkey, f.context)).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
  } finally {
    f.profiles.dispose();
  }
});

it.each([
  { name: "metadata without attestation", event: profile([]) },
  { name: "different human owner", event: profile([auth(creator, stranger)]) },
  { name: "borrowed attestation", event: profile([auth(stranger)]) },
  {
    name: "invalid attestation",
    event: profile([["auth", owner.pubkey, "", "0".repeat(128)]]),
  },
  { name: "duplicated attestation", event: profile([auth(), auth()]) },
  {
    name: "unsatisfied conditions",
    event: profile([auth(creator, owner, "kind=9")]),
  },
  { name: "unadmitted copy", event: { ...profile() } },
  { name: "wrong profile signer", event: profile([auth(stranger)], stranger) },
  {
    name: "wrong event kind",
    event: eventDto(signed(creator, { kind: 9, content: "", tags: [auth()] })),
  },
])("rejects creator profile with $name", async ({ event }) => {
  const ensure = vi.fn(async () => {});
  expect(
    await fromOwner(prompt(), owner.pubkey, {
      authority: relay.pubkey,
      agent: target.pubkey,
      profiles: { ensure, event: () => event as RelayEvent },
    }),
  ).toBe(false);
});

it("recovers from failed or missing reads and respects a replaced profile head", async () => {
  const read = vi.fn(async () => [profile()]);
  read
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce([]);
  const f = directory(read);
  try {
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(false);
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(false);
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    f.profiles.accept([
      eventDto(
        signed(creator, { kind: 0, created_at: 101, content: "{}", tags: [] }),
      ),
    ]);
    expect(await fromOwner(prompt(), owner.pubkey, f.context)).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    f.profiles.dispose();
  }
});

it("denies a profile read invalidated by session disposal", async () => {
  let release!: (events: RelayEvent[]) => void;
  const pending = new Promise<RelayEvent[]>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(() => pending);
  const f = directory(read);
  const result = fromOwner(prompt(), owner.pubkey, f.context);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  f.profiles.dispose();
  release([profile()]);
  expect(await result).toBe(false);
});
