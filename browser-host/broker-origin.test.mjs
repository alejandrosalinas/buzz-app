import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { getPublicKey } from "nostr-tools";
import { createServer, resolveConfig } from "vite";
import { expect, it } from "vitest";
import { relayBrokerPlugin } from "./relay-broker.mjs";

it("admits only the configured browser origin through a loopback proxy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buzz-broker-origin-"));
  const key = new Uint8Array(32).fill(1);
  const browserOrigin = "https://preview.example.org";
  const server = await createServer({
    root: directory,
    configFile: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [
      relayBrokerPlugin({
        browserOrigin,
        identity: () => key.slice(),
        archiveFile: ":memory:",
      }),
    ],
  });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    const allowed = await fetch(`${base}/api/relay/identity`, {
      headers: { Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ viewer: getPublicKey(key) });
    const post = await fetch(
      `${base}/api/relay/prepare-remote-agent-authorization`,
      {
        method: "POST",
        headers: {
          Origin: browserOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          owner: getPublicKey(key),
          agentPubkey: getPublicKey(new Uint8Array(32).fill(2)),
        }),
      },
    );
    expect(post.status).toBe(200);
    expect((await post.json()).slice(0, 2)).toEqual([
      "auth",
      getPublicKey(key),
    ]);
    for (const Origin of [
      "https://other.example.org",
      `${browserOrigin}.evil.example`,
      "null",
      base,
    ]) {
      const denied = await fetch(`${base}/api/relay/identity`, {
        headers: { Origin },
      });
      expect(denied.status, Origin).toBe(403);
    }
    for (const headers of [
      {},
      { Origin: browserOrigin, "Sec-Fetch-Site": "cross-site" },
    ]) {
      const denied = await fetch(
        `${base}/api/relay/prepare-remote-agent-authorization`,
        {
          method: "POST",
          headers,
          body: "{}",
        },
      );
      expect(denied.status).toBe(403);
    }
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(
        `${base}/api/relay/identity`,
        {
          headers: { Origin: browserOrigin, Host: "other.example.org" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ["serve", "production"],
  ["build", "development"],
  ["build", "production"],
])("refuses a hosted origin for %s in %s mode", async (command, mode) => {
  await expect(
    resolveConfig(
      {
        configFile: false,
        mode,
        plugins: [
          relayBrokerPlugin({
            browserOrigin: "https://preview.example.org",
            identity: () => {
              throw new Error("Identity read");
            },
          }),
        ],
      },
      command,
      mode,
    ),
  ).rejects.toThrow(
    "browserOrigin requires the Vite development server in development mode",
  );
});

it.each([
  "*",
  "http://preview.example.org",
  "https://user:pass@preview.example.org",
  "https://preview.example.org/path",
  "https://preview.example.org/?query",
  "https://preview.example.org/#fragment",
  "",
])(
  "refuses invalid browser origin %s before reading identity",
  (browserOrigin) => {
    expect(() =>
      relayBrokerPlugin({
        browserOrigin,
        identity: () => {
          throw new Error("Identity read");
        },
      }),
    ).toThrow("browserOrigin must be an HTTPS origin");
  },
);
