// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PairingPrompt } from "./PairingPrompt";
import type { PairRequest } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const handlers = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  handlers.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    const own = handler as (event: { payload: unknown }) => void;
    handlers.set(name, own);
    return () => {
      if (handlers.get(name) === own) handlers.delete(name);
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const request: PairRequest = {
  id: "r1",
  client: "buzz-cli",
  relay: "wss://relay.example/",
  process: "/usr/local/bin/buzz",
  expiresIn: 120,
};
const ask = async (payload: PairRequest) => {
  await vi.waitFor(() =>
    expect(handlers.has("credential-pair-request")).toBe(true),
  );
  act(() => handlers.get("credential-pair-request")?.({ payload }));
};
/** What the page told native about its prompt, in order. */
const prompts = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "credential_pair_prompt")
    .map(([, args]) => args);
/** Holds each `listen` until it is released, oldest first. As in Tauri, a
 * handler already hears events while its listener is still being set up. */
const holdListen = () => {
  const held: (() => void)[] = [];
  const listening = vi.mocked(listen).getMockImplementation();
  vi.mocked(listen).mockImplementation(async (...args) => {
    const released = new Promise<void>((resolve) => {
      held.push(resolve);
    });
    const unlisten = await listening?.(...args);
    await released;
    return unlisten ?? (() => {});
  });
  return {
    /** Lets the oldest listener still held finish. */
    release: () => held.shift()?.(),
    /** Lets every listener still held finish. */
    releaseAll: () => {
      for (const release of held.splice(0)) release();
    },
  };
};
/** Runs every promise reaction already queued: the mocks settle only in
 * microtasks, which all run before the next task. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

it("names the tool, community and process, with Deny focused", async () => {
  render(<PairingPrompt communities={["wss://relay.example"]} />);
  await ask(request);
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent(
    "buzz-cli wants to use Buzz as you on wss://relay.example/",
  );
  expect(dialog).toHaveTextContent("Requested by /usr/local/bin/buzz");
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect(invoke).toHaveBeenCalledWith("credential_pair_answer", {
    id: "r1",
    approve: true,
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("tells native code the communities saved here", async () => {
  const { rerender } = render(
    <PairingPrompt communities={["wss://relay.example"]} />,
  );
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("credential_pairing_communities", {
      communities: ["https://relay.example"],
    }),
  );
  rerender(<PairingPrompt communities={[]} />);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("credential_pairing_communities", {
      communities: [],
    }),
  );
});

it("closes when native ends the request, and when its time runs out", async () => {
  render(<PairingPrompt communities={["wss://relay.example"]} />);
  await ask(request);
  await screen.findByRole("alertdialog");
  act(() => handlers.get("credential-pair-closed")?.({ payload: "r1" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  vi.useFakeTimers();
  act(() =>
    handlers.get("credential-pair-request")?.({
      payload: { ...request, id: "r2", expiresIn: 2 },
    }),
  );
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Expires in 2 s");
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("lets native ask only once it listens, and not after it leaves", async () => {
  const listeners = holdListen();
  const { unmount } = render(
    <PairingPrompt communities={["wss://relay.example"]} />,
  );
  try {
    await vi.waitFor(() =>
      expect(handlers.has("credential-pair-closed")).toBe(true),
    );
    // While any listener is still being set up, native must not ask.
    listeners.release();
    await settled();
    expect(prompts()).toEqual([]);
  } finally {
    listeners.releaseAll();
  }
  await vi.waitFor(() => expect(prompts()).toEqual([{ mounted: true }]));
  unmount();
  expect(prompts()).toEqual([{ mounted: true }, { mounted: false }]);
});

it("refuses a request heard after it stopped, since nobody can show it", async () => {
  const listeners = holdListen();
  const { unmount } = render(
    <PairingPrompt communities={["wss://relay.example"]} />,
  );
  try {
    await vi.waitFor(() =>
      expect(handlers.has("credential-pair-request")).toBe(true),
    );
    unmount();
    act(() => handlers.get("credential-pair-request")?.({ payload: request }));
    expect(invoke).toHaveBeenCalledWith("credential_pair_answer", {
      id: "r1",
      approve: false,
    });
  } finally {
    listeners.releaseAll();
  }
  // Once its listeners are gone, it has still never counted as listening.
  await vi.waitFor(() => expect(handlers.size).toBe(0));
  expect(prompts()).toEqual([]);
});

it("is mounted once under a development remount", async () => {
  const { unmount } = render(
    <StrictMode>
      <PairingPrompt communities={["wss://relay.example"]} />
    </StrictMode>,
  );
  await vi.waitFor(() => expect(prompts()).toEqual([{ mounted: true }]));
  unmount();
  expect(prompts()).toEqual([{ mounted: true }, { mounted: false }]);
});
