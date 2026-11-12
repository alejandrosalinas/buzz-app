// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AvatarEditor } from "./AvatarEditor";
import {
  emojiAvatar,
  emojiAvatarScale,
  paintEmojiAvatar,
  uploadAvatar,
} from "./avatar-upload";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";

stubAvatarBrowserApis();

vi.mock("./avatar-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./avatar-upload")>()),
  uploadAvatar: vi.fn(),
  emojiAvatar: vi.fn(),
  paintEmojiAvatar: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const community = "https://a.example";
const original = "https://images.example/original.png";
const next = "https://images.example/next.png";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Form({
  save = vi.fn(),
  destination = community,
}: {
  save?: (value: string) => void;
  destination?: string;
}) {
  const [picture, setPicture] = useState(original);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <AvatarEditor
        value={picture}
        name="Human"
        community={destination}
        onChange={setPicture}
        onBusyChange={setBusy}
      />
      <output aria-label="Draft picture">{picture}</output>
      <button type="button" disabled={busy} onClick={() => save(picture)}>
        Save profile
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setPicture(original)}
      >
        Cancel profile
      </button>
    </>
  );
}
function upload() {
  fireEvent.change(screen.getByLabelText("Upload an image"), {
    target: { files: [new File(["test"], "test.png", { type: "image/png" })] },
  });
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
  await screen.findByLabelText("Picture URL (optional)");
}
function close() {
  fireEvent.keyDown(screen.getByLabelText("Picture URL (optional)"), {
    key: "Escape",
  });
}

it("Done selects a draft and removal still requires the enclosing Save; Cancel discards it", async () => {
  const save = vi.fn();
  render(<Form save={save} />);
  await open();
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
    target: { value: next },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(next);
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel profile" }));
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Remove avatar" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  expect(save).toHaveBeenCalledExactlyOnceWith("");
});

it("closing an unfinished URL draft does not apply it", async () => {
  render(<Form />);
  await open();
  fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
    target: { value: next },
  });
  close();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled(),
  );
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
  await open();
  expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(original);
});

it("aborts a pending upload on close and ignores its late result even after reopening", async () => {
  const late = deferred<string>();
  vi.mocked(uploadAvatar).mockReturnValueOnce(late.promise);
  render(<Form />);
  await open();
  upload();
  await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(uploadAvatar).mock.calls[0]?.[2];
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  close();
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await open();
  await act(async () => {
    late.resolve(next);
    await late.promise;
  });
  expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(original);
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
});

it("retiring a community aborts its upload and cannot update the next editor", async () => {
  const late = deferred<string>();
  vi.mocked(uploadAvatar).mockReturnValueOnce(late.promise);
  const view = render(<Form key="a" />);
  await open();
  upload();
  await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(uploadAvatar).mock.calls[0]?.[2];
  view.rerender(<Form key="b" destination="https://b.example" />);
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    late.resolve(next);
    await late.promise;
  });
  await open();
  expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(original);
  expect(vi.mocked(uploadAvatar).mock.calls[0]?.[1]).toBe(community);
});

it("an upload error keeps the draft and permits an explicit same-file retry", async () => {
  vi.mocked(uploadAvatar)
    .mockRejectedValueOnce(new Error("Upload rejected"))
    .mockResolvedValueOnce(next);
  render(<Form />);
  await open();
  upload();
  await screen.findByText("Upload rejected");
  expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(original);
  upload();
  await waitFor(() =>
    expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(next),
  );
  expect(uploadAvatar).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(next);
});

it("rejects unsafe URLs before selecting the draft", async () => {
  render(<Form />);
  await open();
  for (const value of [
    "http://images.example/a.png",
    "https://user:password@images.example/a.png",
    "data:image/png;base64,AA==",
  ]) {
    fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
    expect(
      screen.getByLabelText("Picture URL (optional)"),
    ).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  }
});

it("shows a URL error after blur or an attempt, then keeps it current", async () => {
  render(<Form />);
  await open();
  const url = screen.getByLabelText("Picture URL (optional)");
  const message = /Use an HTTPS image URL/;
  fireEvent.change(url, { target: { value: "h" } });
  expect(url).not.toHaveAccessibleDescription(message);
  // Enter is an attempt: it shows the error and applies nothing.
  fireEvent.keyDown(url, { key: "Enter" });
  expect(url).toHaveAccessibleDescription(message);
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
  fireEvent.change(url, { target: { value: next } });
  expect(url).not.toHaveAccessibleDescription(message);
  fireEvent.change(url, { target: { value: "http://images.example/a.png" } });
  expect(url).toHaveAccessibleDescription(message);
  fireEvent.change(url, { target: { value: "" } });
  expect(url).not.toHaveAccessibleDescription(message);

  close();
  await open();
  const fresh = screen.getByLabelText("Picture URL (optional)");
  fireEvent.change(fresh, { target: { value: "ftp://x" } });
  expect(fresh).not.toHaveAccessibleDescription(message);
  fireEvent.blur(fresh);
  expect(fresh).toHaveAccessibleDescription(message);

  close();
  await open();
  const attempt = screen.getByLabelText("Picture URL (optional)");
  fireEvent.change(attempt, { target: { value: "ftp://x" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(attempt).toHaveAccessibleDescription(message);
  expect(attempt).toHaveFocus();
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
});

it("accepts equivalent HTTPS spellings without a misleading validation error", async () => {
  render(<Form />);
  await open();
  fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
    target: { value: "HTTPS://IMAGES.example:443/avatar.png" },
  });
  expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("previews emoji colors without selecting a draft, and restores the image when dismissed", async () => {
  render(<Form />);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
  expect(
    screen.queryByRole("group", { name: "Avatar background" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Background" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Use #476CFF background" }),
  );
  expect(
    screen
      .getByRole("slider", { name: "Emoji position" })
      .querySelector("[data-avatar-shape]"),
  ).toHaveStyle({
    backgroundColor: "#476CFF",
  });
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
  fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
  expect(
    screen
      .getByRole("slider", { name: "Emoji position" })
      .querySelector("[data-avatar-shape]"),
  ).toHaveStyle({
    backgroundColor: "#476CFF",
  });
  fireEvent.click(screen.getByRole("tab", { name: "Image" }));
  expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(original);
  close();
  await waitFor(() =>
    expect(
      screen.queryByRole("slider", { name: "Emoji position" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
});

it("accepts a file dropped over the emoji panel and returns to its image draft", async () => {
  vi.mocked(uploadAvatar).mockResolvedValueOnce(next);
  render(<Form />);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
  fireEvent.drop(screen.getByRole("group", { name: "Avatar picker" }), {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["test"], "test.png", { type: "image/png" })],
    },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Picture URL (optional)")).toHaveValue(next),
  );
  expect(screen.getByRole("tab", { name: "Image" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(original);
});

it("Enter selects a valid URL without submitting the enclosing form", async () => {
  const save = vi.fn();
  render(<Form save={save} />);
  await open();
  fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
    target: { value: next },
  });
  fireEvent.keyDown(screen.getByLabelText("Picture URL (optional)"), {
    key: "Enter",
  });
  expect(screen.getByLabelText("Draft picture")).toHaveTextContent(next);
  expect(save).not.toHaveBeenCalled();
});

it("opens the shared image flow from a text trigger and applies its URL", async () => {
  const onChange = vi.fn();
  render(
    <AvatarEditor
      triggerLabel="Use image"
      value=""
      name="Agent"
      community={community}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use image" }));
  const input = await screen.findByLabelText("Picture URL (optional)");
  fireEvent.change(input, { target: { value: next } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(next);
});

it("keeps a Buzz mobile emoji avatar for a personal profile, never for an agent", async () => {
  const emoji = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#FFB84D"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🛹</text></svg>',
  )}`;
  const change = vi.fn();
  // The agent editor: native saving takes HTTPS pictures only.
  const agent = render(
    <AvatarEditor
      triggerStyle="dotted-squircle"
      inlinePicker
      shape="squircle"
      value=""
      name="Agent"
      community={community}
      onChange={change}
    />,
  );
  const url = screen.getByLabelText("Picture URL (optional)");
  fireEvent.change(url, { target: { value: emoji } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(url).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  expect(change).not.toHaveBeenCalled();
  agent.unmount();

  render(
    <AvatarEditor
      personal
      value={original}
      name="Human"
      community={community}
      onChange={change}
    />,
  );
  await open();
  fireEvent.change(screen.getByLabelText("Picture URL (optional)"), {
    target: { value: emoji },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(change).toHaveBeenCalledExactlyOnceWith(emoji);
});

it("previews an inline agent emoji and its background with Done in the form footer", async () => {
  const footer = document.createElement("div");
  document.body.append(footer);
  const change = vi.fn();
  const view = render(
    <AvatarEditor
      triggerStyle="dotted-squircle"
      inlinePicker
      actionTarget={footer}
      value=""
      name="Agent"
      community={community}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
  const position = screen.getByRole("slider", { name: "Emoji position" });
  expect(position).toBeVisible();
  // Only the artwork inside takes the avatar mask, which would clip focus.
  expect(position).not.toHaveAttribute("data-avatar-shape");
  expect(position.querySelector("[data-avatar-shape]")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  fireEvent.click(screen.getByRole("tab", { name: "Background" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Use #476CFF background" }),
  );
  expect(
    screen
      .getByRole("slider", { name: "Emoji position" })
      .querySelector("[data-avatar-shape]"),
  ).toHaveStyle({
    backgroundColor: "#476CFF",
  });
  expect(footer).toContainElement(screen.getByRole("button", { name: "Done" }));
  expect(
    screen.queryByRole("button", { name: "Remove avatar" }),
  ).not.toBeInTheDocument();
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  view.unmount();
  footer.remove();
});

it("sizes and moves the emoji in its preview and its uploaded avatar", async () => {
  vi.mocked(emojiAvatar).mockResolvedValue(
    new File([], "avatar.png", { type: "image/png" }),
  );
  vi.mocked(uploadAvatar).mockResolvedValue(next);
  const change = vi.fn();
  render(
    <AvatarEditor
      triggerStyle="dotted-squircle"
      inlinePicker
      value=""
      name="Agent"
      community={community}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
  const size = screen.getByRole("slider", { name: "Emoji size" });
  expect(size).toHaveValue("1");
  fireEvent.change(size, { target: { value: "1.5" } });
  expect(paintEmojiAvatar).toHaveBeenLastCalledWith(
    expect.any(HTMLCanvasElement),
    "😀",
    undefined,
    emojiAvatarScale * 1.5,
    0,
  );
  expect(
    within(screen.getByRole("group", { name: "Avatar picker" })).queryByRole(
      "slider",
      { name: "Emoji size" },
    ),
  ).toBeNull();
  const position = screen.getByRole("slider", { name: "Emoji position" });
  for (let step = 0; step < 5; step++)
    fireEvent.keyDown(position, { key: "ArrowDown" });
  expect(position).toHaveAttribute("aria-valuetext", "10% down");
  expect(paintEmojiAvatar).toHaveBeenLastCalledWith(
    expect.any(HTMLCanvasElement),
    "😀",
    undefined,
    emojiAvatarScale * 1.5,
    0.1,
  );
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(change).toHaveBeenCalledWith(next));
  expect(emojiAvatar).toHaveBeenCalledExactlyOnceWith(
    "😀",
    "#FFF4CC",
    emojiAvatarScale * 1.5,
    0.1,
  );
});
