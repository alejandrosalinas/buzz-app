import { expect, it } from "vitest";
import { relayOrigin } from "../communities/destination";
import type { SessionSnapshot } from "../federated-identity/service";
import {
  atPublicBuilderlab,
  hostedByThisBuilderlab,
} from "./builderlab-hosted";

const server = (id: string, communityHosts: string[]) =>
  ({
    status: "signed-out",
    authority: {
      id,
      identityOrigin: `https://${id}.example`,
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
      communityHosts,
    },
    revision: "",
    email: null,
    failure: null,
    expiresAt: null,
    expiring: false,
    cleanup: false,
  }) satisfies SessionSnapshot;
const PUBLIC = server("bb-public", [
  "*.communities.buzz.xyz",
  "communities.buzz.xyz",
]);
const ACME = server("bb-acme", ["buzz.acme.builderlab.xyz"]);
const hosted = (input: string, servers: SessionSnapshot[]) =>
  hostedByThisBuilderlab({ url: relayOrigin(input) }, async () => servers);

it("follows the build's first compiled server, by its community hosts", async () => {
  expect(await hosted("wss://design.communities.buzz.xyz", [PUBLIC])).toBe(
    true,
  );
  expect(await hosted("wss://communities.buzz.xyz", [PUBLIC])).toBe(true);
  // Deeper than the one-label wildcard: native attaches no token there.
  expect(await hosted("wss://a.b.communities.buzz.xyz", [PUBLIC])).toBe(false);
  // Another server covers it, but first run signs in to the first only.
  expect(
    await hosted("wss://design.communities.buzz.xyz", [ACME, PUBLIC]),
  ).toBe(false);
  expect(await hosted("wss://buzz.acme.builderlab.xyz", [ACME, PUBLIC])).toBe(
    true,
  );
});

it("treats every community as unhosted without a compiled server", async () => {
  expect(await hosted("wss://design.communities.buzz.xyz", [])).toBe(false);
  expect(
    await hostedByThisBuilderlab(
      { url: relayOrigin("wss://design.communities.buzz.xyz") },
      () => Promise.reject(new Error("native unavailable")),
    ),
  ).toBe(false);
});

it.each([
  "https://app.builderlab.xyz",
  "https://app.builderlab.xyz/",
  // A federated-identity build at the public portal, as vite.config.ts
  // derives it from an `apiBasePath` of /buzz/api/goose/.
  "https://app.builderlab.xyz/buzz",
])("%s is the public Builderlab", (build) => {
  expect(atPublicBuilderlab(build)).toBe(true);
});

it.each([
  "",
  "not a url",
  "http://app.builderlab.xyz",
  "https://app.builderlab.xyz:8443",
  "https://staging.app.builderlab.xyz",
  "https://builderlab.example",
])("%s is not the public Builderlab", (build) => {
  expect(atPublicBuilderlab(build)).toBe(false);
});
