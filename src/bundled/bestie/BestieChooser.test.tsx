// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { BestieChooser } from "./BestieChooser";

vi.mock("../agents/AgentCreateDialog", () => ({
  AgentCreateDialog: ({
    onCreated,
  }: {
    onCreated(agent: { pubkey: string }): void;
  }) => (
    <button type="button" onClick={() => onCreated({ pubkey: pollen })}>
      Finish creation
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const pollen = "b".repeat(64);
const instruction = "Choose an eligible agent or create a new one:";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  write: (agent: string | null) => Promise<void>,
  initial = [{ pubkey: pollen, name: "Pollen", managed: true }],
  place: Agent["place"] = "here",
) {
  let selectable = initial;
  const makeSnapshot = () =>
    ({
      status: "ready" as const,
      complete: true,
      pending: false,
      selectable,
      identities: selectable,
      definitions: [],
      archives: { status: "ready" as const, archived: [] },
      templates: {
        status: "ready" as const,
        complete: true,
        pending: false,
        identities: selectable,
        definitions: [],
      },
    }) as const;
  let choices = makeSnapshot();
  const session = {
    mainAgent: { read: async () => undefined, write: vi.fn(write) },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
      refresh: vi.fn(async () => {}),
    },
  } as unknown as RelaySession;
  const agents = {
    subscribe: () => () => {},
    snapshot: () => undefined,
    types: () => empty,
    find: (pubkey: string) => ({ pubkey, place }),
  } as unknown as Agents;
  return {
    session,
    removeChoice: () => {
      selectable = [];
      choices = makeSnapshot();
    },
    mount: () =>
      render(
        <BestieChooser
          session={session}
          scope="community:viewer"
          agents={agents}
        />,
      ),
  };
}

const empty: readonly never[] = [];

async function selectPollen() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: instruction }));
  await user.click(await screen.findByRole("option", { name: /^Pollen / }));
  return user;
}

it("searches namesakes, shows distinct identities, and selects with the keyboard", async () => {
  const other = "c".repeat(64);
  const f = fixture(async () => {}, [
    { pubkey: pollen, name: "Pollen", managed: true },
    { pubkey: other, name: "Pollen", managed: true },
    { pubkey: "d".repeat(64), name: "Fizz", managed: true },
  ]);
  f.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: instruction });
  await user.click(trigger);
  const search = await screen.findByRole("combobox", { name: "Search" });
  await user.type(search, "Nobody");
  expect(await screen.findByText("No matching agents.")).toBeVisible();
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
  await user.clear(search);
  await user.type(search, "poll");
  await waitFor(() => {
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).not.toBe(options[1]?.textContent);
  });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
  await user.click(trigger);
  const reopened = await screen.findByRole("combobox", { name: "Search" });
  expect(reopened).toHaveValue("");
  await user.type(reopened, "poll");
  await user.keyboard("{ArrowDown}{End}{Enter}");
  await waitFor(() =>
    expect(f.session.mainAgent?.write).toHaveBeenCalledWith(other),
  );
});

it("holds the selected agent disabled until the account save settles", async () => {
  const gate = deferred();
  const f = fixture(async () => gate.promise);
  f.mount();
  await selectPollen();
  expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen);
  expect(screen.getByRole("combobox", { name: instruction })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Saving your Bestie…");
  gate.resolve();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: instruction })).toBeEnabled(),
  );
});

it("keeps the chooser available when the account save fails", async () => {
  const f = fixture(async () => {
    throw new Error("save failed");
  });
  f.mount();
  await selectPollen();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  expect(screen.getByRole("combobox", { name: instruction })).toBeEnabled();
});

it("rejects a choice that became stale before selection", async () => {
  const f = fixture(async () => {});
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: instruction }));
  const option = await screen.findByRole("option", { name: /^Pollen / });
  f.removeChoice();
  await user.click(option);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That agent is no longer available. Choose another.",
  );
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
});

it.each(["hosted", "elsewhere"] as const)(
  "warns before saving an agent running %s and allows cancellation or confirmation",
  async (place) => {
    const f = fixture(async () => {}, undefined, place);
    f.mount();
    const user = await selectPollen();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Use Pollen as your bestie?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Some bestie features aren’t available with remote agents.",
    );
    expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
    // Initial focus and primary styling are independent: Enter still backs out.
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveAttribute("data-variant", "subtle");
    expect(
      within(dialog).getByRole("button", { name: "Use as bestie" }),
    ).toHaveAttribute("data-variant", "prominent");
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
    await selectPollen();
    await user.click(
      await screen.findByRole("button", { name: "Use as bestie" }),
    );
    await waitFor(() =>
      expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen),
    );
  },
);

it("rechecks a remote agent's eligibility when its confirmation is accepted", async () => {
  const f = fixture(async () => {}, undefined, "hosted");
  f.mount();
  const user = await selectPollen();
  await screen.findByRole("alertdialog");
  f.removeChoice();
  await user.click(screen.getByRole("button", { name: "Use as bestie" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That agent is no longer available. Choose another.",
  );
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
});

it("keeps a remote choice open for retry after a save fails", async () => {
  const gate = deferred();
  let attempts = 0;
  const f = fixture(
    async () => {
      if (++attempts === 1) throw new Error("offline");
      await gate.promise;
    },
    undefined,
    "hosted",
  );
  f.mount();
  const user = await selectPollen();
  await user.click(
    await screen.findByRole("button", { name: "Use as bestie" }),
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Use as bestie" }),
  );
  try {
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
  } finally {
    gate.resolve();
  }
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(f.session.mainAgent?.write).toHaveBeenCalledTimes(2);
});

it("warns after creating a hosted agent without automatically saving it as Bestie", async () => {
  const f = fixture(async () => {}, undefined, "hosted");
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await user.click(screen.getByRole("button", { name: "Finish creation" }));
  await screen.findByRole("alertdialog", {
    name: "Use Pollen as your bestie?",
  });
  expect(f.session.agentChoices.refresh).toHaveBeenCalled();
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Use as bestie" }));
  await waitFor(() =>
    expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen),
  );
});

it("retries the handoff after agent creation refresh fails", async () => {
  const f = fixture(async () => {});
  vi.mocked(f.session.agentChoices.refresh)
    .mockRejectedValueOnce(new Error("inventory failed"))
    .mockResolvedValue(undefined);
  f.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await user.click(screen.getByRole("button", { name: "Finish creation" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "inventory failed",
  );
  expect(f.session.mainAgent?.write).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(f.session.mainAgent?.write).toHaveBeenCalledWith(pollen),
  );
});
