// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import { localAgentsFixture } from "../agents/local-testing";
import { createRelaySession, type RelaySession } from "../relay/session";
import { ProfilePeek } from "./ProfilePeek";

beforeEach(() => {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1024,
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    768,
  );
  // jsdom has no native top layer. Rendered placement is checked in the browser.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});
const person = "a".repeat(64);
const viewer = "b".repeat(64);
function fixture(agent = false, agentChoices?: RelaySession["agentChoices"]) {
  const owner = createRelaySession(null);
  const open =
    vi.fn<(keys: readonly string[], signal: AbortSignal) => Promise<string>>();
  const onOpen = vi.fn(() => true);
  const session = {
    ...owner.session,
    agentChoices: agentChoices ?? owner.session.agentChoices,
    directMessages: { ...owner.session.directMessages, available: true, open },
  };
  const view = render(
    <>
      <ProfilePeek
        trigger={<button type="button">Avatar</button>}
        name="Morgan"
        picture={undefined}
        pubkey={person}
        agent={agent}
        session={session}
        viewer={viewer}
        channelId="source"
        target="profile"
        onOpen={onOpen}
      />
      <button type="button">Next</button>
    </>,
  );
  // Supply visible anchor geometry; jsdom otherwise reports a clipped zero-size trigger.
  vi.spyOn(
    screen.getByRole("button", { name: "Avatar" }),
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(100, 100, 40, 40));
  return { owner, open, onOpen, view };
}

it("offers Message for a hosted agent while owned community evidence is available", async () => {
  const source = localAgentsFixture();
  const lifetime = new AbortController();
  const hosted = {
    pubkey: person,
    name: "Morgan",
    owner: viewer,
    relayUrl: "https://relay.example.test",
  };
  source.set({ hosted: [hosted] });
  const choices = createAgentChoices({
    scope: `${hosted.relayUrl}:${viewer}`,
    library: createAgentLibrary(undefined).queries,
    native: source,
    signal: lifetime.signal,
  });
  const f = fixture(true, choices);
  const user = userEvent.setup();
  try {
    expect(choices.snapshot().identities).toEqual([
      {
        pubkey: person,
        name: "Morgan",
        managed: false,
        messageable: true,
        execution: "remote",
      },
    ]);
    f.open.mockResolvedValueOnce("hosted-dm");
    await user.tab();
    await screen.findByRole("dialog", { name: "Morgan profile preview" });
    expect(screen.getByRole("button", { name: "Message" })).toBeVisible();
    act(() => source.set({ hosted: [] }));
    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
    act(() => source.set({ hosted: [hosted] }));
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(f.open).toHaveBeenCalledExactlyOnceWith(
      [person],
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(f.onOpen).toHaveBeenCalledWith("buzz://channel/hosted-dm"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    f.view.unmount();
    lifetime.abort();
    f.owner.dispose();
  }
});

it("tabs through both actions, restores the avatar on Escape, and resumes after the preview", async () => {
  const f = fixture();
  const user = userEvent.setup();
  try {
    await user.tab();
    await screen.findByRole("dialog", { name: "Morgan profile preview" });
    await user.tab();
    expect(screen.getByRole("button", { name: "View profile" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Message" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "View profile" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Avatar" })).toHaveFocus(),
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  } finally {
    f.view.unmount();
    f.owner.dispose();
  }
});

it("shows DM failure, retries, and opens the returned conversation without sending a message", async () => {
  const f = fixture();
  const user = userEvent.setup();
  let resolve!: (id: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  try {
    f.open.mockRejectedValueOnce(new Error("Offline"));
    await user.tab();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    f.open.mockReturnValueOnce(pending);
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(f.open).toHaveBeenLastCalledWith([person], expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Message" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(f.open).toHaveBeenCalledTimes(2);
    await act(async () => resolve("dm-1"));
    expect(f.onOpen).toHaveBeenCalledWith("buzz://channel/dm-1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    resolve?.("dm-1");
    f.view.unmount();
    f.owner.dispose();
  }
});

it("cancels a pending open when the preview is dismissed and ignores its late result", async () => {
  const f = fixture();
  const user = userEvent.setup();
  let resolve!: (id: string) => void;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  try {
    f.open.mockReturnValueOnce(pending);
    await user.tab();
    await screen.findByRole("dialog");
    await user.tab();
    await user.tab();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    const signal = f.open.mock.calls[0]?.[1];
    await user.keyboard("{Escape}");
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => resolve("dm-1"));
    expect(f.onOpen).not.toHaveBeenCalled();
  } finally {
    resolve?.("dm-1");
    f.view.unmount();
    f.owner.dispose();
  }
});

it("records the originating avatar as the profile navigation focus target", async () => {
  const f = fixture();
  const user = userEvent.setup();
  try {
    f.onOpen.mockImplementation(() => {
      expect(screen.getByRole("button", { name: "Avatar" })).toHaveFocus();
      return true;
    });
    await user.tab();
    await screen.findByRole("dialog");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(f.onOpen).toHaveBeenCalledWith("profile");
  } finally {
    f.view.unmount();
    f.owner.dispose();
  }
});
