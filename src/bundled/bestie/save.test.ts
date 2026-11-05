import { expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import { checkinHourly, memory, withFeature } from "./features";
import { cannotEdit, saveFeature } from "./save";

it("refuses to turn on a section edited by hand, saving nothing", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = { save, types: () => [] };
  const instructions = withFeature(
    withFeature("Be brief.", memory, true),
    checkinHourly,
    true,
  ).replace("<!-- /buzz:bestie/checkin.hourly -->", "");
  const agent = {
    key: "a".repeat(64),
    attention: {},
    config: { instructions },
  } as unknown as Agent;
  await expect(
    saveFeature(agents, agent, checkinHourly, true, { channel: "dm" }),
  ).rejects.toThrow("restore it first");
  // Its timer would otherwise be saved first, leaving half of it on.
  expect(save).not.toHaveBeenCalled();
});

const hosted = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  place: "hosted",
  type: "test/cloud",
  attention: {},
} as unknown as Agent;

it("lets a hosted agent's provider take memory, not a timer, and no other remote agent", () => {
  const provider = { get: vi.fn(), set: vi.fn() };
  const agents = {
    save: vi.fn(),
    types: () => [],
    hostedInstructions: () => provider,
  };
  expect(cannotEdit(agents, hosted, memory)).toBeUndefined();
  expect(cannotEdit(agents, hosted, checkinHourly)).toBe(
    "Not available with remote agents yet.",
  );
  expect(cannotEdit(agents, hosted)).toBe(
    "Not available with remote agents yet.",
  );
  expect(
    cannotEdit(
      { ...agents, hostedInstructions: () => undefined },
      hosted,
      memory,
    ),
  ).toBe("Not available with remote agents yet.");
  expect(
    cannotEdit(agents, { ...hosted, place: "elsewhere" } as Agent, memory),
  ).toBe("Not available with remote agents yet.");
});

it("saves a hosted agent's feature through its provider, not Agents", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const set = vi.fn(async () => {});
  const agents = {
    save,
    types: () => [],
    hostedInstructions: () => ({ get: vi.fn(), set }),
  };
  const agent = {
    ...hosted,
    config: { instructions: "Be brief." },
  } as unknown as Agent;
  await saveFeature(agents, agent, memory, true);
  // The provider replaces only the copy the switch showed.
  expect(set).toHaveBeenCalledWith(
    withFeature("Be brief.", memory, true),
    "Be brief.",
  );
  expect(save).not.toHaveBeenCalled();
});
