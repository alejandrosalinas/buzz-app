// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowWebhookSecretDialog } from "./WorkflowWebhookSecretDialog";

const workflowId = "55555555-5555-4555-8555-555555555555";
const hookUrl = `https://relay.example.test/hooks/${workflowId}`;
const masked = "•".repeat(24);
const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: clipboard,
});
afterEach(() => {
  cleanup();
  clipboard.writeText.mockReset();
  clipboard.writeText.mockImplementation(async () => {});
});

/** `null` stands for "absent" so destructuring defaults do not refill it. */
function mount({
  address = hookUrl,
  secret = "one-time-secret",
}: {
  address?: string | null;
  secret?: string | null;
} = {}) {
  const take = vi.fn(() => secret ?? undefined);
  const onContinue = vi.fn();
  render(
    <StrictMode>
      <WorkflowWebhookSecretDialog
        workflowId={workflowId}
        hookUrl={address ?? undefined}
        take={take}
        onContinue={onContinue}
      />
    </StrictMode>,
  );
  return { take, onContinue };
}
// A string `name` already matches the full accessible name.
const button = (name: string, root: HTMLElement = document.body) =>
  within(root).getByRole("button", { name });

it("takes the secret exactly once under StrictMode, masks it and reveals on request", () => {
  const { take, onContinue } = mount();
  expect(take).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(screen.getByTestId("webhook-url")).toHaveTextContent(hookUrl);
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(masked);
  expect(document.body.textContent).not.toContain("one-time-secret");
  fireEvent.click(button("Reveal webhook secret"));
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "one-time-secret",
  );
  fireEvent.click(button("Hide webhook secret"));
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(masked);
  // Revealing counts as handling: leaving no longer asks.
  fireEvent.click(button("Continue"));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("an outside click never discards a revealed secret", async () => {
  const { onContinue } = mount();
  fireEvent.click(button("Reveal webhook secret"));
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(onContinue).not.toHaveBeenCalled();
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(
    "one-time-secret",
  );
});

it("asks before continuing with an unseen secret; copying the secret satisfies the guard", async () => {
  const { onContinue } = mount();
  fireEvent.click(button("Continue"));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Continue without this secret?",
  });
  expect(confirm).toHaveTextContent("cannot be recovered");
  // The secret is lost for good, so Enter goes back.
  await waitFor(() => expect(button("Go back", confirm)).toHaveFocus());
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(button("Go back", confirm));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog", { name: "Webhook ready" })).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(button("Copy URL"));
  expect(await screen.findByRole("status")).toHaveTextContent("URL copied.");
  expect(clipboard.writeText).toHaveBeenLastCalledWith(hookUrl);
  // Copying only the URL does not count as keeping the secret.
  fireEvent.click(button("Continue"));
  const again = await screen.findByRole("alertdialog");
  fireEvent.click(button("Go back", again));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(button("Copy secret"));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Secret copied."),
  );
  expect(clipboard.writeText).toHaveBeenLastCalledWith("one-time-secret");
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent(masked);
  fireEvent.click(button("Continue"));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("confirming leaves the secret behind; a failed copy reports and keeps asking", async () => {
  clipboard.writeText.mockRejectedValue(new Error("denied"));
  const { onContinue } = mount();
  fireEvent.click(button("Copy secret"));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Couldn’t copy the secret. Reveal it and copy it manually.",
  );
  fireEvent.click(button("Continue"));
  const confirm = await screen.findByRole("alertdialog", {
    name: "Continue without this secret?",
  });
  fireEvent.click(button("Continue", confirm));
  expect(onContinue).toHaveBeenCalledTimes(1);
});

it("shows the relative route without a relay address and skips the guard when the secret is gone", () => {
  const { take, onContinue } = mount({ address: null, secret: null });
  expect(take).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("webhook-url")).toBeNull();
  expect(screen.getByText(/Send requests to/)).toHaveTextContent(
    `/hooks/${workflowId}`,
  );
  expect(screen.getByTestId("webhook-secret")).toHaveTextContent("Unavailable");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This secret is no longer available from this session.",
  );
  expect(button("Reveal webhook secret")).toBeDisabled();
  expect(button("Copy secret")).toBeDisabled();
  fireEvent.click(button("Continue"));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
