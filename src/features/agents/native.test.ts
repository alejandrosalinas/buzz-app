import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { hasEventProof } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { nativeAgents, unconfirmedAgentEvent } from "./native";
import { importedEmojiPicture } from "./import-picture";

vi.mock("./import-picture", () => ({ importedEmojiPicture: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

const native = nativeAgents();
if (!native) throw new Error("expected native agents under Tauri");
const agent = keypair();
const member = { pubkey: agent.pubkey, relay: "https://relay.example.test" };
const message = signed(agent, { kind: 9, content: "hi", tags: [["h", "c"]] });
const query = (response: unknown) => {
  vi.mocked(invoke).mockResolvedValueOnce(response);
  return native.query(member, [{ kinds: [9] }]);
};

it("prepares the selected source's emoji before importing and passes back native upload notes", async () => {
  const converted = {
    source: "legacy-svg",
    png: "data:image/png;base64,iVBORw0KGgo=",
  };
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      agents: [
        { source: "development", pubkey: agent.pubkey, picture: "other" },
        { source: "installed", pubkey: agent.pubkey, picture: "legacy-svg" },
      ],
    })
    .mockResolvedValueOnce({
      agent: { pubkey: agent.pubkey },
      carry: {},
      notes: [],
    });
  vi.mocked(importedEmojiPicture).mockResolvedValueOnce(converted);
  expect(
    await native.port("installed", agent.pubkey, member.relay, "owner", "type"),
  ).toMatchObject({ agent: { pubkey: agent.pubkey }, notes: [] });
  expect(importedEmojiPicture).toHaveBeenLastCalledWith("legacy-svg");
  expect(invoke).toHaveBeenLastCalledWith("app_agent_port", {
    source: "installed",
    pubkey: agent.pubkey,
    destination: member.relay,
    owner: "owner",
    agentType: "type",
    convertedPicture: converted,
  });
});

it.each(["read", "render"])(
  "still imports with native's warning after a %s failure",
  async (failure) => {
    if (failure === "read")
      vi.mocked(invoke).mockRejectedValueOnce(new Error("Unreadable"));
    else {
      vi.mocked(invoke).mockResolvedValueOnce({
        agents: [
          { source: "installed", pubkey: agent.pubkey, picture: "legacy-svg" },
        ],
      });
      vi.mocked(importedEmojiPicture).mockRejectedValueOnce(
        new Error("No canvas"),
      );
    }
    const result = {
      agent: { pubkey: agent.pubkey },
      carry: {},
      notes: ["Picture was skipped"],
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    expect(
      await native.port(
        "installed",
        agent.pubkey,
        member.relay,
        "owner",
        "type",
      ),
    ).toEqual(result);
    expect(invoke).toHaveBeenLastCalledWith(
      "app_agent_port",
      expect.objectContaining({ convertedPicture: undefined }),
    );
  },
);

it("reads the signed id from an uncertain native publish outcome", () => {
  const id = "a".repeat(64);
  const uncertain = `Agent event ${id} unconfirmed; it may or may not have been accepted`;
  expect(unconfirmedAgentEvent(new Error(uncertain))).toBe(id);
  expect(unconfirmedAgentEvent(uncertain)).toBe(id);
  expect(
    unconfirmedAgentEvent(
      new Error("The community refused the agent event: blocked"),
    ),
  ).toBeUndefined();
});

it("admits the community's events through the relay verifier", async () => {
  const events = await query([JSON.parse(JSON.stringify(message))]);
  expect(events).toMatchObject([{ id: message.id, content: "hi" }]);
  expect(events.every(hasEventProof)).toBe(true);
  expect(invoke).toHaveBeenCalledWith("app_agent_query", {
    ...member,
    filters: [{ kinds: [9] }],
  });
});

it("reads effective edit state through the agent-authenticated native query", async () => {
  const edit = signed(agent, {
    kind: 40003,
    content: "no files",
    tags: [
      ["h", "c"],
      ["e", message.id.toUpperCase()],
    ],
  });
  vi.mocked(invoke).mockResolvedValueOnce({
    effective_edit: 1,
    original: message,
    edit,
  });
  const current = await native.effectiveEdit(member, message.id, "c");
  expect(current.id).toBe(edit.id);
  expect(hasEventProof(current)).toBe(true);
  expect(current.tags.filter((t) => t[0] === "imeta")).toEqual([]);
  expect(invoke).toHaveBeenLastCalledWith("app_agent_query", {
    ...member,
    filters: [
      {
        kinds: [9, 40002, 40008, 45001, 45003],
        ids: [message.id],
        "#h": ["c"],
        effective_edit: 1,
        consistency: "strong",
      },
    ],
  });
});

it.each([
  ["old relay", [message]],
  [
    "unsigned original",
    {
      effective_edit: 1,
      original: { ...message, sig: "0".repeat(128) },
      edit: null,
    },
  ],
  ["wrong channel", { effective_edit: 1, original: message, edit: null }],
])("rejects effective state from %s", async (fault, response) => {
  vi.mocked(invoke).mockResolvedValueOnce(response);
  await expect(
    native.effectiveEdit(
      member,
      message.id,
      fault === "wrong channel" ? "other" : "c",
    ),
  ).rejects.toThrow();
});

it.each([
  ["a forged signature", [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", [{ ...message, content: "bye" }]],
  ["a malformed record", [{ ...message, tags: "h" }]],
  ["one bad event among good ones", [message, { ...message, kind: 7 }]],
  ["a non-array body", { events: [message] }],
])("rejects %s", async (_, response) => {
  await expect(query(response)).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});

it("searches profile names natively and reports a community without the search", async () => {
  const profile = signed(agent, {
    kind: 0,
    content: '{"name":"Wes"}',
    tags: [],
  });
  vi.mocked(invoke).mockResolvedValueOnce([
    JSON.parse(JSON.stringify(profile)),
  ]);
  const found = await native.searchProfiles(member, "wes", 100);
  expect(found).toMatchObject([{ id: profile.id }]);
  expect(found?.every(hasEventProof)).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("app_agent_search_profiles", {
    ...member,
    query: "wes",
    limit: 100,
  });
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await native.searchProfiles(member, "wes", 100)).toBeUndefined();
  vi.mocked(invoke).mockResolvedValueOnce([
    { ...profile, sig: "0".repeat(128) },
  ]);
  await expect(native.searchProfiles(member, "wes", 100)).rejects.toThrow(
    /malformed or invalidly signed/,
  );
});
