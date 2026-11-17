// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { Agent, Agents } from "../../features/agents/service";
import {
  croppedAvatar,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { AgentIdentityDialog } from "./AgentIdentityDialog";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  uploadAvatar: vi.fn(),
  croppedAvatar: vi.fn(),
}));

// jsdom decodes no images; each upload is a decoded square.
vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
  100,
);
vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
  100,
);
HTMLImageElement.prototype.decode = () => Promise.resolve();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const picture = "https://images.example/current.png";

// Uploads are content-addressed, so re-uploading returns the current URL.
const reupload = (...later: string[]) => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:upload"),
      revokeObjectURL: vi.fn(),
    }),
  );
  for (const url of [picture, ...later])
    vi.mocked(uploadAvatar).mockResolvedValueOnce(url);
  const agents = {
    save: vi.fn(async () => {}),
    subscribe: () => () => {},
    memberships: () => [],
  } as unknown as Agents & { save: ReturnType<typeof vi.fn> };
  const onClose = vi.fn();
  render(
    <AgentIdentityDialog
      agent={
        {
          key: "a".repeat(64),
          pubkey: "a".repeat(64),
          name: "Ada",
          picture,
          relay: "https://a.example",
          place: "here",
        } as Agent
      }
      agents={agents}
      onClose={onClose}
      finalFocus={createRef()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Upload an image"), {
    target: {
      files: [new File(["image"], "image.png", { type: "image/png" })],
    },
  });
  return { agents, onClose };
};

it("saves a reframed upload of the agent's current picture", async () => {
  const cropped = new File(["crop"], "avatar.png", { type: "image/png" });
  vi.mocked(croppedAvatar).mockResolvedValueOnce(cropped);
  const { agents, onClose } = reupload("https://images.example/cropped.png");
  const save = screen.getByRole("button", { name: "Save changes" });
  fireEvent.change(await screen.findByRole("slider", { name: "Zoom" }), {
    target: { value: "2" },
  });
  expect(save).toBeEnabled();
  await userEvent.click(save);
  await waitFor(() =>
    expect(agents.save).toHaveBeenCalledExactlyOnceWith("a".repeat(64), {
      picture: "https://images.example/cropped.png",
    }),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps Save off when the framing returns to the original", async () => {
  reupload();
  const save = screen.getByRole("button", { name: "Save changes" });
  const zoom = await screen.findByRole("slider", { name: "Zoom" });
  const frame = screen.getByRole("application", { name: "Image position" });
  // A square image at full size has no room to pan.
  fireEvent.keyDown(frame, { key: "ArrowRight" });
  expect(save).toBeDisabled();
  fireEvent.change(zoom, { target: { value: "2" } });
  fireEvent.keyDown(frame, { key: "ArrowRight" });
  expect(save).toBeEnabled();
  fireEvent.change(zoom, { target: { value: "1" } });
  expect(save).toBeDisabled();
});
