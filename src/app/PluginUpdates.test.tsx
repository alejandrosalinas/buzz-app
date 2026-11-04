// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginUpdates, PluginUpdatesMenu } from "./PluginUpdates";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../shared/design-system/ui/Menu";
import type { PluginManager } from "../plugins/manager";
import type { ImportPreview, PluginInfo } from "../plugins/types";
import type { AppServices } from "./services";
import { createPluginInstallRequests } from "../plugins/installer";

afterEach(cleanup);

function fixture() {
  const source = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: ".",
  };
  const plugin: PluginInfo = {
    manifest: { id: "example.notes", name: "Notes", apiVersion: 1 },
    source: "external",
    enabled: true,
    revision: "old",
    previous: "older",
    reloadable: true,
    error: null,
    updateSource: source,
  };
  const candidate = {
    path: ".",
    manifest: plugin.manifest,
    revision: "new",
    publisher: null as string | null,
  };
  const freshCandidate = { ...candidate };
  const discovered: ImportPreview = {
    token: "metadata",
    source: source.repository,
    commit: "a".repeat(40),
    candidates: [candidate],
    warnings: [],
  };
  const fresh: ImportPreview = {
    ...discovered,
    token: "immutable-preview",
    candidates: [freshCandidate],
  };
  let snapshot: ReturnType<PluginManager["snapshot"]> = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: { profile: "test", location: "test", plugins: [plugin] },
    },
    busy: false,
    activation: {},
    error: null,
    refreshError: null,
  };
  const listeners = new Set<() => void>();
  const imports = {
    checkGit: vi.fn(async () => discovered),
    git: vi.fn(async () => fresh),
    discard: vi.fn(async () => {}),
  };
  const installImport = vi.fn(async () => true);
  const manager = {
    imports,
    installImport,
    change: vi.fn(),
    retryPlugin: vi.fn(),
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginManager;
  const relay = { snapshot: () => ({ session: {} }) } as AppServices["relay"];
  const mount = () =>
    render(
      <ToastProvider>
        <PluginUpdates
          plugins={manager}
          relay={relay}
          installRequests={createPluginInstallRequests()}
        >
          <MenuRoot>
            <MenuTrigger>Profile</MenuTrigger>
            <MenuPopup>
              <PluginUpdatesMenu recommendations={0} onManage={vi.fn()} />
            </MenuPopup>
          </MenuRoot>
        </PluginUpdates>
      </ToastProvider>,
    );
  return {
    source,
    candidate,
    freshCandidate,
    plugin,
    discovered,
    fresh,
    imports,
    installImport,
    manager,
    state: () => snapshot,
    emit(next: Partial<ReturnType<PluginManager["snapshot"]>>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    mount,
  };
}

it("applies a fresh preview for an update without more access", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() =>
    expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
      "immutable-preview",
      ".",
    ),
  );
  expect(f.imports.git).toHaveBeenCalledOnce();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it.each(["discovered", "fresh", "publisher"] as const)(
  "requires confirmation when %s data requires review",
  async (kind) => {
    const f = fixture();
    if (kind === "discovered")
      f.candidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    if (kind === "publisher") f.freshCandidate.publisher = "b".repeat(64);
    else
      f.freshCandidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name:
          kind === "discovered" ? "Review permissions" : "Update and reload",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
    const confirm = await within(dialog).findByRole("button", {
      name: "Update",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(f.installImport).not.toHaveBeenCalled();
    if (kind === "publisher")
      expect(
        within(dialog).getByText(/Previous publisher: Unsigned/),
      ).toBeVisible();
    else
      expect(within(dialog).getByText("Read your files (added)")).toBeVisible();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
        "immutable-preview",
        ".",
      ),
    );
  },
);

it("keeps Later updates in the Plugins menu and cancellation leaves the plugin running", async () => {
  const f = fixture();
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { files: true },
  };
  f.mount();
  const later = await screen.findByRole("button", {
    name: "Later",
  });
  fireEvent.click(later);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Update and reload" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Plugins/ }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Update Notes" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Update" }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("can cancel while a fresh preview loads, then discards the late preview", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  await waitFor(() =>
    expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview"),
  );
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("shows an install failure in the review and permits a retry", async () => {
  const f = fixture();
  f.installImport.mockResolvedValueOnce(false);
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Plugin installation wasn’t confirmed");
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Update" }),
  );
  await waitFor(() => expect(f.installImport).toHaveBeenCalledTimes(2));
});

it("offers activation retry and the existing rollback confirmation outside Settings", async () => {
  const f = fixture();
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
  await act(async () => {
    f.emit({
      activation: {
        "example.notes": {
          revision: "old",
          status: "failed",
          error: "Activation failed",
        },
      },
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry activation" }),
  );
  expect(f.manager.retryPlugin).toHaveBeenCalledWith("example.notes");
  fireEvent.click(
    screen.getByRole("button", { name: "Plugin recovery actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Roll back" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Roll back Notes?",
  });
  expect(f.manager.change).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.manager.change).not.toHaveBeenCalled();
});

it.each([true, false])(
  "preserves the managed pin and refuses a mismatched preview (matches: %s)",
  async (matches) => {
    const f = fixture();
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    f.emit({
      configuration: {
        ...configuration,
        managed: {
          status: "ready",
          path: "policy",
          source: "Example",
          problems: [],
          plugins: [
            {
              id: f.plugin.manifest.id,
              ...f.source,
              commit: "a".repeat(40),
              state: "outdated",
            },
          ],
        },
      },
    });
    if (!matches) f.fresh.commit = "b".repeat(40);
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Update and reload" }),
    );
    await waitFor(() =>
      expect(f.imports.git).toHaveBeenCalledWith(
        f.source.repository,
        "main",
        undefined,
        "a".repeat(40),
      ),
    );
    if (matches)
      await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
    else {
      expect(
        await screen.findByText(/not at the commit that was requested/),
      ).toBeVisible();
      expect(f.installImport).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    }
  },
);

it("retires a pending preview when the saved source changes", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    act(() =>
      f.emit({
        configuration: {
          ...configuration,
          catalog: {
            ...configuration.catalog,
            plugins: [
              {
                ...f.plugin,
                updateSource: { ...f.source, reference: "other" },
              },
            ],
          },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview");
});

it("requires review when a fresh update removes a process artifact constraint", async () => {
  const f = fixture();
  const process = { id: "worker", program: "worker", args: [] };
  f.plugin.manifest = {
    ...f.plugin.manifest,
    host: {
      processes: [
        {
          ...process,
          artifact: { path: "bin/worker", sha256: "a".repeat(64) },
        },
      ],
    },
  };
  f.candidate.manifest = f.plugin.manifest;
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { processes: [process] },
  };
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  const confirm = await within(dialog).findByRole("button", { name: "Update" });
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: /Start worker/ }));
  await waitFor(() =>
    expect(within(dialog).getByText("bin/worker")).toBeVisible(),
  );
  fireEvent.click(confirm);
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
});
