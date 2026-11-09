// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, expect, it } from "vitest";
import type { ComposerSession } from "./composer-session";
import type { DraftAttachment } from "./attachment-draft";
import { sendInBackground } from "./background-upload";
import { BackgroundUploadStatus } from "./BackgroundUploadStatus";

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Already uploaded, so the send goes straight to publishing. */
const ready = (name: string): DraftAttachment => ({
  id: crypto.randomUUID(),
  file: new File([], name),
  status: "ready",
  uploaded: {
    name,
    url: `https://relay.test/media/${"a".repeat(64)}.txt`,
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
  },
});

it("leaves cancelled sends out of the count and disables Cancel once nothing is left to stop", async () => {
  const session = { attachments: {} } as unknown as ComposerSession;
  const focusTarget = createRef<HTMLTextAreaElement>();
  render(
    <>
      <textarea ref={focusTarget} aria-label="Message" />
      <BackgroundUploadStatus
        session={session}
        focusTarget={focusTarget}
        here="buzz://channel/elsewhere"
      />
    </>,
  );
  // A publish ignores Cancel: each send stays listed until its publish settles.
  const held = [deferred(), deferred()];
  for (const [index, name] of ["#Design", "#Ideas"].entries())
    act(() =>
      sendInBackground(
        session,
        name,
        name,
        { name, link: `buzz://channel/${name}` },
        [ready(`${index}.txt`)],
        () => held[index]?.promise,
        () => true,
      ),
    );
  expect(
    screen.getByText("Finishing upload to #Ideas and 1 more"),
  ).toHaveAttribute("role", "status");

  await userEvent.click(
    screen.getByRole("button", { name: "Cancel upload to #Ideas" }),
  );
  expect(screen.getByText("Finishing upload to #Design")).toBeVisible();
  const cancel = screen.getByRole("button", {
    name: "Cancel upload to #Design",
  });
  expect(cancel).toHaveAttribute("aria-disabled", "false");

  await userEvent.click(cancel);
  // Both are cancelled and still publishing. Cancel stops nothing, but keeps
  // focus: browsers move focus off a `disabled` button.
  expect(screen.getByText("Finishing upload to #Ideas")).toBeVisible();
  expect(cancel).toHaveAccessibleName("Cancel upload to #Ideas");
  expect(cancel).toHaveAttribute("aria-disabled", "true");
  expect(cancel).not.toHaveAttribute("disabled");
  expect(cancel).toHaveFocus();

  await act(async () => {
    for (const publish of held) publish.resolve();
  });
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(focusTarget.current).toHaveFocus();
});
