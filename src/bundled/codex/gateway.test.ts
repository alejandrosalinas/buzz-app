import { describe, expect, it } from "vitest";
import {
  VECTOR_BINDING,
  VECTOR_IDENTITY,
  VECTOR_PROFILE,
} from "../../features/agents/gateway/vectors";
import { inferenceBundle } from "../../features/agents/gateway/contract";
import type { EligibleRoute } from "../../features/agents/gateway/route";
import { gatewayProvider, threadConfig } from "./gateway";

const route: EligibleRoute = {
  kind: "eligible",
  revision: 1,
  gatewayOrigin: "https://gateway.example.org",
  identity: VECTOR_IDENTITY,
  profile: VECTOR_PROFILE,
  harnesses: ["codex"],
};
const origin = route.gatewayOrigin;
const baseUrl = `${origin}/upstream/codex/v1`;
const id = "example-codex";

describe("gatewayProvider", () => {
  it.each([baseUrl, `${baseUrl}/`, `${origin}/alternate/codex/v1`])(
    "uses the provider at %s with its headers",
    (base_url) => {
      expect(
        gatewayProvider(
          {
            model_provider: id,
            model_providers: {
              [id]: { base_url, http_headers: { "x-team": "t" } },
              other: {},
            },
          },
          origin,
        ),
      ).toEqual({ id, headers: { "x-team": "t" } });
    },
  );

  it.each([
    [
      "no active provider",
      { model_providers: { [id]: { base_url: baseUrl } } },
    ],
    [
      "the built-in provider",
      {
        model_provider: "openai",
        model_providers: { openai: { base_url: baseUrl } },
      },
    ],
    [
      "a dotted provider ID",
      {
        model_provider: "example.codex",
        model_providers: { "example.codex": { base_url: baseUrl } },
      },
    ],
    [
      "an undefined active provider",
      { model_provider: id, model_providers: {} },
    ],
  ])("ignores %s", (_, providers) => {
    expect(gatewayProvider(providers, origin)).toBeUndefined();
  });

  it.each([
    null,
    "not a URL",
    "https://other.example.org/upstream/codex/v1",
    baseUrl.replace("https://", "http://"),
    baseUrl.replace("/upstream", ":8443/upstream"),
    `blob:${baseUrl}`,
    baseUrl.replace("https://", "https://user@"),
  ])("ignores the configured provider at %s", (base_url) => {
    expect(
      gatewayProvider(
        {
          model_provider: id,
          model_providers: { [id]: { base_url } },
        },
        origin,
      ),
    ).toBeUndefined();
  });
});

describe("threadConfig", () => {
  it("keeps the person's headers and replaces every reserved one with the bundle", () => {
    const bundle = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
      channel_id: null,
      message_id: null,
      thread_id: null,
    });
    if (!bundle.ok) throw new Error(bundle.message);
    const table = threadConfig(
      { route },
      {
        id: "corp",
        headers: {
          "x-team": "t",
          "X-GW-CTX-Channel-Id": "stale",
          x_gw_launcher_session: "stale",
        },
      },
      bundle.value,
    );
    expect(table).toEqual({
      "model_providers.corp.http_headers": { "x-team": "t", ...bundle.value },
    });
  });
});
