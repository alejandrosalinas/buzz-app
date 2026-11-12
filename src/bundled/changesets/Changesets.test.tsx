// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { TurnCards } from "./Card";
import { type ChangedFile, Unreadable } from "./git";
import { ChangesetPanel } from "./Panel";
import { targetFor } from "./target";
import type { Turn, Turns } from "./turns";

afterEach(cleanup);

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  ...extra,
});
const turn = (shared?: true): Turn => ({
  id: "t1",
  agent: "A",
  channelId: "c",
  viewer: "me",
  origin: "o",
  start: 1,
  end: 2,
  checkouts: [
    {
      dir: "/work/app",
      prefix: "",
      label: "app (main)",
      before: "a".repeat(40),
      after: "b".repeat(40),
      files: 2,
      ...(shared ? { shared } : {}),
    },
  ],
});
const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-one",
  "+two",
  "",
].join("\n");

function fakeTurns(overrides: Partial<Record<keyof Turns, unknown>> = {}) {
  const t = turn();
  return {
    subscribe: () => () => {},
    version: () => 0,
    claim: vi.fn(),
    cardsFor: () => [t],
    summary: vi.fn(async () => [
      file("a.txt"),
      file("b.bin", { binary: true }),
    ]),
    patch: vi.fn(async () => PATCH),
    find: () => ({ turn: t, checkout: t.checkouts[0], after: "b".repeat(40) }),
    ...overrides,
  } as unknown as Turns;
}

const props = (open = vi.fn(() => true), canOpen = () => true) =>
  ({
    message: { id: "m1", authorId: "A", channelId: "c", createdAt: 1 },
    canOpen,
    open,
  }) as unknown as ComposerAccessoryProps;

it("lists the files a turn changed and opens one's diff", async () => {
  const open = vi.fn(() => true);
  const turns = fakeTurns();
  render(<TurnCards {...props(open)} turns={turns} />);
  await screen.findByText("a.txt");
  expect(screen.getByText("2 files changed")).toBeInTheDocument();
  expect(screen.getByText("binary")).toBeInTheDocument();
  expect(turns.claim).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /a\.txt/ }));
  expect(open).toHaveBeenCalledWith(targetFor("t1", 0, "a.txt"));
});

it("shows nothing for a message without a card", () => {
  const { container } = render(
    <TurnCards {...props()} turns={fakeTurns({ cardsFor: () => [] })} />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("does not offer links the host cannot open", async () => {
  render(
    <TurnCards
      {...props(
        vi.fn(() => true),
        () => false,
      )}
      turns={fakeTurns()}
    />,
  );
  expect(await screen.findByRole("button", { name: /a\.txt/ })).toBeDisabled();
});

it("shows the first files and the rest on request", async () => {
  const many = Array.from({ length: 12 }, (_, n) => file(`f${n}.txt`));
  render(
    <TurnCards {...props()} turns={fakeTurns({ summary: async () => many })} />,
  );
  await screen.findByText("f0.txt");
  expect(screen.queryByText("f11.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show all 12 files" }));
  expect(screen.getByText("f11.txt")).toBeInTheDocument();
});

it("says when another agent was working in the same checkout", async () => {
  const t = turn(true);
  render(<TurnCards {...props()} turns={fakeTurns({ cardsFor: () => [t] })} />);
  expect(
    await screen.findByText(/Another agent was working here too/),
  ).toBeInTheDocument();
});

it("says when recording began after the agent started", async () => {
  const t = turn();
  const late = t.checkouts[0];
  if (late) late.late = true;
  render(<TurnCards {...props()} turns={fakeTurns({ cardsFor: () => [t] })} />);
  expect(
    await screen.findByText(/first edits may be missing/),
  ).toBeInTheDocument();
});

it("explains a changeset that cannot be read and tries again", async () => {
  const summary = vi
    .fn()
    .mockRejectedValueOnce(
      new Error("git has cleaned up this changeset's snapshots."),
    )
    .mockResolvedValue([file("a.txt")]);
  render(<TurnCards {...props()} turns={fakeTurns({ summary })} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("cleaned up");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("a.txt")).toBeInTheDocument();
});

it("reads a turn's files and shows the chosen file's diff in the panel", async () => {
  const turns = fakeTurns();
  render(<ChangesetPanel target={targetFor("t1", 0, "a.txt")} turns={turns} />);
  await waitFor(() => expect(turns.patch).toHaveBeenCalled());
  expect(await screen.findByText("two")).toBeInTheDocument();
  expect(screen.getByText(/2 files changed/)).toBeInTheDocument();
  expect(turns.patch).toHaveBeenCalledWith(
    "t1",
    0,
    expect.objectContaining({ path: "a.txt" }),
  );
});

it("steps to a binary file and says there is no text diff", async () => {
  const turns = fakeTurns();
  render(<ChangesetPanel target={targetFor("t1", 0, "a.txt")} turns={turns} />);
  await screen.findByText("two");
  fireEvent.click(screen.getByRole("button", { name: "Next file" }));
  expect(await screen.findByText(/Binary file/)).toBeInTheDocument();
  expect(turns.patch).toHaveBeenCalledTimes(1);
});

it("says a patch is too big and does not offer to try again", async () => {
  render(
    <ChangesetPanel
      target={targetFor("t1", 0, "a.txt")}
      turns={fakeTurns({
        patch: async () => {
          throw new Unreadable("This is too big to show here.");
        },
      })}
    />,
  );
  expect(
    await screen.findByText("This is too big to show here."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("offers to try again after a failure that may pass", async () => {
  const patch = vi
    .fn()
    .mockRejectedValueOnce(new Error("git took too long."))
    .mockResolvedValue(PATCH);
  render(
    <ChangesetPanel
      target={targetFor("t1", 0, "a.txt")}
      turns={fakeTurns({ patch })}
    />,
  );
  expect(await screen.findByText("git took too long.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("two")).toBeInTheDocument();
});

it("does not offer to try again on a binary file or a snapshot git cleaned up", async () => {
  const turns = fakeTurns({
    summary: async () => [file("b.bin", { binary: true })],
  });
  const view = render(
    <ChangesetPanel target={targetFor("t1", 0, "b.bin")} turns={turns} />,
  );
  expect(await screen.findByText(/Binary file/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  view.unmount();
  render(
    <TurnCards
      {...props()}
      turns={fakeTurns({
        summary: async () => {
          throw new Unreadable(
            "git has cleaned up this changeset's snapshots.",
          );
        },
      })}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("cleaned up");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("says so for a changeset another Buzz recorded", () => {
  render(
    <ChangesetPanel
      target={targetFor("t9", 0)}
      turns={fakeTurns({ find: () => undefined })}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "recorded in another Buzz",
  );
});
