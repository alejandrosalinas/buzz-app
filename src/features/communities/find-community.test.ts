import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import {
  FindCommunityError,
  findCommunity,
  nativeRelayFetch,
  type RelayFetch,
} from "./find-community";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const url = "https://relay.example.com:8443";
const self = "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01";
const buzz = {
  name: "Buzz Relay",
  software: "https://github.com/block/buzz",
  version: "1.4.2",
  icon: "https://cdn.example.com/icon.png",
  self,
  read_state_snapshot: { community_id: "c1" },
};
const policy = {
  version: "v1",
  terms_markdown: "# Terms",
  privacy_markdown: null,
  age_attestation_required: true,
};
type Answer = Response | Error;
const html = (status = 200) =>
  new Response("<html><body>Hi</body></html>", { status });
function fetcher(answers: Record<string, Answer>) {
  return vi.fn<RelayFetch>((_origin, path) => {
    const answer = answers[path];
    if (!answer) throw new Error(`Unexpected path ${path}`);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}
const find = (answers: Record<string, Answer>) =>
  findCommunity(url, fetcher(answers), new AbortController().signal);
const failure = (answers: Record<string, Answer>) =>
  find(answers).then(
    () => "found",
    (error: unknown) =>
      error instanceof FindCommunityError ? error.failure : error,
  );

it("reports only what the relay publishes, with the icon sanitized, from two unauthenticated reads", async () => {
  const request = fetcher({
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({ policy }),
  });
  await expect(
    findCommunity(url, request, new AbortController().signal),
  ).resolves.toEqual({
    url,
    host: "relay.example.com:8443",
    name: "Buzz Relay",
    icon: "https://cdn.example.com/icon.png",
    self,
    policy: {
      version: "v1",
      terms_markdown: "# Terms",
      privacy_markdown: undefined,
      age_attestation_required: true,
    },
  });
  // Nothing is signed before the user chooses to join: GETs only, no body.
  expect(request.mock.calls).toEqual([
    [url, "/", expect.any(AbortSignal)],
    [url, "/api/join-policy", expect.any(AbortSignal)],
  ]);
  await expect(
    find({
      "/": Response.json({
        software: "https://github.com/block/buzz",
        buzz_v1: {},
        icon: "javascript:alert(1)",
        version: 3,
      }),
      "/api/join-policy": Response.json({}),
    }),
  ).resolves.toEqual({
    url,
    host: "relay.example.com:8443",
    icon: undefined,
    self: undefined,
    policy: null,
  });
});

it.each([self.toUpperCase(), self.slice(1), 42, null])(
  "keeps only a well-formed relay key, dropping self %j",
  async (value) => {
    await expect(
      find({
        "/": Response.json({ ...buzz, self: value }),
        "/api/join-policy": html(404),
      }),
    ).resolves.toMatchObject({ self: undefined });
  },
);

it.each([
  ["a network failure", { "/": new TypeError("fetch failed") }, "unreachable"],
  ["a relay 5xx", { "/": html(503) }, "unreachable"],
  ["an HTML page", { "/": html() }, "not-buzz"],
  ["a 404", { "/": html(404) }, "not-buzz"],
  ["a JSON array", { "/": Response.json([]) }, "not-buzz"],
  [
    "another relay implementation",
    { "/": Response.json({ name: "strfry", software: "git+https://x" }) },
    "not-buzz",
  ],
  [
    "a Buzz relay with no community bound to this host",
    {
      "/": new Response("relay: no community is configured for this host", {
        status: 404,
      }),
    },
    "no-community",
  ],
] as const)(
  "classifies NIP-11 answered by %s",
  async (_label, answers, failure_) => {
    await expect(
      failure({ "/api/join-policy": html(404), ...answers }),
    ).resolves.toBe(failure_);
  },
);

it("finds a released relay that does not advertise host-bound fields", async () => {
  // relay-v0.2.1 (the Helm chart's image) serves NIP-11 without
  // read_state_snapshot or buzz_v1, and without icon until one is set.
  await expect(
    find({
      "/": Response.json({
        name: "Buzz Relay",
        software: "https://github.com/block/buzz",
        version: "0.2.1",
        self,
      }),
      "/api/join-policy": Response.json({}),
    }),
  ).resolves.toMatchObject({ host: "relay.example.com:8443", policy: null });
});

it.each([
  ["404", html(404), null],
  ["{}", Response.json({}), null],
  ["{policy:null}", Response.json({ policy: null }), null],
  ["a network failure", new TypeError("fetch failed"), "unreachable"],
  ["a 5xx", html(500), "unreachable"],
  ["a redirect", new Response(null, { status: 302 }), "unreachable"],
  ["HTML", html(), "unreachable"],
  [
    "a malformed policy",
    Response.json({ policy: { version: 1 } }),
    "unreachable",
  ],
  ["a JSON array", Response.json([]), "unreachable"],
])(
  "treats a join policy answered by %s as %j once NIP-11 is a Buzz relay",
  async (_label, answer, expected) => {
    const result = await failure({
      "/": Response.json(buzz),
      "/api/join-policy": answer,
    }).then((value) => (value === "found" ? null : value));
    expect(result).toBe(expected);
  },
);

it("reads both documents at once and lets the NIP-11 verdict win", async () => {
  const paths: string[] = [];
  const release: Array<() => void> = [];
  const request: RelayFetch = (_origin, path) => {
    paths.push(path);
    return new Promise<Response>((resolve) =>
      release.push(() =>
        resolve(path === "/" ? html() : Response.json({ policy })),
      ),
    );
  };
  const found = findCommunity(url, request, new AbortController().signal);
  await vi.waitFor(() => expect(paths).toEqual(["/", "/api/join-policy"]));
  for (const resolve of release) resolve();
  await expect(found).rejects.toMatchObject({ failure: "not-buzz" });
});

it("passes the caller's abort through instead of calling it unreachable", async () => {
  const controller = new AbortController();
  const request: RelayFetch = (_origin, _path, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  const found = findCommunity(url, request, controller.signal);
  controller.abort(new Error("left the page"));
  await expect(found).rejects.toThrow("left the page");
});

it("finds a relay that answers after 12 s, within the native limit", async () => {
  vi.useFakeTimers();
  // Node's native AbortSignal timer is not driven by Vitest's clock.
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
  const answers: Record<string, unknown> = {
    "/": buzz,
    "/api/join-policy": { policy },
  };
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    expect(command).toBe("relay_http");
    await answered;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers[(args as { path: string }).path]),
    };
  });
  let settled = false;
  const found = findCommunity(
    url,
    nativeRelayFetch,
    new AbortController().signal,
  ).finally(() => (settled = true));
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    release();
    await expect(found).resolves.toMatchObject({ self, policy: {} });
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
