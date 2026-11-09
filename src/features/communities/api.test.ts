import { afterEach, expect, it, vi } from "vitest";
import { communityRequest } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("registers an unvisited destination before its scoped read, without a session", async () => {
  let release!: () => void;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/relay/register") {
      expect(JSON.parse(init?.body as string)).toEqual({
        url: "https://unvisited.example",
      });
      await registered;
      return Response.json({});
    }
    expect(url).toBe(
      "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
    );
    expect(init?.body).toBe("{}");
    return Response.json({ identities: ["ab".repeat(32)] });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = communityRequest(
    "https://unvisited.example",
    "agent-inventory",
    {},
  );
  try {
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await expect(result).resolves.toEqual({ identities: ["ab".repeat(32)] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(
    fetcher.mock.calls[1]?.[1]?.signal,
  );
});

it("does not read after registration failure and registers again on retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Destination rejected" }, { status: 400 }),
    )
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ identities: [] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).rejects.toThrow("Destination rejected");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).resolves.toEqual({ identities: [] });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/relay/register",
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
  ]);
});

it("does not read when cancelled during registration", async () => {
  const cancel = new AbortController();
  const fetcher = vi.fn(async () => {
    cancel.abort();
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest(
      "https://unvisited.example",
      "agent-inventory",
      {},
      cancel.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([408, 429, 500, 502, 503])(
  "preserves retryable HTTP %s and its broker message",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/register")
          ? Response.json({})
          : Response.json({ error: "Relay unavailable" }, { status }),
      ),
    );
    await expect(
      communityRequest("https://unvisited.example", "info"),
    ).rejects.toMatchObject({
      name: "ReadError",
      kind: "unavailable",
      status,
      message: "Relay unavailable",
    });
  },
);
