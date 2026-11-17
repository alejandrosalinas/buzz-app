import { expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  allowsOutsideMentions,
  mentionAdmission,
  outsideMentionReferences,
  pastedMentionRecipient,
} from "./mention-admission";

const member = "a".repeat(64);
const outside = "b".repeat(64);
const library = "c".repeat(64);
const archived = "e".repeat(64);

function session(
  channel: Record<string, unknown> | undefined,
  viewer?: string,
  complete = true,
): RelaySession {
  return {
    viewer,
    channels: {
      list: () => ({
        status: "ready",
        channels: channel
          ? [{ id: "channel", members: [member, archived], ...channel }]
          : [],
      }),
    },
    agentChoices: {
      snapshot: () => ({
        identities: [{ pubkey: library, name: "Honey" }],
        complete,
      }),
    },
    archives: {
      state: (key: string) => (key === archived ? "archived" : "active"),
      snapshot: () => ({ status: "ready", archived: [archived] }),
    },
  } as unknown as RelaySession;
}

it("admits any valid key where outside people can be named", () => {
  for (const channelType of ["stream", "forum", "dm"]) {
    const admits = mentionAdmission(session({ channelType }), "channel");
    expect(admits(member)).toBe(true);
    // Not offered by any chooser; delivery asks before addressing it.
    expect(admits(outside)).toBe(true);
  }
});

it("keeps Solo chat, roster and agent-invite limits", () => {
  const sessionChannel = session({ channelType: "solo" });
  const plain = mentionAdmission(sessionChannel, "channel");
  expect(plain(member)).toBe(true);
  // Without Solo mode (media comments, edits) only members are offered.
  expect(plain(outside)).toBe(false);
  expect(plain(library)).toBe(false);
  // In Solo mode outside keys are references; delivery never adds them.
  const inviting = mentionAdmission(sessionChannel, "channel", true);
  expect(inviting(library)).toBe(true);
  expect(inviting(outside)).toBe(true);
  // Until the agent read is complete, an outside key may be the viewer's
  // agent, so none is admitted; the agents it lists still are.
  const reading = mentionAdmission(
    session({ channelType: "solo" }, undefined, false),
    "channel",
    true,
  );
  expect(reading(library)).toBe(true);
  expect(reading(outside)).toBe(false);
  // The owner's roster leaves a member out on purpose; naming outside people
  // does not bring that member back.
  const owned = mentionAdmission(sessionChannel, "channel", true, [
    { pubkey: library, name: "Honey" },
  ]);
  expect(owned(library)).toBe(true);
  expect(owned(outside)).toBe(true);
  expect(owned(member)).toBe(false);
  // A roster that leaves out one of the viewer's agents (a region's plugin
  // refuses it) keeps it out: the send would add it, not reference it.
  const narrowed = mentionAdmission(sessionChannel, "channel", true, []);
  expect(narrowed(library)).toBe(false);
  expect(narrowed(outside)).toBe(true);
  // Unknown Solo membership cannot tell outside keys from left-out members.
  expect(
    mentionAdmission(
      session({ channelType: "solo", members: undefined }),
      "channel",
      true,
      [{ pubkey: library, name: "Honey" }],
    )(outside),
  ).toBe(false);
  // Agent invitation never admits directory people in other channels.
  expect(
    mentionAdmission(
      session({ channelType: "stream" }),
      "channel",
      true,
    )(outside),
  ).toBe(false);
  expect(
    mentionAdmission(session({ channelType: "dm" }), "channel", true)(library),
  ).toBe(false);
  const roster = [{ pubkey: outside, name: "Wes" }];
  const draft = mentionAdmission(session(undefined), "draft", false, roster);
  expect(draft(outside)).toBe(true);
  expect(draft(member)).toBe(false);
  expect(mentionAdmission(session(undefined), "unknown")(outside)).toBe(false);
});

it("refuses invalid keys, archived identities and closed destinations", () => {
  const admits = mentionAdmission(
    session({ channelType: "stream" }),
    "channel",
  );
  expect(admits("A".repeat(64))).toBe(false);
  expect(admits("abc")).toBe(false);
  expect(admits(archived)).toBe(false);
  const viewer = session({ channelType: "solo" }, archived);
  expect(mentionAdmission(viewer, "channel")(archived)).toBe(true);
  for (const closed of [{ archived: true }, { readOnly: true }])
    expect(
      mentionAdmission(
        session({ channelType: "stream", ...closed }),
        "channel",
      )(member),
    ).toBe(false);
});

it("names a pasted recipient from current state, and leaves an unknown outsider display-only", () => {
  const base = session({ channelType: "stream" });
  const profiles = new Map([[outside, { name: "Jane" }]]);
  const withProfiles = {
    ...base,
    profiles: { snapshot: () => profiles },
  } as unknown as RelaySession;
  expect(pastedMentionRecipient(withProfiles, "channel", outside)).toEqual({
    pubkey: outside,
    name: "Jane",
  });
  expect(pastedMentionRecipient(withProfiles, "channel", member)).toEqual({
    pubkey: member,
    name: member.slice(0, 12),
  });
  expect(pastedMentionRecipient(withProfiles, "channel", library)).toEqual({
    pubkey: library,
    name: "Honey",
  });
  expect(pastedMentionRecipient(withProfiles, "channel", "f".repeat(64))).toBe(
    null,
  );
  expect(pastedMentionRecipient(withProfiles, "channel", archived)).toBe(null);
});

it("names outsiders only as references in DMs and Solo chats", () => {
  const agents = [{ pubkey: library }];
  expect(outsideMentionReferences({ channelType: "dm" }, agents, library)).toBe(
    true,
  );
  expect(
    outsideMentionReferences({ channelType: "solo" }, agents, outside),
  ).toBe(true);
  // The viewer's own agent joins a Solo chat instead.
  expect(
    outsideMentionReferences({ channelType: "solo" }, agents, library),
  ).toBe(false);
  // Streams and forums ask whether to add outside people.
  for (const channelType of ["stream", "forum"] as const)
    expect(outsideMentionReferences({ channelType }, agents, outside)).toBe(
      false,
    );
});

it("opens Solo chats to outside names only in Solo mode", () => {
  const solo = { channelType: "solo" as const };
  const roster = [{ pubkey: library, name: "Honey" }];
  // Media comments and edits do not invite agents, even under the owner's
  // roster.
  expect(allowsOutsideMentions(solo)).toBe(false);
  expect(allowsOutsideMentions(solo, roster)).toBe(false);
  expect(allowsOutsideMentions(solo, undefined, true)).toBe(true);
  expect(allowsOutsideMentions(solo, roster, true)).toBe(true);
  const stream = { channelType: "stream" as const };
  expect(allowsOutsideMentions(stream)).toBe(true);
  expect(allowsOutsideMentions(stream, roster)).toBe(false);
  expect(allowsOutsideMentions(stream, undefined, true)).toBe(false);
  expect(allowsOutsideMentions(undefined, roster, true)).toBe(false);
});
