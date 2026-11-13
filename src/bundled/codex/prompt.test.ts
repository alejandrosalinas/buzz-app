import { expect, it } from "vitest";
import { MENTION_PROMPT } from "../../features/agent-harness/base-prompt";
import type { EventData } from "../../features/relay/events";
import { developerInstructions, turnInput } from "./prompt";

const event = {
  id: "1".repeat(64),
  pubkey: "a".repeat(64),
  kind: 9,
  created_at: 1_800_000_000,
  content: "@Codex what changed?",
  tags: [["h", "chan"]],
  sig: "",
} as EventData;
const conversation = { channelId: "chan", name: "general", root: event.id };

it("permits the runtime's agent CLI provider without credential or owner fallback", () => {
  const instructions = developerInstructions({
    name: "Codex",
    pubkey: "b".repeat(64),
  });
  expect(instructions).toContain("Prefer these tools for Buzz operations.");
  expect(instructions).toContain("You may use the buzz CLI");
  expect(instructions).toContain("agent-specific BUZZ_CREDENTIAL_PROVIDER");
  expect(instructions).toContain(
    "use the available Buzz tools or report the blocker",
  );
  expect(instructions).toContain(
    "Do not look for credentials, read private keys",
  );
  expect(instructions).toContain(
    "change the provider, or pair the CLI as your owner",
  );
  expect(instructions).not.toContain("Do not invoke the buzz CLI");
});

it("tells a turn a mention starts what it owes the mention, and a wake's turn nothing of the kind", () => {
  const asked = turnInput("agent", event, conversation, "what changed?");
  expect(asked).toContain(`${MENTION_PROMPT}\n<buzz-event>`);
  expect(
    turnInput("agent", event, conversation, "what changed?", true),
  ).toContain(MENTION_PROMPT);
  const woken = turnInput("agent", event, conversation, "", false, undefined, {
    type: "attention",
    channel: "chan",
    root: event.id,
    text: '<watch-task>\nThis turn was started by watch "w".\n</watch-task>',
    id: "w".repeat(64),
    at: 1_800_000_000_000,
  });
  expect(woken).not.toContain("<mention>");
  expect(woken).not.toContain("MUST reply");
  // What a mention is owed is no longer in every turn's prompt.
  const instructions = developerInstructions({
    name: "Codex",
    pubkey: "b".repeat(64),
  });
  expect(instructions).not.toContain("MUST reply");
  expect(instructions).not.toContain("MUST publish");
});

it("names the agent's workspace for a thread in a conversation folder", () => {
  const agent = { name: "Codex", pubkey: "b".repeat(64) };
  const own = developerInstructions(agent, "/home/me/.buzz");
  expect(own).toContain(
    "Your persistent workspace is at `/home/me/.buzz`, not in your working directory",
  );
  expect(own).toContain("do not create them in your working directory");
  expect(developerInstructions(agent)).toContain(
    "Your persistent workspace is in your working directory:",
  );
});
