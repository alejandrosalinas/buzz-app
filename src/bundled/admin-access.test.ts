import { expect, it, vi } from "vitest";
import type {
  CommunityReader,
  ClientSnapshot,
} from "../features/communities/service";
import type { RelayData, RelaySnapshot } from "../features/relay/service";
import type {
  RelayStaffBackend,
  ProbeDto,
  StaffOutcome,
} from "../features/relay-staff/contract";
import { createAdminAccess } from "./admin-access";

const viewer = "a".repeat(64);
const authority = "f".repeat(64);
const origin = "https://primary.example";
const probe: ProbeDto = {
  status: "ok",
  authMode: "nip98",
  role: "moderator",
  source: "db",
  canAct: true,
  canStaff: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(available = true) {
  const roster = (role: string) => [
    {
      id: "e".repeat(64),
      pubkey: authority,
      kind: 13534,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["member", viewer, role]],
    },
  ];
  const rosterGate = deferred<ReturnType<typeof roster>>();
  const read = vi.fn(() => rosterGate.promise);
  let connection = {
    status: "ready",
    generation: 1,
    scope: `${origin}:${viewer}`,
    viewer,
    session: { relayAuthor: authority, read, subscribeLive: () => () => {} },
  } as unknown as RelaySnapshot;
  let client = { status: "ready", selected: origin, viewer } as ClientSnapshot;
  const relayListeners = new Set<() => void>();
  const clientListeners = new Set<() => void>();
  const relay = {
    snapshot: () => connection,
    subscribe: (f: () => void) => {
      relayListeners.add(f);
      return () => relayListeners.delete(f);
    },
    retry: vi.fn(),
    tryAgain: vi.fn(),
  } as unknown as RelayData;
  const reader: CommunityReader = {
    snapshot: () => client,
    subscribe: (f) => {
      clientListeners.add(f);
      return () => clientListeners.delete(f);
    },
  };
  const probeGate = deferred<StaffOutcome<unknown>>();
  const request = vi.fn(() => probeGate.promise);
  const discover = vi.fn(async () => "https://admin.example");
  const access = createAdminAccess(relay, reader, {
    available,
    discover,
    request,
  } as unknown as RelayStaffBackend);
  return {
    access,
    read,
    request,
    discover,
    roster,
    rosterGate,
    probeGate,
    relay,
    switchClient(next: Partial<ClientSnapshot>) {
      client = { ...client, ...next };
      for (const f of clientListeners) f();
    },
    switchRelay(next: Partial<RelaySnapshot>) {
      connection = { ...connection, ...next } as RelaySnapshot;
      for (const f of relayListeners) f();
    },
  };
}

it("checks disabled plugins and shares one check with active navigation", async () => {
  const f = setup();
  const release = f.access.ensure();
  const navRelease = f.access.membership.ensure();
  const staffRelease = f.access.staff.ensure();
  expect(f.access.status("buzz.moderation")).toBe("checking");
  expect(f.access.status("buzz.relay-staff")).toBe("checking");
  f.rosterGate.resolve(f.roster("admin"));
  f.probeGate.resolve({ ok: true, value: probe });
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("allowed"),
  );
  await vi.waitFor(() =>
    expect(f.access.status("buzz.relay-staff")).toBe("allowed"),
  );
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
  navRelease();
  staffRelease(); // Disabling contributions cannot destroy catalog access.
  expect(f.access.status("buzz.moderation")).toBe("allowed");
  expect(f.access.status("buzz.relay-staff")).toBe("allowed");
  release();
  f.access.dispose();
});

it("keeps roster failures distinct from denial and recovers on retry", async () => {
  const f = setup();
  const release = f.access.ensure();
  f.rosterGate.reject(new Error("offline"));
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("error"),
  );
  const retry = deferred<ReturnType<typeof f.roster>>();
  f.read.mockReturnValueOnce(retry.promise);
  f.access.retry("buzz.moderation");
  expect(f.access.status("buzz.moderation")).toBe("checking");
  retry.resolve(f.roster("member"));
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("denied"),
  );
  release();
  f.access.dispose();
});

it("drops old roster answers on community/identity changes and blocks the handoff gap", async () => {
  const f = setup();
  const release = f.access.ensure();
  f.rosterGate.resolve(f.roster("owner"));
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("allowed"),
  );
  f.switchClient({ selected: "https://other.example", viewer: "b".repeat(64) });
  expect(f.access.status("buzz.moderation")).toBe("checking");
  const next = deferred<ReturnType<typeof f.roster>>();
  f.read.mockReturnValueOnce(next.promise);
  f.switchRelay({
    generation: 2,
    scope: `https://other.example:${"b".repeat(64)}`,
    viewer: "b".repeat(64),
  });
  expect(f.access.status("buzz.moderation")).toBe("checking");
  next.resolve(f.roster("owner")); // Old viewer is owner; new viewer is not.
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("denied"),
  );
  f.switchClient({ selected: null });
  expect(f.access.status("buzz.moderation")).toBe("no-community");
  expect(f.access.status("buzz.relay-staff")).toBe("no-community");
  release();
  f.access.dispose();
});

it("rechecks remembered staff access without enabling while the probe is held", async () => {
  const f = setup();
  let release = f.access.ensure();
  f.probeGate.resolve({ ok: true, value: probe });
  await vi.waitFor(() =>
    expect(f.access.status("buzz.relay-staff")).toBe("allowed"),
  );
  release();
  const next = deferred<{ ok: true; value: ProbeDto }>();
  f.request.mockReturnValueOnce(next.promise);
  release = f.access.ensure();
  expect(f.access.status("buzz.relay-staff")).toBe("checking");
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.access.status("buzz.relay-staff")).toBe("checking");
  next.resolve({ ok: true, value: probe });
  await vi.waitFor(() =>
    expect(f.access.status("buzz.relay-staff")).toBe("allowed"),
  );
  release();
  f.access.dispose();
});

it("does not publish or probe after disposal during discovery", async () => {
  const f = setup();
  const discovery = deferred<string>();
  f.discover.mockReturnValueOnce(discovery.promise);
  const listener = vi.fn();
  f.access.subscribe(listener);
  f.access.ensure();
  f.access.dispose();
  const calls = listener.mock.calls.length;
  discovery.resolve("https://admin.example");
  f.rosterGate.resolve(f.roster("owner"));
  await discovery.promise;
  await f.rosterGate.promise;
  await Promise.resolve();
  expect(f.request).not.toHaveBeenCalled();
  expect(listener).toHaveBeenCalledTimes(calls);
});

it("distinguishes missing native support from a staff permission denial", () => {
  const f = setup(false);
  const release = f.access.ensure();
  expect(f.access.status("buzz.relay-staff")).toBe("unavailable");
  expect(f.request).not.toHaveBeenCalled();
  release();
  f.access.dispose();
});

it("recovers a failed staff discovery through the same shared owner", async () => {
  const f = setup();
  f.discover.mockRejectedValueOnce(new Error("offline"));
  const release = f.access.ensure();
  await vi.waitFor(() =>
    expect(f.access.status("buzz.relay-staff")).toBe("error"),
  );
  f.access.retry("buzz.relay-staff");
  expect(f.access.status("buzz.relay-staff")).toBe("checking");
  f.probeGate.resolve({ ok: true, value: probe });
  await vi.waitFor(() =>
    expect(f.access.status("buzz.relay-staff")).toBe("allowed"),
  );
  release();
  f.access.dispose();
});

it("ignores a roster response from the community that was left", async () => {
  const f = setup();
  const release = f.access.ensure();
  const next = deferred<ReturnType<typeof f.roster>>();
  f.read.mockReturnValueOnce(next.promise);
  f.switchClient({ selected: "https://other.example" });
  f.switchRelay({ generation: 2, scope: `https://other.example:${viewer}` });
  next.resolve(f.roster("member"));
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("denied"),
  );
  f.rosterGate.resolve(f.roster("owner"));
  await f.rosterGate.promise;
  await Promise.resolve();
  expect(f.access.status("buzz.moderation")).toBe("denied");
  release();
  f.access.dispose();
});

it.each([
  [403, "rejected", "denied"],
  [403, "intercepted", "error"],
  [404, "rejected", "unavailable"],
] as const)(
  "maps staff response %s/%s to %s",
  async (status, category, expected) => {
    const f = setup();
    const release = f.access.ensure();
    f.probeGate.resolve({
      ok: false,
      failure: {
        status,
        category,
        bodyComplete: true,
        bodyEmpty: true,
        authLost: status === 403,
        notSent: false,
        code: null,
        message: "Failed",
      },
    });
    await vi.waitFor(() =>
      expect(f.access.status("buzz.relay-staff")).toBe(expected),
    );
    release();
    f.access.dispose();
  },
);

it("retries the connection when roster access cannot be read offline", () => {
  const f = setup();
  f.switchRelay({ status: "disconnected" });
  expect(f.access.status("buzz.moderation")).toBe("error");
  f.access.retry("buzz.moderation");
  // A person asked: the sign-in server is asked again too.
  expect(f.relay.tryAgain).toHaveBeenCalledTimes(1);
  expect(f.relay.retry).not.toHaveBeenCalled();
  f.access.dispose();
});

it("treats an unpublished member list as unavailable rather than a retryable failure", async () => {
  const f = setup();
  const release = f.access.ensure();
  f.rosterGate.resolve([]);
  await vi.waitFor(() =>
    expect(f.access.status("buzz.moderation")).toBe("unavailable"),
  );
  expect(f.access.membership.snapshot().error).toBeFalsy();
  release();
  f.access.dispose();
});
