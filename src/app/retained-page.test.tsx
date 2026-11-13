// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { PageNavigation } from "../features/navigation/service";
import type { PageProps } from "../features/pages/service";
import { App } from "./App";
import { createServices, type AppServices } from "./services";

// The page acknowledges only while `answer` is set; otherwise it stays silent.
// `gate` is a Settings card's authorization, which can still be loading.
const page = vi.hoisted(() => ({
  answer: true,
  gate: true as boolean | "pending",
  listeners: new Set<() => void>(),
  // The request the page last received, as the page itself holds it.
  navigation: undefined as PageNavigation | undefined,
}));
function setGate(gate: boolean | "pending") {
  page.gate = gate;
  for (const listener of page.listeners) listener();
}
function Held({ navigation }: PageProps) {
  useEffect(() => {
    page.navigation = navigation;
    if (page.answer) navigation?.complete({ status: "opened" });
  }, [navigation]);
  return <p>Held content</p>;
}
// Counts renders of the app shell, which a page's request does not need.
const shell = vi.hoisted(() => ({ renders: 0 }));
vi.mock("./shell/AppShell", async (original) => {
  const actual = await original<typeof import("./shell/AppShell")>();
  return {
    ...actual,
    AppShell(props: Parameters<typeof actual.AppShell>[0]) {
      shell.renders++;
      return <actual.AppShell {...props} />;
    },
  };
});
vi.mock("../bundled", () => ({
  bundledPlugins: [
    {
      manifest: { id: "test.held", name: "Held", apiVersion: 1 },
      module: {
        inject: ["pages", "settingsCards"],
        apply(ctx: Context) {
          ctx.settingsCards.register({
            id: "gate",
            title: "Gated",
            group: "Test",
            visibility: {
              snapshot: () => page.gate,
              subscribe(listener) {
                page.listeners.add(listener);
                return () => page.listeners.delete(listener);
              },
              ensure: () => () => {},
            },
            component: () => <p>Gated controls</p>,
          });
          ctx.pages.register({
            id: "other",
            title: "Other",
            component: () => <p>Other content</p>,
          });
          ctx.pages.register({
            id: "held",
            title: "Held",
            handlesNavigation: true,
            route: { version: 1, validate: () => true },
            component: Held,
          });
        },
      },
    },
  ],
}));

beforeEach(() => {
  page.answer = true;
  page.gate = true;
  page.navigation = undefined;
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
let services: AppServices | undefined;
afterEach(async () => {
  cleanup();
  await services?.dispose();
  services = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function start(
  target: Record<string, unknown> = {
    version: 1,
    kind: "page",
    pluginId: "test.held",
    pageId: "held",
  },
  prepare?: (services: AppServices) => void,
) {
  window.history.replaceState(
    null,
    "",
    `/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
  );
  const current = createServices();
  services = current;
  prepare?.(current);
  render(<App services={current} />);
  return current;
}

// The navigation controller's own 15 s deadline, passed on cue. Call it before
// the open starts, since the open sets its timer. Only timeouts are faked, and
// real time still moves them, so Testing Library's waits keep working.
function controlDeadline() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  return () => vi.advanceTimersByTime(15_000);
}

// Text of every node added to the page until the returned stop is called, so a
// card drawn for one commit is still caught.
function recordFrames() {
  const added: string[] = [];
  const collect = (records: MutationRecord[]) => {
    for (const record of records)
      for (const node of record.addedNodes) added.push(node.textContent ?? "");
  };
  const frames = new MutationObserver(collect);
  frames.observe(document.body, { childList: true, subtree: true });
  return () => {
    collect(frames.takeRecords());
    frames.disconnect();
    return added;
  };
}

it("keeps a shown page on screen when a background reopen times out", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // Something reopens the same visit without the person acting; the page
  // does not answer before the deadline.
  page.answer = false;
  const passDeadline = controlDeadline();
  act(() => void current.navigation.retry());
  act(passDeadline);
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    presented: true,
  });
  expect(screen.getByText("Held content")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "This page isn’t available" }),
  ).toBeNull();
});

it("still replaces the page when it reports its own failure", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  act(() => void current.navigation.retry());
  const attempt = current.navigation.snapshot().attempt;
  act(() => {
    current.navigationHost.complete(attempt, {
      status: "failed",
      reason: "unavailable",
    });
  });
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByText("Held content")).toBeNull();
});

it("replaces the page when it reports a timeout itself", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  const previous = page.navigation;
  act(() => void current.navigation.retry());
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const request = page.navigation;
  if (!request) throw new Error("The page received no request");
  // Only the host's own deadline keeps the page: a timeout the page reports
  // before it is a failure of the page's own.
  act(() => {
    expect(request.complete({ status: "failed", reason: "timeout" })).toBe(
      true,
    );
  });
  expect(current.navigation.snapshot().presented).toBeUndefined();
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByText("Held content")).toBeNull();
});

it("replaces a kept page when it reports its own failure after the deadline", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  const previous = page.navigation;
  const passDeadline = controlDeadline();
  act(() => void current.navigation.retry());
  // The page receives the retry as a new request of its own.
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const request = page.navigation;
  if (!request) throw new Error("The page received no request");
  act(passDeadline);
  expect(screen.getByText("Held content")).toBeVisible();
  // The page's own lookup fails after the deadline, through its own request.
  let accepted = false;
  act(() => {
    accepted = request.complete({ status: "failed", reason: "unavailable" });
  });
  expect(accepted).toBe(true);
  expect(
    await screen.findByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  expect(screen.queryByText("Held content")).toBeNull();
});

it("rejects a kept page's late answer once another visit replaced it", async () => {
  const current = start();
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  page.answer = false;
  const previous = page.navigation;
  const passDeadline = controlDeadline();
  act(() => void current.navigation.retry());
  // The page receives the retry as a new request of its own.
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const stale = page.navigation;
  if (!stale) throw new Error("The page received no request");
  act(passDeadline);
  act(() => {
    void current.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "test.held",
      pageId: "other",
    });
  });
  expect(await screen.findByText("Other content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // Another page replaced it: the old page's address, success or failure is refused.
  let answers: boolean[] = [];
  act(() => {
    answers = [
      stale.resolve({ ...stale.target }),
      stale.complete({ status: "opened" }),
      stale.complete({ status: "failed", reason: "unavailable" }),
    ];
  });
  expect(answers).toEqual([false, false, false]);
  expect(current.navigation.snapshot()).toMatchObject({
    status: "opened",
    entry: { target: { pageId: "other" } },
  });
  expect(
    screen.queryByRole("heading", { name: "This page isn’t available" }),
  ).toBeNull();
});

it("keeps a shown Settings section when a background reopen times out", async () => {
  const current = start({
    version: 1,
    kind: "settings",
    section: "appearance",
  });
  expect(
    await screen.findByRole("heading", { name: "Conversations" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // Settings answers each open after its render, so the deadline passes
  // before it draws.
  const frames = recordFrames();
  const passDeadline = controlDeadline();
  act(() => {
    void current.navigation.retry();
    passDeadline();
  });
  expect(
    frames().some((text) => text.includes("This page isn’t available")),
  ).toBe(false);
  expect(screen.getByRole("heading", { name: "Conversations" })).toBeVisible();
  // Its late answer reopens the visit.
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});

it("shows the card when a kept timeout leaves only the loading state", async () => {
  const current = start({
    version: 1,
    kind: "settings",
    section: "test.held/gate",
  });
  expect(await screen.findByText("Gated controls")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  // The section reopens while its authorization reloads: the host draws its
  // loading state instead of the editor, and the deadline passes.
  const passDeadline = controlDeadline();
  act(() => {
    setGate("pending");
    void current.navigation.retry();
  });
  expect(screen.queryByText("Gated controls")).toBeNull();
  act(passDeadline);
  // Nothing of the section was drawn, so the host reports its own failure.
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    reason: "timeout",
  });
  expect(current.navigation.snapshot().presented).toBeUndefined();
  expect(
    screen.getByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  // The card stays once loading ends, and Try again reopens the section.
  act(() => setGate(true));
  expect(
    screen.getByRole("heading", { name: "This page isn’t available" }),
  ).toBeVisible();
  act(() => screen.getByRole("button", { name: "Try again" }).click());
  expect(await screen.findByText("Gated controls")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
});

it("keeps a loading state, not the card, when loading starts after a kept timeout", async () => {
  // Plugin state the test can change and announce, as a restart would.
  let announce = () => {};
  let override: ReturnType<AppServices["plugins"]["snapshot"]> | undefined;
  const current = start(undefined, (services) => {
    const plugins = services.plugins;
    const snapshot = plugins.snapshot;
    vi.spyOn(plugins, "snapshot").mockImplementation(
      () => override ?? snapshot.call(plugins),
    );
    const subscribe = services.plugins.subscribe;
    vi.spyOn(services.plugins, "subscribe").mockImplementation((listener) => {
      const previous = announce;
      announce = () => {
        previous();
        listener();
      };
      return subscribe(listener);
    });
  });
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  const frames = recordFrames();
  // The deadline passes while the page is drawn, and it stays.
  page.answer = false;
  const previous = page.navigation;
  const passDeadline = controlDeadline();
  act(() => void current.navigation.retry());
  await waitFor(() => expect(page.navigation).not.toBe(previous));
  const request = page.navigation;
  if (!request) throw new Error("The page received no request");
  act(passDeadline);
  expect(screen.getByText("Held content")).toBeVisible();
  // Later the page updates its address, and in the same moment its plugin
  // restarts in the background: the host draws its loading state over the
  // kept page, not the card.
  const snapshot = current.plugins.snapshot();
  const held = snapshot.activation["test.held"];
  if (!held) throw new Error("Missing held plugin");
  override = {
    ...snapshot,
    activation: {
      ...snapshot.activation,
      "test.held": { ...held, status: "starting" },
    },
  };
  act(() => {
    expect(
      request.resolve({
        version: 1,
        kind: "page",
        pluginId: "test.held",
        pageId: "held",
        route: { version: 1, params: "a" },
      }),
    ).toBe(true);
    announce();
  });
  expect(screen.queryByText("Held content")).toBeNull();
  expect(current.navigation.snapshot()).toMatchObject({
    status: "failed",
    presented: true,
  });
  // The restart ends and the page answers.
  page.answer = true;
  override = undefined;
  act(() => announce());
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(
    frames().some((text) => text.includes("This page isn’t available")),
  ).toBe(false);
});

it("hands a page its request without rendering the shell again", async () => {
  const current = start({
    version: 1,
    kind: "page",
    pluginId: "test.held",
    pageId: "other",
  });
  expect(await screen.findByText("Other content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  shell.renders = 0;
  act(
    () =>
      void current.navigation.open({
        version: 1,
        kind: "page",
        pluginId: "test.held",
        pageId: "held",
      }),
  );
  expect(await screen.findByText("Held content")).toBeVisible();
  await waitFor(() =>
    expect(current.navigation.snapshot().status).toBe("opened"),
  );
  expect(page.navigation?.entryId).toBe(current.navigation.snapshot().entry.id);
  // The shell renders once for the visit; the request reaches only the page.
  expect(shell.renders).toBe(1);
});
