import { afterEach, expect, it } from "vitest";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory, homeTarget } from "../navigation/history";
import type { OpenTarget } from "../navigation/targets";
import {
  agentRoute,
  agentTarget,
  historyRoute,
  historyTarget,
} from "../../bundled/agents/routes";
import {
  profileHistoryRoute,
  profileHistoryTarget,
  profileTarget,
} from "../profiles/target";
import {
  historyPresentation,
  type HistorySelection,
} from "./history-presentation";

const pubkey = "a".repeat(64);
const selection: HistorySelection = {
  side: "instructions",
  id: "b".repeat(64),
};
const scope = {
  viewer: "c".repeat(64),
  communityOrigin: "https://relay.example",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

for (const hostKind of ["page", "profile"] as const) {
  it(`${hostKind}: preserves Back/Forward, retires explicit Close and permits a fresh opening`, async () => {
    const base: OpenTarget =
      hostKind === "page"
        ? historyTarget({ ...agentTarget(pubkey), scope }, { agent: pubkey })
        : {
            version: 1,
            kind: "conversation",
            scope,
            channelId: "channel",
            detail: {
              target: profileHistoryTarget(profileTarget(pubkey) as string),
            },
          };
    const target = (selected?: HistorySelection): OpenTarget =>
      base.kind === "page"
        ? historyTarget(base, { agent: pubkey }, selected)
        : ({
            ...base,
            detail: {
              target: profileHistoryTarget(
                (base as Extract<OpenTarget, { kind: "conversation" }>).detail
                  ?.target as string,
                selected,
              ),
            },
          } as OpenTarget);
    const history = createMemoryHistory();
    const host = createNavigationController(history);
    cleanups.push(host.dispose, host.attach());
    const nav = host.navigation;
    const finish = () => {
      if (nav.snapshot().status === "opening")
        host.complete(nav.snapshot().attempt, { status: "opened" });
    };
    cleanups.push(nav.subscribe(finish));
    finish();
    await nav.open(base);
    const underlying = nav.snapshot().entry.id;
    const presentation = () => {
      const address = nav.snapshot().entry.target;
      const selected =
        address.kind === "page"
          ? historyRoute(address.route?.params, agentRoute)
          : address.kind === "conversation" && address.detail
            ? profileHistoryRoute(address.detail.target)
            : undefined;
      return historyPresentation(nav, selected || undefined, target);
    };
    const stale = presentation();
    stale.select(selection);
    expect(nav.snapshot().entry.target).toEqual(target(selection));
    expect(nav.snapshot().entry.id).not.toBe(underlying);
    const pendingCompletion = presentation();
    nav.back();
    expect(nav.snapshot().entry.id).toBe(underlying);
    nav.forward();
    expect(nav.snapshot().entry.target).toEqual(target(selection));
    presentation().select();
    expect(nav.snapshot().entry.id).toBe(underlying);
    nav.back();
    expect(nav.snapshot().entry.target).toEqual(homeTarget);
    nav.forward();
    expect(nav.snapshot().entry.id).toBe(underlying);
    expect(nav.snapshot().canGoForward).toBe(false);
    presentation().select(selection);
    expect(nav.snapshot().entry.target).toEqual(target(selection));
    // Completing a write after Back retires its presentation without replay.
    nav.back();
    pendingCompletion.select();
    expect(nav.snapshot().entry.id).toBe(underlying);
    expect(nav.snapshot().canGoForward).toBe(false);
    await nav.open({ version: 1, kind: "settings", section: "profile" });
    stale.select(selection);
    expect(nav.snapshot().entry.target.kind).toBe("settings");
  });
}

it("gives a locally selected agent a reconstructible underlying visit without adding a stop", async () => {
  const inventory: OpenTarget = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope,
  };
  const history = createMemoryHistory();
  const host = createNavigationController(history);
  cleanups.push(host.dispose, host.attach());
  const nav = host.navigation;
  const finish = () => {
    if (nav.snapshot().status === "opening")
      host.complete(nav.snapshot().attempt, { status: "opened" });
  };
  cleanups.push(nav.subscribe(finish));
  finish();
  await nav.open(inventory);
  historyPresentation(nav, undefined, (selected) =>
    historyTarget(inventory, { agent: pubkey }, selected),
  ).select(selection);
  await Promise.resolve();
  expect(nav.snapshot().entry.target).toEqual(
    historyTarget(inventory, { agent: pubkey }, selection),
  );
  nav.back();
  expect(nav.snapshot().entry.target).toEqual(
    historyTarget(inventory, { agent: pubkey }),
  );
  nav.back();
  expect(nav.snapshot().entry.target).toEqual(homeTarget);
});
