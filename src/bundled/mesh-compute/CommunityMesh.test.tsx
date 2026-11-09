// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { CommunityMesh, modelLabel } from "./CommunityMesh";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function relay(
  viewer?: string,
  names?: { resolve(pubkey: string, fallback?: string): string | undefined },
) {
  const profiles = new Map([["a".repeat(64), { name: "Alice" }]]);
  const snapshot = {
    viewer,
    session: {
      names: names && {
        ...names,
        snapshot: () => 0,
        subscribe: () => () => {},
      },
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
}
it("reads automatically without starting a node, distinguishes empty, unavailable and errors, and retries", async () => {
  native.invoke.mockResolvedValueOnce({ unavailable: null, entries: [] });
  const source = relay();
  const view = render(
    <CommunityMesh community="https://fixture.example" relay={source} />,
  );
  await screen.findByText("No one is sharing compute yet.");
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith(
    "mesh_compute_inventory",
    { community: "https://fixture.example" },
  );
  native.invoke.mockResolvedValueOnce({
    unavailable: "Status is stale",
    entries: [],
  });
  // The page's single Refresh reruns the read through refreshKey.
  view.rerender(
    <CommunityMesh
      community="https://fixture.example"
      relay={source}
      refreshKey={1}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Status is stale");
  expect(
    screen.queryByText("No one is sharing compute yet."),
  ).not.toBeInTheDocument();
  native.invoke.mockRejectedValueOnce(new Error("Identity unavailable"));
  view.rerender(
    <CommunityMesh
      community="https://fixture.example"
      relay={source}
      refreshKey={2}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Identity unavailable",
  );
});
it("rejects a late previous-community response and resolves names from session profiles", async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  native.invoke.mockReturnValueOnce(pending).mockResolvedValueOnce({
    unavailable: null,
    entries: [
      {
        memberPubkey: "a".repeat(64),
        modelId: "model",
        modelName: "Model",
        deviceId: "device",
        deviceName: "Studio",
        vramGb: 32,
      },
    ],
  });
  const source = relay();
  const view = render(
    <CommunityMesh community="https://old.example" relay={source} />,
  );
  view.rerender(
    <CommunityMesh community="https://new.example" relay={source} />,
  );
  expect(await screen.findByRole("listitem")).toHaveTextContent(
    "Studio · AliceModel32 GB",
  );
  // Thomas's community summary: contributors, shared memory, model count.
  expect(
    screen.getByText("1 person is contributing compute."),
  ).toBeInTheDocument();
  expect(screen.getByText("Shared memory").nextSibling).toHaveTextContent(
    "32 GB",
  );
  await act(async () => {
    release({ unavailable: null, entries: [] });
    await pending;
  });
  expect(
    screen.queryByText("No one is sharing compute yet."),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("Alice");
});
it("totals shared memory once per device and omits it when capacity is unknown", async () => {
  const entry = (
    member: string,
    model: string,
    deviceId: string | null,
    vramGb: number | null,
  ) => ({
    memberPubkey: member.repeat(64),
    modelId: model,
    modelName: model,
    deviceId,
    deviceName: null,
    vramGb,
  });
  native.invoke.mockResolvedValueOnce({
    unavailable: null,
    entries: [
      entry("a", "m1", "dev-1", 32),
      entry("a", "m2", "dev-1", 32),
      entry("b", "m3", "dev-2", 16),
    ],
  });
  const source = relay();
  const view = render(
    <CommunityMesh community="https://fixture.example" relay={source} />,
  );
  // Two models on one 32 GB device plus a 16 GB device: 48 GB, not 80 GB.
  expect(await screen.findByText("48 GB")).toBeInTheDocument();
  // Two models on one device collapse onto that device's row.
  const rows = within(
    screen.getByRole("list", { name: "Shared devices" }),
  ).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("m1, m2");
  expect(screen.getByText("Devices").nextSibling).toHaveTextContent("2");
  expect(
    screen.getByText("2 people are contributing compute."),
  ).toBeInTheDocument();
  native.invoke.mockResolvedValueOnce({
    unavailable: null,
    entries: [entry("a", "m1", "dev-1", 32), entry("b", "m3", null, null)],
  });
  view.rerender(
    <CommunityMesh
      community="https://fixture.example"
      relay={source}
      refreshKey={1}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText("Shared memory").nextSibling).toHaveTextContent(
      "Not reported",
    ),
  );
});
it("lists your own devices first and never merges entries without a device identity", async () => {
  const you = "c".repeat(64);
  const entry = (
    member: string,
    model: string,
    deviceId: string | null,
    deviceName: string | null,
  ) => ({
    memberPubkey: member,
    modelId: `org/${model}`,
    modelName: model,
    deviceId,
    deviceName,
    vramGb: null,
  });
  native.invoke.mockResolvedValueOnce({
    unavailable: null,
    entries: [
      entry("a".repeat(64), "Qwen 9B", null, null),
      entry("a".repeat(64), "Gemma E4B", null, null),
      entry(you, "Qwen 27B", "studio", "Studio"),
    ],
  });
  render(
    <CommunityMesh community="https://fixture.example" relay={relay(you)} />,
  );
  const list = await screen.findByRole("list", { name: "Shared devices" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("Studio · YouQwen 27B");
  for (const row of rows.slice(1))
    expect(row).toHaveTextContent(/^\S?Unnamed device · Alice/);
  expect(list).toHaveTextContent("Gemma E4B");
  expect(list).toHaveTextContent("Qwen 9B");
});
it("names every contributor, never by key fragment, and prefers the shared naming layer", async () => {
  const agent = "b".repeat(64);
  const anonymous = "e".repeat(64);
  const entry = (member: string, deviceName: string) => ({
    memberPubkey: member,
    modelId: "org/model",
    modelName: "Model",
    deviceId: deviceName,
    deviceName,
    vramGb: 8,
  });
  native.invoke.mockResolvedValueOnce({
    unavailable: null,
    entries: [
      entry("a".repeat(64), "Studio"),
      entry(agent, "Runner"),
      entry(anonymous, "Laptop"),
    ],
  });
  // e.g. one of this app's own agents, which has no published profile yet.
  const names = {
    resolve: (pubkey: string, fallback?: string) =>
      pubkey === agent ? "Builder bot" : fallback,
  };
  render(
    <CommunityMesh
      community="https://fixture.example"
      relay={relay(undefined, names)}
    />,
  );
  const list = await screen.findByRole("list", { name: "Shared devices" });
  expect(list).toHaveTextContent("Studio · Alice");
  expect(list).toHaveTextContent("Runner · Builder bot");
  expect(list).toHaveTextContent("Laptop · Unnamed member");
  expect(list).not.toHaveTextContent("npub");
  expect(
    screen.getByRole("heading", { name: "Community mesh" }),
  ).toBeInTheDocument();
});
it("labels Mesh model refs by name and quantization", () => {
  expect(modelLabel("unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M")).toBe(
    "Qwen3.8-27B · UD-Q4_K_M",
  );
  expect(
    modelLabel("meshllm/Qwen3.5-35B-A3B-UD-Q4_K_XL-layers@69cbd9fc1f928305"),
  ).toBe("Qwen3.5-35B-A3B-UD-Q4_K_XL-layers");
  expect(modelLabel("hf://meshllm/qwen3-8b@main")).toBe("qwen3-8b");
  expect(modelLabel("local-gguf/sha256-7756e8943d5ec98b")).toBe("Local model");
  expect(modelLabel("Qwen 27B")).toBe("Qwen 27B");
});
