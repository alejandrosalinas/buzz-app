// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeveloperSettings } from "./DeveloperSettings";
import { logLevel, setLogLevel } from "../features/developer/logging";
import type { RelayData } from "../features/relay/service";
const relay = { clearCache: vi.fn() } as unknown as RelayData;
beforeEach(() => vi.stubEnv("BUZZ_DEV_SETTINGS", "1"));
let revision = 0;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  setLogLevel("info");
});
it("loads the saved level, changes it live, and displays remote changes", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    Response.json({
      revision: ++revision,
      logLevel: init?.body ? JSON.parse(String(init.body)).logLevel : "debug",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<DeveloperSettings relay={relay} />);
  const control = screen.getByRole("combobox", { name: "Log level" });
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveTextContent("Debug");
  await user.tab();
  expect(control).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Debug" })).toHaveFocus(),
  );
  await user.keyboard("{End}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Trace" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(control).toHaveTextContent("Trace"));
  expect(logLevel()).toBe("trace");
  act(() => setLogLevel("warn"));
  expect(control).toHaveTextContent("Warn");
});
it("shows save failure without pretending the level was persisted", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("", { status: 500 })
        : Response.json({ logLevel: "debug", revision: ++revision }),
    ),
  );
  render(<DeveloperSettings relay={relay} />);
  const control = screen.getByRole("combobox", { name: "Log level" });
  await waitFor(() => expect(control).toBeEnabled());
  await user.tab();
  expect(control).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Debug" })).toHaveFocus(),
  );
  await user.keyboard("{Home}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Silent" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Log level wasn’t saved",
  );
  expect(control).toHaveTextContent("Debug");
  expect(control).toBeEnabled();
});

it("disables unsupported runtime settings without requesting their API", async () => {
  vi.stubEnv("BUZZ_DEV_SETTINGS", "0");
  const fetcher = vi.fn(async (_url: unknown) => Response.json({ queries: 0 }));
  vi.stubGlobal("fetch", fetcher);
  render(<DeveloperSettings relay={relay} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Runtime settings require",
  );
  expect(screen.getByRole("combobox", { name: "Log level" })).toBeDisabled();
  expect(fetcher.mock.calls.every(([url]) => url !== "/api/dev/settings")).toBe(
    true,
  );
});

const brokerStats = { queries: 12, errors: 1, media: 3, connects: 4 };

it("omits broker activity and never polls stats without the development broker", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/relay/stats")
      throw new Error("unexpected broker request");
    return Response.json({ logLevel: "debug", revision: ++revision });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.useFakeTimers();
  render(<DeveloperSettings relay={relay} />);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("combobox", { name: "Log level" })).toBeEnabled();
  expect(
    screen.queryByRole("heading", { name: "Broker activity" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Broker stats aren’t available/),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Runtime settings")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Clear cache" }),
  ).toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/dev/settings"]);
});

it("shows broker diagnostics and refreshes their totals in development", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  let statsReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/relay/stats") {
      statsReads++;
      return Response.json({ ...brokerStats, queries: statsReads * 12 });
    }
    return Response.json({ logLevel: "debug", revision: ++revision });
  });
  vi.stubGlobal("fetch", fetcher);
  vi.useFakeTimers();
  const { unmount } = render(<DeveloperSettings relay={relay} />);
  const activity = screen.getByRole("region", { name: "Broker activity" });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(activity).toHaveTextContent("12");
  expect(activity).toHaveTextContent("Connections");
  expect(activity).toHaveTextContent("4");
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(activity).toHaveTextContent("24");
  expect(statsReads).toBe(2);
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(statsReads).toBe(2);
});
