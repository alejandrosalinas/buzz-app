import { expect, it } from "vitest";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import { createSoloWorkspaces } from "./solo-workspaces";

it("projects the existing Solo catalog and writer, preserving uncertainty and fencing ended bindings", async () => {
  const binding = { scope: "community", viewer: "owner", incarnation: "first" };
  let sections = [{ id: "existing", name: "Existing", order: 0 }];
  let connected = true;
  let uncertain = true;
  const connectionListeners = new Set<() => void>();
  const store = createSidebarPreferencesStore({
    available: true,
    groupsOnly: true,
    read: async () => ({
      sections,
      assignments: { privateChat: "existing" },
      starred: [],
      muted: [],
    }),
    write: async () => {
      throw new Error("No assignment writes");
    },
    createSection: async ({ id, name }) => {
      if (!sections.some((section) => section.id === id))
        sections = [...sections, { id, name, order: sections.length }];
      if (uncertain) {
        uncertain = false;
        throw new Error("Confirmation lost");
      }
      return { sections, assignments: {}, starred: [], muted: [] };
    },
  });
  const api = createSoloWorkspaces(
    (current) => (connected && current === binding ? store.queries : undefined),
    (listener) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
  );
  let notifications = 0;
  const stop = api.subscribe(binding, () => notifications++);
  try {
    expect(api.snapshot(binding).status).toBe("loading");
    await api.refresh(binding);
    const snapshot = api.snapshot(binding);
    expect(api.snapshot(binding)).toBe(snapshot);
    expect(snapshot).toEqual({
      status: "ready",
      workspaces: [{ id: "existing", name: "Existing" }],
      canCreate: true,
    });
    const creation = { id: "stable", name: "Demo" };
    await expect(api.create(binding, creation)).rejects.toThrow(
      "Confirmation lost",
    );
    // Reconciliation can discover an accepted write; retry retains its identity.
    await api.refresh(binding);
    await api.create(binding, creation);
    expect(api.snapshot(binding).workspaces).toEqual([
      { id: "existing", name: "Existing" },
      { id: "stable", name: "Demo" },
    ]);
    expect(notifications).toBeGreaterThan(0);
    connected = false;
    for (const listener of connectionListeners) listener();
    expect(api.snapshot(binding)).toMatchObject({
      status: "unavailable",
      workspaces: [],
      canCreate: false,
    });
    await expect(api.create(binding, { id: "no", name: "No" })).rejects.toThrow(
      "ended",
    );
    await expect(api.refresh(binding)).rejects.toThrow("ended");
  } finally {
    stop();
    store.dispose();
  }
  expect(connectionListeners.size).toBe(0);
});
