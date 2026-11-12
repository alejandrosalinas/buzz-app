// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowChannel } from "./WorkflowChannel";
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

it("hands confirmed deletion to the page and discards draft navigation risk", async () => {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={remove}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workflow YAML" }),
    "\n# Unsaved edit",
  );
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith(fixtureDefinition);
  expect(screen.queryByRole("dialog", { name: "Message helper" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeNull();
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  expect(fixture.calls.delete).toBe(0);
});

it("keeps the open workflow visible without a refresh banner", async () => {
  const fixture = createWorkflowFixture();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  expect(
    within(editor).getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("Message helper");
  act(() =>
    fixture.definitions.update({
      status: "loading",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(
    within(editor).getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("Message helper");
  // Only the editor reports the reread; loaded items suppress the page banner.
  expect(screen.getAllByText("Reading configurations…")).toEqual([
    within(editor).getByText("Reading configurations…"),
  ]);
  const refresh = within(editor).getByRole("button", {
    name: "Refresh configurations",
  });
  expect(refresh).toBeDisabled();
  act(() =>
    fixture.definitions.update({
      status: "error",
      error: "Read failed",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(within(editor).getByRole("alert")).toHaveTextContent("Read failed");
  expect(refresh).toBeEnabled();
  expect(screen.getByRole("dialog", { name: "Message helper" })).toBe(editor);
});

it("releases a mounted run latch after unknown delivery without replaying it", async () => {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={remove}
    />,
  );
  const user = userEvent.setup();
  const action = async (name: string) => {
    await user.click(screen.getByRole("button", { name: "Workflow actions" }));
    await user.click(await screen.findByRole("menuitem", { name }));
  };
  const runNow = () => screen.getByRole("button", { name: "Run now" });
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(1);
  expect(runNow()).toBeDisabled();
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(1);
  act(() => fixture.finish("unknown"));
  expect(fixture.calls.trigger).toBe(1);
  expect(screen.getByText(/The run may have started/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
  await user.click(
    screen.getByRole("button", { name: "Dismiss notice and continue" }),
  );
  expect(fixture.capability.operations.snapshot()).toEqual([]);
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(2);
  act(() => fixture.finish("unknown"));
  await action("Delete workflow");
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith(fixtureDefinition);
});

it("runs despite a lost earlier run receipt, rereads open history on success and reports rejection", async () => {
  const fixture = createWorkflowFixture();
  // A journaled run whose receipt was lost (e.g. across a restart).
  act(() => {
    fixture.capability.trigger(fixtureDefinition);
    fixture.finish("unknown");
  });
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const run = async () => {
    const button = screen.getByRole("button", { name: "Run now" });
    expect(button).toBeEnabled();
    await user.click(button);
  };
  await user.click(screen.getByRole("tab", { name: "Runs" }));
  expect(fixture.calls.runs).toBe(1);
  await run();
  expect(fixture.calls.trigger).toBe(2);
  // A pending run explains the paused save without pointing at save recovery.
  expect(screen.getAllByText("Requesting a run…")[0]).toBeVisible();
  expect(screen.getByText(/Recent activity/)).toBeVisible();
  act(() => fixture.finish("succeeded"));
  expect(
    screen.getByText("Run requested. Inspect run history for its result."),
  ).toBeVisible();
  expect(fixture.calls.runs).toBe(2);
  await run();
  expect(fixture.calls.trigger).toBe(3);
  act(() => fixture.finish("rejected"));
  expect(screen.getByText("Failed to trigger workflow")).toBeVisible();
  expect(screen.getByText("Fixture conflict")).toBeVisible();
  // Delete stays available for the owner.
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

it.each(["rejected", "unknown"] as const)(
  "recovers a restored %s run through durable dismissal",
  async (outcome) => {
    const fixture = createWorkflowFixture();
    fixture.capability.trigger(fixtureDefinition);
    fixture.finish(outcome);
    render(
      <WorkflowChannel
        capability={fixture.capability}
        channelId={fixtureChannel}
        channel={{ name: "Fixture channel" }}
        viewer={fixtureViewer}
        initialSelection={fixtureDefinition}
        onClose={() => {}}
        onDelete={() => {}}
      />,
    );
    const user = userEvent.setup();
    fixture.setDismissError("Journal unavailable");
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(
      screen.getByText(/Unsaved changes stay in this editor/),
    ).toBeVisible();
    expect(screen.getByText("Configuration details")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss notice and continue" }),
    );
    expect(await screen.findByText("Journal unavailable")).toBeVisible();
    expect(fixture.capability.operations.snapshot()).toHaveLength(1);
    fixture.setDismissError(undefined);
    await user.click(
      screen.getByRole("button", { name: "Dismiss notice and continue" }),
    );
    expect(fixture.capability.operations.snapshot()).toEqual([]);
    expect(fixture.calls.trigger).toBe(1);
  },
);

it("runs once a newer head supersedes a save whose receipt was lost", async () => {
  const fixture = createWorkflowFixture();
  act(() => {
    fixture.capability.save({
      channelId: fixtureChannel,
      existing: fixtureDefinition,
      yaml: fixtureDefinition.yaml,
    });
    fixture.finish("unknown");
  });
  const head = {
    ...fixtureDefinition,
    revision: "bb".repeat(32),
    createdAt: fixtureDefinition.createdAt + 100,
  };
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={head}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const run = await screen.findByRole("button", { name: "Run now" });
  expect(run).toBeEnabled();
  await user.click(run);
  expect(fixture.calls.trigger).toBe(1);
});

it("drops a run status when another configuration replaces the draft", async () => {
  const fixture = createWorkflowFixture();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const runStatus = "Run requested. Inspect run history for its result.";
  await user.click(screen.getByRole("button", { name: "Run now" }));
  act(() => fixture.finish("succeeded"));
  expect(screen.getByText(runStatus)).toBeVisible();
  await user.type(
    screen.getByRole("textbox", { name: "Workflow name" }),
    " renamed",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  // A different readback offers the current configuration in place of the draft.
  act(() => fixture.finish("succeeded", false));
  await user.click(
    screen.getByRole("button", { name: "Review current configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Leave draft" }));
  expect(screen.queryByText(runStatus)).not.toBeInTheDocument();
});

const archivedReason = "This channel is archived, so its workflows can't run.";

function archivedEditor(yaml = fixtureYaml, archived = true) {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  const element = (archivedNow: boolean) => (
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{
        name: "Fixture channel",
        ...(archivedNow && { archived: true as const }),
      }}
      viewer={fixtureViewer}
      initialSelection={{ ...fixtureDefinition, yaml }}
      onClose={() => {}}
      onDelete={remove}
    />
  );
  const { rerender } = render(element(archived));
  return {
    fixture,
    remove,
    archive: () => rerender(element(true)),
  };
}

it("can't turn a workflow on in an archived channel, but saves its edits while it's off", async () => {
  const { fixture } = archivedEditor();
  const user = userEvent.setup();
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  const run = within(editor).getByRole("button", { name: "Run now" });
  expect(run).toHaveAttribute("aria-disabled", "true");
  expect(run).toHaveAccessibleDescription(archivedReason);
  const enable = within(editor).getByRole("switch", {
    name: "Enabled in configuration",
  });
  expect(enable).not.toBeChecked();
  expect(enable).toHaveAttribute("aria-disabled", "true");
  expect(enable).toHaveAccessibleDescription(archivedReason);
  await user.click(enable);
  expect(enable).not.toBeChecked();
  await user.type(
    within(editor).getByRole("textbox", { name: "Description" }),
    "Kept for the archive",
  );
  const save = within(editor).getByRole("button", { name: "Save changes" });
  expect(save).toBeEnabled();
  await user.click(save);
  expect(fixture.calls.save).toBe(1);
  expect(fixture.input()?.yaml).toContain("enabled: false");
  expect(fixture.input()?.yaml).toContain("Kept for the archive");
  expect(fixture.calls.trigger).toBe(0);
});

it("blocks saving an enabled workflow in an archived channel until it's turned off, and keeps Delete", async () => {
  const saveReason = `${archivedReason} Turn this workflow off to save it.`;
  const { fixture, remove } = archivedEditor(
    fixtureYaml.replace("enabled: false", "enabled: true"),
  );
  const user = userEvent.setup();
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  const save = within(editor).getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  expect(
    within(editor).getByText(saveReason, { selector: "[role=status]" }),
  ).toBeVisible();
  const enable = within(editor).getByRole("switch", {
    name: "Enabled in configuration",
  });
  expect(enable).toBeChecked();
  expect(enable).not.toHaveAttribute("aria-disabled");
  expect(enable).toHaveAccessibleDescription(saveReason);
  await user.click(
    within(editor).getByRole("button", { name: "Workflow actions" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  await user.click(
    within(
      screen.getByRole("alertdialog", { name: "Delete this workflow?" }),
    ).getByRole("button", { name: "Cancel" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();

  await user.click(enable);
  expect(enable).not.toBeChecked();
  // Like the landing's switch, it can't be turned back on here.
  expect(enable).toHaveAttribute("aria-disabled", "true");
  expect(enable).toHaveAccessibleDescription(archivedReason);
  expect(within(editor).queryByText(saveReason)).toBeNull();
  expect(
    within(editor).getByRole("button", { name: "Run now" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(save).toBeEnabled();
  await user.click(save);
  expect(fixture.calls.save).toBe(1);
  expect(fixture.input()?.yaml).toContain("enabled: false");
  expect(fixture.calls.trigger).toBe(0);
  expect(remove).not.toHaveBeenCalled();
});

it("doesn't save an enabled workflow when its channel is archived during the activation confirmation", async () => {
  const { fixture, archive } = archivedEditor(fixtureYaml, false);
  const user = userEvent.setup();
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  await user.click(
    within(editor).getByRole("switch", { name: "Enabled in configuration" }),
  );
  await user.click(
    within(editor).getByRole("button", { name: "Save changes" }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "This workflow may run often",
  });
  archive();
  await user.click(
    within(confirm).getByRole("button", { name: "Save enabled workflow" }),
  );
  expect(fixture.calls.save).toBe(0);
});

it("blocks saving a workflow turned on in the YAML tab of an archived channel", async () => {
  const { fixture } = archivedEditor();
  const user = userEvent.setup();
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  await user.click(within(editor).getByRole("tab", { name: "YAML" }));
  fireEvent.change(
    within(editor).getByRole("textbox", { name: "Workflow YAML" }),
    {
      target: { value: fixtureYaml.replace("enabled: false", "enabled: true") },
    },
  );
  const save = within(editor).getByRole("button", { name: "Save changes" });
  expect(save).toBeDisabled();
  expect(
    within(editor).getByText(
      `${archivedReason} Turn this workflow off to save it.`,
      {
        selector: "[role=status]",
      },
    ),
  ).toBeVisible();
  await user.click(save);
  expect(fixture.calls.save).toBe(0);
});

it("keeps a rejected save's and unreadable YAML's reasons ahead of the archived one", async () => {
  const saveReason = `${archivedReason} Turn this workflow off to save it.`;
  const { fixture, archive } = archivedEditor(
    fixtureYaml.replace("enabled: false", "enabled: true"),
    false,
  );
  const user = userEvent.setup();
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  await user.type(
    within(editor).getByRole("textbox", { name: "Description" }),
    "Rejected note",
  );
  await user.click(
    within(editor).getByRole("button", { name: "Save changes" }),
  );
  act(() => fixture.finish("rejected"));
  archive();
  expect(
    within(editor).getByText(
      "Draft retained. Review the error below before continuing.",
      { selector: "[role=status]" },
    ),
  ).toBeVisible();
  expect(within(editor).queryByText(saveReason)).toBeNull();

  cleanup();
  archivedEditor();
  const reopened = await screen.findByRole("dialog", {
    name: "Message helper",
  });
  await user.click(within(reopened).getByRole("tab", { name: "YAML" }));
  fireEvent.change(
    within(reopened).getByRole("textbox", { name: "Workflow YAML" }),
    { target: { value: "name: [" } },
  );
  expect(
    within(reopened).getByText(
      "Correct the YAML before changing the name or configuration.",
      { selector: "[role=status]" },
    ),
  ).toBeVisible();
  expect(within(reopened).queryByText(saveReason)).toBeNull();
});
