// @vitest-environment node
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  associateForward,
  closeForward,
  openForward,
  pushForwardAdmission,
  registerForwardChild,
  sealForward,
  type ForwardEvent,
} from "./forward";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

const owner = { id: "buzz.agents", revision: "abc" };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

// The argument names are the native commands' (camelCase over IPC).
it("pushes admission under the owner's grant", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ type: "applied", revoked: 1 });
  await expect(
    pushForwardAdmission(owner, "route-a", 2, true),
  ).resolves.toEqual({ type: "applied", revoked: 1 });
  expect(invoke).toHaveBeenCalledWith("plugin_host_forward_admission", {
    id: "buzz.agents",
    revision: "abc",
    route: "route-a",
    routeRevision: 2,
    admits: true,
  });
});

it("opens a generation and delivers its events", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    type: "opened",
    id: 7,
    url: "http://127.0.0.1:1/h",
  });
  const events: ForwardEvent[] = [];
  const opened = await openForward(owner, {
    route: "route-a",
    routeRevision: 2,
    harness: "goose",
    inference: { "x-a": "1" },
    discovery: {},
    onEvent: (event) => events.push(event),
  });
  expect(opened).toEqual({
    type: "opened",
    id: 7,
    url: "http://127.0.0.1:1/h",
  });
  const [command, args] = vi.mocked(invoke).mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect(command).toBe("plugin_host_forward_open");
  const { onEvent, ...rest } = args;
  expect(rest).toEqual({
    id: "buzz.agents",
    revision: "abc",
    route: "route-a",
    routeRevision: 2,
    harness: "goose",
    inference: { "x-a": "1" },
    discovery: {},
  });
  (onEvent as { onmessage: (event: unknown) => void }).onmessage({
    type: "closed",
  });
  expect(events).toEqual([{ type: "closed" }]);
});

it("seals and closes by generation", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await sealForward(owner, 7);
  await closeForward(owner, 7);
  expect(invoke).toHaveBeenNthCalledWith(1, "plugin_host_forward_seal", {
    id: "buzz.agents",
    generation: 7,
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "plugin_host_forward_close", {
    id: "buzz.agents",
    generation: 7,
  });
});

it("opens a goose generation without a session, then associates it", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await openForward(owner, {
    route: "route-a",
    routeRevision: 2,
    harness: "goose",
    inference: {},
    discovery: {},
    onEvent: () => {},
  });
  const [, args] = vi.mocked(invoke).mock.calls[0] as [
    string,
    Record<string, unknown>,
  ];
  expect(args.harness).toBe("goose");
  expect("session" in args).toBe(false);
  await associateForward(owner, 7, "20261104_1");
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_forward_associate", {
    id: "buzz.agents",
    generation: 7,
    session: "20261104_1",
  });
});

it("registers a goose child and passes each outcome through", async () => {
  const outcomes = [
    { type: "registered" },
    ...[
      "child_call_conflict",
      "child_cap",
      "call_cap",
      "generation_ended",
      "generation_revoked",
    ].map((reason) => ({ type: "refused", reason })),
  ];
  for (const outcome of outcomes) {
    vi.mocked(invoke).mockResolvedValueOnce(outcome);
    await expect(
      registerForwardChild(owner, 7, "call-1", "20261104_2"),
    ).resolves.toEqual(outcome);
  }
  expect(invoke).toHaveBeenLastCalledWith(
    "plugin_host_forward_register_child",
    {
      id: "buzz.agents",
      generation: 7,
      call: "call-1",
      child: "20261104_2",
    },
  );
  vi.mocked(invoke).mockRejectedValueOnce("Invalid child session");
  await expect(
    registerForwardChild(owner, 7, "call-1", "20261104_1"),
  ).rejects.toBe("Invalid child session");
});
