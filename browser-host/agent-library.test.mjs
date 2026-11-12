import { fixtureRelayUrl } from "../tests/relay-config.ts";
import { expect, it, vi } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installedBuzzDataDir,
  projectAgentLibrary,
  projectAgentIdentities,
  readAgentLibrary,
} from "./agent-library.mjs";
import identityCases from "../tests/fixtures/agent-identity-library.json" with {
  type: "json",
};

it.each(identityCases)(
  "current identity store: $name",
  ({ rows, expected }) => {
    if (expected) expect(projectAgentIdentities(rows)).toEqual(expected);
    else expect(() => projectAgentIdentities(rows)).toThrow("Could not read");
  },
);

it.each(identityCases)(
  "community/account-scoped identity store: $name",
  ({ rows, expected, scopedExpected }) => {
    const scope = { community: "https://relay.example", owner: "d".repeat(64) };
    if (expected)
      expect(projectAgentIdentities(rows, scope)).toEqual(
        scopedExpected ?? expected,
      );
    else
      expect(() => projectAgentIdentities(rows, scope)).toThrow(
        "Could not read",
      );
  },
);

it("locates the installed Buzz data directory per platform and refuses to guess elsewhere", () => {
  expect(installedBuzzDataDir("darwin", {}, "/Users/t")).toBe(
    "/Users/t/Library/Application Support/xyz.block.buzz.desktop",
  );
  expect(installedBuzzDataDir("linux", {}, "/home/t")).toBe(
    "/home/t/.local/share/xyz.block.buzz.desktop",
  );
  expect(
    installedBuzzDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/t"),
  ).toBe("/data/xyz.block.buzz.desktop");
  // Tauri's dirs crate ignores a relative XDG_DATA_HOME; so must this reader,
  // or it would look where the installed app never writes.
  for (const XDG_DATA_HOME of ["relative", "./data", ""])
    expect(
      installedBuzzDataDir("linux", { XDG_DATA_HOME }, "/home/t"),
      JSON.stringify(XDG_DATA_HOME),
    ).toBe("/home/t/.local/share/xyz.block.buzz.desktop");
  expect(installedBuzzDataDir("win32", {}, "/home/t")).toBeUndefined();
  expect(installedBuzzDataDir("freebsd", {}, "/home/t")).toBeUndefined();
});
const key = "a".repeat(64);
const rows = [
  {
    pubkey: "",
    name: "legacy",
    display_name: "Brain",
    slug: "brain",
    private_key_nsec: "secret",
    system_prompt: "private instructions",
    env_vars: { TOKEN: "private token" },
  },
  {
    pubkey: key,
    name: "Brain",
    persona_id: "brain",
    private_key_nsec: "secret",
    auth_tag: "private auth",
  },
  { pubkey: "", name: "Hidden", slug: "hidden", is_active: false },
  { pubkey: "", name: "No coordinate" },
];
it("projects selected definitions and exact linked keys, never arbitrary config/secrets", () => {
  expect(projectAgentLibrary(rows)).toEqual({
    definitions: [{ id: "brain", name: "Brain" }],
    identities: [{ pubkey: key, name: "Brain", definitionId: "brain" }],
  });
});
it("projects only safe optional avatar artwork without broadening the public fields", () => {
  const avatar = "https://images.example/brain.png";
  const data = "data:image/png;base64,aGVsbG8=";
  expect(
    projectAgentLibrary([
      { ...rows[0], avatar_url: data },
      { ...rows[1], avatar_url: avatar },
    ]),
  ).toEqual({
    definitions: [{ id: "brain", name: "Brain", avatar: data }],
    identities: [{ pubkey: key, name: "Brain", definitionId: "brain", avatar }],
  });
  for (const avatar_url of [
    "file:///secret",
    "javascript:alert(1)",
    "https://user:secret@example.com/picture",
    "data:image/svg+xml;base64,PHN2Zz4=",
    `data:image/png;base64,${"A".repeat(512 * 1024)}`,
    {},
    null,
  ]) {
    expect(
      projectAgentLibrary([{ ...rows[0], avatar_url }]).definitions,
    ).toEqual([{ id: "brain", name: "Brain" }]);
  }
});
it("read is byte-preserving, treats a missing source as empty, and rejects linked/malformed/nonregular/oversized sources without copying data into errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-library-"));
  const path = join(root, "managed-agents.json");
  try {
    const raw = JSON.stringify(rows);
    await writeFile(path, raw);
    expect(await readAgentLibrary(path)).toEqual(projectAgentLibrary(rows));
    expect(await readFile(path, "utf8")).toBe(raw);
    await symlink(path, join(root, "link"));
    for (const missing of [
      join(root, "missing"),
      join(root, "missing-dir/agents.json"),
    ])
      expect(await readAgentLibrary(missing)).toEqual({
        definitions: [],
        identities: [],
      });
    // A dangling link is a link, not a missing library.
    await symlink(join(root, "missing"), join(root, "dangling"));
    for (const bad of [
      join(root, "link"),
      join(root, "dangling"),
      join(path, "child"),
      root,
    ])
      await expect(readAgentLibrary(bad)).rejects.toThrow("Could not read");
    await writeFile(path, "private broken content");
    await expect(readAgentLibrary(path)).rejects.toThrow("Could not read");
    expect(await readFile(path, "utf8")).toBe("private broken content");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readAgentLibrary(path)).rejects.toThrow("Could not read");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  null,
  {},
  Array(2001).fill(rows[0]),
  [{ pubkey: "bad", name: "private" }],
  [rows[1], rows[1]],
  [rows[0], rows[0]],
  [{ ...rows[0], is_active: "false" }],
])(
  "malformed display fields fail instead of inventing an empty library (%#)",
  (raw) => {
    expect(() => projectAgentLibrary(raw)).toThrow("Could not read");
  },
);

it.each(["array", "versioned"])(
  "actual broker and transport expose only the scoped %s library projection, reject cross-origin reads, and retry failures",
  async (format) => {
    const { createServer } = await import("node:http");
    const { generateSecretKey, getPublicKey } = await import("nostr-tools");
    const { relayBrokerPlugin } = await import("./relay-broker.mjs");
    const { connectBrokerTransport } = await import(
      "../src/features/relay/transport.ts"
    );
    const root = await mkdtemp(join(tmpdir(), "buzz-library-http-"));
    const path = join(root, "managed-agents.json");
    const secret = generateSecretKey();
    const owner = getPublicKey(secret);
    const localRows = [
      { pubkey: key, name: "Elsewhere", relay: "wss://other.example", owner },
      {
        pubkey: "c".repeat(64),
        name: "Other account",
        relay: fixtureRelayUrl,
        owner: "f".repeat(64),
      },
      { pubkey: key, name: "Brain", relay: fixtureRelayUrl, owner },
    ];
    // Both existing file formats go through the actual scoped host reader.
    const scopedSource =
      format === "array" ? localRows : { version: 2, agents: localRows };
    const bytes = JSON.stringify(scopedSource);
    const expected = {
      definitions: [],
      identities: [{ pubkey: key, name: "Brain" }],
    };
    await writeFile(path, bytes);
    let handler,
      reads = 0;
    const server = createServer((req, res) =>
      handler(req, res, () => {
        res.writeHead(404);
        res.end();
      }),
    );
    await relayBrokerPlugin({
      archiveFile: ":memory:",
      relayUrl: fixtureRelayUrl,
      identity: () => secret,
      authority: async () => ({
        relayAuthor: getPublicKey(generateSecretKey()),
      }),
      agentLibrary: (_path, scope) => {
        reads++;
        return readAgentLibrary(path, scope);
      },
    }).configureServer({
      httpServer: server,
      config: { logger: { info() {} } },
      middlewares: {
        use(fn) {
          handler = fn;
        },
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const realFetch = globalThis.fetch;
    const scopedTransport = async (community) => {
      // Registration is a trusted same-origin POST; Node fetch has no page origin.
      const response = await realFetch(`${base}/api/relay/register`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ url: community }),
      });
      expect(response.status).toBe(200);
      return `${base}/api/relay/${encodeURIComponent(community)}/agent-library`;
    };
    try {
      const transport = await connectBrokerTransport(base);
      expect(reads).toBe(0);
      expect(
        await transport.readAgentLibrary(new AbortController().signal),
      ).toEqual(expected);
      const bad = await fetch(`${base}/api/relay/agent-library`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(bad.status).toBe(403);
      expect(reads).toBe(1);
      await writeFile(path, "secret malformed value");
      await expect(
        transport.readAgentLibrary(new AbortController().signal),
      ).rejects.toThrow();
      const error = await fetch(`${base}/api/relay/agent-library`);
      expect(await error.text()).not.toContain("secret");
      await writeFile(path, bytes);
      expect(
        await transport.readAgentLibrary(new AbortController().signal),
      ).toEqual(expected);
      const elsewhere = await scopedTransport("https://other.example");
      expect(await (await realFetch(elsewhere)).json()).toEqual({
        definitions: [],
        identities: [{ pubkey: key, name: "Elsewhere" }],
      });
      const fresh = await scopedTransport("https://new.example");
      expect(await (await realFetch(fresh)).json()).toEqual({
        definitions: [],
        identities: [],
      });
      expect(await readFile(path, "utf8")).toBe(bytes);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("projects current Buzz 1.0 saved agents without parked legacy identities or private fields", () => {
  const current = {
    version: 1,
    agents: [
      {
        id: "sol",
        pubkey: key,
        name: "Sol",
        picture: "https://images.example/sol.png",
        enabled: false,
        systemPrompt: "private instructions",
        environment: { TOKEN: "private token" },
        imported: {
          record: { private_key_nsec: "secret", persona_id: "legacy-profile" },
        },
        authTag: "private auth",
        credentialId: "private credential reference",
      },
      {
        id: "sol-2",
        pubkey: "b".repeat(64),
        name: "Sol",
        picture: "file:///private",
      },
    ],
    parked: {
      ["c".repeat(64)]: {
        pubkey: "c".repeat(64),
        name: "Old Bumble",
        sources: ["installed"],
      },
    },
  };
  expect(projectAgentLibrary(current)).toEqual({
    definitions: [],
    identities: [
      { pubkey: key, name: "Sol", avatar: "https://images.example/sol.png" },
      { pubkey: "b".repeat(64), name: "Sol" },
    ],
  });
  expect(
    projectAgentLibrary({ version: 1, agents: [], parked: current.parked }),
  ).toEqual({ definitions: [], identities: [] });
});
it("reads the current saved agent document byte-for-byte without rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "buzz-current-library-"));
  const path = join(root, "agents.json");
  const raw = JSON.stringify({
    version: 1,
    agents: [{ pubkey: key, name: "Sol", environment: { TOKEN: "secret" } }],
    parked: {},
  });
  try {
    await writeFile(path, raw);
    expect(await readAgentLibrary(path)).toEqual({
      definitions: [],
      identities: [{ pubkey: key, name: "Sol" }],
    });
    expect(await readFile(path, "utf8")).toBe(raw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  { version: 2, agents: [] },
  { version: 1 },
  { version: 1, agents: null },
  { version: 1, agents: [null] },
  { version: 1, agents: [{ pubkey: "bad", name: "Sol" }] },
])(
  "rejects unsupported or malformed current agent storage without returning an empty inventory (%#)",
  (raw) => {
    expect(() => projectAgentLibrary(raw)).toThrow("Could not read");
  },
);

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "the default reader uses current Buzz 1.0 storage and never falls back to Classic",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-default-library-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("XDG_DATA_HOME", root);
    const appData =
      process.platform === "darwin"
        ? join(root, "Library/Application Support")
        : root;
    const current = join(
      appData,
      "xyz.block.buzz.desktop/agents/identities.json",
    );
    const legacy = join(
      appData,
      "xyz.block.buzz.app/agents/managed-agents.json",
    );
    try {
      await mkdir(join(appData, "xyz.block.buzz.desktop/agents"), {
        recursive: true,
      });
      await mkdir(join(appData, "xyz.block.buzz.app/agents"), {
        recursive: true,
      });
      await writeFile(legacy, JSON.stringify(rows));
      await writeFile(current, JSON.stringify([{ pubkey: key, name: "Luna" }]));
      expect(await readAgentLibrary()).toEqual({
        definitions: [],
        identities: [{ pubkey: key, name: "Luna" }],
      });
      // Missing is empty, never a fallback to the Classic library.
      await rm(current);
      expect(await readAgentLibrary()).toEqual({
        definitions: [],
        identities: [],
      });
      await expect(readFile(current)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(current, "private malformed config");
      await expect(readAgentLibrary()).rejects.toThrow("Could not read");
      await writeFile(
        current,
        JSON.stringify([{ pubkey: key, name: "Old Luna", deleted: true }]),
      );
      expect(await readAgentLibrary()).toEqual({
        definitions: [],
        identities: [],
      });
      expect(await readFile(legacy, "utf8")).toBe(JSON.stringify(rows));
      // Until the updated desktop moves it, the pre-1.0 folder is read.
      const foundation = join(appData, "dev.local.buzz.foundation/agents");
      await mkdir(foundation, { recursive: true });
      await writeFile(
        join(foundation, "identities.json"),
        JSON.stringify([{ pubkey: key, name: "Nova" }]),
      );
      expect((await readAgentLibrary()).identities).toEqual([]);
      await rm(join(appData, "xyz.block.buzz.desktop"), { recursive: true });
      expect(await readAgentLibrary()).toEqual({
        definitions: [],
        identities: [{ pubkey: key, name: "Nova" }],
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("deduplicates current custody records, preferring the configured setup and retaining equal-status order", () => {
  const retained = {
    pubkey: key,
    name: "Retained",
    configured: false,
    picture: "https://images.example/retained.png",
  };
  const configured = {
    pubkey: key,
    name: "Renamed",
    picture: "https://images.example/renamed.png",
  };
  const equal = { ...configured, name: "Other community" };
  for (const agents of [
    [retained, configured, equal],
    [configured, retained, equal],
  ]) {
    expect(projectAgentLibrary({ version: 1, agents })).toEqual({
      definitions: [],
      identities: [
        { pubkey: key, name: "Renamed", avatar: configured.picture },
      ],
    });
  }
  expect(() => projectAgentLibrary([configured, configured])).toThrow(
    "Could not read",
  );
  expect(() =>
    projectAgentLibrary({
      version: 1,
      agents: [configured, { ...retained, name: null }],
    }),
  ).toThrow("Could not read");
});
