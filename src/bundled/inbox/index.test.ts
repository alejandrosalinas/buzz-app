// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";
import manifest from "./manifest.json";

afterEach(() => vi.restoreAllMocks());
it("opens the Activity page with filters from four chords, including from the composer", () => {
  const shortcuts = { register: vi.fn() };
  const pages = { register: vi.fn() };
  const open = vi.fn();
  apply({
    pages,
    relay: {},
    navigation: { open },
    shortcuts,
  } as unknown as Parameters<typeof apply>[0]);
  const registered = shortcuts.register.mock.calls.map(([item]) => item);
  const cases = [
    [
      "open-unread",
      "Open unread in Activity",
      "a",
      { activity: "all", attention: "unread" },
    ],
    ["open-threads", "Open threads in Activity", "t", { activity: "threads" }],
    [
      "open-mentions",
      "Open mentions in Activity",
      "m",
      { activity: "mentions" },
    ],
    ["open-dms", "Open DMs in Activity", "k", { activity: "dms" }],
  ] as const;
  // No other Activity shortcut: Archive was removed with the Archived view.
  expect(registered.map((item) => item.id)).toEqual(cases.map(([id]) => id));
  const orders = new Set<number>();
  for (const [id, title, key, params] of cases) {
    const shortcut = registered.find((item) => item.id === id);
    expect(shortcut).toMatchObject({
      title,
      binding: { key, mod: true, shift: true },
      allowInEditable: true,
    });
    expect(shortcut.when).toBeUndefined();
    orders.add(shortcut.order);
    open.mockClear();
    shortcut.run();
    expect(open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 1, params },
    });
  }
  expect(orders.size).toBe(4);
  const [page] = pages.register.mock.calls[0] ?? [];
  // Shown as Activity; the page id and route stay "inbox".
  expect(page).toMatchObject({ id: "inbox", title: "Activity" });
  expect(page.route.version).toBe(1);
  expect(page.route.validate({ activity: "threads" })).toBe(true);
  expect(page.route.validate({ activity: "bogus" })).toBe(false);
  expect(page.handlesNavigation).toBeUndefined();
});

it("names the plugin Activity while keeping its buzz.inbox id", () => {
  expect(manifest).toMatchObject({ id: "buzz.inbox", name: "Activity" });
});
