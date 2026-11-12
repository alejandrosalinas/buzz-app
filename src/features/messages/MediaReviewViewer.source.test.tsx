// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createRelaySession as CreateRelaySession } from "../relay/session";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

const url = `https://relay.test/media/${"a".repeat(64)}.mp4`;
const source = `buzz-media://localhost/${encodeURIComponent(url)}`;
const owners: ReturnType<typeof CreateRelaySession>[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

// The listener's failure is cached before review opens, as when an inline
// player already found it unavailable.
async function reviewAfterCachedFailure() {
  const { useMediaElementSource } = await import("./use-media-element-source");
  const { createRelaySession } = await import("../relay/session");
  const { keypair, message } = await import("../relay/testing");
  const { MediaReviewViewer } = await import("./MediaReviewViewer");
  const inline = renderHook(() => useMediaElementSource(source));
  await waitFor(() => expect(inline.result.current.unavailable).toBe(true));
  inline.unmount();
  const viewer = keypair();
  const root = message(viewer, "one", "Video", 1, [
    ["imeta", `url ${url}`, "m video/mp4"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => source,
    async query(filters) {
      return filters.some((filter) => filter.ids?.includes(root.id))
        ? [root]
        : [];
    },
  });
  owners.push(owner);
  await act(async () => {
    render(
      <MediaReviewViewer
        attachment={{ url, kind: "video" }}
        session={owner.session}
        scope="review-source-test"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        onOpenLink={() => false}
        close={() => {}}
      />,
    );
  });
}

async function expectUnavailable() {
  // The root message loads first; a cold run under a loaded suite can take
  // several seconds, so the test's own timeout below leaves room for this.
  expect(
    await screen.findByText("Media unavailable", {}, { timeout: 10_000 }),
  ).toBeInTheDocument();
  expect(document.querySelector("video")).toBeNull();
}

it.each([
  ["reports none", () => vi.mocked(invoke).mockResolvedValue(null)],
  [
    "lookup fails",
    () => vi.mocked(invoke).mockRejectedValue(new Error("no listener")),
  ],
])(
  "review opened after the listener %s shows the video unavailable",
  async (_, mock) => {
    mock();
    await reviewAfterCachedFailure();
    await expectUnavailable();
  },
  15_000,
);
