// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalIdentityAuthorization } from "./ExternalIdentityAuthorization";
import { IdentitySettings } from "./IdentitySettings";
import { SecuritySettings } from "./SecuritySettings";
import type { Identity } from "../features/identity/service";
import { npubEncode } from "nostr-tools/nip19";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
  Channel: class {},
}));
vi.mock("../features/credential-pairing/service", () => ({
  listPairedTools: async () => [],
  onPairingEvents: () => () => {},
  revokePairedTool: vi.fn(),
}));
async function approve(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Authorize identity" }));
  await user.click(screen.getByRole("button", { name: "Authorize this key" }));
}

const viewer = "ab".repeat(32);
const agent = "cd".repeat(32);
const tag = ["auth", viewer, "", "ef".repeat(64)];
beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => {
      if (command === "identity_restore") return viewer;
      if (command === "identity_prepare_remote_agent_authorization") return tag;
      if (command === "clipboard_write_text") return undefined;
      throw new Error(`Unexpected command: ${command}`);
    });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("signs only after approval and returns the exact native proof for the entered key", async () => {
  const user = userEvent.setup();
  render(<ExternalIdentityAuthorization viewer={viewer} />);
  expect(invoke).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Authorize identity" }),
  ).toBeDisabled();
  await user.type(
    screen.getByLabelText("Application public key (hex)"),
    agent.toUpperCase(),
  );
  expect(invoke).not.toHaveBeenCalled();
  await approve(user);
  expect(await screen.findByLabelText("Ownership proof")).toHaveValue(
    JSON.stringify(tag),
  );
  expect(invoke).toHaveBeenLastCalledWith(
    "identity_prepare_remote_agent_authorization",
    { owner: viewer, agentPubkey: agent },
  );
  await user.click(
    screen.getByRole("button", { name: "Copy ownership proof" }),
  );
  expect(invoke).toHaveBeenLastCalledWith("clipboard_write_text", {
    text: JSON.stringify(tag),
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Ownership proof copied.",
  );
  await user.clear(screen.getByLabelText("Application public key (hex)"));
  expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each(["invalid", viewer, "nsec1notapublickey"])(
  "never dispatches an invalid or self key: %s",
  async (input) => {
    const user = userEvent.setup();
    render(<ExternalIdentityAuthorization viewer={viewer} />);
    await user.type(
      screen.getByLabelText("Application public key (hex)"),
      input,
    );
    await user.click(
      screen.getByRole("button", { name: "Authorize identity" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "application's 64-character hexadecimal public key",
    );
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("holds the entered key and excludes duplicate requests during native signing", async () => {
  let complete!: (result: unknown) => void;
  vi.mocked(invoke)
    .mockResolvedValueOnce(viewer)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const user = userEvent.setup();
  render(<ExternalIdentityAuthorization viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await approve(user);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  try {
    expect(
      screen.getByLabelText("Application public key (hex)"),
    ).toHaveAttribute("readonly");
    const pending = screen.getByRole("button", { name: /Authorizing/ });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    await user.click(pending);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => complete(tag));
  }
  expect(await screen.findByLabelText("Ownership proof")).toHaveValue(
    JSON.stringify(tag),
  );
});

it("refuses an ownership proof from a different signed-in owner", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(agent)
    .mockResolvedValueOnce(["auth", agent, "", "ef".repeat(64)]);
  const user = userEvent.setup();
  render(<ExternalIdentityAuthorization viewer={viewer} />);
  await user.type(
    screen.getByLabelText("Application public key (hex)"),
    "12".repeat(32),
  );
  await approve(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your Buzz identity changed",
  );
  expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
});

it("cancels preparation on leaving settings before native restore answers", async () => {
  let complete!: (result: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  const view = render(<ExternalIdentityAuthorization viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await approve(user);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  view.unmount();
  await act(async () => complete(viewer));
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("keeps the proof selectable when clipboard access fails", async () => {
  const user = userEvent.setup();
  vi.mocked(invoke)
    .mockResolvedValueOnce(viewer)
    .mockResolvedValueOnce(tag)
    .mockRejectedValueOnce(new Error("denied"));
  render(<ExternalIdentityAuthorization viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await approve(user);
  await user.click(
    await screen.findByRole("button", { name: "Copy ownership proof" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("copy it manually");
  expect(screen.getByLabelText("Ownership proof")).toHaveValue(
    JSON.stringify(tag),
  );
});

it("shows the exact identity and agent-control permission before signing, and cancel signs nothing", async () => {
  const user = userEvent.setup();
  render(<ExternalIdentityAuthorization viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await user.click(screen.getByRole("button", { name: "Authorize identity" }));
  expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
    /directing your Buzz coding agents to run commands as you/,
  );
  expect(screen.getByLabelText("Application identity (npub)")).toHaveValue(
    npubEncode(agent),
  );
  expect(invoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
});

const settingsIdentity = () =>
  ({
    backup: {
      snapshot: () => undefined,
      subscribe: () => () => {},
      ready: async () => ({ builderlab: false }),
      refresh: async () => ({ builderlab: false }),
    },
    exportKey: vi.fn(),
    wipeRefusal: async () => "Erasing is unavailable in this test",
  }) as unknown as Identity;

it("clears the real settings form when the displayed owner changes", async () => {
  const user = userEvent.setup();
  const view = render(<SecuritySettings viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await approve(user);
  expect(await screen.findByLabelText("Ownership proof")).toHaveValue(
    JSON.stringify(tag),
  );
  view.rerender(<SecuritySettings viewer={"12".repeat(32)} />);
  expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Application public key (hex)")).toHaveValue("");
});

it("discards an in-flight signer result when leaving Security to remove the key in Identity", async () => {
  let complete!: (result: unknown) => void;
  vi.mocked(invoke)
    .mockResolvedValueOnce(viewer)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  const user = userEvent.setup();
  const view = render(<SecuritySettings viewer={viewer} />);
  await user.type(screen.getByLabelText("Application public key (hex)"), agent);
  await approve(user);
  await waitFor(() => expect(complete).toBeTypeOf("function"));
  view.rerender(
    <IdentitySettings viewer={viewer} identity={settingsIdentity()} />,
  );
  await user.click(screen.getByRole("button", { name: "More options" }));
  await user.click(screen.getByRole("button", { name: "Remove from device" }));
  await act(async () => complete(tag));
  expect(
    screen.getByRole("alertdialog", {
      name: "Remove your key from this device?",
    }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Application public key (hex)"),
  ).not.toBeInTheDocument();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["restore", "signer"])(
  "allows an explicit retry after a native %s rejection",
  async (stage) => {
    if (stage === "restore")
      vi.mocked(invoke).mockRejectedValueOnce("Identity unavailable");
    else
      vi.mocked(invoke)
        .mockResolvedValueOnce(viewer)
        .mockRejectedValueOnce("Signing unavailable");
    const user = userEvent.setup();
    render(<ExternalIdentityAuthorization viewer={viewer} />);
    await user.type(
      screen.getByLabelText("Application public key (hex)"),
      agent,
    );
    await approve(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      stage === "restore" ? "Couldn’t authorize" : "Signing unavailable",
    );
    expect(screen.queryByLabelText("Ownership proof")).not.toBeInTheDocument();
    await approve(user);
    expect(await screen.findByLabelText("Ownership proof")).toHaveValue(
      JSON.stringify(tag),
    );
  },
);
