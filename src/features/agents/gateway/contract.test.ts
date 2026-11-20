import { describe, expect, it } from "vitest";
import {
  bindSession,
  discoveryBundle,
  identityErrors,
  inferenceBundle,
  turnErrors,
  type TurnContext,
} from "./contract";
import {
  INFERENCE_VECTORS,
  VECTOR_BINDING,
  VECTOR_IDENTITY,
  VECTOR_PROFILE,
} from "./vectors";

const route = { identity: VECTOR_IDENTITY };
const [{ turn: MESSAGE }, { turn: TIMER }] = INFERENCE_VECTORS as [
  (typeof INFERENCE_VECTORS)[number],
  (typeof INFERENCE_VECTORS)[number],
];
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("bindSession", () => {
  it("resumes a saved binding with the same identity and doesn't rewrite it", () => {
    expect(bindSession(route, { ...VECTOR_BINDING }, "resume")).toEqual({
      ok: true,
      binding: VECTOR_BINDING,
      persist: false,
    });
  });

  it("creates and persists one when nothing is saved", () => {
    for (const saved of [undefined, null]) {
      const bound = bindSession(route, saved, "resume");
      expect(bound.ok && bound.persist).toBe(true);
      expect(bound.ok && bound.binding.client_session_id).toMatch(UUID_V4);
      expect(bound.ok && bound.binding.identity).toEqual(VECTOR_IDENTITY);
    }
  });

  it("rotates only on New session or a replaced harness session", () => {
    for (const event of ["reset", "new_generation"] as const) {
      const bound = bindSession(route, VECTOR_BINDING, event);
      expect(bound.ok && bound.persist).toBe(true);
      expect(bound.ok && bound.binding.client_session_id).not.toBe(
        VECTOR_BINDING.client_session_id,
      );
    }
  });

  it("keeps the session across an auth or network outage: the route was blocked, not the session lost", () => {
    // While blocked there is no identity to bind with; once eligible again
    // the adapter resumes, and the saved session survives.
    const before = bindSession(route, VECTOR_BINDING, "resume");
    const after = bindSession(route, VECTOR_BINDING, "resume");
    expect(before.ok && after.ok && after.binding).toEqual(
      before.ok && before.binding,
    );
    expect(after.ok && after.binding.client_session_id).toBe(
      VECTOR_BINDING.client_session_id,
    );
  });

  it("gives a standalone turn a fresh binding that isn't saved", () => {
    const bound = bindSession(route, VECTOR_BINDING, "standalone");
    expect(bound.ok && bound.persist).toBe(false);
    expect(bound.ok && bound.binding.client_session_id).not.toBe(
      VECTOR_BINDING.client_session_id,
    );
  });

  it("refuses another membership's or an unreadable binding without replacing it", () => {
    const other = {
      ...VECTOR_BINDING,
      identity: { ...VECTOR_IDENTITY, human_pubkey: "f".repeat(64) },
    };
    expect(bindSession(route, other, "resume")).toMatchObject({
      ok: false,
      error: "identity_conflict",
    });
    for (const saved of [
      "x",
      { ...VECTOR_BINDING, v: 2 },
      { ...VECTOR_BINDING, extra: 1 },
      {
        ...VECTOR_BINDING,
        client_session_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      },
      {
        ...VECTOR_BINDING,
        client_session_id: "00000000-0000-0000-0000-000000000000",
      },
    ])
      expect(bindSession(route, saved, "resume")).toMatchObject({
        ok: false,
        error: "binding_malformed",
      });
  });

  it("throws for an identity that isn't canonical", () => {
    expect(() =>
      bindSession(
        { identity: { ...VECTOR_IDENTITY, agent_pubkey: "B".repeat(64) } },
        undefined,
        "resume",
      ),
    ).toThrow();
  });
});

describe("validators", () => {
  it("accepts only exact canonical identities", () => {
    expect(identityErrors(VECTOR_IDENTITY)).toBeUndefined();
    expect(identityErrors({ ...VECTOR_IDENTITY, extra: "" })).toBeDefined();
    expect(
      identityErrors({ ...VECTOR_IDENTITY, community_id: "relay.example" }),
    ).toBeDefined();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a non-UUID channel", { channel_id: "general" }],
    ["an uppercase message id", { message_id: "C".repeat(64) }],
    ["a short thread id", { thread_id: "d".repeat(63) }],
    ["a dropped purpose field", { purpose: "inference" }],
    ["a dropped trigger kind", { trigger_kind: "message" }],
    ["a dropped trigger id", { trigger_id: "c".repeat(64) }],
    ["a dropped message time", { message_created_at: 1 }],
  ])("rejects %s", (_name, change) => {
    expect(turnErrors({ ...MESSAGE, ...change })).toBeDefined();
    expect(
      inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, {
        ...MESSAGE,
        ...change,
      } as TurnContext).ok,
    ).toBe(false);
  });

  it("accepts a turn with every ID null", () => {
    expect(turnErrors(TIMER)).toBeUndefined();
    expect(
      turnErrors({ channel_id: null, message_id: null, thread_id: null }),
    ).toBeUndefined();
  });
});

describe("bundles", () => {
  it("fit their byte budget with every field at its largest", () => {
    const bundle = inferenceBundle(VECTOR_PROFILE, VECTOR_BINDING, MESSAGE);
    expect(bundle.ok).toBe(true);
    expect(Object.keys(bundle.ok ? bundle.value : {})).toHaveLength(8);
  });

  it("send discovery with identity only, plus the session when it matches", () => {
    const bare = discoveryBundle(VECTOR_PROFILE, route);
    expect(bare.ok && bare.value).toEqual({
      "x-gw-launcher-client": "client-a",
      "x-gw-ctx-human-pubkey": "a".repeat(64),
      "x-gw-ctx-agent-pubkey": "b".repeat(64),
      "x-gw-ctx-community-id": VECTOR_IDENTITY.community_id,
    });
    const bound = discoveryBundle(VECTOR_PROFILE, route, VECTOR_BINDING);
    expect(bound.ok && bound.value["x-gw-launcher-session"]).toBe(
      VECTOR_BINDING.client_session_id,
    );
    expect(
      discoveryBundle(
        VECTOR_PROFILE,
        { identity: { ...VECTOR_IDENTITY, agent_pubkey: "f".repeat(64) } },
        VECTOR_BINDING,
      ).ok,
    ).toBe(false);
  });

  it("refuse a malformed binding", () => {
    expect(
      inferenceBundle(
        VECTOR_PROFILE,
        { ...VECTOR_BINDING, client_session_id: "x" },
        MESSAGE,
      ).ok,
    ).toBe(false);
  });
});
