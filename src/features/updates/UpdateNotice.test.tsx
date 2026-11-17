// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { UpdateAction } from "./UpdateAction";
import { UpdateNotice } from "./UpdateNotice";
import { createUpdates, type Updates } from "./updates";

let updates: Updates | undefined;
afterEach(() => {
  cleanup();
  updates?.dispose();
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const READY = "Update ready. Restart Buzz to install";

function UpdateSurfaces({ updates }: { updates: Updates }) {
  return (
    <ToastProvider>
      <UpdateAction updates={updates} />
      <UpdateNotice updates={updates} />
    </ToastProvider>
  );
}

async function readyUpdate() {
  const download = deferred();
  const install = deferred();
  const update = {
    version: "1.2.3",
    download: () => download.promise,
    install: vi.fn(() => install.promise),
    close: vi.fn(async () => {}),
  };
  const checks = [update, null, update];
  const relaunch = vi.fn(async () => {});
  updates = createUpdates({
    desktop: true,
    check: async () => checks.shift() ?? null,
    relaunch,
  });
  const view = render(<UpdateSurfaces updates={updates} />);
  await waitFor(() => expect(updates?.snapshot().state).toBe("downloading"));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  download.resolve();
  await screen.findByRole("button", { name: READY });
  return { updates, update, install, relaunch, view };
}

it("offers restart from the top bar without a toast once the download is ready", async () => {
  const { update, install, relaunch } = await readyUpdate();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: READY })).toHaveTextContent(
    "Update",
  );

  fireEvent.click(screen.getByRole("button", { name: READY }));
  expect(
    await screen.findByRole("button", { name: "Updating Buzz" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(update.install).toHaveBeenCalledOnce();
  install.resolve();
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});

it.each(["install", "restart"])(
  "keeps %s failure and retry reachable in the notice",
  async (failure) => {
    const { install, relaunch, view, updates } = await readyUpdate();
    if (failure === "restart")
      relaunch.mockRejectedValueOnce(new Error("shutdown refused"));
    fireEvent.click(screen.getByRole("button", { name: READY }));
    if (failure === "install") install.reject(new Error("read-only location"));
    else install.resolve();
    expect(
      await screen.findByRole("dialog", { name: "Update failed" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        failure === "install" ? "read-only location" : "shutdown refused",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: READY }),
    ).not.toBeInTheDocument();
    // App restoration may remount the notice; recovery belongs to the update owner.
    view.unmount();
    render(<UpdateSurfaces updates={updates} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("You're on the latest version."),
    ).toBeVisible();
  },
);

it("does not surface background check failures", async () => {
  const check = vi.fn(async () => {
    throw new Error("offline");
  });
  updates = createUpdates({ desktop: true, check, relaunch: async () => {} });
  await act(async () => {});
  render(<UpdateSurfaces updates={updates} />);
  expect(check).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("a dismissed failure stays hidden across remounts and later checks", async () => {
  const { install, view, updates } = await readyUpdate();
  fireEvent.click(screen.getByRole("button", { name: READY }));
  install.reject(new Error("read-only location"));
  await screen.findByRole("dialog", { name: "Update failed" });
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss update notification" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );

  view.unmount();
  render(<UpdateSurfaces updates={updates} />);
  expect(updates.snapshot().state).toBe("error");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await updates.checkForUpdate();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  void updates.checkForUpdate();
  expect(await screen.findByRole("button", { name: READY })).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
