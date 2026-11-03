// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowRuns } from "./WorkflowRuns";
import {
  createWorkflowFixture,
  fixtureDefinition,
  fixtureRun,
  fixtureView,
} from "./fixtures";

afterEach(cleanup);
it("keeps loaded runs visible without a refresh banner and retains failures", async () => {
  const fixture = createWorkflowFixture();
  const data = { runs: [fixtureRun], next: null };
  const runs = fixtureView(data);
  render(
    <WorkflowRuns
      capability={{ ...fixture.capability, runs: () => runs.view }}
      workflow={fixtureDefinition}
    />,
  );
  await screen.findByText("completed");
  act(() => runs.update({ status: "loading", data }));
  expect(screen.getByText("completed")).toBeVisible();
  expect(screen.queryByText("Reading runs…")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeDisabled();
  act(() => runs.update({ status: "error", error: "Read failed", data }));
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
  expect(screen.getByRole("button", { name: "Refresh runs" })).toBeEnabled();
});

it("links each message a run's completed send_message steps posted", async () => {
  const fixture = createWorkflowFixture();
  const open = vi.fn();
  const trace = [
    ...fixtureRun.trace,
    { step_id: "wait", status: "running" },
    { step_id: "sent", status: "completed", output: { sent: true } },
    {
      step_id: "hook",
      status: "completed",
      output: { event_id: "cc".repeat(32) },
    },
    {
      step_id: "again",
      status: "completed",
      output: { sent: true, event_id: "ff".repeat(32) },
    },
    { status: "completed", output: { sent: true, event_id: "dd".repeat(32) } },
    {
      step_id: "again",
      status: "completed",
      output: { sent: true, event_id: "ff".repeat(32) },
    },
  ];
  const runs = fixtureView({ runs: [{ ...fixtureRun, trace }], next: null });
  const capability = { ...fixture.capability, runs: () => runs.view };
  const view = render(
    <WorkflowRuns
      capability={capability}
      workflow={fixtureDefinition}
      onOpenMessage={open}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Open posted message (notify)" }),
  );
  expect(open).toHaveBeenCalledWith("ee".repeat(32));
  fireEvent.click(
    screen.getByRole("button", { name: "Open posted message (again)" }),
  );
  expect(open).toHaveBeenLastCalledWith("ff".repeat(32));
  fireEvent.click(
    screen.getByRole("button", { name: /^Open posted message$/ }),
  );
  expect(open).toHaveBeenLastCalledWith("dd".repeat(32));
  expect(
    screen.getAllByRole("button", { name: /^Open posted message/ }),
  ).toHaveLength(3);
  view.rerender(
    <WorkflowRuns capability={capability} workflow={fixtureDefinition} />,
  );
  expect(
    screen.queryByRole("button", { name: /^Open posted message/ }),
  ).toBeNull();
});
