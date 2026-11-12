import { assert, afterEach, expect, it, vi } from "vitest";
import {
  connectBrokerTransport,
  connectSignedTransport,
  acceptPublish,
  acceptReadStatePublish,
} from "./transport";
import {
  ReadStateTimestampRejected,
  READ_STATE_TIMESTAMP_REFUSAL,
} from "./read-state-host";
import { PublishRejected } from "./outbox";
import { hostSigner, keypair, signed } from "./testing";
const key = keypair();
afterEach(() => vi.unstubAllGlobals());
it.each([
  {
    status: 503,
    sent: false,
    error: READ_STATE_TIMESTAMP_REFUSAL,
    expired: true,
  },
  {
    status: 400,
    sent: undefined,
    error: READ_STATE_TIMESTAMP_REFUSAL,
    expired: true,
  },
  {
    status: 503,
    sent: undefined,
    error: READ_STATE_TIMESTAMP_REFUSAL,
    expired: false,
  },
  {
    status: 503,
    sent: false,
    error: "invalid: something else",
    expired: false,
  },
  {
    status: 503,
    sent: false,
    error: `${READ_STATE_TIMESTAMP_REFUSAL}\nprivate`,
    expired: false,
  },
  {
    status: 429,
    sent: false,
    error: "rate-limited: quota exceeded; retry in 17s",
    expired: false,
  },
  {
    status: 401,
    sent: false,
    error: READ_STATE_TIMESTAMP_REFUSAL,
    expired: false,
  },
])(
  "bounds read-state refusal classification: $status $sent $error",
  async ({ status, sent, error, expired }) => {
    const failure = await acceptReadStatePublish(
      Response.json({ sent, error }, { status }),
      "event",
    ).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof ReadStateTimestampRejected).toBe(expired);
  },
);
it("read-state parser preserves bounded socket quota reporting", async () => {
  await expect(
    acceptReadStatePublish(
      Response.json(
        { sent: false, error: "rate-limited: shared admission unavailable" },
        { status: 503 },
      ),
      "event",
    ),
  ).rejects.toThrow("rate-limited: shared admission unavailable");
});
it("publishes the unchanged signed event bytes through the host's /events request", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  // The host mints NIP-98 for these exact bytes at dispatch; see the native
  // `native_http_signs_exact_bytes_and_never_follows_redirects` test.
  const request = vi.fn(async (_url: string, _body: string) =>
    Response.json({ accepted: true, event_id: event.id }),
  );
  const transport = await connectSignedTransport(
    hostSigner(key, request),
    "https://relay.test",
    "relay",
  );
  assert.exists(transport.writer);
  const controller = new AbortController();
  await transport.writer.publish(event, controller.signal);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://relay.test/events",
    JSON.stringify(event),
    controller.signal,
  );
});
it("distinguishes explicit rejection from invalid or missing delivery receipts", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    "relay",
  );
  vi.stubGlobal("fetch", async () =>
    Response.json({ accepted: false, event_id: event.id, message: "denied" }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
  vi.stubGlobal("fetch", async () =>
    Response.json({ accepted: true, event_id: "wrong" }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("invalid delivery receipt");
  vi.stubGlobal(
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  // A broker that never reached the relay is a definite non-delivery, not an unknown outcome.
  vi.stubGlobal("fetch", async () =>
    Response.json({ error: "Relay unreachable", sent: false }, { status: 502 }),
  );
  assert.exists(transport.writer);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishRejected);
});
const refusal = (status: number, body: unknown) =>
  acceptPublish(Response.json(body, { status }), "id").catch(
    (reason: unknown) => reason,
  );
it.each([
  [
    'invalid: an open channel named "Launch" already exists',
    'An open channel named "Launch" already exists',
  ],
  ["blocked:   you are banned", "You are banned"],
  ["restricted: not a channel member", "Not a channel member"],
  ["error: internal failure", "Internal failure"],
  ["pow: difficulty too low", "Difficulty too low"],
  ["duplicate: already accepted", "Already accepted"],
  ["invalid:  ", "Relay rejected the message (400)"],
  // Prefixes writers match on carry meaning: left as sent.
  ["conflict: stale prev", "conflict: stale prev"],
  ["rate-limited: slow down", "rate-limited: slow down"],
  ["auth-required: sign in", "auth-required: sign in"],
])(
  "shows the relay's refusal text without its NIP-01 prefix: %s",
  async (error, message) => {
    const result = await refusal(400, { error });
    expect(result).toBeInstanceOf(PublishRejected);
    expect(result).toMatchObject({ message, reason: error });
  },
);
it.each([
  [400, {}],
  [403, { error: 7 }],
  [422, { error: "" }],
  [404, "not an object"],
  // A gateway or VPN edge can answer these statuses with JSON `{error}`; text
  // without a NIP-01 prefix is not the relay's, so it is never shown.
  [403, { error: "Forbidden by proxy" }],
  [400, { error: "Plain relay text" }],
  [401, { error: "Relay request failed (401)" }],
])(
  "falls back to the status summary when a %s refusal has no relay text: %j",
  async (status, body) => {
    const result = await refusal(status, body);
    expect(result).toBeInstanceOf(PublishRejected);
    expect(result).toHaveProperty(
      "message",
      `Relay rejected the message (${status})`,
    );
  },
);
it("carries the relay's refusal text through both publish transports", async () => {
  const error = 'invalid: an open channel named "Launch" already exists';
  const shown = 'An open channel named "Launch" already exists';
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const publishes = async (
    transport: Awaited<ReturnType<typeof connectSignedTransport>>,
  ) => {
    assert.exists(transport.writer);
    return transport.writer
      .publish(event, new AbortController().signal)
      .catch((reason: unknown) => reason);
  };
  // Admission reduces an upstream body to a status summary unless the
  // publish keeps the relay's refusal.
  const signedTransport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    "relay",
  );
  vi.stubGlobal("fetch", async () => Response.json({ error }, { status: 400 }));
  expect(await publishes(signedTransport)).toMatchObject({
    message: shown,
    reason: error,
  });
  // Without relay text, admission's own summary must not replace the
  // status summary `acceptPublish` shows.
  for (const [status, body] of [
    [400, {}],
    [400, { error: 7 }],
    [403, { error: "Forbidden by proxy" }],
  ] as const) {
    vi.stubGlobal("fetch", async () => Response.json(body, { status }));
    expect(await publishes(signedTransport)).toHaveProperty(
      "message",
      `Relay rejected the message (${status})`,
    );
  }
  // Other statuses stay a status summary, never upstream text.
  vi.stubGlobal("fetch", async () => Response.json({ error }, { status: 500 }));
  expect(await publishes(signedTransport)).toHaveProperty(
    "message",
    "Relay delivery could not be confirmed (500)",
  );
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("/session")
      ? Response.json({
          viewer: key.pubkey,
          relayAuthor: "relay",
          writeKinds: [9],
        })
      : Response.json({ error }, { status: 400 }),
  );
  expect(await publishes(await connectBrokerTransport())).toMatchObject({
    message: shown,
    reason: error,
  });
});
it("keeps the conflict refusal and the raw reason for classifying writers", async () => {
  const conflict = await refusal(409, { error: "invalid: whatever" });
  expect(conflict).toHaveProperty(
    "message",
    "conflict: the relay state changed; reload before writing again",
  );
  const refused = await refusal(400, { error: "restricted: nope" });
  expect(refused).toHaveProperty("reason", "restricted: nope");
});
it.each([
  [
    "rate-limited: quota exceeded; retry in 17s",
    false,
    "rate-limited: quota exceeded; retry in 17s",
  ],
  [
    "rate-limited: shared admission unavailable",
    false,
    "rate-limited: shared admission unavailable",
  ],
  [
    "rate-limited: quota exceeded; retry in 17s\nprivate",
    false,
    "rate-limited: unrecognized reason",
  ],
  [
    "rate-limited: quota exceeded; retry in 100000s",
    false,
    "rate-limited: unrecognized reason",
  ],
  [
    "rate-limited: private response",
    false,
    "rate-limited: unrecognized reason",
  ],
  ["private response", false, "Relay request failed (503)"],
  [
    "rate-limited: quota exceeded; retry in 17s",
    undefined,
    "Relay delivery could not be confirmed (503)",
  ],
  [
    "rate-limited: shared admission unavailable",
    true,
    "Relay delivery could not be confirmed (503)",
  ],
])(
  "keeps publication quota reporting bounded and separate from delivery evidence: %s, sent=%s",
  async (error, sent, message) => {
    const event = signed(key, { kind: 9000, content: "", tags: [["h", "c"]] });
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/session")
        ? Response.json({
            viewer: key.pubkey,
            relayAuthor: "relay",
            writeKinds: [9000],
          })
        : Response.json({ error, sent }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport();
    assert.exists(transport.writer);
    const result = await transport.writer
      .publish(event, new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof PublishRejected).toBe(sent === false);
    expect(result).toHaveProperty("message", message);
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/publish")),
    ).toHaveLength(1);
  },
);
it("the broker advertises and supplies writes through the same connection", async () => {
  const event = signed(key, { kind: 9, content: "hello", tags: [["h", "c"]] });
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/session"))
      return Response.json({
        viewer: key.pubkey,
        relayAuthor: "relay",
        relayUrl: "https://relay.test",
        writeKinds: [9],
      });
    if (url.endsWith("/sign")) return Response.json(event);
    return Response.json({ accepted: true, event_id: event.id });
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  expect(transport.scope).toBe("https://relay.test");
  expect(transport.relayHttpUrl).toBe("https://relay.test");
  expect(transport.writer?.kinds).toEqual([9]);
  assert.exists(transport.writer);
  const signedEvent = await transport.writer.sign(
    event,
    new AbortController().signal,
  );
  await transport.writer.publish(signedEvent, new AbortController().signal);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/relay/session",
    "/api/relay/sign",
    "/api/relay/publish",
  ]);
});

it("saves the viewer's config artifacts when the broker admits kind 45010", async () => {
  const artifact = signed(key, { kind: 45010, content: "{}", tags: [] });
  const other = signed(keypair(), {
    kind: 45010,
    content: "{}",
    tags: [],
  });
  let returned = artifact,
    refuse = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("/session"))
      return Response.json({
        viewer: key.pubkey,
        relayAuthor: "relay",
        writeKinds: [9, 45010],
      });
    if (url.endsWith("/sign")) return Response.json(returned);
    return Response.json({
      accepted: !refuse,
      event_id: artifact.id,
      message: refuse ? "rate-limited: try later" : "",
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  const writer = transport.configArtifacts;
  assert.exists(writer);
  const signal = new AbortController().signal;
  const saved = await writer.sign(
    { kind: 45010, content: "{}", tags: [], created_at: 1 },
    signal,
  );
  await writer.publish(saved, signal);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
    "/api/relay/session",
    "/api/relay/sign",
    "/api/relay/publish",
  ]);
  refuse = true;
  const refused = await writer
    .publish(saved, signal)
    .catch((error: unknown) => error);
  expect(writer.isNotSent?.(refused)).toBe(true);
  expect(writer.isNotSent?.(new Error((refused as Error).message))).toBe(false);
  expect(writer.isNotSent?.(new PublishRejected("denied"))).toBe(false);
  refuse = false;
  // Only this viewer's artifacts.
  await expect(
    writer.sign({ kind: 9, content: "", tags: [], created_at: 1 }, signal),
  ).rejects.toThrow("Not an artifact");
  returned = other;
  await expect(
    writer.sign(
      { kind: 45010, content: "{}", tags: [], created_at: 1 },
      signal,
    ),
  ).rejects.toThrow("Invalid artifact signature");
  await expect(writer.publish(other, signal)).rejects.toThrow(
    "Not this viewer's artifact",
  );
  // A broker that doesn't admit the kind offers no artifact writer.
  vi.stubGlobal("fetch", async () =>
    Response.json({
      viewer: key.pubkey,
      relayAuthor: "relay",
      writeKinds: [9],
    }),
  );
  expect((await connectBrokerTransport()).configArtifacts).toBeUndefined();
});

it("exposes the relay HTTP base for display, preferring the broker's explicit value", async () => {
  const session = (extra: Record<string, unknown>) => async () =>
    Response.json({ viewer: key.pubkey, relayAuthor: "relay", ...extra });
  vi.stubGlobal("fetch", session({ relayUrl: "wss://relay.test" }));
  expect((await connectBrokerTransport()).relayHttpUrl).toBe(
    "https://relay.test",
  );
  vi.stubGlobal(
    "fetch",
    session({
      relayUrl: "wss://relay.test",
      relayHttpUrl: "https://hooks.relay.test/",
    }),
  );
  expect((await connectBrokerTransport()).relayHttpUrl).toBe(
    "https://hooks.relay.test",
  );
  // Paths, credentials and non-HTTP schemes never become a hook base.
  for (const relayHttpUrl of [
    "https://relay.test/path",
    "https://user@relay.test",
    "ftp://relay.test",
    42,
  ]) {
    vi.stubGlobal("fetch", session({ relayHttpUrl }));
    expect((await connectBrokerTransport()).relayHttpUrl).toBeUndefined();
  }
  const direct = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    "relay",
  );
  expect(direct.relayHttpUrl).toBe("https://relay.test");
});

it("requests relay thumbnails only for small media", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      viewer: key.pubkey,
      relayAuthor: "relay",
      relayUrl: "https://relay.test",
    }),
  );
  const transport = await connectBrokerTransport();
  const hash = "1".repeat(64);
  const original = `https://relay.test/media/${hash}.png`;
  const thumbnail = `https://relay.test/media/${hash}.thumb.webp`;

  expect(transport.media(original)).toBe(
    `/api/relay/media?url=${encodeURIComponent(original)}`,
  );
  expect(transport.media(original, "small")).toBe(
    `/api/relay/media?url=${encodeURIComponent(thumbnail)}`,
  );
  expect(transport.media("https://images.example/avatar.png", "small")).toBe(
    "https://images.example/avatar.png",
  );
});

it("loads the still image of a desktop animated avatar", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      viewer: key.pubkey,
      relayAuthor: "relay",
      relayUrl: "https://relay.test",
    }),
  );
  const transport = await connectBrokerTransport();
  const hash = "1".repeat(64);
  const still = `https://relay.test/media/${hash}.png`;
  const animated = `${still}#buzz-anim=${encodeURIComponent(
    `https://relay.test/media/${"2".repeat(64)}.png`,
  )}`;

  expect(transport.media(animated)).toBe(
    `/api/relay/media?url=${encodeURIComponent(still)}`,
  );
  expect(transport.media(animated, "small")).toBe(
    `/api/relay/media?url=${encodeURIComponent(
      `https://relay.test/media/${hash}.thumb.webp`,
    )}`,
  );
});

it.each([null, 42, "", "A".repeat(64), "b".repeat(64)])(
  "rejects malformed or mismatched broker archive authority %j",
  async (archiveAuthority) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        viewer: key.pubkey,
        relayAuthor: key.pubkey,
        archiveAuthority,
      }),
    );
    await expect(connectBrokerTransport()).rejects.toMatchObject({
      kind: "invalid-response",
    });
  },
);
it("does not infer archive authority from a host-supplied signing key", async () => {
  const transport = await connectSignedTransport(
    hostSigner(key),
    "https://relay.test",
    key.pubkey,
  );
  expect(transport.archiveAuthority).toBeUndefined();
});

it.each([Infinity, 1.5])(
  "direct signed transport rejects raw invalid timestamp %s",
  async (created_at) => {
    const event = signed(key, { kind: 0, created_at, content: "{}", tags: [] });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify([event]).replace(
            '"created_at":null',
            '"created_at":1e400',
          ),
        ),
    );
    const transport = await connectSignedTransport(
      hostSigner(key),
      "https://relay.test",
      key.pubkey,
    );
    await expect(transport.query([{ kinds: [0], limit: 1 }])).rejects.toThrow(
      /malformed/,
    );
  },
);

it("uses each signed transport's own origin for protected media, never a deployment default", async () => {
  const signer = {
    getPublicKey: async () => "a".repeat(64),
    signEvent: async () => {
      throw new Error("not signing");
    },
    request: async () => {
      throw new Error("not requesting");
    },
  };
  const a = await connectSignedTransport(
    signer,
    "wss://media-a.example",
    "b".repeat(64),
  );
  const b = await connectSignedTransport(
    signer,
    "wss://media-b.example",
    "c".repeat(64),
  );
  expect(a.media("https://media-a.example/media/private")).toBeUndefined();
  expect(b.media("https://media-b.example/media/private")).toBeUndefined();
  expect(a.media("https://images.example/public.png")).toBe(
    "https://images.example/public.png",
  );
  expect(a.media("http://images.example/insecure.png")).toBeUndefined();
});

it("presence validates whole snapshots before omission means Offline; busy is not empty", async () => {
  const relay = keypair(),
    author = keypair().pubkey,
    absent = keypair().pubkey;
  const event = signed(relay, {
    kind: 20001,
    content: "online",
    tags: [["p", author]],
  });
  let response = () => Response.json([event]);
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith("/session")
      ? Response.json({
          viewer: key.pubkey,
          relayAuthor: relay.pubkey,
          live: true,
          presence: true,
        })
      : response(),
  );
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectBrokerTransport();
  assert.exists(transport.presenceSnapshot);
  const snapshot = transport.presenceSnapshot;
  const read = () => snapshot([author, absent], new AbortController().signal);
  expect(await read()).toEqual(
    new Map([
      [author, "online"],
      [absent, "offline"],
    ]),
  );
  response = () => new Response(null, { status: 204 });
  expect(await read()).toBeNull();
  for (const events of [
    [event, event],
    [{ ...event, sig: "0".repeat(128) }],
    [signed(key, { kind: 20001, content: "online", tags: [["p", author]] })],
    [
      signed(relay, {
        kind: 20001,
        content: "online",
        tags: [["p", key.pubkey]],
      }),
    ],
    [signed(relay, { kind: 20002, content: "online", tags: [["p", author]] })],
    [
      signed(relay, {
        kind: 20001,
        content: "online",
        tags: [["p", author, "extra"]],
      }),
    ],
    [
      signed(relay, {
        kind: 20001,
        content: "away",
        tags: [
          ["p", author],
          ["p", absent],
        ],
      }),
    ],
  ]) {
    response = () => Response.json(events);
    await expect(read()).rejects.toThrow();
  }
  response = () =>
    Response.json([
      signed(relay, {
        kind: 20001,
        content: '{"status":"away"}',
        tags: [["p", author]],
      }),
    ]);
  expect((await read())?.get(author)).toBe("away");
  response = () => new Response(" ".repeat(1024 * 1024 + 1));
  await expect(read()).rejects.toThrow("capacity");
  await expect(snapshot([], new AbortController().signal)).rejects.toThrow(
    "demand",
  );
});

it.each(["busy", '{"status":"busy"}', "{custom-status", '{"status":42}'])(
  "keeps valid peers and omissions when a signed status is unsupported: %s",
  async (content) => {
    const relay = keypair(),
      custom = keypair().pubkey,
      online = keypair().pubkey,
      absent = keypair().pubkey;
    const customEvent = signed(relay, {
      kind: 20001,
      content,
      tags: [["p", custom]],
    });
    const onlineEvent = signed(relay, {
      kind: 20001,
      content: "online",
      tags: [["p", online]],
    });
    let events = [customEvent, onlineEvent];
    vi.stubGlobal("fetch", async (url: string) =>
      Response.json(
        url.endsWith("/session")
          ? {
              viewer: key.pubkey,
              relayAuthor: relay.pubkey,
              live: true,
              presence: true,
            }
          : events,
      ),
    );
    const transport = await connectBrokerTransport();
    assert.exists(transport.presenceSnapshot);
    const snapshot = transport.presenceSnapshot;
    const read = () =>
      snapshot([custom, online, absent], new AbortController().signal);
    expect(await read()).toEqual(
      new Map([
        [custom, "unknown"],
        [online, "online"],
        [absent, "offline"],
      ]),
    );
    // Unknown is still an observed subject: duplicates and invalid signatures
    // invalidate the complete snapshot, rather than applying a partial result.
    events = [customEvent, onlineEvent, customEvent];
    await expect(read()).rejects.toThrow();
    events = [customEvent, { ...onlineEvent, sig: "0".repeat(128) }];
    await expect(read()).rejects.toThrow();
  },
);

it.each(["relay", "https://relay.test"])(
  "binds agent-log proof to broker session origin for community %s",
  async (community) => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/session")
          ? {
              viewer: key.pubkey,
              relayAuthor: key.pubkey,
              relayUrl: "https://relay.test",
              agentLogProof: true,
            }
          : { signature: "a".repeat(128) },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport("", undefined, community);
    assert.exists(transport.authorizeAgentLog);
    const target = {
      id: "fixture-id",
      pubkey: key.pubkey,
      relayUrl: "wss://relay.test",
    };
    expect(await transport.authorizeAgentLog(target, "nonce")).toBe(
      "a".repeat(128),
    );
    expect(fetcher).toHaveBeenCalledWith(
      `/api/relay/${encodeURIComponent(community)}/agent-log-proof`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...target, nonce: "nonce" }),
      }),
    );
    const before = fetcher.mock.calls.length;
    await expect(
      transport.authorizeAgentLog(
        { ...target, relayUrl: "wss://different.test" },
        "nonce",
      ),
    ).rejects.toThrow("Log authorization unavailable");
    expect(fetcher).toHaveBeenCalledTimes(before);
  },
);

it.each(["relay", "https://relay.test"])(
  "signs Git access only for the broker community's repositories (%s)",
  async (community) => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/session")
          ? {
              viewer: key.pubkey,
              relayAuthor: key.pubkey,
              relayUrl: "wss://relay.test",
              gitAuthorization: true,
            }
          : { token: "dG9rZW4=" },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectBrokerTransport("", undefined, community);
    assert.exists(transport.authorizeGit);
    const repository = `https://relay.test/git/${"a".repeat(64)}/plugins`;
    expect(await transport.authorizeGit(` ${repository} `)).toEqual({
      repository,
      token: "dG9rZW4=",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/relay/${encodeURIComponent(community)}/git-authorization`,
      expect.objectContaining({ body: JSON.stringify({ repository }) }),
    );
    const before = fetcher.mock.calls.length;
    for (const other of [
      `https://other.test/git/${"a".repeat(64)}/plugins`,
      "https://github.com/block/plugins",
      "block/plugins",
    ])
      expect(await transport.authorizeGit(other)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(before);
  },
);
it("searches profile names through the host's signed /profiles/search request", async () => {
  const profile = signed(key, {
    kind: 0,
    content: JSON.stringify({ display_name: "Wes" }),
    tags: [],
  });
  const forged = { ...profile, content: JSON.stringify({ name: "Mallory" }) };
  let reply: Response = Response.json([profile]);
  const request = vi.fn(async (_url: string, _body: string) => reply);
  const transport = await connectSignedTransport(
    hostSigner(key, request),
    "https://relay.test",
    "relay",
  );
  assert.exists(transport.searchProfiles);
  const controller = new AbortController();
  expect(
    await transport.searchProfiles(
      "wes",
      40,
      2,
      controller.signal,
      "foreground",
    ),
  ).toEqual([profile]);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://relay.test/profiles/search",
    JSON.stringify({ query: "wes", limit: 40, page: 2 }),
    controller.signal,
  );
  // An older relay's missing route keeps its status for the NIP-50 fallback.
  reply = Response.json({ error: "not found" }, { status: 404 });
  await expect(
    transport.searchProfiles("wes", 40, 2, controller.signal, "foreground"),
  ).rejects.toMatchObject({ name: "ReadError", status: 404 });
  // Signatures are checked like any other read.
  reply = Response.json([forged]);
  await expect(
    transport.searchProfiles("wes", 40, 2, controller.signal, "foreground"),
  ).rejects.toThrow();
});
