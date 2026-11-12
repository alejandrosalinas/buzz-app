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
import userEvent from "@testing-library/user-event";
import { formStateToYaml, yamlToFormState } from "./workflowFormTypes";
import type { ChannelList } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { formatPublicKey } from "../../shared/identity/public-key";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import { keypair, profile, signed } from "../../features/relay/testing";
import type { RelayEvent } from "../../features/relay/events";
import { createAgentLibrary } from "../../features/agents/library";
import { bindNames } from "../../features/identity-names/service";
import { agentDirectory } from "../../features/identity-names/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { WorkflowCommunity } from "./WorkflowsPage";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
  fixtureYaml,
} from "./fixtures";
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

function mount(
  initialYaml = fixtureYaml,
  owner = fixtureViewer,
  save = true,
  identity: Partial<Pick<RelaySession, "profiles" | "names">> = {},
) {
  const fixture = createWorkflowFixture(identity.profiles);
  fixture.definitions.update({
    status: "ready",
    data: {
      partial: false,
      items: [{ ...fixtureDefinition, owner, yaml: initialYaml }],
    },
  });
  let list: ChannelList = {
    status: "ready",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  const listeners = new Set<() => void>();
  const session = {
    profiles: createProfileDirectory({ read: async () => [] }).queries,
    ...identity,
    workflows: save
      ? fixture.capability
      : {
          ...fixture.capability,
          availability: { ...fixture.capability.availability, save: false },
        },
    channels: {
      list: () => list,
      ensureList: () => {},
      subscribeList: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <WorkflowCommunity session={session} viewer={fixtureViewer} />
    </ToastProvider>,
  );
  return {
    ...fixture,
    setChannels(next: ChannelList) {
      list = next;
      for (const fn of listeners) fn();
    },
  };
}

function detailPane() {
  return within(screen.getByRole("region", { name: "Workflow details" }));
}

it("shows the owner's identity in the row and detail and follows profile updates", async () => {
  const owner = keypair();
  let releaseRead: (events: readonly RelayEvent[]) => void = () => {};
  const pendingRead = new Promise<readonly RelayEvent[]>((resolve) => {
    releaseRead = resolve;
  });
  const read = vi.fn(() => pendingRead);
  const profiles = createProfileDirectory({ read });
  const library = createAgentLibrary(undefined);
  let alias: string | undefined;
  let renamed = () => {};
  const names = bindNames(
    { profiles: profiles.queries, agentLibrary: library.queries },
    {
      snapshot: () => [
        {
          id: "owner-alias",
          activate: () => undefined,
          scope: () => (key: string) =>
            key === owner.pubkey && alias ? { name: alias } : undefined,
          subscribe(listener: () => void) {
            renamed = listener;
            return () => {};
          },
        },
      ],
      subscribe: () => () => {},
    },
  );
  try {
    mount(fixtureYaml, owner.pubkey, true, {
      profiles: profiles.queries,
      names,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Owner: My workflows" }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "All channel workflows" }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByText(`Owner: ${formatPublicKey(owner.pubkey)}`),
      ).toBeVisible(),
    );
    await act(async () => releaseRead([profile(owner, { name: "Salman" })]));
    expect(screen.getByText("Owner: Salman")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    );
    expect(detailPane().getByText("Owner: Salman")).toBeVisible();
    act(() =>
      profiles.accept([
        profile(owner, { name: "Updated name" }, 1_700_000_001),
      ]),
    );
    expect(detailPane().getByText("Owner: Updated name")).toBeVisible();
    expect(screen.queryByText("Owner: Salman")).toBeNull();
    act(() => {
      alias = "Local owner alias";
      renamed();
    });
    expect(screen.getAllByText("Owner: Local owner alias")).toHaveLength(2);
    expect(screen.queryByText("Owner: Updated name")).toBeNull();
  } finally {
    await act(async () => releaseRead([]));
    cleanup();
    names.dispose();
    library.dispose();
    profiles.dispose();
  }
});

it.each(["{}", "malformed JSON"])(
  "uses an abbreviated public key for a nameless profile: %s",
  async (content) => {
    const owner = keypair();
    const namesake = keypair();
    const profiles = createProfileDirectory({
      read: async () => [signed(owner, { kind: 0, content, tags: [] })],
    });
    profiles.accept([profile(namesake, { name: owner.pubkey.slice(0, 10) })]);
    const library = createAgentLibrary(undefined);
    const names = bindNames(
      { profiles: profiles.queries, agentLibrary: library.queries },
      {
        snapshot: () => [agentDirectory],
        subscribe: () => () => {},
      },
    );
    try {
      const fixture = mount(fixtureYaml, owner.pubkey, true, {
        profiles: profiles.queries,
        names,
      });
      act(() =>
        fixture.setChannels({
          status: "ready",
          channels: [
            {
              id: fixtureChannel,
              name: "Fixture channel",
              members: [owner.pubkey, namesake.pubkey],
            },
          ],
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Owner: My workflows" }),
      );
      fireEvent.click(
        screen.getByRole("radio", { name: "All channel workflows" }),
      );
      await waitFor(() =>
        expect(
          profiles.queries.snapshot().get(owner.pubkey)?.nameIsFallback,
        ).toBe(true),
      );
      await waitFor(() =>
        expect(
          screen.getByText(`Owner: ${formatPublicKey(owner.pubkey)}`),
        ).toBeVisible(),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /^Open Message helper:/ }),
      );
      expect(
        detailPane().getByText(`Owner: ${formatPublicKey(owner.pubkey)}`),
      ).toBeVisible();
      expect(
        screen.queryByText(`Owner: ${owner.pubkey.slice(0, 10)}`),
      ).toBeNull();
    } finally {
      cleanup();
      names.dispose();
      library.dispose();
      profiles.dispose();
    }
  },
);

it("hydrates distinct displayed workflow owners in one batched profile query", async () => {
  const owners = [keypair(), keypair(), keypair()] as const;
  const read = vi.fn(async () =>
    owners.map((owner, index) => profile(owner, { name: `Owner ${index}` })),
  );
  const profiles = createProfileDirectory({ read });
  try {
    const fixture = mount(fixtureYaml, owners[0].pubkey, true, {
      profiles: profiles.queries,
    });
    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: {
          partial: false,
          items: [...owners, owners[0]].map((owner, index) => ({
            ...fixtureDefinition,
            id: `${index}`,
            owner: owner.pubkey,
          })),
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Owner: My workflows" }),
    );
    fireEvent.click(
      screen.getByRole("radio", { name: "All channel workflows" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/^Owner: Owner \d$/)).toHaveLength(4),
    );
    expect(read).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    profiles.dispose();
  }
});

it("lengthens fallback key suffixes when visible owners share one", async () => {
  // Both npubs end in "caj" but differ at the fourth-to-last character.
  const owners = ["a".repeat(64), `${"b".repeat(60)}d92e`] as const;
  const fixture = mount(fixtureYaml, owners[0]);
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: {
        partial: false,
        items: owners.map((owner, index) => ({
          ...fixtureDefinition,
          id: `${index}`,
          owner,
        })),
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Owner: My workflows" }));
  fireEvent.click(screen.getByRole("radio", { name: "All channel workflows" }));
  expect(await screen.findByText("Owner: npub…rcaj")).toBeVisible();
  expect(screen.getByText("Owner: npub…vcaj")).toBeVisible();
  expect(screen.queryByText("Owner: npub…caj")).toBeNull();
});

it("delivers a late webhook secret on the landing page after confirmed navigation", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  );
  fireEvent.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(fixture.calls.save).toBe(1);
  expect(fixture.capability.operations.snapshot()[0]?.outcome).toBe("pending");
  fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Leave this draft?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Leave draft" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull(),
  );
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-NAVIGATION-SECRET");
  });
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "•".repeat(24),
  );
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain(
    "DISPOSABLE-NAVIGATION-SECRET",
  );
});

it("labels landing controls as configuration and retains the runtime caveat in detail", async () => {
  mount();
  expect(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).not.toBeChecked();
  expect(screen.queryByText("Configuration: Off")).not.toBeInTheDocument();
  expect(
    screen.getByText(/Turning off does not confirm runs have stopped/),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  );
  fireEvent.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  expect(
    await screen.findByRole("region", { name: "Workflow editor" }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("dialog", { name: "Message helper" })).getByText(
      /Turning off does not confirm runs have stopped/,
    ),
  ).toBeVisible();
});

it("explains another author's disabled controls from the landing through the read-only dialog", async () => {
  const user = userEvent.setup();
  const fixture = mount(fixtureYaml, "22".repeat(32));
  await user.click(screen.getByRole("button", { name: "Owner: My workflows" }));
  await user.click(
    screen.getByRole("radio", { name: "All channel workflows" }),
  );
  const toggle = await screen.findByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(
    "Only the author can change this workflow.",
  );
  const reason = screen.getByText("Only the author can change this workflow.");
  expect(reason).not.toBeVisible();
  expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  await user.click(toggle);
  await user.click(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  );
  const pane = detailPane();
  const paneToggle = pane.getByRole("switch", {
    name: "Enabled in configuration",
  });
  expect(paneToggle).toHaveAttribute("aria-disabled", "true");
  expect(paneToggle).toHaveAccessibleDescription(
    "Only the author can change this workflow.",
  );
  expect(
    pane.getByText("Only the author can change this workflow."),
  ).toBeVisible();
  await user.click(pane.getByRole("button", { name: "View workflow" }));
  const dialog = screen.getByRole("dialog", { name: "Message helper" });
  const controls = within(dialog);
  const enable = controls.getByRole("switch", {
    name: "Enabled in configuration",
  });
  expect(enable).toHaveAttribute("aria-disabled", "true");
  expect(enable).toHaveAccessibleDescription(
    "Only the author can change this workflow.",
  );
  await user.click(enable);
  expect(
    controls.getByRole("textbox", { name: "Workflow name" }),
  ).toHaveAccessibleDescription("Only the author can change this workflow.");
  expect(
    controls.getByRole("textbox", { name: "Workflow name" }),
  ).toBeDisabled();
  expect(controls.queryByText("Read-only")).not.toBeInTheDocument();
  expect(
    controls.queryByRole("button", { name: "Save changes" }),
  ).not.toBeInTheDocument();
  expect(
    controls.queryByRole("button", { name: /^(Close|Cancel)$/ }),
  ).not.toBeInTheDocument();
  expect(controls.getByRole("tab", { name: "Form" })).toBeVisible();
  await user.click(controls.getByRole("tab", { name: "YAML" }));
  expect(
    controls.getByRole("textbox", { name: "Workflow YAML" }),
  ).toHaveAttribute("readonly");
  await user.click(controls.getByRole("button", { name: "Close editor" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.calls.save).toBe(0);
});

it("explains a pending toggle until exact readback and then shows the saved state", async () => {
  const user = userEvent.setup();
  const fixture = mount();
  const toggle = await screen.findByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Turn on" }));
  expect(fixture.calls.save).toBe(1);
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(
    "Waiting for the submitted change to be resolved.",
  );
  expect(toggle).not.toBeChecked();
  await act(async () => fixture.finish("succeeded"));
  const savedToggle = screen.getByRole("switch", {
    name: "Enabled in configuration: Message helper",
  });
  expect(savedToggle).not.toHaveAttribute("aria-disabled", "true");
  expect(savedToggle).toBeChecked();
  expect(savedToggle).not.toHaveAccessibleDescription();
});

it("describes unavailable host saving without a disclosure", async () => {
  const reason = "Saving is unavailable from this host.";
  const fixture = mount(fixtureYaml, fixtureViewer, false);
  const toggle = await screen.findByRole("switch");
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  expect(toggle).toHaveAccessibleDescription(reason);
  const user = userEvent.setup();
  expect(screen.queryByText("Saving unavailable")).not.toBeInTheDocument();
  expect(screen.getByText(reason)).not.toBeVisible();
  await user.click(toggle);
  expect(fixture.calls.save).toBe(0);
});

it("does not show unreadable YAML as an enabled configuration", async () => {
  const fixture = mount("name: [");
  const restriction = await screen.findByText("Unreadable configuration");
  await waitFor(() => expect(restriction).toBeVisible());
  expect(restriction.closest("details")).toBeNull();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(fixture.calls.save).toBe(0);
});

it("shows valid omitted-enabled configuration as on", async () => {
  mount(fixtureYaml.replace("enabled: false\n", ""));
  expect(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).toBeChecked();
});

it("keeps the editor mounted through exact readback beneath the one-time secret", async () => {
  const fixture = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  );
  fireEvent.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  const editor = screen.getByRole("dialog", { name: "Message helper" });
  fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow YAML" }), {
    target: { value: fixtureYaml.replace("message_posted", "webhook") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {
    fixture.finish("succeeded", true, "DISPOSABLE-SAVE-SECRET");
  });
  expect(editor).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(fixture.calls.take).toBe(1);
  expect(document.body.textContent).not.toContain("DISPOSABLE-SAVE-SECRET");
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal webhook secret" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("dialog", { name: "Message helper" })).toBe(editor);
  expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
    fixtureYaml.replace("message_posted", "webhook"),
  );
});

it.each(["discard", "remove"])(
  "guards canonical YAML's incomplete local condition until %s",
  async (finish) => {
    const parsed = yamlToFormState(fixtureYaml);
    if (!parsed.ok) throw new Error(parsed.error);
    const canonical = formStateToYaml(parsed.state);
    const fixture = mount(canonical);
    const user = userEvent.setup();
    const warnsOnUnload = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    await user.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    await user.click(
      detailPane().getByRole("button", { name: "Edit workflow" }),
    );
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Add condition" }));
    await user.click(await screen.findByRole("option", { name: "Author" }));
    await user.type(
      screen.getByRole("textbox", { name: "Value" }),
      "partial-pubkey",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(warnsOnUnload()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    const confirm = screen.getByRole("alertdialog", {
      name: "Leave this draft?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue(
      "partial-pubkey",
    );
    if (finish === "remove") {
      await user.click(
        screen.getByRole("button", { name: "Remove Author condition" }),
      );
      expect(warnsOnUnload()).toBe(false);
      await user.click(screen.getByRole("tab", { name: "YAML" }));
      // Prove this was a form-only edit, not incidental YAML reformatting.
      expect(
        screen.getByRole("textbox", { name: "Workflow YAML" }),
      ).toHaveValue(canonical);
    } else {
      await user.click(screen.getByRole("button", { name: "Close inspector" }));
    }
    await user.click(screen.getByRole("button", { name: "Close editor" }));
    if (finish === "discard") {
      await user.click(
        within(
          screen.getByRole("alertdialog", { name: "Leave this draft?" }),
        ).getByRole("button", { name: "Leave draft" }),
      );
    }
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Workflow editor" }),
      ).toBeNull(),
    );
    expect(warnsOnUnload()).toBe(false);
    expect(fixture.calls.save).toBe(0);
    await user.click(
      detailPane().getByRole("button", { name: "Edit workflow" }),
    );
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
      canonical,
    );
  },
);

// About 30 rendered steps, twice: loaded CI runs it at the 5s default budget.
it("discards form-only state on same-revision review and re-arms the next draft's guards", async () => {
  const parsed = yamlToFormState(fixtureYaml);
  if (!parsed.ok) throw new Error(parsed.error);
  const canonical = formStateToYaml(parsed.state);
  const fixture = mount(canonical);
  // Retain an older successful operation whose current head is a different revision.
  await act(async () => {
    fixture.capability.save({
      channelId: fixtureChannel,
      existing: fixtureDefinition,
      yaml: canonical,
    });
    fixture.finish("succeeded", false);
  });
  const user = userEvent.setup();
  const warnsOnUnload = () =>
    !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await user.click(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  );
  await user.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  // Repeat so replacement keys must be fresh, not merely differ from the first key.
  for (const value of ["first-partial", "second-partial"]) {
    const editor = screen.getByRole("dialog", { name: "Message helper" });
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    await user.click(screen.getByRole("combobox", { name: "Add condition" }));
    await user.click(await screen.findByRole("option", { name: "Author" }));
    // One change event keeps this two-cycle test inside the default timeout;
    // keystroke entry is pinned by the `guards canonical…` siblings.
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), {
      target: { value },
    });
    expect(warnsOnUnload()).toBe(true);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(
      screen.getByRole("button", { name: "Review current configuration" }),
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Message helper" })).toBe(editor);
    expect(warnsOnUnload()).toBe(true);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue(value);
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    await user.click(
      screen.getByRole("button", { name: "Review current configuration" }),
    );
    await user.click(screen.getByRole("button", { name: "Leave draft" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(warnsOnUnload()).toBe(false);
    await user.click(
      screen.getByRole("button", { name: "Edit trigger: Message posted" }),
    );
    expect(screen.queryByRole("textbox", { name: "Value" })).toBeNull();
    expect(editor).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(screen.getByRole("textbox", { name: "Workflow YAML" })).toHaveValue(
      canonical,
    );
    await user.click(screen.getByRole("tab", { name: "Form" }));
  }
  await user.click(screen.getByRole("button", { name: "Close editor" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull(),
  );
  expect(warnsOnUnload()).toBe(false);
  expect(fixture.calls.save).toBe(1);
}, 15_000);

async function confirmDeletion(from: "grid" | "detail" = "grid") {
  const user = userEvent.setup();
  if (from === "detail") {
    await user.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    await user.click(
      detailPane().getByRole("button", { name: "Edit workflow" }),
    );
    await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  } else {
    // The selected card's detail pane repeats this label; use the card's own menu.
    const card = (
      await screen.findByRole("button", { name: /^Open Message helper:/ })
    ).closest("article");
    if (!card) throw new Error("Missing workflow card");
    await user.click(
      within(card).getByRole("button", { name: "Actions for Message helper" }),
    );
  }
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  const dialog = await screen.findByRole("alertdialog", {
    name: "Delete this workflow?",
  });
  expect(
    within(dialog).getByRole("button", { name: "Delete workflow" }),
  ).toHaveAttribute("data-variant", "destructive");
  await user.click(
    within(dialog).getByRole("button", { name: "Delete workflow" }),
  );
}

it.each(["grid", "detail"] as const)(
  "deletes an owned agent's workflow from %s while keeping edits and runs read-only",
  async (from) => {
    const author = keypair().pubkey;
    const profiles = createProfileDirectory({ read: async () => [] });
    const listeners = new Set<() => void>();
    let owned = false;
    const fixture = mount(fixtureYaml, author, true, {
      profiles: {
        ...profiles.queries,
        owner: (key) => (owned && key === author ? fixtureViewer : undefined),
        subscribe: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Owner: My workflows" }),
    );
    await user.click(
      screen.getByRole("radio", { name: "All channel workflows" }),
    );
    const card = (
      await screen.findByRole("button", { name: /^Open Message helper:/ })
    ).closest("article");
    if (!card) throw new Error("Missing workflow card");
    await user.click(
      within(card).getByRole("button", { name: "Actions for Message helper" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Delete workflow" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: "Delete workflow" }),
    ).toHaveAccessibleDescription(
      "Only the author or their verified agent owner can delete this workflow.",
    );
    act(() => {
      owned = true;
      for (const fn of listeners) fn();
    });
    expect(
      screen.getByRole("menuitem", { name: "Delete workflow" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(
      within(card).getByRole("button", { name: "Run now: Message helper" }),
    ).toBeDisabled();
    if (from === "detail") {
      await user.click(
        within(card).getByRole("button", { name: /^Open Message helper:/ }),
      );
      await user.click(
        detailPane().getByRole("button", { name: "View workflow" }),
      );
      expect(screen.queryByRole("button", { name: /^Run now$/ })).toBeNull();
      await user.click(
        screen.getByRole("button", { name: "Workflow actions" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete workflow" }),
      );
      const dialog = await screen.findByRole("alertdialog", {
        name: "Delete this workflow?",
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Delete workflow" }),
      );
    } else await confirmDeletion();
    expect(fixture.calls.delete).toBe(1);
    expect(fixture.capability.operations.snapshot()[0]).toMatchObject({
      action: "delete",
      workflow: { owner: author },
      outcome: "pending",
    });
    profiles.dispose();
  },
);

it.each(["landing", "detail"])(
  "reports ownership lost during %s deletion confirmation",
  async (from) => {
    const author = keypair().pubkey;
    const profiles = createProfileDirectory({ read: async () => [] });
    let owned = true;
    const fixture = mount(fixtureYaml, author, true, {
      profiles: {
        ...profiles.queries,
        owner: () => (owned ? fixtureViewer : undefined),
      },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Owner: My workflows" }),
    );
    await user.click(
      screen.getByRole("radio", { name: "All channel workflows" }),
    );
    if (from === "detail") {
      await user.click(
        await screen.findByRole("button", { name: /^Open Message helper:/ }),
      );
      await user.click(
        detailPane().getByRole("button", { name: "View workflow" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Workflow actions" }),
      );
    } else {
      await user.click(
        await screen.findByRole("button", {
          name: "Actions for Message helper",
        }),
      );
    }
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete workflow" }),
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Delete this workflow?",
    });
    owned = false;
    await user.click(
      within(dialog).getByRole("button", { name: "Delete workflow" }),
    );
    expect(fixture.calls.delete).toBe(0);
    expect(
      screen.queryByRole("alertdialog", { name: "Delete this workflow?" }),
    ).toBeNull();
    expect(
      await screen.findByText(
        "You no longer have permission to delete this workflow. Refresh and try again.",
      ),
    ).toBeVisible();
    if (from === "detail") {
      expect(
        screen.getByRole("dialog", { name: "Message helper" }),
      ).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "Workflow actions" }),
      );
      expect(
        await screen.findByRole("menuitem", { name: "Delete workflow" }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByText(
          "Only the author or their verified agent owner can delete this workflow.",
        ),
      ).toBeVisible();
    } else expect(screen.getByText("Couldn't start deletion")).toBeVisible();
    profiles.dispose();
  },
);

it("confirms on the grid without mounting detail, cancels safely, and removes only after readback", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Actions for Message helper" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  expect(screen.queryByRole("region", { name: "Workflow editor" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fixture.calls.delete).toBe(0);
  await confirmDeletion();
  expect(fixture.calls.delete).toBe(1);
  expect(screen.queryByRole("region", { name: "Workflow editor" })).toBeNull();
  expect(screen.getByText("Deleting…")).toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  ).toHaveAccessibleDescription(/When a message is posted.*Deleting…/);
  expect(screen.getByText("Deleting…").closest("button")).toBeNull();
  await act(async () => {
    fixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    });
  });
  expect(await screen.findByText("Deleting workflow…")).toBeVisible();
  expect(screen.queryByText("Deleting…")).toBeNull();
  expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
  await act(async () => {
    fixture.finish("succeeded");
  });
  expect(screen.queryByText("Deleting workflow…")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
  expect(screen.queryByText(/Couldn't confirm deletion/)).toBeNull();
  expect(fixture.calls.delete).toBe(1);
});

it("recovers on the grid when detail deletion is refused by an unresolved save", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Turn on" }));
  await act(async () => {
    fixture.finish("succeeded");
    fixture.definitions.update({
      status: "ready",
      data: { items: [fixtureDefinition], partial: false },
    });
  });
  await confirmDeletion("detail");
  expect(fixture.calls.delete).toBe(0);
  expect(screen.queryByRole("region", { name: "Workflow editor" })).toBeNull();
  expect(await screen.findByText("Couldn't start deletion")).toBeVisible();
  expect(
    screen.getByText(
      "Another workflow change is still being confirmed. Refresh and try again.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  ).toBeEnabled();
});

it.each(["grid", "detail"] as const)(
  "returns to the grid on synchronous %s submission errors and permits a deliberate retry",
  async (from) => {
    const fixture = mount();
    const remove = vi
      .spyOn(fixture.capability, "delete")
      .mockImplementationOnce(() => {
        throw new Error("Connection unavailable. Try again.");
      });
    await confirmDeletion(from);
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull();
    expect(await screen.findByText("Couldn't start deletion")).toBeVisible();
    expect(
      screen.getByText("Connection unavailable. Try again."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeEnabled();
    await confirmDeletion();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(fixture.calls.delete).toBe(1);
  },
);

it("returns to the grid before completion, then shows rejection and restores actions", async () => {
  const fixture = mount();
  await confirmDeletion("detail");
  expect(fixture.capability.operations.snapshot()[0]?.outcome).toBe("pending");
  expect(screen.queryByRole("region", { name: "Workflow editor" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeNull();
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  await act(async () => {
    fixture.finish("rejected");
  });
  expect(
    await screen.findByText("Couldn't delete Message helper"),
  ).toBeVisible();
  expect(
    screen.getByText("Fixture conflict").closest("details"),
  ).not.toHaveAttribute("open");
  expect(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  ).toBeEnabled();
  expect(
    screen.getByRole("switch", {
      name: "Enabled in configuration: Message helper",
    }),
  ).toBeEnabled();
  await confirmDeletion();
  expect(fixture.calls.delete).toBe(2);
  await waitFor(() =>
    expect(screen.queryByText("Couldn't delete Message helper")).toBeNull(),
  );
  await act(async () => {
    fixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    });
    fixture.finish("succeeded");
  });
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
  expect(screen.queryByText(/^Couldn't delete/)).toBeNull();
});

it.each(["unknown", "succeeded"] as const)(
  "keeps %s deletion actionable on the grid without resubmitting",
  async (outcome) => {
    const fixture = mount();
    await confirmDeletion();
    await act(async () => {
      fixture.finish(outcome);
    });
    expect(
      await screen.findByText("Couldn't confirm deletion of Message helper"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Check saved configuration" }),
    );
    expect(fixture.calls.delete).toBe(1);
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull();
    act(() =>
      fixture.definitions.update({
        status: "loading",
        data: { items: [fixtureDefinition], partial: false },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Checking deletion…" }),
    ).toBeDisabled();
    act(() =>
      fixture.definitions.update({
        status: "ready",
        data: { items: [], partial: true },
      }),
    );
    expect(screen.getByText("Couldn't confirm deletion")).toBeVisible();
    expect(screen.queryByText(/Saved workflow deleted/)).toBeNull();
    await act(async () => {
      fixture.definitions.update({
        status: "ready",
        data: { items: [], partial: false },
      });
      fixture.finish("succeeded");
    });
    await waitFor(() =>
      expect(screen.queryByText(/^Couldn't confirm deletion/)).toBeNull(),
    );
  },
);

it("purges deletion recovery on access loss", async () => {
  const fixture = mount();
  await confirmDeletion();
  await act(async () => {
    fixture.finish("unknown");
  });
  expect(
    await screen.findByText("Couldn't confirm deletion of Message helper"),
  ).toBeVisible();
  act(() => fixture.revoke());
  await waitFor(() =>
    expect(screen.queryByText(/^Couldn't confirm deletion/)).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
});

it("resumes a paused read from the deletion toast and never republishes", async () => {
  const fixture = mount();
  await confirmDeletion();
  await act(async () => {
    fixture.finish("unknown");
  });
  act(() =>
    fixture.definitions.update({
      status: "error",
      error: "Read unavailable",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(screen.getByText(/Workflow discovery paused/)).toBeVisible();
  const original = fixture.capability.definitions;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = vi
    .spyOn(fixture.capability, "definitions")
    .mockImplementation((ids) => {
      const view = original(ids);
      return {
        ...view,
        refresh: async () => {
          fixture.definitions.update({
            status: "loading",
            data: { items: [fixtureDefinition], partial: false },
          });
          await gate;
          fixture.definitions.update({
            status: "ready",
            data: { items: [], partial: false },
          });
          fixture.finish("succeeded");
        },
      };
    });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "Check saved configuration" }),
    );
    expect(reads).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Checking deletion…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeDisabled();
  } finally {
    await act(async () => release());
  }
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull(),
  );
  expect(screen.queryByText(/^Couldn't confirm deletion/)).toBeNull();
  expect(fixture.calls.delete).toBe(1);
});

it("keeps uncertain deletion locked through durable dismissal and recovers from persistence errors", async () => {
  const fixture = mount();
  await confirmDeletion();
  await act(async () => {
    fixture.finish("unknown");
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Dismiss notice" }),
  );
  fixture.holdDismiss();
  fixture.setDismissError("Storage unavailable. Try again.");
  try {
    await user.click(
      screen.getByRole("button", { name: "Dismiss notice and continue" }),
    );
    expect(fixture.calls.dismiss).toHaveLength(1);
    expect(fixture.capability.operations.snapshot()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Dismissing…" })).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: /^Open Message helper:/,
        hidden: true,
      }),
    ).toBeDisabled();
  } finally {
    await act(async () => fixture.releaseDismiss());
  }
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Storage unavailable. Try again.",
  );
  expect(fixture.capability.operations.snapshot()).toHaveLength(1);
  fixture.setDismissError();
  await user.click(
    screen.getByRole("button", { name: "Dismiss notice and continue" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  ).toBeEnabled();
  expect(fixture.calls.delete).toBe(1);
  await user.click(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  );
  await user.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  expect(screen.queryByText("Deleting…")).toBeNull();
});

it("does not add a channel-loading banner above retained workflow cards", async () => {
  const fixture = createWorkflowFixture();
  const list: ChannelList = {
    status: "loading",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  const session = {
    profiles: createProfileDirectory({ read: async () => [] }).queries,
    workflows: fixture.capability,
    channels: {
      list: () => list,
      ensureList() {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <WorkflowCommunity session={session} viewer={fixtureViewer} />
    </ToastProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeVisible(),
  );
  expect(screen.queryByText("Reading channels…")).toBeNull();
});

it.each([{ huddle: true as const }, { metadataPending: true as const }])(
  "retires an excluded workflow destination even in a partial list: %j",
  async (excluded) => {
    const fixture = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Open Message helper:/ }),
    );
    fireEvent.click(
      detailPane().getByRole("button", { name: "Edit workflow" }),
    );
    expect(
      screen.getByRole("region", { name: "Workflow editor" }),
    ).toBeVisible();
    act(() =>
      fixture.setChannels({
        status: "ready",
        coverage: "partial",
        channels: [
          { id: fixtureChannel, name: "Fixture channel", ...excluded },
        ],
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Workflow editor" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Open Message helper:/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(fixture.calls.save).toBe(0);
  },
);

function channelFilteredPage() {
  const fixture = mount();
  const other = { id: "other-channel", name: "Other channel" };
  act(() =>
    fixture.setChannels({
      status: "ready",
      channels: [{ id: fixtureChannel, name: "Fixture channel" }, other],
    }),
  );
  const user = userEvent.setup();
  const openChannels = async () => {
    screen.getByRole("button", { name: /^Channels(?::|$)/ }).focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Channels" });
  };
  const otherDefinition = {
    ...fixtureDefinition,
    channelId: other.id,
    yaml: fixtureYaml.replace("Message helper", "Other helper"),
  };
  return { fixture, user, openChannels, otherDefinition };
}

it("opens a selected card in the side pane and closes its tab", async () => {
  const { user } = channelFilteredPage();
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }).closest("header"),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
  const open = await screen.findByRole("button", {
    name: /^Open Message helper:/,
  });
  await user.click(open);
  expect(open).toHaveAccessibleName(
    "Open Message helper: When a message is posted, send a message.",
  );
  expect(open).toHaveAttribute("aria-pressed", "true");
  const tab = detailPane().getByRole("tab", { name: "Message helper" });
  fireEvent.keyDown(tab, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
  expect(open).toHaveAttribute("aria-pressed", "false");
  await user.click(open);
  await user.click(
    detailPane().getByRole("button", { name: "Close Message helper tab" }),
  );
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
});

it("combines channel selections and resets them while closing filtered details", async () => {
  const { fixture, user, openChannels, otherDefinition } =
    channelFilteredPage();
  await openChannels();
  expect(
    await screen.findByRole("checkbox", { name: "Fixture channel" }),
  ).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: "Other channel" })).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [fixtureDefinition, otherDefinition] },
    }),
  );
  await openChannels();
  await user.click(
    await screen.findByRole("checkbox", { name: "Other channel" }),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Other helper:/ }),
    ).toBeVisible(),
  );
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
  await openChannels();
  expect(
    screen.getByRole("checkbox", { name: "Other channel" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByRole("checkbox", { name: "Fixture channel" }));
  // Multi-selection keeps the menu open and includes both channels.
  expect(
    screen.getByRole("checkbox", { name: "Fixture channel" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("checkbox", { name: "Other channel" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveTextContent("2 channels");
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveAccessibleName("Channels: 2 channels");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeVisible(),
  );
  await user.click(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  );
  expect(
    screen.getByRole("region", { name: "Workflow details" }),
  ).toBeVisible();
  await openChannels();
  await user.click(screen.getByRole("checkbox", { name: "Fixture channel" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /^Open Message helper:/ }),
  ).toBeNull();
  await openChannels();
  await user.click(screen.getByRole("checkbox", { name: "Other channel" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Clear channels filter" }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeVisible(),
  );
  expect(
    screen.getByRole("button", { name: "Owner: My workflows" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Clear all" })).toBeVisible();
  await openChannels();
  await user.click(screen.getByRole("checkbox", { name: "Fixture channel" }));
  await user.click(screen.getByRole("checkbox", { name: "Other channel" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  await openChannels();
  await user.click(screen.getByRole("button", { name: "Clear all" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Clear channels filter" }),
  ).toBeNull();
});

it("drops stale channel filters after readback and membership changes", async () => {
  const { fixture, user, openChannels, otherDefinition } =
    channelFilteredPage();
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [fixtureDefinition, otherDefinition] },
    }),
  );
  await openChannels();
  await user.click(screen.getByRole("checkbox", { name: "Other channel" }));
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  act(() =>
    fixture.definitions.update({
      status: "loading",
      data: { partial: false, items: [] },
    }),
  );
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveAccessibleDescription("Other channel");
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [fixtureDefinition] },
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Clear channels filter" }),
  ).toBeNull();
  await openChannels();
  await screen.findByRole("checkbox", { name: "Fixture channel" });
  expect(screen.queryByRole("checkbox", { name: "Other channel" })).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [fixtureDefinition, otherDefinition] },
    }),
  );
  await openChannels();
  await user.click(
    await screen.findByRole("checkbox", { name: "Other channel" }),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Channels" })).toBeNull(),
  );
  expect(
    screen.getByRole("button", { name: /^Channels(?::|$)/ }),
  ).toHaveAccessibleDescription("Other channel");
  act(() => {
    fixture.setChannels({
      status: "ready",
      channels: [{ id: fixtureChannel, name: "Fixture channel" }],
    });
  });
  expect(
    screen.queryByRole("button", { name: "Clear channels filter" }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Open Message helper:/ }),
    ).toBeVisible(),
  );
});

it("closes the side pane when the final channel leaves", async () => {
  const fixture = createWorkflowFixture();
  let list: ChannelList = {
    status: "ready",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  const listeners = new Set<() => void>();
  const session = {
    profiles: createProfileDirectory({ read: async () => [] }).queries,
    workflows: fixture.capability,
    channels: {
      list: () => list,
      ensureList() {},
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as RelaySession;
  render(
    <ToastProvider>
      <WorkflowCommunity session={session} viewer={fixtureViewer} />
    </ToastProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  );
  expect(
    screen.getByRole("region", { name: "Workflow details" }),
  ).toBeInTheDocument();
  act(() => {
    list = { ...list, channels: [] };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getByText("No channels are available in this community."),
  ).toBeVisible();
  expect(screen.queryByRole("region", { name: "Workflow details" })).toBeNull();
});

function narrowMedia(initial: boolean) {
  const media = {
    matches: initial,
    listeners: new Set<() => void>(),
    addEventListener: (_: string, listener: () => void) =>
      media.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      media.listeners.delete(listener),
  };
  const previous = window.matchMedia;
  Object.assign(window, {
    matchMedia: (query: string) => {
      expect(query).toBe("(max-width: 52rem)");
      return media;
    },
  });
  return {
    restore: () => Object.assign(window, { matchMedia: previous }),
    resize(matches: boolean) {
      media.matches = matches;
      for (const listener of media.listeners) listener();
    },
  };
}

function renderSinglePage() {
  const fixture = createWorkflowFixture();
  const list: ChannelList = {
    status: "ready",
    channels: [{ id: fixtureChannel, name: "Fixture channel" }],
  };
  render(
    <ToastProvider>
      <WorkflowCommunity
        session={
          {
            profiles: createProfileDirectory({ read: async () => [] }).queries,
            workflows: fixture.capability,
            channels: {
              list: () => list,
              ensureList() {},
              subscribeList: () => () => {},
            },
          } as unknown as RelaySession
        }
        viewer={fixtureViewer}
      />
    </ToastProvider>,
  );
}

it("moves focus into a pane that replaces the list and returns it on close", async () => {
  const media = narrowMedia(true);
  try {
    renderSinglePage();
    const open = await screen.findByRole("button", {
      name: /^Open Message helper:/,
    });
    open.focus();
    fireEvent.click(open);
    const detail = detailPane().getByRole("region", {
      name: "Message helper details",
    });
    await waitFor(() => expect(detail).toHaveFocus());
    fireEvent.keyDown(detail, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Workflow details" }),
    ).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
  } finally {
    media.restore();
  }
});

it("moves list focus into an open pane when the page narrows", async () => {
  const media = narrowMedia(false);
  try {
    renderSinglePage();
    const open = await screen.findByRole("button", {
      name: /^Open Message helper:/,
    });
    open.focus();
    fireEvent.click(open);
    const detail = detailPane().getByRole("region", {
      name: "Message helper details",
    });
    expect(open).toHaveFocus();
    act(() => media.resize(true));
    expect(detail).toHaveFocus();
    fireEvent.keyDown(detail, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Workflow details" }),
    ).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
  } finally {
    media.restore();
  }
});

it("describes an unreadable workflow outside its row button", async () => {
  mount("not: [valid yaml");
  const open = await screen.findByRole("button", {
    name: /^Open Unnamed or malformed workflow:/,
  });
  expect(open).toHaveAccessibleDescription(/Unreadable configuration/);
  expect(
    screen.getByText("Unreadable configuration").closest("button"),
  ).toBeNull();
});

it("offers only live channels to New workflow and disables it when only archived channels remain", async () => {
  const fixture = mount();
  const user = userEvent.setup();
  const archived = {
    id: fixtureChannel,
    name: "Fixture channel",
    archived: true as const,
  };
  act(() =>
    fixture.setChannels({
      status: "ready",
      channels: [archived, { id: "live-channel", name: "Live channel" }],
    }),
  );
  await user.click(screen.getByRole("button", { name: "New workflow" }));
  const create = await screen.findByRole("dialog", { name: "Create workflow" });
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Live channel"]);
  // Escape closes the open channel list, which hides the dialog's other controls.
  await user.keyboard("{Escape}");
  await user.click(
    within(create).getByRole("button", { name: "Close editor" }),
  );
  expect(screen.queryByRole("dialog", { name: "Create workflow" })).toBeNull();
  act(() => fixture.setChannels({ status: "ready", channels: [archived] }));
  expect(screen.getByRole("button", { name: "New workflow" })).toBeDisabled();
  // Its workflows stay listed, so they can still be turned off or deleted.
  expect(
    screen.getByRole("button", { name: /^Open Message helper:/ }),
  ).toBeVisible();
  act(() =>
    fixture.definitions.update({
      status: "ready",
      data: { partial: false, items: [] },
    }),
  );
  await screen.findByText("Automations that keep your community moving.");
  expect(screen.getAllByRole("button", { name: "New workflow" })).toEqual([
    screen.getByRole("button", { name: "New workflow" }),
  ]);
});

it("keeps an open editor and its draft when its channel is archived, and blocks saving it enabled and Run now", async () => {
  const fixture = mount(fixtureYaml.replace("enabled: false", "enabled: true"));
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /^Open Message helper:/ }),
  );
  await user.click(detailPane().getByRole("button", { name: "Edit workflow" }));
  const editor = screen.getByRole("dialog", { name: "Message helper" });
  await user.type(
    within(editor).getByRole("textbox", { name: "Description" }),
    "Draft note",
  );
  act(() =>
    fixture.setChannels({
      status: "ready",
      channels: [
        { id: fixtureChannel, name: "Fixture channel", archived: true },
      ],
    }),
  );
  expect(screen.getByRole("dialog", { name: "Message helper" })).toBe(editor);
  expect(
    within(editor).getByRole("textbox", { name: "Description" }),
  ).toHaveValue("Draft note");
  expect(
    within(editor).getByText(
      "This channel is archived, so its workflows can't run. Turn this workflow off to save it.",
      { selector: "[role=status]" },
    ),
  ).toBeVisible();
  expect(
    within(editor).getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  expect(
    within(editor).getByRole("button", { name: "Run now" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(fixture.calls.save).toBe(0);
});
