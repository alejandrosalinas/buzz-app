import { describe, expect, it } from "vitest";

import { sameDirectMessage } from "./direct-message-policy";

const viewer = "a".repeat(64);
const taylor = "b".repeat(64);
const robin = "c".repeat(64);
const agent = "d".repeat(64);
const isAgent = (key: string) => key === agent;

describe("sameDirectMessage", () => {
  it("never shows a DM of one person and their agents once a person is added", () => {
    const agentOnly = [viewer, agent];
    expect(sameDirectMessage(agentOnly, new Set(agentOnly), isAgent)).toBe(
      true,
    );
    expect(
      sameDirectMessage(agentOnly, new Set([viewer, agent, taylor]), isAgent),
    ).toBe(false);
    expect(
      sameDirectMessage(agentOnly, new Set([viewer, taylor]), isAgent),
    ).toBe(false);
  });

  it("matches a DM of two or more people by its people", () => {
    expect(
      sameDirectMessage(
        [viewer, taylor, agent],
        new Set([viewer, taylor]),
        isAgent,
      ),
    ).toBe(true);
    expect(
      sameDirectMessage(
        [viewer, taylor],
        new Set([viewer, taylor, robin]),
        isAgent,
      ),
    ).toBe(false);
  });
});
