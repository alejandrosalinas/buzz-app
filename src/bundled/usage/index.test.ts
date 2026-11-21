// @vitest-environment node
import { expect, it } from "vitest";
import { USAGE_CARD, usageOn } from "../../features/agents/standalone-sessions";
import { apply } from "./index";
import manifest from "./manifest.json";

it("registers the card runtimes ask before they record a one-off turn", () => {
  const registered: string[] = [];
  apply({
    settingsCards: {
      register: (card: { id: string }) =>
        registered.push(`${manifest.id}/${card.id}`),
    },
  } as never);
  expect(registered).toEqual([USAGE_CARD]);
  const cards = new Set<string>();
  const on = usageOn({ has: (key) => cards.has(key) });
  expect(on()).toBe(false);
  cards.add(USAGE_CARD);
  expect(on()).toBe(true);
});
