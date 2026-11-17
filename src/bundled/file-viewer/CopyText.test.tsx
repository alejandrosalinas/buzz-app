// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CopyText } from "./CopyText";

const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(cleanup);

function deferred() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const button = () => screen.getByRole("button", { name: "Copy text" });

it("is busy while the text is read, then copies it", async () => {
  const read = deferred();
  let signal: AbortSignal | undefined;
  render(
    <CopyText
      read={(given) => {
        signal = given;
        return read.promise;
      }}
    />,
    { wrapper: ToastProvider },
  );
  await userEvent.click(button());
  expect(button()).toBeDisabled();
  await act(async () => read.resolve("page text"));
  expect(await screen.findByText("Copied text to clipboard")).toBeVisible();
  expect(writeText).toHaveBeenCalledWith("page text");
  expect(button()).toBeEnabled();
  expect(signal?.aborted).toBe(false);
});

it("says when the text was cut at its limit", async () => {
  render(<CopyText read={() => "abcd"} limit={4} />, {
    wrapper: ToastProvider,
  });
  await userEvent.click(button());
  expect(
    await screen.findByText("Copied the first 4 characters to clipboard"),
  ).toBeVisible();
  expect(writeText).toHaveBeenCalledWith("abcd");
});

it.each([
  ["has no text", () => " \n ", "No text to copy"],
  [
    "can't be read",
    () => {
      throw new Error("unreadable");
    },
    "Failed to copy text",
  ],
])("says so when the file %s", async (_, read, message) => {
  render(<CopyText read={read} />, { wrapper: ToastProvider });
  await userEvent.click(button());
  expect(await screen.findByText(message)).toBeVisible();
  expect(writeText).not.toHaveBeenCalled();
  expect(button()).toBeEnabled();
});

it("says so when the clipboard refuses the text", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  render(<CopyText read={() => "text"} />, { wrapper: ToastProvider });
  await userEvent.click(button());
  expect(await screen.findByText("Failed to copy text")).toBeVisible();
});

it("stops a read in progress when the file closes, and reports nothing", async () => {
  const read = deferred();
  let signal: AbortSignal | undefined;
  const view = render(
    <ToastProvider>
      <CopyText
        read={(given) => {
          signal = given;
          return read.promise;
        }}
      />
    </ToastProvider>,
  );
  await userEvent.click(button());
  view.rerender(<ToastProvider>{null}</ToastProvider>);
  expect(signal?.aborted).toBe(true);
  await act(async () => read.resolve("late text"));
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByText(/Copied|Failed/)).toBeNull();
});
