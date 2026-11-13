// The Bestie tools: which of its owner's agents new Solo chats in this
// community start with, as Make my bestie saves it. An agent running here can
// read and change it for its owner.
import type { BuzzClient } from "./client";
import type { Tool } from "./tools";

const none = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const BESTIE_TOOLS: readonly Tool[] = [
  {
    name: "bestie_get",
    description:
      "Your owner's Bestie in this community, the agent new Solo chats start with: device is the agent saved on this device and account the one saved to their account, null for none; here says whether device's agent is one your owner can tag here.",
    inputSchema: none,
    annotations: { readOnlyHint: true },
  },
  {
    name: "bestie_set",
    description:
      "Make one of your owner's agents in this community their Bestie, saved on this device and their account as Make my bestie saves it. Unlike Make my bestie, it doesn't turn on Remembers you; your owner does that in the agent's Bestie tab. The answer is bestie_get's.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's pubkey (hex)." },
      },
      required: ["agent"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "bestie_clear",
    description:
      "Save that your owner has no Bestie, on this device and their account, as Remove as bestie does. The answer is bestie_get's.",
    inputSchema: none,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export const isBestieTool = (name: string) =>
  BESTIE_TOOLS.some((tool) => tool.name === name);

/** Runs Bestie tool `name` as `client`. A throw is a tool error. */
export async function callBestieTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  const tool = BESTIE_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const extra = Object.keys(args).filter(
    (arg) => !Object.hasOwn(tool.inputSchema.properties, arg),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  const { bestie } = client;
  if (!bestie)
    throw new Error(
      "Your owner's Bestie can't be changed from this connection.",
    );
  if (name === "bestie_get") return JSON.stringify(await bestie.read());
  if (name === "bestie_clear") return JSON.stringify(await bestie.clear());
  if (typeof args.agent !== "string")
    throw new Error("agent must be the agent's pubkey.");
  return JSON.stringify(await bestie.set(args.agent));
}
