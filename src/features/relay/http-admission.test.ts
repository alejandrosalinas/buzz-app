import { afterEach, expect, it, vi } from "vitest";
import {
  apiFailure,
  admittedApiRequest,
  ApiPaused,
  createApiAdmission,
  readApiFailure,
  refusalOfError,
} from "./http-admission";

afterEach(() => vi.useRealTimers());
it("starts six requests without advancing time and refills by foreground priority on completion", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const calls: string[] = [];
  const release: Array<() => void> = [];
  const work = (name: string) => () => {
    calls.push(name);
    return new Promise<void>((resolve) => release.push(resolve));
  };
  const active = Array.from({ length: 6 }, (_, i) => lane.run(work(`${i}`)));
  expect(calls).toEqual(["0", "1", "2", "3", "4", "5"]);
  const background = lane.run(work("background"), undefined, "background");
  const foreground = lane.run(work("foreground"));
  expect(calls).toHaveLength(6);
  release.shift()?.();
  await active[0];
  await Promise.resolve();
  expect(calls.at(-1)).toBe("foreground");
  release.shift()?.();
  await active[1];
  await Promise.resolve();
  expect(calls.at(-1)).toBe("background");
  for (const finish of release) finish();
  await Promise.all([...active, background, foreground]);
  await lane.run(async () => calls.push("after idle"));
  expect(calls.at(-1)).toBe("after idle");
  expect(performance.now()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("pauses queued consumers, cancels before dispatch, and never retries admitted work", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = vi.fn(() => held);
  const active = Array.from({ length: 6 }, () => lane.run(work));
  const controller = new AbortController();
  const cancelled = expect(
    lane.run(work, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await cancelled;
  const refused = expect(lane.run(work)).rejects.toBeInstanceOf(ApiPaused);
  lane.pause(3000);
  await refused;
  await expect(lane.run(work)).rejects.toBeInstanceOf(ApiPaused);
  release();
  await Promise.all(active);
  await vi.advanceTimersByTimeAsync(2999);
  await expect(lane.run(work)).rejects.toBeInstanceOf(ApiPaused);
  await vi.advanceTimersByTimeAsync(1);
  await lane.run(async () => {});
  expect(work).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});
it("normalizes only upstream quota hints and bounds streaming error bodies", async () => {
  expect(
    apiFailure(429, { error: "rate-limited: quota exceeded; retry in 2s" }),
  ).toMatchObject({ quota: "api", retryAfterMs: 3000 });
  for (const value of [
    "Query concurrency limit",
    "Live stream capacity reached",
    "unexpected",
  ])
    expect(apiFailure(429, { error: value }).quota).toBeUndefined();
  expect(
    apiFailure(503, { error: "rate-limited: quota exceeded; retry in 2s" })
      .quota,
  ).toBeUndefined();
  const failure = await readApiFailure(
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 0s" },
      { status: 429 },
    ),
  );
  expect(failure.retryAfterMs).toBe(1000);
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(4097));
    },
    cancel,
  });
  expect(
    (await readApiFailure(new Response(body, { status: 429 }))).quota,
  ).toBeUndefined();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("the fetch boundary preserves normalized quota hints and blocks later work without resending", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  const upstream = vi.fn(async () =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 2s" },
      { status: 429 },
    ),
  );
  const response = await admittedApiRequest(lane, upstream);
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    quota: "api",
    retryAfterMs: 3000,
  });
  await expect(admittedApiRequest(lane, upstream)).rejects.toBeInstanceOf(
    ApiPaused,
  );
  expect(upstream).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3000);
  const result = await admittedApiRequest(lane, async () => new Response("[]"));
  expect(result.ok).toBe(true);
});

it.each([
  ["rate-limited: quota exceeded", 61000],
  ["rate-limited: quota exceeded; retry in invalid", 61000],
  ["rate-limited: quota exceeded; retry in 61s", 62000],
  ["rate-limited: quota exceeded; retry in 9007199254740992s", 86401000],
])(
  "known quota with unsupported/long hint cannot drain the queue: %s",
  async (error, retryAfterMs) => {
    vi.useFakeTimers();
    const lane = createApiAdmission();
    const fetcher = vi.fn(async () =>
      Response.json({ error }, { status: 429 }),
    );
    const response = await admittedApiRequest(lane, fetcher);
    expect(await response.json()).toMatchObject({ quota: "api", retryAfterMs });
    await expect(admittedApiRequest(lane, fetcher)).rejects.toBeInstanceOf(
      ApiPaused,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("a partial quota body retains its host owner until normalization installs cooldown", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const response = admittedApiRequest(
    lane,
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            body = c;
          },
        }),
        { status: 429 },
      ),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(lane.idle()).toBe(false);
  body.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ error: "rate-limited: quota exceeded; retry in 2s" }),
    ),
  );
  body.close();
  await response;
  expect(lane.idle()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(lane.idle()).toBe(true);
});

it("presence starts alongside held ordinary work but retains its own flight, pacing and shared cooldown", async () => {
  vi.useFakeTimers();
  const lane = createApiAdmission();
  let finish!: () => void;
  const ordinary = lane.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    undefined,
    "background",
  );
  const release = lane.tryPresence();
  expect(release).toBeTypeOf("function");
  expect(lane.tryPresence()).toBeUndefined();
  release?.();
  expect(lane.tryPresence()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(4999);
  expect(lane.tryPresence()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  const next = lane.tryPresence();
  expect(next).toBeTypeOf("function");
  next?.();
  lane.pause(6000);
  expect(lane.tryPresence()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5999);
  expect(lane.tryPresence()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  const resumed = lane.tryPresence();
  expect(resumed).toBeTypeOf("function");
  resumed?.();
  finish();
  await ordinary;
});
it.each([
  [403, { error: "restricted: not a member" }, true],
  [401, { error: "auth-required" }, true],
  [403, undefined, undefined],
  [403, { message: "Forbidden" }, undefined],
  [500, { error: "boom" }, undefined],
])("marks only relay-shaped %i refusals as denied", (status, body, denied) => {
  expect(apiFailure(status, body).denied).toBe(denied);
});
it("reads an edge 403 page as unavailable, not as the relay's denial", async () => {
  const page = new Response("<html><body>Forbidden</body></html>", {
    status: 403,
    headers: { "Content-Type": "text/html" },
  });
  await expect(readApiFailure(page)).resolves.toEqual({
    error: "Relay request failed (403)",
  });
});
it.each([
  [401, "authentication required\n", "sign-in"],
  [403, "evidence rejected\n", "sign-in"],
  [403, "authorization denied\n", "access"],
])(
  "reads the relay's exact %i %j as a community refusal",
  async (status, body, admission) => {
    const failure = await readApiFailure(
      new Response(body, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    expect(failure).toMatchObject({ denied: true, admission });
    // The broker forwards it as JSON; reading that again keeps the refusal.
    expect(apiFailure(status, failure)).toEqual(failure);
  },
);
it.each([
  // An outage, not a refusal: NIP-FI's, and the media route's own.
  [503, "authorization unavailable\n"],
  [503, JSON.stringify({ error: "media service temporarily unavailable" })],
  // A known body under the wrong status, or not exactly the relay's bytes.
  [403, "authentication required\n"],
  [403, "authorization denied"],
  [403, "Authorization denied\n"],
])("leaves %i %j to the feature that asked", async (status, body) => {
  const failure = await readApiFailure(new Response(body, { status }));
  expect(failure.admission).toBeUndefined();
  expect(failure.denied).toBeUndefined();
});
it.each([
  [
    {
      error: "relay_membership_required",
      message: "You must be a relay member to access this relay",
    },
    "restricted: not a relay member",
  ],
  [
    { error: "blocked: you are banned from this community" },
    "blocked: you are banned from this community",
  ],
  // Media routes refuse a non-member or a banned key with their own spelling.
  [{ error: "relay membership required" }, "restricted: not a relay member"],
])(
  "reads a community's membership refusal %j as a community refusal",
  async (body, error) => {
    const failure = await readApiFailure(Response.json(body, { status: 403 }));
    expect(failure).toEqual({ error, denied: true, admission: "access" });
    // The broker forwards it as JSON; reading that again keeps the refusal.
    expect(apiFailure(403, failure)).toEqual(failure);
    // A refusal met while connecting keeps its reason.
    expect(refusalOfError(new Error(failure.error))).toBe("access");
    // Under another status it isn't the relay's front door.
    expect(apiFailure(401, body).admission).toBeUndefined();
  },
);
it("keeps one item's JSON refusal with its feature", async () => {
  const failure = await readApiFailure(
    Response.json({ error: "restricted: p-gated" }, { status: 403 }),
  );
  expect(failure).toMatchObject({ denied: true });
  expect(failure.admission).toBeUndefined();
  // Claimed admission without the relay's own reason is not one either.
  expect(
    apiFailure(403, { error: "restricted: p-gated", admission: "access" })
      .admission,
  ).toBeUndefined();
});
it("keeps the relay's status and its classified reason through the lane", async () => {
  const response = await admittedApiRequest(
    createApiAdmission(),
    async () => new Response("authorization denied\n", { status: 403 }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: "restricted: authorization denied",
    admission: "access",
  });
});
