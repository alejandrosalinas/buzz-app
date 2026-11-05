// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowForm, type WorkflowSelection } from "./WorkflowForm";
import {
  type WorkflowMentionMember,
  WorkflowMentionMembers,
  useWorkflowMentionMembers,
} from "./WorkflowMessageText";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import type { RelaySession } from "../../features/relay/session";
import {
  DEFAULT_FORM_STATE,
  type WorkflowFormState,
} from "./workflowFormTypes";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

const members: WorkflowMentionMember[] = [
  { pubkey: "a".repeat(64), name: "Alice Smith", label: "Alice Smith" },
  // A namesake label is shown; the relay still matches the profile name.
  { pubkey: "b".repeat(64), name: "Bob", label: "Bob (bbbb)", agent: true },
];

function Example({ people = members }: { people?: WorkflowMentionMember[] }) {
  const [state, setState] = useState<WorkflowFormState>({
    ...DEFAULT_FORM_STATE,
    steps: [{ id: "step_1", action: "send_message", text: "" }],
  });
  const [selection, onSelect] = useState<WorkflowSelection>({
    type: "step",
    id: "step_1",
  });
  return (
    <WorkflowMentionMembers.Provider value={people}>
      <WorkflowForm
        state={state}
        onChange={setState}
        disabled={false}
        selection={selection}
        onSelect={onSelect}
      />
    </WorkflowMentionMembers.Provider>
  );
}

it("suggests channel members and inserts the name the relay matches", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const text = screen.getByRole("textbox", { name: "Message text" });
  await user.type(text, "Hi @ali");
  expect(
    await screen.findByRole("option", { name: /^Alice Smith/ }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    screen.queryByRole("option", { name: /^Bob/ }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(text).toHaveValue("Hi @Alice Smith ");
  expect(text).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

  await user.type(text, "and @");
  await user.keyboard("{ArrowDown}{Tab}");
  expect(text).toHaveValue("Hi @Alice Smith and @Bob ");
});

it("closes on Escape until a new mention starts, and accepts a pointer pick", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const text = screen.getByRole("textbox", { name: "Message text" });
  await user.type(text, "@bo");
  expect(await screen.findByRole("listbox")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.type(text, "b{Enter}");
  expect(text).toHaveValue("@bob\n");
  await user.type(
    text,
    "{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}@",
  );
  expect(await screen.findByRole("listbox")).toBeInTheDocument();
  await user.type(text, "bob{Enter}");
  expect(text).toHaveValue("@Bob ");
  await user.type(text, "{Enter}");

  await user.type(text, "@zz");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.type(text, "{Backspace}{Backspace}b");
  await user.click(
    await screen.findByRole("option", { name: /^Bob \(bbbb\)/ }),
  );
  expect(text).toHaveValue("@Bob \n@Bob ");
});

it("shows the composer's 50 rows and asks to narrow past them", async () => {
  const user = userEvent.setup();
  const people = Array.from({ length: 51 }, (_, index) => {
    const name = `Member ${String(index).padStart(2, "0")}`;
    return { pubkey: index.toString(16).padStart(64, "0"), name, label: name };
  });
  render(<Example people={people} />);
  await user.type(screen.getByRole("textbox", { name: "Message text" }), "@");
  expect(await screen.findAllByRole("option")).toHaveLength(50);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Narrow your search to see more members.",
  );
});

it("reserves profile room for the channel's roster while mounted", () => {
  const read = vi.fn(async () => []);
  const directory = createProfileDirectory({ read }).queries;
  const release = vi.fn();
  const reserve = vi.fn((members: number) => {
    const give = directory.reserve?.(members);
    return () => {
      give?.();
      release();
    };
  });
  const ensure = vi.fn(directory.ensure);
  const ids = Array.from({ length: 1500 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const channel = { id: "c", members: ids };
  const session = {
    profiles: { ...directory, reserve, ensure },
    channels: {
      list: () => ({ status: "ready", channels: [channel] }),
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const view = renderHook(() => useWorkflowMentionMembers(session, channel));
  expect(reserve).toHaveBeenCalledExactlyOnceWith(1500);
  // Past the base: every member is asked for, in per-call batches.
  expect(ensure.mock.calls.flatMap(([batch]) => batch)).toEqual(ids);
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});
