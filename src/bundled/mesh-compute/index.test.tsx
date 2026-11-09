import { Context } from "@deepseek-ai/cordis";
import { createCommunities } from "../../features/communities/service";
import { flush } from "../../features/relay/testing";
import userEvent from "@testing-library/user-event";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginModule } from "../../plugins/api";
import { apply as applyPlugin, shareActionSettled } from "./index";
// Legacy unit fixtures model account changes alongside relay updates. Navigation
// regressions below supply the real, independent community identity owner.
const apply: typeof applyPlugin = (ctx) =>
  applyPlugin({
    ...ctx,
    communityReader: ctx.communityReader ?? {
      snapshot: () => ({ viewer: ctx.relay.snapshot().viewer }),
      subscribe: ctx.relay.subscribe,
    },
  } as Parameters<typeof applyPlugin>[0]);
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
  ...native,
  invoke: (command: string, args?: unknown) =>
    command === "mesh_compute_catalog"
      ? Promise.resolve({
          gpuName: null,
          vramDisplay: "unknown",
          recommended: null,
          entries: [],
        })
      : native.invoke(command, args),
}));
/** Static UI cases only; lifecycle tests retain their controlled source/effects. */
function staticPage(snapshot: object) {
  let Component!: React.ComponentType;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  return Component;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
/** The Mesh agent type registers after native availability resolves. */
const flushRegistration = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

it("revokes a pending selection on disposal and never starts it", async () => {
  let resolve!: (value: string) => void;
  const gate = new Promise<string>((done) => {
    resolve = done;
  });
  native.invoke.mockImplementation((command) =>
    command === "mesh_compute_select"
      ? gate
      : Promise.resolve({ lifecycle: { state: "stopped" } }),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let dispose!: () => void;
  let Component!: React.ComponentType;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
      community: "https://fixture.example",
      restoreSharing: true,
    }),
  );
  await screen.findByText("Checking shared compute…");
  expect(
    screen.queryByRole("button", { name: "Connect to community compute" }),
  ).not.toBeInTheDocument();
  dispose();
  await act(async () => {
    resolve("old-lease");
    await gate;
  });
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
      lease: "old-lease",
    }),
  );
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === "mesh_compute_start",
    ),
  ).toBe(false);
});

it("preserves the running lease through reconnect and revokes on identity change", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "stable-lease"
        : { lifecycle: { state: "ready" } },
    ),
  );
  let snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const listeners = new Set<() => void>();
  let dispose!: () => void;
  let Component!: React.ComponentType;
  const ctx = {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await screen.findByText("Sharing is off. Connected to community compute.");
  await act(async () => {
    snapshot = { ...snapshot, status: "connecting" };
    for (const listener of listeners) listener();
    snapshot = { ...snapshot, status: "ready" };
    for (const listener of listeners) listener();
  });
  expect(
    native.invoke.mock.calls.filter(
      ([command]) => command === "mesh_compute_select",
    ),
  ).toHaveLength(1);
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === "mesh_compute_release",
    ),
  ).toBe(false);
  await act(async () => {
    snapshot = { status: "disconnected", viewer: "", scope: "" };
    for (const listener of listeners) listener();
  });
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
      lease: "stable-lease",
    }),
  );
  dispose();
});

it("renders Running without a reload control and offers recovery after polling errors", async () => {
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    return Promise.resolve({ lifecycle: { state: "ready" } });
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  vi.useFakeTimers();
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sharing is off. Connected to community compute.",
    );
    expect(
      screen.queryByRole("button", {
        name: /Disconnect|Connect|Cancel connection|Refresh/,
      }),
    ).not.toBeInTheDocument();
    native.invoke.mockRejectedValueOnce(new Error("Status unavailable"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connected to community compute.",
    );
    expect(native.invoke).not.toHaveBeenCalledWith(
      "mesh_compute_release",
      expect.anything(),
    );
  } finally {
    cleanup();
    dispose();
    vi.useRealTimers();
  }
});

it("polls transient states serially, refreshes Running activity, and cancels on unmount", async () => {
  vi.useFakeTimers();
  let state = "starting";
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select" ? "lease" : { lifecycle: { state } },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (page: { component: React.ComponentType }) => {
        Component = page.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting to community compute…",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connecting to community compute…",
    );
    state = "ready";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connected to community compute.",
    );
    const count = native.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(native.invoke).toHaveBeenCalledTimes(count + 1);
    state = "stopping";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Stopping…");
    state = "stopped";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Sharing is off.");
    cleanup();
    const finalCount = native.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(native.invoke).toHaveBeenCalledTimes(finalCount);
  } finally {
    cleanup();
    dispose();
    vi.useRealTimers();
  }
});

it("starts sharing the selected model through the existing community lease", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : { lifecycle: { state: "stopped" }, sharing: null },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const Component = staticPage(snapshot);
  render(<Component />);
  await screen.findByRole("switch", { name: "Share compute" });
  expect(
    screen.getByRole("switch", { name: "Share compute" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(
    screen.getByRole("combobox", { name: "Model to share" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Custom model or local GGUF" }),
  );
  fireEvent.change(
    screen.getByLabelText("Model reference or local GGUF path"),
    { target: { value: "/models/local.gguf" } },
  );
  fireEvent.click(screen.getByRole("switch", { name: "Share compute" }));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "share-lease",
      model: "/models/local.gguf",
      maxVramGb: null,
      auto: false,
    }),
  );
});

it.each([
  // Off can cancel a serve that is still starting, e.g. a long download.
  ["starting", "Starting /models/local.gguf…", false],
  ["ready", "Preparing /models/local.gguf", false],
  ["failed", "Mesh needs recovery. Load failed.", false],
] as const)(
  "shows serving intent truthfully in %s",
  async (phase, label, disabled) => {
    native.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === "mesh_compute_select"
          ? "share-lease"
          : {
              lifecycle: {
                state: phase,
                reason: phase === "failed" ? "Load failed" : undefined,
              },
              sharing: "/models/local.gguf",
            },
      ),
    );
    const snapshot = {
      status: "ready",
      viewer: "viewer",
      scope: "https://fixture.example:viewer",
    };
    const Component = staticPage(snapshot);
    render(<Component />);
    expect(
      await screen.findByText((text) => text.startsWith(label)),
    ).toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Model to share" });
    if (picker.hasAttribute("disabled")) {
      expect(picker).toBeDisabled();
    } else {
      await userEvent.click(picker);
      expect(
        await screen.findByRole("option", {
          name: "Custom model or local GGUF",
        }),
      ).toHaveAttribute("aria-disabled", "true");
      await userEvent.keyboard("{Escape}");
    }
    const stop = screen.getByRole("switch", { name: "Share compute" });
    if (disabled) {
      expect(stop).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(stop);
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === "mesh_compute_share",
        ),
      ).toHaveLength(0);
    } else {
      expect(stop).not.toHaveAttribute("aria-disabled", "true");
      fireEvent.click(stop);
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
          lease: "share-lease",
          model: null,
          maxVramGb: null,
          auto: true,
        }),
      );
    }
    if (phase !== "ready")
      expect(
        screen.queryByText("Sharing /models/local.gguf"),
      ).not.toBeInTheDocument();
  },
);

it("refreshes cleared intent even when stopping a failed worker reports an error", async () => {
  let stopped = false;
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select")
      return Promise.resolve("share-lease");
    if (command === "mesh_compute_share") {
      stopped = true;
      return Promise.reject("Shutdown not confirmed");
    }
    return Promise.resolve({
      lifecycle: { state: "failed", reason: "Load failed" },
      sharing: stopped ? null : "/models/local.gguf",
    });
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const Component = staticPage(snapshot);
  render(<Component />);
  fireEvent.click(await screen.findByRole("switch", { name: "Share compute" }));
  await screen.findByText("Shutdown not confirmed");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Model to share" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("switch", { name: "Share compute" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

it("restores a disarmed model hint and sends sharing only on explicit resume", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : {
            lifecycle: { state: "stopped" },
            sharing: null,
            savedSharing: { model: "/models/local.gguf", enabled: false },
          },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const Component = staticPage(snapshot);
  render(<Component />);
  const resume = await screen.findByRole("switch", {
    name: "Share compute",
  });
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Model to share" }),
    ).toHaveTextContent("/models/local.gguf"),
  );
  expect(
    native.invoke.mock.calls.some(
      ([command]) =>
        command === "mesh_compute_start" || command === "mesh_compute_share",
    ),
  ).toBe(false);
  fireEvent.click(resume);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "share-lease",
      model: "/models/local.gguf",
      maxVramGb: null,
      auto: false,
    }),
  );
});

it("keeps SDK download progress live after management readiness and cancels on unmount", async () => {
  vi.useFakeTimers();
  let bytes = 1_000_000_000;
  let modelReady = false;
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "lease"
        : {
            lifecycle: { state: "ready" },
            sharing: "fixture-model",
            modelReady,
            download: {
              label: "layers",
              file: "layer.gguf",
              downloadedBytes: bytes,
              totalBytes: 4_000_000_000,
              done: false,
            },
          },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (page: { component: React.ComponentType }) => {
        Component = page.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(screen.getByText(/Downloading layer.gguf/)).toHaveTextContent(
      "1.00 GB / 4.00 GB",
    );
    bytes = 2_000_000_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText(/Downloading layer.gguf/)).toHaveTextContent(
      "2.00 GB / 4.00 GB",
    );
    modelReady = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const reads = () =>
      native.invoke.mock.calls.filter(
        ([command]) => command === "mesh_compute_status",
      ).length;
    const count = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reads()).toBe(count + 1);
    cleanup();
    const afterUnmount = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(reads()).toBe(afterUnmount);
  } finally {
    cleanup();
    dispose();
    vi.useRealTimers();
  }
});

it("persists Reset to Auto without restarting an active share, then starts Auto natively after stopping", async () => {
  let automatic = false;
  let sharing: string | null = "/running.gguf";
  const status = () => ({
    lifecycle: { state: sharing ? "ready" : "stopped" },
    modelReady: true,
    sharing,
    savedSharing: {
      model: "/running.gguf",
      enabled: !!sharing,
      auto: automatic,
    },
  });
  native.invoke.mockImplementation((command, args) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    if (command === "mesh_compute_catalog")
      return Promise.resolve({
        gpuName: "GPU",
        vramDisplay: "128 GB",
        recommended: "recommended/M",
        entries: [],
      });
    if (command === "mesh_compute_share") {
      if (args.resetOnly) automatic = true;
      else sharing = args.model;
    }
    return Promise.resolve(status());
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const Component = staticPage(snapshot);
  render(<Component />);
  fireEvent.click(
    await screen.findByRole("combobox", { name: "Model to share" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "Auto" }));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "lease",
      model: null,
      maxVramGb: null,
      auto: true,
      resetOnly: true,
    }),
  );
  expect(sharing).toBe("/running.gguf");
  expect(
    native.invoke.mock.calls.filter(
      ([command]) => command === "mesh_compute_start",
    ),
  ).toHaveLength(0);
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
    lease: "lease",
    model: null,
    maxVramGb: null,
    auto: true,
    resetOnly: true,
  });
  fireEvent.click(screen.getByRole("switch", { name: "Share compute" }));
  fireEvent.click(await screen.findByRole("switch", { name: "Share compute" }));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "lease",
      model: "/running.gguf",
      maxVramGb: null,
      auto: true,
    }),
  );
});

it("shows the failure and native cause in Auto mode without presenting it as an override", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "lease"
        : {
            lifecycle: {
              state: "failed",
              reason: "Native model startup failed: fixture cause",
            },
            sharing: null,
            savedSharing: {
              model: "recommended/M",
              enabled: false,
              auto: true,
            },
          },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const Component = staticPage(snapshot);
  render(<Component />);
  await screen.findByText(/Native model startup failed: fixture cause/);
  expect(screen.getByText(/Mesh needs recovery\./)).toHaveTextContent(
    "Restart Buzz before starting Mesh again",
  );
  expect(screen.queryByText(/Saved model:/)).not.toBeInTheDocument();
});

it("foreground A to B to A preserves compute and requires explicit replacement", async () => {
  let bound = "https://a.example";
  native.invoke.mockImplementation((command, args) => {
    if (command === "mesh_compute_select") {
      if (args.replaceExisting) bound = args.community;
      return Promise.resolve("bound-lease");
    }
    return Promise.resolve({
      boundCommunity: bound,
      modelReady: true,
      sharing: "fixture-model",
      lifecycle: { state: "ready" },
    });
  });
  let snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://a.example:viewer",
  };
  const listeners = new Set<() => void>();
  let Component!: React.ComponentType;
  const ctx = {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await screen.findByText(/^Sharing fixture-model/);
  const navigate = async (scope: string) =>
    act(async () => {
      snapshot = { ...snapshot, scope };
      for (const listener of listeners) listener();
    });
  await navigate("https://b.example:viewer");
  await screen.findByText(/Sharing in https:\/\/a.example/);
  expect(
    screen.queryByRole("button", { name: "Reset to Auto" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("switch", { name: "Share compute" }),
  ).not.toBeInTheDocument();
  await navigate("https://a.example:viewer");
  await screen.findByText(/^Sharing fixture-model/);
  expect(
    native.invoke.mock.calls.filter(([name]) => name === "mesh_compute_select"),
  ).toHaveLength(1);
  expect(
    native.invoke.mock.calls.filter(
      ([name]) => name === "mesh_compute_release",
    ),
  ).toHaveLength(0);
  await navigate("https://b.example:viewer");
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Use compute in this community instead",
    }),
  );
  expect(
    native.invoke.mock.calls.filter(([name]) => name === "mesh_compute_select"),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Stop agents and switch compute" }),
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
      community: "https://b.example",
      restoreSharing: false,
      replaceExisting: true,
    }),
  );
});

it.each([
  ["starting", "Sharing is off. Connecting to community compute…", false],
  ["stopping", "Stopping…", true],
] as const)(
  "a consumer that is %s never freezes Share; only a shutdown waits",
  async (phase, label, disabled) => {
    native.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === "mesh_compute_select"
          ? "share-lease"
          : { lifecycle: { state: phase }, sharing: null },
      ),
    );
    mountSharing();
    await screen.findByText(label);
    const share = screen.getByRole("switch", { name: "Share compute" });
    if (disabled) {
      expect(share).toHaveAttribute("aria-disabled", "true");
      return;
    }
    // A join that never settles must not lock the member out of sharing.
    expect(share).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(share);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        "mesh_compute_share",
        expect.objectContaining({ lease: "share-lease", auto: true }),
      ),
    );
  },
);

function mountSharing() {
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  render(<Component />);
}

it("failed with saved sharing: Off persists the disarm, then On stays blocked until restart", async () => {
  let enabled = true;
  native.invoke.mockImplementation((command, args) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    if (command === "mesh_compute_share") {
      expect(args).toMatchObject({ lease: "lease", model: null });
      enabled = false;
      return Promise.resolve();
    }
    return Promise.resolve({
      lifecycle: { state: "failed", reason: "Startup failed" },
      sharing: null,
      savedSharing: { model: "m/Q4", enabled, auto: true },
    });
  });
  mountSharing();
  const toggle = await screen.findByRole("switch", {
    name: "Share compute",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(
    screen.getByText(/Sharing is still enabled for next launch/),
  ).toBeInTheDocument();
  expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  // Consent is cleared; the unconfirmed runtime is never presented as stopped.
  expect(
    screen.getByText(/Shutdown could not be confirmed\. Restart Buzz/),
  ).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(toggle);
  expect(
    native.invoke.mock.calls.filter(([c]) => c === "mesh_compute_share"),
  ).toHaveLength(1);
});

it("a failed disarm write leaves sharing visibly enabled with the error", async () => {
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    if (command === "mesh_compute_share")
      return Promise.reject("Could not write sharing settings");
    return Promise.resolve({
      lifecycle: { state: "failed", reason: "Startup failed" },
      sharing: null,
      savedSharing: { model: "m/Q4", enabled: true, auto: true },
    });
  });
  mountSharing();
  const toggle = await screen.findByRole("switch", {
    name: "Share compute",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(toggle);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not write sharing settings",
  );
  expect(toggle).toHaveAttribute("aria-checked", "true");
});

it("a transient selection failure is retried without restoring sharing before Off", async () => {
  let selects = 0;
  native.invoke.mockImplementation((command, args) => {
    if (command === "mesh_compute_select")
      return ++selects === 1
        ? Promise.reject("Previous Mesh runtime shutdown is not confirmed")
        : Promise.resolve("fresh-lease");
    if (command === "mesh_compute_share") {
      expect(args).toMatchObject({ lease: "fresh-lease", model: null });
      return Promise.resolve();
    }
    return Promise.resolve({
      lifecycle: { state: "stopped" },
      sharing: null,
      savedSharing: { model: "m/Q4", enabled: true, auto: true },
    });
  });
  mountSharing();
  const toggle = await screen.findByRole("switch", {
    name: "Share compute",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith(
      "mesh_compute_share",
      expect.objectContaining({ lease: "fresh-lease", model: null }),
    ),
  );
  const selectCalls = native.invoke.mock.calls.filter(
    ([c]) => c === "mesh_compute_select",
  );
  expect(selectCalls).toHaveLength(2);
  // The recovery selection must not restore (start) the armed share.
  expect(selectCalls[1]?.[1]).toMatchObject({ restoreSharing: false });
  expect(
    native.invoke.mock.calls.some(([c]) => c === "mesh_compute_start"),
  ).toBe(false);
});

it("unsafe failed runtime with no lease: Off disarms consent without selection or shutdown", async () => {
  let enabled = true;
  native.invoke.mockImplementation((command, args) => {
    // Native select must confirm shutdown first; a sticky failure always rejects.
    if (command === "mesh_compute_select")
      return Promise.reject("Mesh shutdown timed out; restart Buzz");
    if (command === "mesh_compute_disarm") {
      expect(args).toEqual({
        community: "https://fixture.example",
        expectedViewer: "viewer",
      });
      enabled = false;
      return Promise.resolve();
    }
    if (command === "mesh_compute_share")
      throw new Error("share must not be reached without a lease");
    return Promise.resolve({
      lifecycle: { state: "failed", reason: "Mesh shutdown timed out" },
      sharing: null,
      savedSharing: { model: "m/Q4", enabled, auto: true },
    });
  });
  mountSharing();
  const toggle = await screen.findByRole("switch", {
    name: "Share compute",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_disarm", {
    community: "https://fixture.example",
    expectedViewer: "viewer",
  });
  expect(
    screen.getByText(/Shutdown could not be confirmed\. Restart Buzz/),
  ).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
});

for (const retire of ["identity", "dispose"] as const) {
  it(`a retired Off (${retire}) never disarms after its selection rejects`, async () => {
    let snapshot = {
      status: "ready",
      viewer: "viewer",
      scope: "https://fixture.example:viewer",
    };
    const listeners = new Set<() => void>();
    let rejectRetry!: (reason: string) => void;
    let selects = 0;
    native.invoke.mockImplementation((command) => {
      if (command === "mesh_compute_select") {
        selects++;
        if (selects === 1) return Promise.reject("first selection failed");
        if (selects === 2)
          return new Promise((_, reject) => {
            rejectRetry = reject;
          });
        return Promise.resolve("other-lease");
      }
      return Promise.resolve({
        lifecycle: { state: "failed", reason: "stuck" },
        sharing: null,
        savedSharing: { model: "m/Q4", enabled: true, auto: true },
      });
    });
    let Component!: React.ComponentType;
    let dispose!: () => void;
    apply({
      relay: {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      effect: (setup: () => () => void) => {
        dispose = setup();
      },
      settingsCards: {
        register: (card: { component: React.ComponentType }) => {
          Component = card.component;
        },
      },
    } as unknown as Parameters<PluginModule["apply"]>[0]);
    await flushRegistration();
    render(<Component />);
    const toggle = await screen.findByRole("switch", {
      name: "Share compute",
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(toggle);
    // The Off action is now waiting on its retried selection.
    await waitFor(() => expect(selects).toBe(2));
    await act(async () => {
      if (retire === "identity") {
        snapshot = {
          status: "ready",
          viewer: "other",
          scope: "https://other.example:other",
        };
        for (const listener of listeners) listener();
      } else {
        dispose();
      }
    });
    const retired = shareActionSettled();
    try {
      await act(async () => {
        rejectRetry("Mesh shutdown timed out; restart Buzz");
        // Wait for the retired Off action itself to finish, not a timer tick.
        await retired;
      });
    } finally {
      rejectRetry("released");
    }
    expect(
      native.invoke.mock.calls.some(([c]) => c === "mesh_compute_disarm"),
    ).toBe(false);
  });
}

it.each(["stopped", "ready"])(
  "does not open a widget for a non-sharing consumer that is %s",
  async (state) => {
    native.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === "mesh_compute_select"
          ? "lease"
          : {
              lifecycle: { state },
              sharing: null,
            },
      ),
    );
    const snapshot = {
      status: "ready",
      viewer: "viewer",
      scope: "https://fixture.example:viewer",
    };
    let Component!: React.ComponentType;
    let dispose!: () => void;
    apply({
      relay: { snapshot: () => snapshot, subscribe: () => () => {} },
      effect: (setup: () => () => void) => {
        dispose = setup();
      },
      settingsCards: {
        register: (card: { component: React.ComponentType }) => {
          Component = card.component;
        },
      },
    } as unknown as Parameters<PluginModule["apply"]>[0]);
    await flushRegistration();
    try {
      render(<Component />);
      const button = await screen.findByRole("button", {
        name: "Open activity widget",
      });
      expect(button).toBeDisabled();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(native.invoke).not.toHaveBeenCalledWith(
        "mesh_compute_widget_open",
        undefined,
      );
    } finally {
      await act(async () => {
        dispose();
      });
    }
  },
);
it("opens the activity widget for restored sharing and allows retry after an open failure", async () => {
  let opens = 0;
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_widget_open") {
      opens++;
      return opens === 1
        ? Promise.reject("window unavailable")
        : Promise.resolve();
    }
    return Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : {
            lifecycle: { state: "ready" },
            sharing: "/models/local.gguf",
            modelReady: true,
          },
    );
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await screen.findByText("Couldn’t open activity widget: window unavailable");
  expect(opens).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Open activity widget" }));
  await waitFor(() => expect(opens).toBe(2));
  expect(
    screen.queryByText("Couldn’t open activity widget: window unavailable"),
  ).not.toBeInTheDocument();
  act(() => dispose());
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith(
      "mesh_compute_widget_close",
      undefined,
    ),
  );
});
it("closes a pending widget open before a re-enabled plugin opens its window", async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const commands: string[] = [];
  native.invoke.mockImplementation((command) => {
    commands.push(command);
    if (command === "mesh_compute_widget_open") return gate;
    return Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : {
            lifecycle: { state: "ready" },
            sharing: "fixture-model",
            modelReady: true,
          },
    );
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  const mounted = render(<Component />);
  try {
    await waitFor(() => expect(commands).toContain("mesh_compute_widget_open"));
    act(() => {
      dispose();
      mounted.unmount();
    });
    apply(ctx);
    render(<Component />);
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Share compute" }),
      ).toBeChecked(),
    );
    expect(commands).not.toContain("mesh_compute_widget_close");
  } finally {
    await act(async () => {
      resolve();
      await gate;
    });
  }
  await waitFor(() =>
    expect(
      commands.filter((command) => command.startsWith("mesh_compute_widget_")),
    ).toEqual([
      "mesh_compute_widget_open",
      "mesh_compute_widget_close",
      "mesh_compute_widget_open",
    ]),
  );
  act(() => dispose());
  await waitFor(() =>
    expect(
      commands.filter((command) => command === "mesh_compute_widget_close"),
    ).toHaveLength(2),
  );
});

it("refreshes shared-compute activity and stops polling when unmounted", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const activity = {
    outputTokens: 1234,
    completedRequests: 7,
    finishedRequests: 8,
    activeRequests: 0,
    retries: 1,
    tokensPerSecond: null,
    otherNodes: 3,
    sharingNodes: 1,
  };
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    if (command === "mesh_compute_status") {
      reads++;
      return Promise.resolve({
        lifecycle: { state: "ready" },
        sharing: null,
        activity: reads <= 1 ? activity : null,
      });
    }
    return Promise.resolve();
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(reads).toBe(1);
    // Activity lives in the collapsed community section.
    expect(
      screen.queryByRole("region", { name: "Shared-compute activity" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Community and activity" }),
    );
    expect(
      screen.getByRole("region", { name: "Shared-compute activity" }),
    ).toHaveTextContent("1,234");
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(
      screen.getByText("Other sharing nodes").nextElementSibling,
    ).toHaveTextContent("1");
    expect(
      screen.queryByText(/Includes your requests/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Retries")).not.toBeVisible();
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(screen.getByText("Retries")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(reads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(2);
    expect(
      screen.getByText("Activity is currently unavailable."),
    ).toBeInTheDocument();
    expect(screen.queryByText("1,234")).not.toBeInTheDocument();
    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reads).toBe(2);
  } finally {
    cleanup();
    await act(async () => {
      dispose();
    });
    vi.useRealTimers();
  }
});

it("real community snapshots preserve sharing through Personal and a connecting community", async () => {
  const viewer = "a".repeat(64);
  const root = new Context();
  let connectB!: () => void;
  const pendingB = new Promise<void>((resolve) => {
    connectB = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.endsWith("/identity")) return Response.json({ viewer });
      if (input.endsWith("/session")) {
        const id = decodeURIComponent(input.split("/")[3] ?? "");
        if (id === "https://b.example") await pendingB;
        return Response.json({
          viewer,
          relayAuthor: "b".repeat(64),
          relayUrl: id,
        });
      }
      return Response.json([]);
    }),
  );
  localStorage.clear();
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "sharing-lease"
        : {
            boundCommunity: "https://a.example",
            sharing: "model",
            lifecycle: { state: "ready" },
          },
    ),
  );
  let dispose!: () => void;
  try {
    const client = createCommunities(root, true);
    await flush();
    client.joined(
      { id: "https://a.example", name: "A" },
      { name: "", picture: "" },
    );
    await waitFor(() => expect(client.relay.snapshot().status).toBe("ready"));
    apply({
      relay: client.relay,
      communityReader: {
        snapshot: client.snapshot,
        subscribe: client.subscribe,
      },
      effect: (setup: () => () => void) => {
        dispose = setup();
      },
      settingsCards: { register: () => {} },
    } as unknown as Parameters<typeof apply>[0]);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
        community: "https://a.example",
        restoreSharing: true,
      }),
    );
    client.select(null);
    expect(client.relay.snapshot()).toMatchObject({ status: "disconnected" });
    expect(client.relay.snapshot().viewer).toBeUndefined();
    client.joined(
      { id: "https://b.example", name: "B" },
      { name: "", picture: "" },
    );
    expect(client.relay.snapshot().status).toBe("connecting");
    expect(client.relay.snapshot().viewer).toBeUndefined();
    await flush();
    connectB();
    await waitFor(() => expect(client.relay.snapshot().status).toBe("ready"));
    client.relay.disconnect();
    client.relay.retry();
    await waitFor(() => expect(client.relay.snapshot().status).toBe("ready"));
    client.select("https://a.example");
    await flush();
    expect(
      native.invoke.mock.calls.filter(([cmd]) => cmd === "mesh_compute_select"),
    ).toHaveLength(1);
    expect(
      native.invoke.mock.calls.filter(
        ([cmd]) => cmd === "mesh_compute_release",
      ),
    ).toHaveLength(0);
    dispose();
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
        lease: "sharing-lease",
      }),
    );
  } finally {
    connectB();
    await root.fiber.dispose();
    vi.unstubAllGlobals();
    localStorage.clear();
  }
});

for (const nextViewer of [undefined, "other"] as const) {
  it(`retires sharing on app identity ${nextViewer ?? "removal"} while Personal is foreground`, async () => {
    let account: { viewer?: string } = { viewer: "viewer" };
    let relay: { status: string; viewer?: string; scope?: string } = {
      status: "ready",
      viewer: "viewer",
      scope: "https://a.example:viewer",
    };
    const accountListeners = new Set<() => void>();
    const relayListeners = new Set<() => void>();
    let dispose!: () => void;
    native.invoke.mockImplementation((command) =>
      Promise.resolve(command === "mesh_compute_select" ? "lease" : {}),
    );
    apply({
      relay: {
        snapshot: () => relay,
        subscribe: (fn: () => void) => {
          relayListeners.add(fn);
          return () => relayListeners.delete(fn);
        },
      },
      communityReader: {
        snapshot: () => account,
        subscribe: (fn: () => void) => {
          accountListeners.add(fn);
          return () => accountListeners.delete(fn);
        },
      },
      settingsCards: { register: () => {} },
      effect: (setup: () => () => void) => {
        dispose = setup();
      },
    } as unknown as Parameters<typeof apply>[0]);
    try {
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
          community: "https://a.example",
          restoreSharing: true,
        }),
      );
      relay = { status: "disconnected" };
      for (const fn of relayListeners) fn();
      await flush();
      expect(native.invoke).not.toHaveBeenCalledWith(
        "mesh_compute_release",
        expect.anything(),
      );
      account = nextViewer ? { viewer: nextViewer } : {};
      for (const fn of accountListeners) fn();
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
          lease: "lease",
        }),
      );
    } finally {
      dispose();
    }
  });
}

it("registers the Mesh agent type with the desktop host", () => {
  const register = vi.fn();
  const cleanups: (() => void)[] = [];
  native.invoke.mockImplementation(async () => ({
    lifecycle: { state: "stopped" },
  }));
  apply({
    relay: {
      snapshot: () => ({ status: "loading" }),
      subscribe: () => () => {},
    },
    host: { spawn: vi.fn(), resolveDirectory: vi.fn(), serveMcp: vi.fn() },
    agents: { relay: () => undefined, register },
    effect: (setup: () => () => void) => {
      cleanups.push(setup());
    },
    settingsCards: { register: () => {} },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  expect(register).toHaveBeenCalledTimes(1);
  for (const cleanup of cleanups) cleanup();
});

it.each(["chat", "agent"])(
  "prepares a background %s agent against its own membership, not the foreground",
  async (mode) => {
    const owner = "a".repeat(64);
    const agent = "b".repeat(64);
    const membership = `${agent}@a.example`;
    const memoryRead = vi.fn(async () => ({
      entries: [{ slug: "core", body: "A private memory" }],
      partial: false,
    }));
    const memberSnapshot = {
      origin: "https://a.example",
      status: "ready",
      session: {
        channels: { list: () => ({ channels: [] }) },
        agentMemories: { read: memoryRead },
      },
    };
    const { MeshGoose } = await import("./meshGoose");
    const inline = vi
      .spyOn(MeshGoose.prototype, "run")
      .mockResolvedValue({ text: "A answer", answered: false });
    const snapshot = {
      status: "ready",
      origin: "https://b.example",
      viewer: owner,
      scope: `https://b.example:${owner}`,
    };
    let run!: (
      delivery: import("../../features/agents/service").Delivery,
    ) => Promise<void>;
    const cleanups: (() => void)[] = [];
    const publish = vi.fn(async () => ({}));
    native.invoke.mockImplementation(async (command) => {
      if (command === "mesh_compute_prepare_inference")
        return {
          baseUrl: "http://127.0.0.1:1/A/v1",
          model: "mesh",
          lease: "A",
        };
      if (command === "mesh_compute_chat") return "A answer";
      if (command === "mesh_compute_inference_current") return true;
      return { lifecycle: { state: "stopped" } };
    });
    apply({
      relay: { snapshot: () => snapshot, subscribe: () => () => {} },
      host: {
        spawn: vi.fn(),
        resolveDirectory: vi.fn(async () => "/work"),
        serveMcp: vi.fn(),
      },
      agents: {
        relay: (pubkey: string) => {
          expect(pubkey).toBe(membership);
          return {
            snapshot: () => memberSnapshot,
          };
        },
        register: (type: { run: typeof run }) => {
          run = type.run;
        },
      },
      effect: (setup: () => () => void) => {
        cleanups.push(setup());
      },
      settingsCards: { register: () => {} },
    } as unknown as Parameters<PluginModule["apply"]>[0]);
    await flushRegistration();
    try {
      await run({
        channelId: "channel-a",
        config: { mode, prompt: "Be brief" },
        signal: new AbortController().signal,
        trigger: {
          type: "mention",
          event: {
            id: "c".repeat(64),
            pubkey: owner,
            kind: 9,
            created_at: 1,
            tags: [["h", "channel-a"]],
            content: "A private question",
            sig: "",
          },
        },
        agent: {
          key: membership,
          pubkey: agent,
          owner,
          name: "A helper",
          publish,
          query: async () => [],
        },
      } as unknown as import("../../features/agents/service").Delivery);
      expect(native.invoke).toHaveBeenCalledWith(
        "mesh_compute_prepare_inference",
        {
          relay: "https://a.example",
          model: "auto",
        },
      );
      if (mode === "agent") {
        expect(memoryRead).toHaveBeenCalledWith(
          agent,
          expect.any(AbortSignal),
          undefined,
        );
        expect(inline).toHaveBeenCalledWith(
          expect.objectContaining({
            system: expect.stringContaining("A private memory"),
          }),
        );
      }
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ content: "A answer" }),
        expect.any(Function),
      );
    } finally {
      inline.mockRestore();
      for (const cleanup of cleanups.reverse()) cleanup();
    }
  },
);

it("holds the host queue until Agent and Chat work completes", async () => {
  const { MeshAgentRuntime } = await import("./meshAgent");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runRuntime = vi
    .spyOn(MeshAgentRuntime.prototype, "run")
    .mockReturnValue(pending);
  let run!: (
    delivery: import("../../features/agents/service").Delivery,
  ) => unknown;
  const cleanups: (() => void)[] = [];
  const snapshot = { status: "idle" };
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    host: { spawn: vi.fn(), resolveDirectory: vi.fn(), serveMcp: vi.fn() },
    agents: {
      register: (type: { run: typeof run }) => {
        run = type.run;
      },
    },
    effect: (setup: () => () => void) => {
      cleanups.push(setup());
    },
    settingsCards: { register: () => {} },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  try {
    const workingUntil = vi.fn();
    expect(
      run({
        config: { mode: "agent" },
        workingUntil,
      } as unknown as import("../../features/agents/service").Delivery),
    ).toBe(pending);
    expect(workingUntil).not.toHaveBeenCalled();
    expect(
      run({
        config: { mode: "chat" },
        workingUntil,
      } as unknown as import("../../features/agents/service").Delivery),
    ).toBe(pending);
  } finally {
    release();
    runRuntime.mockRestore();
    for (const cleanup of cleanups.reverse()) cleanup();
  }
});

async function creationSetup(sharing: string | null = null) {
  const owner = "a".repeat(64);
  let snapshot = {
    status: "ready",
    origin: "https://setup.example",
    viewer: owner,
    scope: `https://setup.example:${owner}`,
  };
  let status = {
    boundCommunity: snapshot.origin,
    sharing,
    lifecycle: { state: "ready" },
  };
  let Create!: React.ComponentType<{ disabled: boolean }>;
  const cleanups: (() => void)[] = [];
  const listeners = new Set<() => void>();
  native.invoke.mockImplementation(async (command) => {
    if (command === "mesh_compute_select") return "setup-lease";
    if (command === "mesh_compute_share") {
      status = { ...status, sharing: "auto-model" };
      return;
    }
    return status;
  });
  apply({
    relay: {
      snapshot: () => snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    communityReader: {
      snapshot: () => ({ viewer: snapshot.viewer }),
      subscribe: () => () => {},
    },
    host: { spawn: vi.fn(), resolveDirectory: vi.fn(), serveMcp: vi.fn() },
    agents: {
      register: (type: { Create: typeof Create }) => {
        Create = type.Create;
      },
    },
    settingsCards: { register: () => {} },
    effect: (fn: () => () => void) => {
      cleanups.push(fn());
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  await flushRegistration();
  const view = render(<Create disabled={false} />);
  return {
    dispose: () => {
      view.unmount();
      for (const fn of cleanups.reverse()) fn();
    },
    setStatus: (next: typeof status) => {
      status = next;
    },
    status: () => status,
    switchCommunity: () => {
      snapshot = {
        ...snapshot,
        origin: "https://other.example",
        scope: `https://other.example:${owner}`,
      };
      for (const fn of listeners) fn();
    },
  };
}

it("hosts setup in the existing Create slot; only explicit sharing uses Auto with no budget", async () => {
  const fixture = await creationSetup();
  try {
    const local = await screen.findByRole("button", {
      name: "Start sharing with Auto",
    });
    await waitFor(() => expect(local).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Continue without sharing" }),
    ).toBeEnabled();
    expect(
      native.invoke.mock.calls.some(([cmd]) => cmd === "mesh_compute_share"),
    ).toBe(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start sharing with Auto" }));
    await shareActionSettled();
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "setup-lease",
      model: "auto",
      auto: true,
      maxVramGb: null,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This computer is sharing",
    );
    expect(screen.getByRole("status")).toHaveFocus();
  } finally {
    fixture.dispose();
  }
});

it("does not show setup or restart already-shared compute", async () => {
  const fixture = await creationSetup("existing-model");
  try {
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Set up shared compute" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      native.invoke.mock.calls.some(([cmd]) => cmd === "mesh_compute_share"),
    ).toBe(false);
  } finally {
    fixture.dispose();
  }
});

it("rechecks sharing before starting so a concurrent settings action is preserved", async () => {
  const fixture = await creationSetup();
  try {
    const radio = await screen.findByRole("button", {
      name: "Start sharing with Auto",
    });
    await waitFor(() => expect(radio).toBeEnabled());
    fixture.setStatus({ ...fixture.status(), sharing: "started-elsewhere" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start sharing with Auto" }));
    await shareActionSettled();
    expect(
      native.invoke.mock.calls.some(([cmd]) => cmd === "mesh_compute_share"),
    ).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This computer is sharing",
    );
  } finally {
    fixture.dispose();
  }
});

it("keeps setup failure visible and allows retry without changing the Auto policy", async () => {
  const fixture = await creationSetup();
  try {
    const original = native.invoke.getMockImplementation();
    if (!original) throw new Error("Missing fixture invoke");
    let fail = true;
    native.invoke.mockImplementation(async (...args) => {
      if (args[0] === "mesh_compute_share" && fail)
        throw new Error("Start failed");
      return original(...args);
    });
    const radio = await screen.findByRole("button", {
      name: "Start sharing with Auto",
    });
    await waitFor(() => expect(radio).toBeEnabled());
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start sharing with Auto" }));
    await shareActionSettled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Start failed");
    fail = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Start sharing with Auto" }));
    await shareActionSettled();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This computer is sharing",
    );
  } finally {
    fixture.dispose();
  }
});

it("never offers to replace another community's sharing from creation", async () => {
  const fixture = await creationSetup();
  try {
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start sharing with Auto" }),
      ).toBeEnabled(),
    );
    act(() => fixture.switchCommunity());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start sharing with Auto" }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("another community");
    expect(
      native.invoke.mock.calls.some(([cmd]) => cmd === "mesh_compute_share"),
    ).toBe(false);
  } finally {
    fixture.dispose();
  }
});

it("continues without sharing and can reopen choices without a native action", async () => {
  const fixture = await creationSetup();
  try {
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Continue without sharing" }),
      );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Using community compute",
    );
    expect(screen.getByRole("status")).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Start sharing with Auto" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Change" }));
    expect(
      screen.getByRole("button", { name: "Start sharing with Auto" }),
    ).toBeInTheDocument();
    expect(
      native.invoke.mock.calls.some(([cmd]) => cmd === "mesh_compute_share"),
    ).toBe(false);
  } finally {
    fixture.dispose();
  }
});
