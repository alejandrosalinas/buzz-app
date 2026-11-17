import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { PublishRejected } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import { acceptPublish } from "../relay/transport";
import {
  ARTIFACT_MAX_CONTENT_BYTES,
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactProblem,
  artifactTemplate,
  currentFilter,
  deliver,
  expectedTeam,
  readCurrent,
  readHead,
  refusal,
  settle,
  signedEventBytes,
  teamLabel,
  uuidv5,
  type SnapshotRead,
} from "./agent-config-artifacts";

const key = generateSecretKey();
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
/** A system config channel as the relay serves it: a filter whose `#h` does
 * not name the channel reads nothing from it (NIP-CL), so a read that omits
 * `#h` cannot pass by accident. */
const systemChannelRead =
  (events: readonly RelayEvent[]): SnapshotRead =>
  async (filters) =>
    filters.every((f) => f["#h"]?.includes(channel)) ? events : [];
const sign = (t: ReturnType<typeof artifactTemplate>) =>
  finalizeEvent(t, key) as RelayEvent;
async function instructions(text: string, prev?: string) {
  const d = await artifactD("buzz.agent.instructions", channel);
  const expected = { channel, type: "buzz.agent.instructions" as const, d };
  const event = sign(
    artifactTemplate({
      ...expected,
      ...(prev ? { op: "update" as const, prev } : { op: "create" as const }),
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text }),
    }),
  );
  return { expected, event };
}
const writer = (publish: () => Promise<void>) => ({
  sign: async () => {
    throw new Error("unused");
  },
  publish,
});

describe("artifact identity", () => {
  it("derives RFC 4122 UUIDv5 values", async () => {
    // RFC 4122 appendix: "www.example.com" in the DNS namespace.
    expect(
      await uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("gives each type one stable d per channel", async () => {
    const a = await artifactD("buzz.agent.settings", channel);
    expect(await artifactD("buzz.agent.settings", channel)).toBe(a);
    expect(await artifactD("buzz.agent.instructions", channel)).not.toBe(a);
  });
});

describe("preset tag", () => {
  const preset = (t: { tags: string[][] }) =>
    t.tags.filter(([name]) => name === "preset");
  const settings = async () => ({
    channel,
    type: "buzz.agent.settings" as const,
    d: await artifactD("buzz.agent.settings", channel),
  });
  const body = (extra: object = {}) =>
    JSON.stringify({ version: 1, agentType: "goose", settings: {}, ...extra });

  it("tags agent settings on Automatic, so they can be counted from tags", async () => {
    const expected = await settings();
    const on = artifactTemplate({
      ...expected,
      op: "create",
      title: "Agent settings",
      content: body({ preset: "recommended" }),
    });
    expect(preset(on)).toEqual([["preset", "recommended"]]);
    expect(artifactProblem(sign(on), expected)).toBeUndefined();
    // Off Automatic, a preset tag carried from the head is dropped, so the
    // tag always matches the content.
    const off = artifactTemplate({
      ...expected,
      op: "update",
      prev: "a".repeat(64),
      title: "Agent settings",
      content: body(),
      extra: [["preset", "recommended"]],
    });
    expect(preset(off)).toEqual([]);
  });

  it("tags only agent settings", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const t = artifactTemplate({
      channel,
      type: "buzz.agent.instructions",
      d,
      op: "create",
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text: "", preset: "recommended" }),
    });
    expect(preset(t)).toEqual([]);
  });
});

describe("artifact validation", () => {
  it("accepts a valid revision, including empty instructions", async () => {
    const { expected, event } = await instructions("");
    expect(artifactProblem(event, expected)).toBeUndefined();
  });

  it("rejects a revision from another channel, type or identity", async () => {
    const { expected, event } = await instructions("hi");
    expect(artifactProblem(event, { ...expected, channel: "x" })).toMatch(
      /home/,
    );
    expect(
      artifactProblem(event, { ...expected, type: "buzz.agent.settings" }),
    ).toMatch(/type/);
    expect(artifactProblem(event, { ...expected, d: "x" })).toMatch(/identity/);
  });

  it("rejects unknown versions, U+0000 and oversize content", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const expected = { channel, type: "buzz.agent.instructions" as const, d };
    const make = (content: string) =>
      sign(
        artifactTemplate({ ...expected, op: "create", title: "t", content }),
      );
    expect(artifactProblem(make('{"version":2,"text":""}'), expected)).toMatch(
      /version/,
    );
    expect(
      artifactProblem(make('{"version":1,"text":"a\\u0000"}'), expected),
    ).toMatch(/U\+0000/);
    expect(
      artifactProblem(make(`{"version":1,"text":"\u0000"}`), expected),
    ).toMatch(/U\+0000/);
    const big = JSON.stringify({
      version: 1,
      text: "x".repeat(ARTIFACT_MAX_CONTENT_BYTES),
    });
    expect(artifactProblem(make(big), expected)).toMatch(/too large/);
  });

  it("requires the team name to match its title and one team tag", async () => {
    const d = await artifactD("buzz.team", channel);
    const expected = { channel, type: "buzz.team" as const, d, team: "t1" };
    const team = (title: string, extra: string[][], instructions = "") =>
      sign(
        artifactTemplate({
          ...expected,
          op: "create",
          title,
          content: JSON.stringify({ version: 1, name: "Core", instructions }),
          extra,
        }),
      );
    expect(
      artifactProblem(team("Core", [["team", "t1"]]), expected),
    ).toBeUndefined();
    expect(artifactProblem(team("Other", [["team", "t1"]]), expected)).toMatch(
      /team/,
    );
    expect(artifactProblem(team("Core", []), expected)).toMatch(/Team/);
    expect(
      artifactProblem(team("Core", [["team", "t1"]], "a\u0000"), expected),
    ).toMatch(/U\+0000/);
  });

  it("rejects a valid team envelope whose team id belongs to another channel", async () => {
    const d = await artifactD("buzz.team", channel);
    const label = await teamLabel("builtin-team:core");
    expect(label).toMatch(/^team-[0-9a-f]{59}$/);
    const id = await expectedTeam("builtin-team:core", label);
    await expect(expectedTeam("WRONG-TEAM", label)).rejects.toThrow();
    await expect(expectedTeam("has space", label)).rejects.toThrow();
    const expected = { channel, type: "buzz.team" as const, d, team: id };
    const team = (tag: string[]) =>
      sign(
        artifactTemplate({
          ...expected,
          op: "create",
          title: "Core",
          content: JSON.stringify({
            version: 1,
            name: "Core",
            instructions: "",
          }),
          extra: [tag],
        }),
      );
    expect(
      artifactProblem(team(["team", "builtin-team:core"]), expected),
    ).toBeUndefined();
    expect(artifactProblem(team(["team", "WRONG-TEAM"]), expected)).toMatch(
      /Team/,
    );
    expect(
      artifactProblem(team(["team", "builtin-team:core", "x"]), expected),
    ).toMatch(/Team/);
    const { team: _, ...withoutTeam } = expected;
    expect(
      artifactProblem(team(["team", "builtin-team:core"]), withoutTeam),
    ).toMatch(/Team/);
  });

  it("measures the complete signed event, and fits a maximum snapshot with preserved tags", async () => {
    const d = await artifactD("buzz.agent.instructions", channel);
    const pad = '"'.repeat(ARTIFACT_MAX_CONTENT_BYTES - 64);
    const content = JSON.stringify({ version: 1, text: pad }).slice(
      0,
      ARTIFACT_MAX_CONTENT_BYTES,
    );
    const event = sign(
      artifactTemplate({
        channel,
        type: "buzz.agent.instructions",
        d,
        op: "update",
        prev: "f".repeat(64),
        title: "Agent instructions",
        content,
        extra: Array.from({ length: 15 }, (_, i) => [
          `x${i}`,
          "\\".repeat(4096),
        ]),
      }),
    );
    const size = signedEventBytes(event);
    expect(size).toBe(new TextEncoder().encode(JSON.stringify(event)).length);
    expect(size).toBeGreaterThan(324_071);
    expect(size).toBeLessThanOrEqual(ARTIFACT_MAX_EVENT_BYTES);
  });
});

describe("snapshot reads", () => {
  // `parse_query` in block/buzz `crates/buzz-core/src/artifact.rs`: any key
  // other than these and `#<tag>` is "unsupported artifact predicate".
  const relayArtifactKeys = ["artifact", "kinds", "limit", "offset"];
  const relayAccepts = (filter: object) =>
    Object.keys(filter).every(
      (k) => relayArtifactKeys.includes(k) || /^#./.test(k),
    );

  it("sends a current-heads filter the relay's artifact parser accepts", async () => {
    const sent: unknown[] = [];
    const read: SnapshotRead = async (filters) => {
      sent.push(...filters);
      return [];
    };
    await readCurrent(read, channel);
    expect(sent).toEqual([
      { kinds: [45010], "#h": [channel], artifact: "current", limit: 16 },
    ]);
    expect(relayAccepts(currentFilter(channel))).toBe(true);
    expect(
      relayAccepts({ ...currentFilter(channel), consistency: "strong" }),
    ).toBe(false);
  });

  it("treats two current heads for one d as unavailable, not as whichever came last", async () => {
    const { event: a } = await instructions("A");
    const { event: b } = await instructions("B", a.id);
    const current = await readCurrent(async () => [b], channel);
    expect([...(current?.values() ?? [])]).toEqual([b]);
    expect(await readCurrent(async () => [b, a], channel)).toBeUndefined();
    expect(await readCurrent(async () => [a, b], channel)).toBeUndefined();
  });

  it("never lets an old revision with a later timestamp win the head lookup", async () => {
    const { expected, event: b } = await instructions("B");
    const old = sign({
      ...artifactTemplate({
        ...expected,
        op: "create",
        title: "t",
        content: JSON.stringify({ version: 1, text: "A" }),
      }),
      created_at: b.created_at + 100,
    });
    const { d } = expected;
    const head = (events: RelayEvent[], id = d) =>
      readHead(systemChannelRead(events), channel, id);
    expect(await head([b])).toBe(b);
    expect(await head([b, old])).toBeUndefined();
    expect(await head([old, b])).toBeUndefined();
    expect(await head([b], "other")).toBeUndefined();
  });

  it("names the system channel in #h beside #d, so the relay returns the head", async () => {
    const { expected, event } = await instructions("A");
    const sent: unknown[] = [];
    const read = systemChannelRead([event]);
    expect(
      await readHead(
        async (filters, options) => {
          sent.push(...filters);
          return read(filters, options);
        },
        channel,
        expected.d,
      ),
    ).toBe(event);
    expect(sent).toEqual([
      {
        kinds: [45010],
        "#h": [channel],
        "#d": [expected.d],
        limit: 1,
        consistency: "strong",
      },
    ]);
  });
});

describe("delivery", () => {
  it("classifies refusals by their prefix, not the HTTP status", () => {
    expect(refusal("conflict: prev is not current")).toBe("conflict");
    expect(refusal("duplicate: already have this event")).toBe("duplicate");
    expect(refusal("restricted: not a member")).toBe("permission");
    expect(refusal("restricted: channel is archived")).toBe("archived");
    expect(refusal("invalid: event too large")).toBe("too-large");
    expect(refusal("invalid: bad envelope")).toBe("invalid");
    expect(refusal("rate-limited: slow down")).toBe("rate-limited");
    expect(refusal("Relay rejected the message (400)")).toBe("unknown");
  });

  it("classifies the relay's HTTP refusal bodies through acceptPublish", async () => {
    const { event } = await instructions("hi");
    const signal = new AbortController().signal;
    const through = (response: Response) =>
      deliver(
        writer(() => acceptPublish(response, event.id).then(() => {})),
        event,
        signal,
      );
    const body = (status: number, error: string) =>
      Response.json({ error }, { status });
    expect(
      await through(body(400, "invalid: channel is archived")),
    ).toMatchObject({ status: "refused", refusal: "archived" });
    expect(
      await through(
        body(
          400,
          "invalid: content exceeds maximum size of 131072 bytes (got 131073)",
        ),
      ),
    ).toMatchObject({ status: "refused", refusal: "too-large" });
    expect(await through(body(400, "invalid: missing ar tag"))).toMatchObject({
      status: "refused",
      refusal: "invalid",
      message: "invalid: missing ar tag",
    });
    expect(
      await through(body(403, "blocked: you are banned from this community")),
    ).toMatchObject({ status: "refused", refusal: "permission" });
    expect(await through(body(500, "internal server error"))).toMatchObject({
      status: "uncertain",
    });
    expect(
      await through(new Response("<html>proxy</html>", { status: 403 })),
    ).toMatchObject({
      status: "uncertain",
      message: "Relay rejected the message (403)",
    });
    expect(await through(body(400, "something new"))).toMatchObject({
      status: "uncertain",
      message: "something new",
    });
  });

  it("refuses an event over the relay's size limit before dispatch", async () => {
    const { event } = await instructions("hi");
    let sent = false;
    const huge = { ...event, content: "x".repeat(ARTIFACT_MAX_EVENT_BYTES) };
    const result = await deliver(
      writer(async () => {
        sent = true;
      }),
      huge,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "refused", refusal: "too-large" });
    expect(sent).toBe(false);
  });

  it("refuses an event over a smaller advertised limit before dispatch", async () => {
    const { event } = await instructions("hi");
    let sent = false;
    const result = await deliver(
      writer(async () => {
        sent = true;
      }),
      event,
      new AbortController().signal,
      signedEventBytes(event) - 1,
    );
    expect(result).toMatchObject({ status: "refused", refusal: "too-large" });
    expect(sent).toBe(false);
  });

  it("counts only OK or duplicate-OK as accepted, and never settles a lost answer as refused", async () => {
    const { event } = await instructions("hi");
    const signal = new AbortController().signal;
    expect(
      (
        await deliver(
          writer(async () => {}),
          event,
          signal,
        )
      ).status,
    ).toBe("accepted");
    const dup = writer(async () => {
      throw new PublishRejected("duplicate: already accepted");
    });
    expect((await deliver(dup, event, signal)).status).toBe("accepted");
    const lost = writer(async () => {
      throw new Error("socket closed");
    });
    expect((await deliver(lost, event, signal)).status).toBe("uncertain");
    const untyped = writer(async () => {
      throw new PublishRejected("Relay rejected the message (400)");
    });
    expect((await deliver(untyped, event, signal)).status).toBe("uncertain");
    const conflict = await deliver(
      writer(async () => {
        throw new PublishRejected("conflict: prev is not current");
      }),
      event,
      signal,
    );
    expect(conflict).toMatchObject({ status: "refused", refusal: "conflict" });
  });

  it("never installs an accepted replay that is not the head", async () => {
    const { event: older } = await instructions("old");
    const { event: newer } = await instructions("new", older.id);
    const reads = (head?: RelayEvent): SnapshotRead =>
      systemChannelRead(head ? [head] : []);
    expect(await settle(reads(older), older)).toMatchObject({
      status: "current",
    });
    expect(await settle(reads(newer), older)).toMatchObject({
      status: "superseded",
      head: newer,
    });
    expect(await settle(reads(), older)).toEqual({
      status: "accepted-unavailable",
    });
  });
});
