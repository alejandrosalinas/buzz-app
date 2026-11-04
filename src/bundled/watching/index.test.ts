import { expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import { apply } from "./index";

it("adds Attention to agents on this device only", () => {
  const registerTab = vi.fn<Agents["registerTab"]>();
  const agents = {
    controlAttention: vi.fn(),
    registerTab,
  } as unknown as Agents;
  apply({ agents, relay: {}, navigation: {} } as never);
  const when = registerTab.mock.calls[0]?.[0].when;
  const at = (place: Agent["place"]) => when?.({ place } as Agent);
  // Attention is device-local: a hosted agent has none here.
  expect([at("here"), at("hosted"), at("elsewhere")]).toEqual([
    true,
    false,
    false,
  ]);
});
