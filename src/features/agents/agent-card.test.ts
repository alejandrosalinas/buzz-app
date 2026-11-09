import { afterEach, expect, it, vi } from "vitest";
import {
  agentCardCdn,
  agentCardShares,
  fetchAgentCard,
  parseAgentCard,
} from "./agent-card";

const card = {
  v: 1,
  id: "tinker",
  name: " Tinker ",
  description: "Builds things.",
  model: "opus-5-5",
  avatarUrl: "https://cdn.example/tinker/r1/avatar.png",
  instructions: "You are Tinker.\n",
};
const cdn = "https://cdn.example";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reads the card's name, avatar and instructions, ignoring other keys", () => {
  expect(parseAgentCard(card, "tinker")).toEqual({
    name: "Tinker",
    picture: "https://cdn.example/tinker/r1/avatar.png",
    instructions: "You are Tinker.",
  });
  const { instructions: _instructions, ...bare } = card;
  expect(parseAgentCard(bare, "tinker").instructions).toBe("");
});

it("refuses a card for another id, without a name or HTTPS avatar, or with hidden text", () => {
  for (const invalid of [
    null,
    [],
    { ...card, id: "occam" },
    { ...card, name: " " },
    { ...card, avatarUrl: "http://cdn.example/a.png" },
    { ...card, avatarUrl: 3 },
    { ...card, instructions: 3 },
    { ...card, instructions: "hi\u200bthere" },
  ])
    expect(() => parseAgentCard(invalid, "tinker")).toThrow(
      "This agent card is invalid.",
    );
});

it("uses the staging CDN only for a staging build", () => {
  expect(agentCardCdn("https://app.builderlabstaging.xyz/")).toBe(
    "https://d10hx6rb3fdt3l.cloudfront.net",
  );
  for (const build of ["https://app.builderlab.xyz", "", "not a url"])
    expect(agentCardCdn(build)).toBe("https://d2z0pbxrxbsiz5.cloudfront.net");
});

it("pairs each build's cards with that environment's share pages", () => {
  expect(agentCardShares("https://app.builderlabstaging.xyz")).toEqual({
    "app.builderlabstaging.xyz": "a",
  });
  expect(agentCardShares("not a url")).toEqual({
    "app.builderlab.xyz": "a",
    "builderlab.xyz": "agents",
  });
});

it("fetches the card from the CDN without credentials or redirects", async () => {
  const fetch = vi.fn(async () => Response.json(card));
  vi.stubGlobal("fetch", fetch);
  await expect(
    fetchAgentCard("tinker", new AbortController().signal, cdn),
  ).resolves.toMatchObject({ name: "Tinker" });
  expect(fetch).toHaveBeenCalledWith(
    "https://cdn.example/tinker/agent.json",
    expect.objectContaining({ redirect: "error", credentials: "omit" }),
  );
});

it("explains a missing, failing, oversized or unreadable card", async () => {
  const signal = new AbortController().signal;
  const cases: [() => Promise<Response>, string][] = [
    async () => new Response("", { status: 404 }),
    async () => new Response("", { status: 403 }),
    async () => new Response("", { status: 500 }),
    async () => {
      throw new TypeError("offline");
    },
    async () =>
      new Response("{}", {
        headers: { "content-length": String(3 * 1024 * 1024) },
      }),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    async () => new Response("not json"),
  ].map((respond, index) => [
    respond,
    [
      "This agent card isn’t available.",
      "This agent card isn’t available.",
      "Couldn’t load this agent card. Try again later.",
      "Couldn’t load this agent card. Check your connection and try again.",
      "This agent card is too large.",
      "This agent card is too large.",
      "This agent card is invalid.",
    ][index] as string,
  ]);
  for (const [respond, message] of cases) {
    vi.stubGlobal("fetch", vi.fn(respond));
    await expect(fetchAgentCard("tinker", signal, cdn)).rejects.toThrow(
      message,
    );
  }
  await expect(fetchAgentCard("../x", signal, cdn)).rejects.toThrow(
    "This agent card is invalid.",
  );
});
