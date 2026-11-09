import { expect, it } from "vitest";
import { agentExecution } from "./execution-location";

it("keeps unknown execution distinct from local, including an unavailable harness", () => {
  expect(agentExecution({ place: "hosted" })).toBe("remote");
  expect(agentExecution({ place: "here" })).toBe("local");
  expect(agentExecution({ place: "elsewhere" })).toBeUndefined();
  expect(agentExecution({ place: "elsewhere" }, {})).toBe("local");
});

it("keeps a native agent with a remote execution binding distinct from local custody", () => {
  expect(
    agentExecution({
      place: "here",
      executionBinding: { provider: "internal/remote" },
    }),
  ).toBe("remote");
});
