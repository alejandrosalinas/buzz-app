// @vitest-environment node
import { expect, it } from "vitest";
import type { SessionUsage } from "./service";
import { withRevision, withWakes } from "./session-usage";

const session = (id: string): SessionUsage => ({
  id,
  revision: `r-${id}`,
  gaps: [],
  startedAt: 1,
  lastAt: 2,
  observations: [],
});

it("fills in the wake of the sessions a harness saved one for, its revision covering it", async () => {
  const filled = await withWakes(
    [session("a"), session("b"), session("c")],
    [
      { id: "a", wake: "timer/daily" },
      { id: "b" },
      { id: "z", wake: "watch/gone" },
    ],
  );
  expect(filled).toEqual([
    { ...session("a"), wake: "timer/daily", revision: expect.any(String) },
    session("b"),
    session("c"),
  ]);
  const { revision: _revision, ...usage } = filled[0] ?? session("a");
  expect(filled[0]?.revision).toBe((await withRevision(usage)).revision);
  const other = await withWakes(
    [session("a")],
    [{ id: "a", wake: "timer/hourly" }],
  );
  expect(other[0]?.revision).not.toBe(filled[0]?.revision);
});

it("returns the sessions as they are when none has a saved start", async () => {
  const sessions = [session("a")];
  await expect(withWakes(sessions, [])).resolves.toEqual(sessions);
});
