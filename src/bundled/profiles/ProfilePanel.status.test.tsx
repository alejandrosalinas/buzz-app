// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
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
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { keypair, signed, type Key } from "../../features/relay/testing";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import styles from "../../features/user-status/Status.module.css";

afterEach(cleanup);
const viewer = keypair();
const relayAuthor = keypair();
const status = (
  key: Key,
  content: string,
  created_at: number,
  tags: string[][] = [],
) =>
  signed(key, {
    kind: 30315,
    content,
    created_at,
    tags: [["d", "general"], ...tags],
  });

function fixture(
  statuses: (filter: ReadFilter) => Promise<readonly RelayEvent[]>,
  { origin = "https://relay.example.test", writable = true } = {},
) {
  const reads: ReadFilter[] = [];
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relayAuthor.pubkey,
      scope: origin,
      media: () => undefined,
      query: async (filters) => {
        const filter = filters.find((item) => item.kinds?.includes(30315));
        if (!filter) return [];
        reads.push(filter);
        return [...(await statuses(filter))];
      },
      ...(writable && {
        writer: {
          kinds: [30315],
          sign: async (template) => signed(viewer, template),
          publish,
        },
      }),
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${origin}:${viewer.pubkey}`,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel = (key: Key, agent = false) => (
    <ProfilePanel
      relay={relay}
      target={profileTarget(key.pubkey, { agent }) ?? ""}
      close={() => {}}
    />
  );
  /** Points this panel's relay at another community or identity. */
  const show = (next: RelaySnapshot) =>
    act(() => {
      snapshot = next;
      for (const listener of listeners) listener();
    });
  return { owner, reads, publish, panel, snapshot: () => snapshot, show };
}
const setStatus = (options?: { hidden: boolean }) =>
  screen.queryByRole("button", { name: "Set a status", ...options });
const updateStatus = (options?: { hidden: boolean }) =>
  screen.queryByRole("button", { name: "Update status", ...options });
const editor = () => screen.queryByRole("dialog", { name: "Set a status" });
const heroStatus = () =>
  document.querySelector(`.${styles.status}`)?.textContent;

it("shows the newest self-published general status with its emoji", async () => {
  const person = keypair();
  const f = fixture(async () => [
    status(person, "Old", 1),
    status(person, "In a meeting", 2, [["emoji", "📅"]]),
  ]);
  try {
    render(f.panel(person));
    expect(await screen.findByText("In a meeting")).toBeTruthy();
    expect(document.querySelector(`.${styles.status}`)?.textContent).toBe(
      "📅 In a meeting",
    );
    expect(screen.getByText("📅")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(f.reads).toEqual([
      expect.objectContaining({
        kinds: [30315],
        authors: [person.pubkey],
        "#d": ["general"],
        limit: 1,
      }),
    ]);
  } finally {
    f.owner.dispose();
  }
});

it.each([
  ["a cleared status", async (person: Key) => [status(person, "  ", 2)]],
  ["another author's status", async () => [status(keypair(), "Spoofed", 2)]],
  [
    "a failed read",
    async () => {
      throw new Error("offline");
    },
  ],
])("shows no status for %s", async (_name, result) => {
  const person = keypair();
  const read = vi.fn(() => result(person));
  const f = fixture(read);
  try {
    render(f.panel(person));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => {
      await read.mock.results[0]?.value.catch(() => {});
    });
    expect(screen.queryByText("Spoofed")).toBeNull();
    expect(document.querySelector(`.${styles.status}`)).toBeNull();
  } finally {
    f.owner.dispose();
  }
});

it("ignores a late status after switching profiles", async () => {
  const first = keypair();
  const second = keypair();
  let release = () => {};
  const f = fixture(async (filter) =>
    filter.authors?.includes(first.pubkey)
      ? new Promise((resolve) => {
          release = () => resolve([status(first, "Stale", 2)]);
        })
      : [status(second, "Current", 2)],
  );
  try {
    const view = render(f.panel(first));
    await waitFor(() => expect(f.reads).toHaveLength(1));
    view.rerender(f.panel(second));
    await act(async () => release());
    expect(await screen.findByText("Current")).toBeTruthy();
    expect(screen.queryByText("Stale")).toBeNull();
  } finally {
    f.owner.dispose();
  }
});

it("offers your status editor only on your own profile when statuses are writable", async () => {
  const other = keypair();
  const f = fixture(async (filter) =>
    filter.authors?.includes(other.pubkey) ? [status(other, "Away", 2)] : [],
  );
  const view = render(f.panel(viewer));
  try {
    expect(setStatus()?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(updateStatus()).toBeNull();
    view.rerender(f.panel(other));
    await waitFor(() => expect(heroStatus()).toBe("Away"));
    expect(setStatus()).toBeNull();
    expect(updateStatus()).toBeNull();
    // No separate agent gate: the viewer === pubkey check hides it here too.
    view.rerender(f.panel(keypair(), true));
    expect(setStatus()).toBeNull();
    expect(updateStatus()).toBeNull();
  } finally {
    view.unmount();
    f.owner.dispose();
  }
  const readOnly = fixture(async () => [status(viewer, "Read only", 2)], {
    writable: false,
  });
  try {
    render(readOnly.panel(viewer));
    await waitFor(() => expect(heroStatus()).toBe("Read only"));
    expect(setStatus()).toBeNull();
    expect(updateStatus()).toBeNull();
  } finally {
    readOnly.owner.dispose();
  }
});

it("edits, saves and clears your status from one button whose label follows the status, returning focus to it", async () => {
  const user = userEvent.setup();
  const f = fixture(async () => [
    status(viewer, "Working from home", 2, [["emoji", "🏠"]]),
  ]);
  try {
    render(f.panel(viewer));
    await waitFor(() => expect(heroStatus()).toBe("🏠 Working from home"));
    expect(setStatus()).toBeNull();
    const button = updateStatus() as HTMLElement;
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    await user.click(button);
    expect(editor()).toBeTruthy();
    expect(screen.getByLabelText("Status message")).toHaveProperty(
      "value",
      "Working from home",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(editor()).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());

    await user.click(button);
    fireEvent.change(screen.getByLabelText("Status message"), {
      target: { value: "Design review" },
    });
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({
      pubkey: viewer.pubkey,
      kind: 30315,
      content: "Design review",
      tags: [
        ["d", "general"],
        ["emoji", "🏠"],
      ],
    });
    expect(heroStatus()).toBe("🏠 Design review");
    expect(updateStatus()).toBe(button);
    await waitFor(() => expect(button).toHaveFocus());

    // Clearing relabels the same button, which keeps focus.
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Clear status" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[1]?.[0]).toMatchObject({
      content: "",
      tags: [["d", "general"]],
    });
    expect(heroStatus()).toBeUndefined();
    expect(updateStatus()).toBeNull();
    expect(setStatus()).toBe(button);
    await waitFor(() => expect(button).toHaveFocus());

    // Setting one relabels it back.
    await user.click(button);
    expect(screen.getByLabelText("Status message")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("Status message"), {
      target: { value: "Back" },
    });
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(f.publish).toHaveBeenCalledTimes(3);
    expect(heroStatus()).toBe("💬 Back");
    expect(setStatus()).toBeNull();
    expect(updateStatus()).toBe(button);
    await waitFor(() => expect(button).toHaveFocus());
  } finally {
    f.owner.dispose();
  }
});

it("closes the editor when the panel's community or identity changes and saves to the panel's community", async () => {
  const user = userEvent.setup();
  const home = fixture(async () => []);
  const other = fixture(async () => [], {
    origin: "https://other.example.test",
  });
  try {
    render(home.panel(viewer));
    await user.click(setStatus() as HTMLElement);
    expect(editor()).toBeTruthy();
    home.show(other.snapshot());
    expect(editor()).toBeNull();
    await user.click(setStatus() as HTMLElement);
    fireEvent.change(screen.getByLabelText("Status message"), {
      target: { value: "Elsewhere" },
    });
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(editor()).toBeNull());
    expect(home.publish).not.toHaveBeenCalled();
    expect(other.publish).toHaveBeenCalledOnce();
    expect(other.publish.mock.calls[0]?.[0]).toMatchObject({
      content: "Elsewhere",
    });

    await user.click(updateStatus() as HTMLElement);
    expect(editor()).toBeTruthy();
    const identity = keypair().pubkey;
    home.show({
      ...other.snapshot(),
      generation: 2,
      scope: `https://other.example.test:${identity}`,
      viewer: identity,
    });
    expect(editor()).toBeNull();
    expect(setStatus({ hidden: true })).toBeNull();
    expect(updateStatus({ hidden: true })).toBeNull();
  } finally {
    home.owner.dispose();
    other.owner.dispose();
  }
});
