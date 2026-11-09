import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function platform(): BrowserPlatform {
  return {
    available: true,
    attach: vi.fn(),
    setBounds: vi.fn(),
    setMediaSuspended: vi.fn(async () => {}),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
  };
}

const bounds = { x: 0, y: 0, width: 100, height: 100 };

it("does not attach a queued view that was disposed while waiting", async () => {
  const first = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => first.promise);
  const sessions = new BrowserSessions(browserPlatform);
  const active = sessions.attach("https://one.example", bounds, () => true);
  let queuedCurrent = true;
  const queued = sessions.attach(
    "https://two.example",
    bounds,
    () => queuedCurrent,
  );
  queuedCurrent = false;
  first.resolve("session-1");
  await expect(active).resolves.toBe("session-1");
  await expect(queued).resolves.toBeUndefined();
  expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
});

it("detaches an attach result whose view was disposed in flight", async () => {
  const attached = deferred<string>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockImplementation(() => attached.promise);
  const sessions = new BrowserSessions(browserPlatform);
  let current = true;
  const result = sessions.attach("https://example.com", bounds, () => current);
  await vi.waitFor(() =>
    expect(browserPlatform.attach).toHaveBeenCalledTimes(1),
  );
  current = false;
  attached.resolve("session-1");
  await expect(result).resolves.toBeUndefined();
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
});

it("closes a parked guest whose view was disposed while it resumed", async () => {
  const resumed = deferred<void>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockResolvedValue("a");
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("a", "a");
  vi.mocked(browserPlatform.setMediaSuspended).mockImplementationOnce(
    () => resumed.promise,
  );
  let current = true;
  const result = sessions.attach(
    "https://a.example",
    bounds,
    () => current,
    "s",
    "a",
  );
  await vi.waitFor(() =>
    expect(browserPlatform.setMediaSuspended).toHaveBeenLastCalledWith(
      "a",
      false,
    ),
  );
  current = false;
  resumed.resolve();
  await expect(result).resolves.toBeUndefined();
  expect(browserPlatform.detach).toHaveBeenCalledWith("a");
  expect(sessions.owns("a")).toBe(false);
  expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
});

it("opens no fresh guest when a parked one fails to resume after its view left", async () => {
  const resumed = deferred<void>();
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockResolvedValue("a");
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("a", "a");
  vi.mocked(browserPlatform.setMediaSuspended).mockImplementationOnce(() =>
    resumed.promise.then(() => {
      throw new Error("resume failed");
    }),
  );
  let current = true;
  const result = sessions.attach(
    "https://a.example",
    bounds,
    () => current,
    "s",
    "a",
  );
  await vi.waitFor(() =>
    expect(browserPlatform.setMediaSuspended).toHaveBeenLastCalledWith(
      "a",
      false,
    ),
  );
  current = false;
  resumed.resolve();
  await expect(result).resolves.toBeUndefined();
  expect(sessions.owns("a")).toBe(false);
  expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
});

it("closes a parked guest after it waits too long", async () => {
  vi.useFakeTimers();
  try {
    const browserPlatform = platform();
    vi.mocked(browserPlatform.attach).mockResolvedValue("session-1");
    const sessions = new BrowserSessions(browserPlatform);
    await sessions.attach("https://a.example", bounds, () => true, "s", "k");
    await sessions.detach("session-1", "k");
    expect(browserPlatform.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
    expect(sessions.owns("session-1")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("makes room by closing parked guests before hidden ones", async () => {
  const browserPlatform = platform();
  let next = 0;
  vi.mocked(browserPlatform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(browserPlatform);
  for (const key of ["a", "b", "c", "d"])
    await sessions.attach(
      `https://${key}.example`,
      bounds,
      () => true,
      "s",
      key,
    );
  for (const id of ["session-1", "session-2", "session-4"])
    sessions.present(id, true);
  sessions.present("session-1", false);
  await sessions.detach("session-3", "c");
  await sessions.attach("https://e.example", bounds, () => true);
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-3");
  await sessions.attach("https://f.example", bounds, () => true);
  expect(browserPlatform.detach).toHaveBeenLastCalledWith("session-1");
  expect(sessions.owns("session-2")).toBe(true);
});

it("a parked guest is adopted only under its key", async () => {
  const browserPlatform = platform();
  let next = 0;
  vi.mocked(browserPlatform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("session-1", "a");
  await expect(
    sessions.attach("https://b.example", bounds, () => true, "s", "b"),
  ).resolves.toBe("session-2");
  await expect(
    sessions.attach("https://a.example", bounds, () => true, "s", "a"),
  ).resolves.toBe("session-1");
});

it("sign-out closes live and parked account guests even while another attach is pending", async () => {
  const browserPlatform = platform();
  const held = deferred<string>();
  vi.mocked(browserPlatform.attach)
    .mockResolvedValueOnce("live")
    .mockResolvedValueOnce("parked")
    .mockImplementationOnce(() => held.promise);
  const sessions = new BrowserSessions(browserPlatform);
  const lifetime = new AbortController();
  const viewer = {
    federated: "private",
    storage: "account-one",
    signal: lifetime.signal,
  };
  await sessions.attach(
    "https://a.example",
    bounds,
    () => true,
    viewer.storage,
    "a",
    viewer,
  );
  await sessions.attach(
    "https://b.example",
    bounds,
    () => true,
    viewer.storage,
    "b",
    viewer,
  );
  await sessions.detach("parked", "b");
  const pending = sessions.attach(
    "https://c.example",
    bounds,
    () => true,
    viewer.storage,
    "c",
    viewer,
  );
  await vi.waitFor(() =>
    expect(browserPlatform.attach).toHaveBeenCalledTimes(3),
  );
  lifetime.abort();
  expect(browserPlatform.detach).toHaveBeenCalledWith("live");
  expect(browserPlatform.detach).toHaveBeenCalledWith("parked");
  expect(sessions.owns("live")).toBe(false);
  expect(sessions.owns("parked")).toBe(false);
  held.resolve("pending");
  await expect(pending).resolves.toBeUndefined();
  expect(browserPlatform.detach).toHaveBeenCalledWith("pending");
  const other = new AbortController();
  vi.mocked(browserPlatform.attach).mockResolvedValueOnce("other-account");
  await sessions.attach(
    "https://b.example",
    bounds,
    () => true,
    "account-two",
    "b",
    {
      federated: "other",
      storage: "account-two",
      signal: other.signal,
    },
  );
  expect(sessions.owns("other-account")).toBe(true);
  expect(browserPlatform.attach).toHaveBeenCalledTimes(4);
  other.abort();
});

it.each([undefined, "a"])(
  "hides a closing guest before another authenticated attach finishes (park %s)",
  async (park) => {
    const browserPlatform = platform();
    const held = deferred<string>();
    vi.mocked(browserPlatform.attach)
      .mockResolvedValueOnce("a")
      .mockImplementationOnce(() => held.promise);
    const sessions = new BrowserSessions(browserPlatform);
    await sessions.attach("https://a.example", bounds, () => true);
    sessions.present("a", true);
    const lifetime = new AbortController();
    const pending = sessions.attach(
      "https://b.example",
      bounds,
      () => true,
      "account",
      "b",
      {
        federated: "private",
        storage: "account",
        signal: lifetime.signal,
      },
    );
    await vi.waitFor(() =>
      expect(browserPlatform.attach).toHaveBeenCalledTimes(2),
    );
    const detached = sessions.detach("a", park);
    try {
      expect(browserPlatform.setBounds).toHaveBeenCalledWith(
        "a",
        expect.anything(),
        false,
      );
      expect(browserPlatform.setMediaSuspended).toHaveBeenCalledWith("a", true);
      expect(browserPlatform.attach).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve("b");
      await pending;
      await detached;
      await sessions.detach("a");
      lifetime.abort();
    }
  },
);

it.each([undefined, "a"])(
  "closes a guest whose hide failed (park %j) and reports the hide error",
  async (park) => {
    const browserPlatform = platform();
    const failure = new Error("hide failed");
    vi.mocked(browserPlatform.attach).mockResolvedValue("a");
    vi.mocked(browserPlatform.setBounds).mockRejectedValueOnce(failure);
    const sessions = new BrowserSessions(browserPlatform);
    await sessions.attach("https://a.example", bounds, () => true, "s", "a");
    await expect(sessions.detach("a", park)).rejects.toBe(failure);
    expect(browserPlatform.detach).toHaveBeenCalledWith("a");
    expect(sessions.owns("a")).toBe(false);
    await expect(
      sessions.attach("https://a.example", bounds, () => true, "s", "a"),
    ).resolves.toBe("a");
    expect(browserPlatform.attach).toHaveBeenCalledTimes(2);
  },
);

it("keeps a parked guest's media suspended until a view adopts it", async () => {
  const browserPlatform = platform();
  vi.mocked(browserPlatform.attach).mockResolvedValue("a");
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("a", "a");
  expect(sessions.owns("a")).toBe(true);
  expect(vi.mocked(browserPlatform.setMediaSuspended).mock.calls).toEqual([
    ["a", true],
  ]);
  await expect(
    sessions.attach("https://a.example", bounds, () => true, "s", "a"),
  ).resolves.toBe("a");
  expect(vi.mocked(browserPlatform.setMediaSuspended).mock.calls).toEqual([
    ["a", true],
    ["a", false],
  ]);
});

it.each([undefined, "a"])(
  "closes a guest that could not be silenced (park %j)",
  async (park) => {
    const browserPlatform = platform();
    const failure = new Error("suspend failed");
    vi.mocked(browserPlatform.attach).mockResolvedValue("a");
    vi.mocked(browserPlatform.setMediaSuspended).mockRejectedValueOnce(failure);
    const sessions = new BrowserSessions(browserPlatform);
    await sessions.attach("https://a.example", bounds, () => true, "s", "a");
    await expect(sessions.detach("a", park)).rejects.toBe(failure);
    expect(browserPlatform.detach).toHaveBeenCalledWith("a");
    expect(sessions.owns("a")).toBe(false);
  },
);

it("opens a fresh guest when a parked one cannot play again", async () => {
  const browserPlatform = platform();
  let next = 0;
  vi.mocked(browserPlatform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  await sessions.detach("session-1", "a");
  vi.mocked(browserPlatform.setMediaSuspended).mockRejectedValueOnce(
    new Error("resume failed"),
  );
  await expect(
    sessions.attach("https://a.example", bounds, () => true, "s", "a"),
  ).resolves.toBe("session-2");
  expect(browserPlatform.detach).toHaveBeenCalledWith("session-1");
  expect(sessions.owns("session-1")).toBe(false);
});

it("does not re-adopt a parked guest before its previous hide completes", async () => {
  const browserPlatform = platform();
  const hidden = deferred<void>();
  vi.mocked(browserPlatform.attach).mockResolvedValue("a");
  vi.mocked(browserPlatform.setBounds).mockImplementationOnce(
    () => hidden.promise,
  );
  const sessions = new BrowserSessions(browserPlatform);
  await sessions.attach("https://a.example", bounds, () => true, "s", "a");
  const detached = sessions.detach("a", "a");
  let adopted = false;
  const reopened = sessions
    .attach("https://a.example", bounds, () => true, "s", "a")
    .then((id) => {
      adopted = true;
      return id;
    });
  try {
    // Submitted Promise jobs have run; the explicit native-hide gate remains held.
    await nextTurn();
    expect(adopted).toBe(false);
    expect(browserPlatform.attach).toHaveBeenCalledTimes(1);
  } finally {
    hidden.resolve();
    await detached;
    await expect(reopened).resolves.toBe("a");
    await sessions.detach("a");
  }
});
