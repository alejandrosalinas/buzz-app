// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import type {
  Catalog,
  ImportPreview,
  ManagedEntry,
  ManagedPlugins as Policy,
} from "../plugins/types";
import { createPluginInstallRequests } from "../plugins/installer";
import { ManagedPlugins, UrlPluginInstallReview } from "./ManagedPlugins";

afterEach(cleanup);

const commit = "0123456789abcdef0123456789abcdef01234567";
const entry = (
  state: ManagedEntry["state"],
  overrides: Partial<ManagedEntry> = {},
): ManagedEntry => ({
  id: "example.managed",
  repository: "https://example.com/plugins",
  reference: "v1",
  commit,
  path: "dist",
  state,
  ...overrides,
});
const ready = (plugins: ManagedEntry[], problems: string[] = []): Policy => ({
  status: "ready",
  path: "/data/managed-plugins.json",
  source: "Example Org",
  plugins,
  problems,
});
const manifest = {
  id: "example.managed",
  name: "Managed example",
  apiVersion: 1 as const,
};
const preview = (overrides: Partial<ImportPreview> = {}): ImportPreview => ({
  token: "preview",
  source: "https://example.com/plugins",
  commit,
  warnings: [],
  candidates: [{ path: "dist", revision: "new", manifest }],
  ...overrides,
});
const installed = {
  manifest: { ...manifest, name: "Installed example" },
  source: "external" as const,
  enabled: true,
  revision: "old",
  previous: null,
  reloadable: false,
  error: null,
};
const catalog = (plugins: Catalog["plugins"] = []): Catalog => ({
  profile: "test",
  location: "test",
  plugins,
});

function harness(options: { git?: ReturnType<typeof vi.fn> } = {}) {
  const git = options.git ?? vi.fn(async () => preview());
  const imports = { git, discard: vi.fn(async () => {}) };
  const manager = {
    imports,
    installImport: vi.fn(async () => true),
    change: vi.fn(async () => true),
    snapshot: (): { error: string | null } => ({ error: null }),
  };
  return { manager, imports, git };
}
function show(
  manager: unknown,
  managed: Policy | undefined,
  plugins: Catalog["plugins"] = [],
  extra: {
    busy?: boolean;
    strict?: boolean;
    holdReview?: () => () => void;
  } = {},
) {
  const ui = (
    <ManagedPlugins
      plugins={manager as PluginManager}
      managed={managed}
      catalog={catalog(plugins)}
      busy={extra.busy ?? false}
      holdReview={extra.holdReview}
    />
  );
  return render(extra.strict ? <StrictMode>{ui}</StrictMode> : ui);
}

it("renders nothing without a policy, in the browser, or when everything is current", () => {
  const { manager } = harness();
  const none = show(manager, undefined);
  expect(none.container).toBeEmptyDOMElement();
  none.unmount();
  const current = show(manager, ready([entry("current")]), [installed]);
  expect(current.container).toBeEmptyDOMElement();
  current.unmount();
  const web = show({ imports: undefined }, ready([entry("missing")]));
  expect(web.container).toBeEmptyDOMElement();
});

it("lists pending recommendations under their source without installing anything", () => {
  const { manager, git } = harness();
  show(
    manager,
    ready([
      entry("missing"),
      entry("outdated", { id: "example.moved" }),
      entry("other", { id: "example.other" }),
    ]),
  );
  const group = screen.getByRole("region", {
    name: "Recommended by Example Org",
  });
  expect(
    within(group).getByRole("button", {
      name: "Review and install example.managed",
    }),
  ).toBeEnabled();
  expect(
    within(group).getByRole("button", { name: "Review update example.moved" }),
  ).toBeVisible();
  expect(within(group).getByText(/Update recommended/)).toBeVisible();
  expect(
    within(group).getByText(/Installed from a different source/),
  ).toBeVisible();
  expect(within(group).getAllByRole("button")).toHaveLength(2);
  expect(git).not.toHaveBeenCalled();
});

it("reviews at the pinned commit, then installs and enables only after confirmation", async () => {
  const { manager, git, imports } = harness();
  show(manager, ready([entry("missing")]), [], { strict: true });
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Review Managed example Plugin access",
  });
  await within(dialog).findByText(`Commit: ${commit}`);
  expect(git).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/plugins",
    "v1",
    undefined,
    commit,
  );
  expect(within(dialog).getByText(/Recommended by Example Org/)).toBeVisible();
  expect(manager.installImport).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "preview",
      "dist",
    ),
  );
  await waitFor(() =>
    expect(manager.change).toHaveBeenCalledExactlyOnceWith(
      "enable",
      "example.managed",
    ),
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("reviews a URL recommendation from its pinned artifact without Git", async () => {
  const { manager, git } = harness();
  const sha256 = "a".repeat(64);
  const url = vi.fn(async () =>
    preview({
      source: "https://cdn.example.com/example.managed.json",
      commit: null,
      candidates: [{ path: ".", revision: sha256, manifest }],
    }),
  );
  Object.assign(manager.imports, { url });
  show(
    manager,
    ready([
      {
        id: "example.managed",
        url: "https://cdn.example.com/example.managed.json",
        sha256,
        state: "missing",
      },
    ]),
    [],
    { strict: true },
  );
  expect(
    screen.getByText("https://cdn.example.com/example.managed.json"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Review Managed example Plugin access",
  });
  expect(url).toHaveBeenCalledExactlyOnceWith(
    "https://cdn.example.com/example.managed.json",
    sha256,
  );
  expect(git).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "preview",
      ".",
    ),
  );
});

it("refuses a URL artifact that is a different plugin", async () => {
  const { manager, imports } = harness();
  const url = vi.fn(async () =>
    preview({
      commit: null,
      candidates: [
        {
          path: ".",
          revision: "b".repeat(64),
          manifest: { ...manifest, id: "example.other" },
        },
      ],
    }),
  );
  Object.assign(manager.imports, { url });
  show(
    manager,
    ready([
      {
        id: "example.managed",
        url: "https://cdn.example.com/example.managed.json",
        sha256: "b".repeat(64),
        state: "missing",
      },
    ]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(
    await within(dialog).findByText(
      "The plugin at this URL is example.other, not example.managed.",
    ),
  ).toBeVisible();
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(manager.installImport).not.toHaveBeenCalled();
});

const market = { id: "example.market", name: "Market" };

it("holds install requests off while a managed review is open, including one already admitted", async () => {
  const { manager } = harness();
  const requests = createPluginInstallRequests();
  const source = {
    repository: "https://example.com/other.git",
    reference: "main",
  };
  show(manager, ready([entry("missing")]), [], {
    strict: true,
    holdReview: requests.holdReview,
  });
  const admitted = requests.request(source, market);
  const id = requests.snapshot()?.id ?? 0;
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(requests.claim(id)).toBe(false);
  await expect(admitted).resolves.toBe("unavailable");
  await expect(requests.request(source, market)).resolves.toBe("unavailable");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const later = requests.request(source, market);
  expect(requests.snapshot()).toBeDefined();
  requests.settle(requests.snapshot()?.id ?? 0, "cancelled");
  await later;
});

it("keeps a new plugin disabled when the user opts out", async () => {
  const { manager } = harness();
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("switch", { name: "Enable plugin" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(manager.installImport).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).not.toHaveBeenCalled();
});

it("discards the preview when the review is cancelled", async () => {
  const { manager, imports } = harness();
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  const cancel = await within(dialog).findByRole("button", { name: "Cancel" });
  await waitFor(() => expect(cancel).toHaveFocus());
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("offers an update for the installed plugin and preserves its enabled state", async () => {
  const { manager } = harness();
  show(manager, ready([entry("outdated")]), [{ ...installed, enabled: false }]);
  fireEvent.click(
    screen.getByRole("button", { name: "Review update example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Update Managed example",
  });
  expect(
    await within(dialog).findByText("This plugin will stay disabled."),
  ).toBeVisible();
  expect(
    within(dialog).queryByRole("switch", { name: "Enable plugin" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "preview",
      "dist",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).not.toHaveBeenCalled();
});

it("refuses a moved reference and lets the user try again", async () => {
  const git = vi
    .fn()
    .mockRejectedValueOnce(
      "The repository reference is at commit abc, not the required commit def.",
    )
    .mockResolvedValue(preview());
  const { manager } = harness({ git });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "not the required commit def",
  );
  expect(
    within(dialog).queryByRole("button", { name: "Install plugin" }),
  ).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  expect(
    await within(dialog).findByRole("button", { name: "Install plugin" }),
  ).toBeEnabled();
  expect(git).toHaveBeenCalledTimes(2);
});

it("rejects a commit without the recommended plugin at the recommended path", async () => {
  const { manager, imports } = harness({
    git: vi.fn(async () =>
      preview({
        warnings: ["dist: No built plugin.js beside manifest.json"],
        candidates: [],
      }),
    ),
  });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "dist: No built plugin.js beside manifest.json",
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
});

it("rejects a different plugin ID at the recommended path", async () => {
  const { manager } = harness({
    git: vi.fn(async () =>
      preview({
        candidates: [
          {
            path: "dist",
            revision: "new",
            manifest: { ...manifest, id: "example.other" },
          },
        ],
      }),
    ),
  });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "example.other, not example.managed",
  );
});

it("keeps a failed installation open with its reason", async () => {
  const { manager } = harness();
  manager.installImport.mockResolvedValue(false);
  manager.snapshot = () => ({ error: "Registry is locked" });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Install plugin" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Registry is locked",
  );
  expect(manager.change).not.toHaveBeenCalled();
});

it("disables reviews while plugin management is busy", () => {
  const { manager } = harness();
  show(manager, ready([entry("missing")]), [], { busy: true });
  expect(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  ).toBeDisabled();
});

it("reports an unusable file and ignored entries without recommending anything", () => {
  const { manager } = harness();
  const invalid = show(manager, {
    status: "invalid",
    path: "/data/managed-plugins.json",
    reason: "Invalid JSON: EOF while parsing",
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "/data/managed-plugins.json. Invalid JSON: EOF while parsing",
  );
  expect(screen.queryByRole("button")).toBeNull();
  invalid.unmount();
  show(
    manager,
    ready(
      [],
      ["Plugin 2: commit must be a full 40 or 64 digit hexadecimal object ID"],
    ),
  );
  expect(
    screen.getByRole("heading", { name: "Recommended plugins" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Plugin 2: commit must be",
  );
  expect(screen.queryByRole("button")).toBeNull();
});

const other = "fedcba9876543210fedcba9876543210fedcba98";

it("refuses a preview whose commit is not the pinned one, even when the host ignored the pin", async () => {
  const { manager, imports } = harness({
    git: vi.fn(async () => preview({ commit: other })),
  });
  show(manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    `returned commit ${other}, not the recommended commit ${commit}`,
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(
    within(dialog).queryByRole("button", { name: "Install plugin" }),
  ).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("refuses a preview without a commit and accepts the pin in any letter case", async () => {
  const missing = harness({
    git: vi.fn(async () => preview({ commit: null })),
  });
  const first = show(missing.manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("unknown");
  first.unmount();
  cleanup();
  const upper = harness({
    git: vi.fn(async () => preview({ commit: commit.toUpperCase() })),
  });
  show(upper.manager, ready([entry("missing")]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  expect(
    await screen.findByRole("button", { name: "Install plugin" }),
  ).toBeEnabled();
});

it("keeps reviewing and enables a new plugin when installing empties the recommendations", async () => {
  const { manager, imports } = harness();
  const view = (managed: Policy, plugins: Catalog["plugins"]) => (
    <ManagedPlugins
      plugins={manager as unknown as PluginManager}
      managed={managed}
      catalog={catalog(plugins)}
      busy={false}
    />
  );
  const { rerender } = render(view(ready([entry("missing")]), []));
  let dialogAtEnable: HTMLElement | null = null;
  let discardedBeforeEnable = false;
  manager.installImport.mockImplementation(async () => {
    rerender(view(ready([entry("current")]), [installed]));
    return true;
  });
  manager.change.mockImplementation(async () => {
    dialogAtEnable = screen.queryByRole("dialog");
    discardedBeforeEnable = imports.discard.mock.calls.length > 1;
    return true;
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() =>
    expect(manager.change).toHaveBeenCalledExactlyOnceWith(
      "enable",
      "example.managed",
    ),
  );
  expect(dialogAtEnable).not.toBeNull();
  expect(discardedBeforeEnable).toBe(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(imports.discard).toHaveBeenCalledTimes(1);
});

it("reviews again when the recommendation changes while the review is open", async () => {
  const git = vi
    .fn()
    .mockResolvedValueOnce(preview())
    .mockResolvedValueOnce(preview({ token: "second", commit: other }));
  const { manager, imports } = harness({ git });
  const view = (managed: Policy) => (
    <ManagedPlugins
      plugins={manager as unknown as PluginManager}
      managed={managed}
      catalog={catalog()}
      busy={false}
    />
  );
  const { rerender } = render(view(ready([entry("missing")])));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  await screen.findByText(`Commit: ${commit}`);
  rerender(view(ready([entry("missing", { commit: other })])));
  await screen.findByText(`Commit: ${other}`);
  expect(git).toHaveBeenLastCalledWith(
    "https://example.com/plugins",
    "v1",
    undefined,
    other,
  );
  expect(imports.discard).toHaveBeenCalledWith("preview");
  fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  await waitFor(() =>
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "second",
      "dist",
    ),
  );
});

it("cannot install a preview for a recommendation that has since changed", async () => {
  let release: (value: ImportPreview) => void = () => {};
  const git = vi
    .fn()
    .mockResolvedValueOnce(preview())
    .mockReturnValueOnce(
      new Promise<ImportPreview>((done) => (release = done)),
    );
  const { manager } = harness({ git });
  const view = (managed: Policy) => (
    <ManagedPlugins
      plugins={manager as unknown as PluginManager}
      managed={managed}
      catalog={catalog()}
      busy={false}
    />
  );
  const { rerender } = render(view(ready([entry("missing")])));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  await screen.findByText(`Commit: ${commit}`);
  rerender(view(ready([entry("missing", { commit: other })])));
  await waitFor(() => expect(git).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
  release(preview({ token: "second", commit: other }));
  expect(
    await screen.findByRole("button", { name: "Install plugin" }),
  ).toBeEnabled();
});

it("closes the review when the policy no longer lists the plugin", async () => {
  const { manager, imports } = harness();
  const view = (managed: Policy) => (
    <ManagedPlugins
      plugins={manager as unknown as PluginManager}
      managed={managed}
      catalog={catalog()}
      busy={false}
    />
  );
  const { rerender } = render(view(ready([entry("missing")])));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  await screen.findByText(`Commit: ${commit}`);
  rerender(view(ready([])));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("treats a plugin installed while the review was open as an update", async () => {
  const { manager } = harness();
  const view = (plugins: Catalog["plugins"]) => (
    <ManagedPlugins
      plugins={manager as unknown as PluginManager}
      managed={ready([entry("missing")])}
      catalog={catalog(plugins)}
      busy={false}
    />
  );
  const { rerender } = render(view([]));
  fireEvent.click(
    screen.getByRole("button", { name: "Review and install example.managed" }),
  );
  await screen.findByRole("switch", { name: "Enable plugin" });
  rerender(view([{ ...installed, enabled: false }]));
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await waitFor(() => expect(manager.installImport).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).not.toHaveBeenCalled();
});

it("warns about rollback and a revision the plugin already has, as the Add dialog does", async () => {
  const { manager } = harness({
    git: vi.fn(async () =>
      preview({
        candidates: [
          { path: "dist", revision: "old", manifest, publisher: "npub1signer" },
        ],
      }),
    ),
  });
  show(manager, ready([entry("outdated")]), [
    {
      ...installed,
      hasSignature: false,
      rollbackBlockedReason: "Rolling back is blocked by a newer signature",
    },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Review update example.managed" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Update Managed example",
  });
  expect(
    await within(dialog).findByText(
      "You cannot roll back to the unsigned revision after this update.",
    ),
  ).toBeVisible();
  expect(
    within(dialog).getByText(/already matches this revision/),
  ).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Update" })).toBeEnabled();
});

it("warns when the update keeps a rollback block for an identical revision", async () => {
  const { manager } = harness({
    git: vi.fn(async () =>
      preview({ candidates: [{ path: "dist", revision: "old", manifest }] }),
    ),
  });
  show(manager, ready([entry("outdated")]), [
    {
      ...installed,
      rollbackBlockedReason: "Rolling back is blocked by a newer signature",
    },
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: "Review update example.managed" }),
  );
  expect(
    await screen.findByText("Rolling back is blocked by a newer signature."),
  ).toBeVisible();
});

const artifact = {
  id: "example.managed",
  url: "https://cdn.example.com/example.managed.json",
  sha256: "c".repeat(64),
};
function showRequest(manager: unknown, plugins: Catalog["plugins"] = []) {
  const requests = createPluginInstallRequests();
  const outcome = requests.request(artifact, market);
  const id = requests.snapshot()?.id ?? 0;
  render(
    <StrictMode>
      <UrlPluginInstallReview
        plugins={manager as PluginManager}
        catalog={catalog(plugins)}
        busy={false}
        source={artifact}
        requester="Market"
        holdReview={requests.holdReview}
        request={{ ...requests, id }}
        returnFocus={() => null}
      />
    </StrictMode>,
  );
  return { requests, outcome };
}

it("reviews a plugin's URL install request and reports the install", async () => {
  const { manager, git } = harness();
  const url = vi.fn(async () =>
    preview({
      commit: null,
      candidates: [{ path: ".", revision: artifact.sha256, manifest }],
    }),
  );
  Object.assign(manager.imports, { url });
  const { requests, outcome } = showRequest(manager);
  const dialog = await screen.findByRole("dialog", {
    name: "Review Managed example Plugin access",
  });
  expect(
    await within(dialog).findByText(`SHA-256: ${artifact.sha256}`),
  ).toBeVisible();
  expect(url).toHaveBeenCalledExactlyOnceWith(artifact.url, artifact.sha256);
  expect(git).not.toHaveBeenCalled();
  await expect(requests.request(artifact, market)).resolves.toBe("unavailable");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await expect(outcome).resolves.toBe("installed");
  expect(manager.installImport).toHaveBeenCalledExactlyOnceWith("preview", ".");
});

it("cancels a plugin's URL install request when its review closes", async () => {
  const { manager, imports } = harness();
  Object.assign(manager.imports, {
    url: vi.fn(async () =>
      preview({
        commit: null,
        candidates: [{ path: ".", revision: artifact.sha256, manifest }],
      }),
    ),
  });
  const { outcome } = showRequest(manager, [installed]);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: "Update" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await expect(outcome).resolves.toBe("cancelled");
  expect(imports.discard).toHaveBeenCalledWith("preview");
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("refuses a URL install request over a plugin installed from Git", async () => {
  const { manager } = harness();
  Object.assign(manager.imports, {
    url: vi.fn(async () =>
      preview({
        commit: null,
        candidates: [{ path: ".", revision: artifact.sha256, manifest }],
      }),
    ),
  });
  const { outcome } = showRequest(manager, [
    {
      ...installed,
      updateSource: {
        repository: "https://example.com/plugins",
        reference: "v1",
        path: "dist",
      },
    },
  ]);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Update" }),
  );
  expect(
    await within(dialog).findByText(
      `Installed example is already installed from https://example.com/plugins; remove it first to install it from ${artifact.url}.`,
    ),
  ).toBeVisible();
  expect(manager.installImport).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await expect(outcome).resolves.toBe("cancelled");
});
