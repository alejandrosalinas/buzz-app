import { expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { createCommunityMembership, canManageMembership } from "./membership";

const relayKey = "f".repeat(64);
const viewer = "a".repeat(64);
const roster = (role: "owner" | "admin" | "member") => ({
  id: role.padEnd(64, "0"),
  kind: 13534,
  pubkey: relayKey,
  created_at: 1,
  content: "",
  sig: "",
  tags: [["member", viewer, role]],
});

function setup(role: "owner" | "admin" | "member") {
  const listeners = new Set<() => void>();
  let currentRole = role;
  const read = vi.fn(async () => [roster(currentRole)]);
  const live = new Set<
    (batch: { events: ReturnType<typeof roster>[] }) => void
  >();
  const replay = new Set<
    (batch: { events: ReturnType<typeof roster>[] }) => void
  >();
  const ensureProfiles = vi.fn(async () => {});
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session: {
      relayAuthor: relayKey,
      read,
      subscribeLive(
        listener: (batch: { events: ReturnType<typeof roster>[] }) => void,
        options?: { replay?: boolean },
      ) {
        live.add(listener);
        if (options?.replay) replay.add(listener);
        return () => {
          live.delete(listener);
          replay.delete(listener);
        };
      },
      profiles: { ensure: ensureProfiles },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ relayAuthor: relayKey })),
  );
  const membership = createCommunityMembership({
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData);
  return {
    membership,
    live,
    replay,
    read,
    ensureProfiles,
    role(next: "owner" | "admin" | "member") {
      currentRole = next;
    },
  };
}

for (const [role, allowed] of [
  ["owner", true],
  ["admin", true],
  ["member", false],
] as const)
  it(`projects ${role} navigation authorization from the verified roster`, async () => {
    const { membership, read, ensureProfiles } = setup(role);
    const changed = new Promise<void>((resolve) => {
      const stop = membership.subscribe(() => {
        if (membership.snapshot().status === "ready") {
          stop();
          resolve();
        }
      });
    });
    const release = membership.ensure();
    await changed;
    release();
    expect(canManageMembership(membership.snapshot())).toBe(allowed);
    expect(ensureProfiles).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(
      [{ kinds: [13534], authors: [relayKey], limit: 1 }],
      expect.objectContaining({ fresh: true }),
    );
    membership.dispose();
    vi.unstubAllGlobals();
  });

it("refreshes verified authorization after demand is released and reacquired", async () => {
  const { membership, read, role } = setup("member");
  const ready = () =>
    new Promise<void>((resolve) => {
      const stop = membership.subscribe(() => {
        if (!membership.snapshot().refreshing) {
          stop();
          resolve();
        }
      });
    });

  let changed = ready();
  const firstRelease = membership.ensure();
  await changed;
  expect(canManageMembership(membership.snapshot())).toBe(false);
  firstRelease();

  role("admin");
  changed = ready();
  const secondRelease = membership.ensure();
  await changed;
  expect(canManageMembership(membership.snapshot())).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  secondRelease();
  membership.dispose();
});

it("restores the live listener when reacquired during the initial read", async () => {
  const { membership, live } = setup("member");
  const release = membership.ensure();
  release();
  const releaseAgain = membership.ensure();
  expect(live.size).toBe(1);
  await vi.waitFor(() => expect(membership.snapshot().status).toBe("ready"));
  releaseAgain();
  expect(live.size).toBe(0);
  membership.dispose();
});

it("refreshes on authoritative live roster changes and releases the listener", async () => {
  const { membership, live, role, read } = setup("member");
  const release = membership.ensure();
  await vi.waitFor(() => expect(membership.snapshot().refreshing).toBe(false));
  role("admin");
  for (const listener of live)
    listener({ events: [{ ...roster("admin"), pubkey: viewer }] });
  expect(read).toHaveBeenCalledTimes(1);
  for (const listener of live) listener({ events: [roster("admin")] });
  await vi.waitFor(() => expect(membership.snapshot().role).toBe("admin"));
  expect(read).toHaveBeenCalledTimes(2);
  release();
  expect(live.size).toBe(0);
  membership.dispose();
});

it("refreshes membership changes replayed after reconnect", async () => {
  const { membership, replay, role, read } = setup("member");
  const release = membership.ensure();
  await vi.waitFor(() => expect(membership.snapshot().status).toBe("ready"));
  role("admin");
  for (const listener of replay) listener({ events: [roster("admin")] });
  await vi.waitFor(() => expect(membership.snapshot().role).toBe("admin"));
  expect(read).toHaveBeenCalledTimes(2);
  release();
  expect(replay.size).toBe(0);
  membership.dispose();
});
