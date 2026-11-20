import { afterEach, assert, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "./channel-details";
import {
  channelVisibility,
  channelJoinRole,
  canonicalDetailsName,
  detailsSettings,
  detailsTemplate,
  validateDetailsTemplate,
} from "./channel-details-protocol";
import { PublishRejected } from "./outbox";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { SOLO_NAMED_LABEL, SOLO_LABEL } from "../solo/labels";
import type { ReadFilter } from "./events";

const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const id = "11111111-1111-4111-8111-111111111111";
const draft = {
  name: "renamed",
  description: "New description",
  visibility: "private" as const,
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(role = "owner", labels = false) {
  let clock = 100;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], created_at: clock++, content: "" },
      relayKey,
    );
  const metadata = (
    name = "original",
    description = "Old description",
    visibility = "public",
    type = "stream",
    labels: readonly string[] = [],
  ) =>
    record(39000, [
      ["name", name],
      ["about", description],
      [visibility],
      ["t", type],
      ...labels.map((label) => ["t", label]),
    ]);
  let events = [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ];
  const read = vi.fn(async (_filters: readonly ReadFilter[]) => events);
  const sign = vi.fn(async (event: EventTemplate) =>
    finalizeEvent(structuredClone(event), key),
  );
  const publish = vi.fn(async () => {
    events = [
      metadata(draft.name, draft.description, draft.visibility),
      ...events.slice(1),
    ];
  });
  const acceptDiscovery = vi.fn();
  let active = true;
  const owner = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    labels,
    viewer,
    relayAuthor,
    canAccess: () => active,
    acceptDiscovery,
  });
  cleanup.push(owner.dispose);
  const entry = (index: number) => {
    const value = events[index];
    assert(value);
    return value;
  };
  return {
    entry,
    owner,
    read,
    sign,
    publish,
    acceptDiscovery,
    metadata,
    record,
    events: () => events,
    set: (next: RelayEvent[]) => {
      events = next;
    },
    revoke: () => {
      active = false;
    },
  };
}
it.each([undefined, "member"] as const)(
  "changes admission defaults from %s without changing the signed roster, and requires matching readback",
  async (initialRole) => {
    const h = harness();
    const withRole = (role: string) =>
      h.record(39000, [...h.metadata().tags.slice(1), ["join_role", role]]);
    if (initialRole) h.set([withRole(initialRole), ...h.events().slice(1)]);
    const originalRoster = h.entry(2);
    const base = await h.owner.capability.load(id);
    expect(base.joinRole).toBe(initialRole ?? "member");
    const next = { ...base, joinRole: "guest" as const };
    // A relay OK that ignores the new tag must not report success.
    h.publish.mockImplementationOnce(async () => {});
    await expect(h.owner.capability.save(base, next)).rejects.toThrow(
      "may have been saved",
    );
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual([
      "join_role",
      "guest",
    ]);
    expect(
      h.sign.mock.calls[0]?.[0].tags.some(
        ([key]) => key === "p" || key === "role",
      ),
    ).toBe(false);
    h.set([withRole("guest"), ...h.events().slice(1)]);
    await h.owner.capability.check(id);
    expect(h.entry(2)).toBe(originalRoster);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);

it.each(["member", "guest"] as const)(
  "publishes public visibility and the %s admission choice together and verifies both",
  async (joinRole) => {
    const h = harness();
    const initialRole = joinRole === "member" ? "guest" : "member";
    const metadata = (visibility: string, role: string) =>
      h.record(39000, [
        ...h.metadata("original", "Old description", visibility).tags.slice(1),
        ["join_role", role],
      ]);
    h.set([metadata("private", initialRole), ...h.events().slice(1)]);
    const roster = h.entry(2);
    const base = await h.owner.capability.load(id);
    const next = { ...base, visibility: "public" as const, joinRole };
    // A readback confirming visibility alone cannot confirm this combined intent.
    h.publish.mockImplementationOnce(async () => {
      h.set([metadata("public", initialRole), ...h.events().slice(1)]);
    });
    await expect(h.owner.capability.save(base, next)).rejects.toThrow(
      "may have been saved",
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
      ["h", id],
      ["name", base.name],
      ["about", base.description],
      ["visibility", "open"],
      ["join_role", joinRole],
    ]);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.owner.capability.snapshot(id)).toEqual({
      draft: next,
      status: "unconfirmed",
    });
    h.set([metadata("public", joinRole), ...h.events().slice(1)]);
    await h.owner.capability.check(id);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
    expect(h.entry(2)).toBe(roster);
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it.each([undefined, "member", "guest"])(
  "only sends a changed admission role (base %s)",
  (joinRole) => {
    const base = { ...draft, joinRole } as typeof draft & {
      joinRole?: "member" | "guest";
    };
    expect(
      detailsTemplate(id, base, base).tags.some(([key]) => key === "join_role"),
    ).toBe(false);
    for (const role of ["member", "guest"] as const) {
      const event = detailsTemplate(id, { ...base, joinRole: role }, base);
      expect(() => validateDetailsTemplate(event)).not.toThrow();
      expect(event.tags.filter(([key]) => key === "join_role")).toEqual(
        role === joinRole ? [] : [["join_role", role]],
      );
    }
  },
);

it("rejects malformed or elevated admission defaults at the host boundary", () => {
  const event = detailsTemplate(id, draft, draft);
  for (const tags of [
    [["join_role", "owner"]],
    [["join_role", "admin"]],
    [["join_role", "bot"]],
    [["join_role", ""]],
    [["join_role"]],
    [["join_role", "guest", "extra"]],
    [
      ["join_role", "member"],
      ["join_role", "guest"],
    ],
    [
      ["join_role", "guest"],
      ["ttl", "60"],
    ],
  ]) {
    expect(() =>
      validateDetailsTemplate({ ...event, tags: [...event.tags, ...tags] }),
    ).toThrow();
  }
  const h = harness();
  expect(channelJoinRole(h.record(39000, []))).toBe("member");
  for (const tags of [
    [["join_role", "owner"]],
    [
      ["join_role", "member"],
      ["join_role", "guest"],
    ],
  ])
    expect(channelJoinRole(h.record(39000, tags))).toBe("guest");
});

it("saves only after two fresh authority checks and projects confirmed readback", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.acceptDiscovery.mockClear();
  h.read.mockClear();
  await h.owner.capability.save(base, draft);
  expect(h.read).toHaveBeenCalledTimes(3);
  for (const call of h.read.mock.calls as unknown as [unknown, unknown][]) {
    expect(call).toEqual([
      [39000, 39001, 39002].map((kind) => ({
        kinds: [kind],
        consistency: "strong",
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
      })),
      expect.objectContaining({ fresh: true, priority: "foreground" }),
    ]);
  }
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.acceptDiscovery).toHaveBeenCalledWith([h.events()[0]]);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it("confirms channel edits while the replica still has the old metadata", async () => {
  const h = harness();
  const replica = h.events();
  h.read.mockImplementation(async (filters) =>
    filters.every((filter) => filter.consistency === "strong")
      ? h.events()
      : replica,
  );
  const base = await h.owner.capability.load(id);
  await h.owner.capability.save(base, draft);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["owner", "admin", "member"])(
  "derives current direct %s authority",
  async (role) => {
    const h = harness(role);
    const base = await h.owner.capability.load(id);
    expect(base.canEdit).toBe(role !== "member");
    if (role === "member") {
      await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
        "permission",
      );
      expect(h.sign).not.toHaveBeenCalled();
    }
  },
);
it("revoked authority while signing prevents publication", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    h.set([h.entry(0), h.record(39001, []), h.entry(2)]);
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "permission",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("publishes no edit once the caller's guard turns false during signing", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  let eligible = true;
  const active = vi.fn(() => eligible);
  h.sign.mockImplementationOnce(async (event) => {
    eligible = false;
    return finalizeEvent(structuredClone(event), key);
  });
  const error = await h.owner.capability
    .save(base, draft, undefined, active)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ name: "AbortError" });
  expect(active).toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  // Nothing reached the relay, so no unconfirmed attempt blocks a later eligible save.
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  await h.owner.capability.save(base, draft);
  expect(h.publish).toHaveBeenCalledOnce();
});
it("checks the guard only after the final re-authorization read settles", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  let eligible = true;
  const active = vi.fn(() => eligible);
  const started = deferred<void>(),
    gate = deferred<void>();
  h.sign.mockImplementationOnce(async (event) => {
    h.read.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      return h.events();
    });
    return finalizeEvent(structuredClone(event), key);
  });
  const saving = h.owner.capability
    .save(base, draft, undefined, active)
    .catch((error: unknown) => error);
  try {
    await started.promise;
    expect(active).not.toHaveBeenCalled();
    eligible = false;
  } finally {
    gate.resolve();
  }
  expect(await saving).toMatchObject({ name: "AbortError" });
  expect(active).toHaveBeenCalledOnce();
  expect(h.publish).not.toHaveBeenCalled();
  eligible = true;
  await h.owner.capability.save(base, draft, undefined, active);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it("stale edit bases fail before signing", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([h.metadata("changed", "", "private"), ...h.events().slice(1)]);
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("changed");
  expect(h.sign).not.toHaveBeenCalled();
});
it.each([
  ["public", "private", "private"],
  ["private", "public", "open"],
  ["public", "public", undefined],
  ["private", "private", undefined],
] as const)(
  "saves %s → %s with only intentional visibility changes",
  async (before, after, tag) => {
    const h = harness();
    h.set([h.metadata("original", "", before), ...h.events().slice(1)]);
    const base = await h.owner.capability.load(id);
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.metadata(draft.name, draft.description, after),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, { ...draft, visibility: after });
    const command = h.sign.mock.calls[0]?.[0];
    assert(command);
    expect(command.tags.find(([key]) => key === "visibility")).toEqual(
      tag ? ["visibility", tag] : undefined,
    );
    expect(() => validateDetailsTemplate(command)).not.toThrow();
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);
it("a metadata change while signing a reopening prevents publication", async () => {
  const h = harness();
  h.set([h.metadata("original", "", "private"), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    h.set([h.metadata("changed", "", "private"), ...h.events().slice(1)]);
    return finalizeEvent(event, key);
  });
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("Reload details");
  expect(h.publish).not.toHaveBeenCalled();
});
it("unconfirmed reopening retains the public draft and checks without resending", async () => {
  const h = harness();
  h.set([h.metadata("original", "", "private"), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  const reopening = { ...draft, visibility: "public" as const };
  h.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.owner.capability.save(base, reopening)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft: reopening,
    status: "unconfirmed",
  });
  await expect(h.owner.capability.check(id)).rejects.toThrow(
    "may have been saved",
  );
  h.set([
    h.metadata(draft.name, draft.description, "public"),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it("saves retained edits after reloading a channel made private by another editor", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.set([
    h.metadata("other edit", "Other description", "private"),
    ...h.events().slice(1),
  ]);
  await expect(
    h.owner.capability.save(base, { ...draft, visibility: "public" }),
  ).rejects.toThrow("Reload details");
  expect(h.sign).not.toHaveBeenCalled();
  const reloaded = await h.owner.capability.load(id);
  await h.owner.capability.save(reloaded, {
    ...draft,
    visibility: reloaded.visibility,
  });
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
});
it.each(["dm", "archived"])("does not edit %s", async (type) => {
  const h = harness();
  const tags = [
    ["name", "name"],
    ["about", ""],
    ["private"],
    ["t", type === "dm" ? "dm" : "stream"],
    ...(type === "archived" ? [["archived", "true"]] : []),
  ];
  h.set([h.record(39000, tags), ...h.events().slice(1)]);
  const base = await h.owner.capability.load(id);
  expect(base.canEdit).toBe(false);
});
it("rejects unknown visibility, foreign coordinates and malformed admin state", async () => {
  const h = harness();
  for (const metadata of [
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
    ]),
    h.record(39000, [
      ["name", "name"],
      ["t", "stream"],
      ["public"],
      ["private"],
    ]),
    h.record(39000, [
      ["d", "other"],
      ["name", "name"],
      ["t", "stream"],
      ["public"],
    ]),
  ]) {
    expect(() =>
      detailsSettings(
        [metadata, ...h.events().slice(1)],
        id,
        viewer,
        relayAuthor,
      ),
    ).toThrow();
  }
  expect(() => detailsSettings(h.events(), id, viewer, viewer)).toThrow();
  expect(() =>
    detailsSettings(
      [
        h.entry(0),
        h.record(39001, [
          ["p", viewer, "owner"],
          ["p", viewer, "admin"],
        ]),
        h.entry(2),
      ],
      id,
      viewer,
      relayAuthor,
    ),
  ).toThrow();
});
it("rejects an in-place mutated signer response", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.sign.mockImplementationOnce(async (event) => {
    event.tags[1] = ["name", "surprise"];
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Signer changed",
  );
  expect(h.publish).not.toHaveBeenCalled();
});
it("retains edits on rejection but locks unknown outcomes until read-only confirmation", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  h.publish.mockRejectedValueOnce(new PublishRejected("Not permitted"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "Not permitted",
  );
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  h.publish.mockRejectedValueOnce(new Error("lost response"));
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft,
    status: "unconfirmed",
  });
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  await expect(h.owner.capability.check(id)).rejects.toThrow(
    "may have been saved",
  );
  h.set([
    h.metadata(draft.name, draft.description, draft.visibility),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it.each([
  ["initial read", "Could not verify current channel access"],
  ["signing", "Could not sign the channel change"],
  ["final read", "Could not recheck channel access after signing"],
] as const)(
  "identifies a failed %s without publishing or retrying",
  async (phase, context) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    // Native IPC can reject with a plain string; read adapters use Error.
    const failure =
      phase === "signing"
        ? "Relay request failed (503)"
        : new Error("Relay request failed (503)");
    if (phase === "signing") h.sign.mockRejectedValueOnce(failure);
    else {
      if (phase === "final read") h.read.mockResolvedValueOnce(h.events());
      h.read.mockRejectedValueOnce(failure);
    }
    await expect(h.owner.capability.save(base, draft)).rejects.toMatchObject({
      message: `${context}: Relay request failed (503)`,
      cause: failure,
    });
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.sign).toHaveBeenCalledTimes(phase === "initial read" ? 0 : 1);
    expect(h.read).toHaveBeenCalledTimes(phase === "final read" ? 3 : 2);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);
it("receipt alone is not success and repeated Save cannot publish twice", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  const gate = deferred<void>(),
    started = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const result = expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "may have been saved",
  );
  await started.promise;
  await expect(h.owner.capability.save(base, draft)).rejects.toThrow(
    "previous change",
  );
  gate.resolve();
  await result;
  expect(h.owner.capability.snapshot(id)?.status).toBe("unconfirmed");
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each(["cancel", "clear", "dispose"] as const)(
  "%s fences late publication/readback",
  async (action) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    h.acceptDiscovery.mockClear();
    const gate = deferred<void>(),
      started = deferred<void>();
    h.publish.mockImplementationOnce(async () => {
      started.resolve();
      await gate.promise;
      h.set([
        h.metadata(draft.name, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    const result = expect(
      h.owner.capability.save(base, draft),
    ).rejects.toThrow();
    await started.promise;
    h.owner[action]();
    gate.resolve();
    await result;
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
    expect(h.owner.capability.snapshot(id)?.status).toBe(
      action === "dispose" ? undefined : "unconfirmed",
    );
  },
);
it("access loss and an aborted late load cannot update discovery", async () => {
  const h = harness();
  const gate = deferred<RelayEvent[]>();
  h.read.mockImplementationOnce(() => gate.promise);
  const result = expect(h.owner.capability.load(id)).rejects.toThrow();
  h.revoke();
  h.owner.cancel();
  gate.resolve(h.events());
  await result;
  expect(h.acceptDiscovery).not.toHaveBeenCalled();
});
it("admits only bounded name/about/visibility/lifetime metadata and preserves explicit description clearing", () => {
  const template = detailsTemplate(id, { ...draft, description: "" }, draft);
  expect(template.tags).toContainEqual(["about", ""]);
  expect(() => validateDetailsTemplate(template)).not.toThrow();
  const invalid = [
    { ...template, kind: 9000 },
    { ...template, content: "extra" },
    { ...template, tags: [...template.tags, ["ttl", "0"]] },
    ...["public", "", "hidden"].map((value) => ({
      ...template,
      tags: [...template.tags.slice(0, 3), ["visibility", value]],
    })),
    {
      ...template,
      tags: [
        ["h", id],
        ["name", " "],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "x".repeat(121)],
        ["about", ""],
      ],
    },
    {
      ...template,
      tags: [
        ["h", id],
        ["name", "name"],
        ["about", "x".repeat(1001)],
      ],
    },
  ];
  invalid.push({
    ...template,
    tags: [
      ["h", id],
      ["name", "name"],
      ["about", `Buzz Huddle (buzz.huddles/v1)\nparent:${id}`],
    ],
  });
  for (const event of invalid)
    expect(() => validateDetailsTemplate(event)).toThrow();
  const h = harness();
  expect(channelVisibility(h.record(39000, []))).toBeUndefined();
});

it("production session wiring updates shared discovery and cancels a retiring owner's read", async () => {
  const h = harness();
  const owner = createRelaySession({
    viewer,
    relayAuthor,
    query: async (filters: readonly ReadFilter[]) =>
      h
        .events()
        .filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
    channelDetails: { sign: h.sign, publish: h.publish },
    media: (url) => url,
  });
  cleanup.push(owner.dispose);
  owner.session.channels.refreshList?.();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const base = await owner.session.channelDetails.load(id);
  await owner.session.channelDetails.save(base, draft);
  expect(owner.session.channels.list().channels[0]).toMatchObject({
    name: draft.name,
    description: draft.description,
    visibility: "private",
  });
  owner.dispose();
  await expect(owner.session.channelDetails.load(id)).rejects.toThrow();
});

it.each([
  ["\u0085# \u0085#renamed\u0085", "renamed"],
  ["\t # # renamed\u00a0", "renamed"],
  ["\u2000#renamed\u3000", "renamed"],
  ["\ufeffrenamed\ufeff", "\ufeffrenamed\ufeff"],
  ["re\u0085named#", "re\u0085named#"],
])(
  "uses relay canonicalization for %j before signing and confirming",
  async (input, expected) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    const name = canonicalDetailsName(input);
    expect(name).toBe(expected);
    if (input !== expected) {
      await expect(
        h.owner.capability.save(base, { ...draft, name: input }),
      ).rejects.toThrow("Enter a channel name");
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.owner.capability.snapshot(id)).toBeUndefined();
      const command = detailsTemplate(id, draft, draft);
      command.tags[1] = ["name", input];
      expect(() => validateDetailsTemplate(command)).toThrow(
        "Enter a channel name",
      );
    }
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.metadata(expected, draft.description, draft.visibility),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, { ...draft, name });
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["name", expected]);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it.each([undefined, 3600, 2147483647])(
  "reads exact duration %s from signed metadata",
  async (ttlSeconds) => {
    const h = harness();
    h.set([
      h.record(39000, [
        ...h.entry(0).tags.slice(1),
        ...(ttlSeconds === undefined ? [] : [["ttl", String(ttlSeconds)]]),
      ]),
      ...h.events().slice(1),
    ]);
    expect((await h.owner.capability.load(id)).ttlSeconds).toBe(ttlSeconds);
  },
);
it.each([
  [["ttl"]],
  [["ttl", ""]],
  [["ttl", "0"]],
  [["ttl", "2147483648"]],
  [["ttl", "60", "extra"]],
  [
    ["ttl", "60"],
    ["ttl", "60"],
  ],
])("rejects ambiguous or invalid metadata duration %j", async (...tags) => {
  const h = harness();
  h.set([
    h.record(39000, [...h.entry(0).tags.slice(1), ...tags]),
    ...h.events().slice(1),
  ]);
  await expect(h.owner.capability.load(id)).rejects.toThrow();
});
it.each([
  [undefined, 604800, "604800"],
  [3600, undefined, ""],
  [3600, 3600, undefined],
])(
  "saves duration %s → %s without resetting unchanged cleanup deadlines",
  async (before, after, tag) => {
    const h = harness();
    const metadata = (ttl: number | undefined) =>
      h.record(39000, [
        ["name", draft.name],
        ["about", draft.description],
        ["private"],
        ["t", "stream"],
        ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
      ]);
    h.set([metadata(before), ...h.events().slice(1)]);
    const base = await h.owner.capability.load(id);
    h.publish.mockImplementationOnce(async () => {
      h.set([metadata(after), ...h.events().slice(1)]);
    });
    await h.owner.capability.save(base, { ...draft, ttlSeconds: after });
    const command = h.sign.mock.calls[0]?.[0];
    expect(command?.tags.filter(([key]) => key === "ttl")).toEqual(
      tag === undefined ? [] : [["ttl", tag]],
    );
    expect(() =>
      validateDetailsTemplate(command as EventTemplate),
    ).not.toThrow();
    expect((await h.owner.capability.load(id)).ttlSeconds).toBe(after);
  },
);
it("locks a mismatched lifetime readback and only clears it after matching read-only confirmation", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  const temporary = { ...draft, ttlSeconds: 604800 };
  await expect(h.owner.capability.save(base, temporary)).rejects.toThrow(
    "may have been saved",
  );
  expect(h.owner.capability.snapshot(id)).toEqual({
    draft: temporary,
    status: "unconfirmed",
  });
  h.set([
    h.record(39000, [...h.entry(0).tags.slice(1), ["ttl", "604800"]]),
    ...h.events().slice(1),
  ]);
  await h.owner.capability.check(id);
  expect(h.owner.capability.snapshot(id)).toBeUndefined();
  expect(h.publish).toHaveBeenCalledOnce();
});
it.each([0, 1.5, 2147483648, "60"])(
  "rejects invalid draft duration %j before signing",
  async (ttlSeconds) => {
    const h = harness();
    const base = await h.owner.capability.load(id);
    await expect(
      h.owner.capability.save(base, {
        ...draft,
        ttlSeconds: ttlSeconds as number,
      }),
    ).rejects.toThrow("duration");
    expect(h.sign).not.toHaveBeenCalled();
  },
);
it("allows only a single canonical TTL command tag without widening other fields", () => {
  const template = detailsTemplate(id, draft, draft);
  for (const tail of [
    [["ttl"]],
    [["ttl", "0"]],
    [["ttl", "-1"]],
    [["ttl", "1.5"]],
    [["ttl", "01"]],
    [["ttl", "2147483648"]],
    [["ttl", "60", "extra"]],
    [
      ["ttl", "60"],
      ["ttl", "60"],
    ],
    [
      ["ttl", "60"],
      ["visibility", "private"],
    ],
    [["visibility,ttl", "private"]],
    [["", ""]],
    [["archived", "true"]],
  ])
    expect(() =>
      validateDetailsTemplate({
        ...template,
        tags: [...template.tags.slice(0, 3), ...tail],
      }),
    ).toThrow();
  for (const ttl of ["", "1", "604800", "2147483647"]) {
    for (const tags of [
      template.tags,
      [...template.tags, ["visibility", "private"]],
      [...template.tags, ["visibility", "open"]],
    ])
      expect(() =>
        validateDetailsTemplate({ ...template, tags: [...tags, ["ttl", ttl]] }),
      ).not.toThrow();
  }
});

it.each([false, true])(
  "promotes a Solo chat in place by clearing its label (public/temporary=%s)",
  async (changed) => {
    const h = harness("owner", true);
    h.set([
      h.metadata("Work", "Notes", "private", "stream", [SOLO_LABEL]),
      ...h.events().slice(1),
    ]);
    const base = await h.owner.capability.load(id);
    const promotion = {
      name: "Work",
      description: "Notes",
      visibility: changed ? ("public" as const) : ("private" as const),
      labels: [],
      ...(changed ? { ttlSeconds: 600 } : {}),
    };
    h.publish.mockImplementationOnce(async () => {
      h.set([
        h.record(39000, [
          ["name", promotion.name],
          ["about", "Notes"],
          [promotion.visibility],
          ["t", "stream"],
          ...(changed ? [["ttl", "600"]] : []),
        ]),
        ...h.events().slice(1),
      ]);
    });
    await h.owner.capability.save(base, promotion);
    const command = h.sign.mock.calls[0]?.[0];
    assert(command);
    expect(command.tags).toEqual([
      ["h", id],
      ["name", "Work"],
      ["about", "Notes"],
      ...(changed
        ? [
            ["visibility", "open"],
            ["ttl", "600"],
          ]
        : []),
      ["t", ""],
    ]);
    expect(() => validateDetailsTemplate(command)).not.toThrow();
    expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
    expect(h.owner.capability.snapshot(id)).toBeUndefined();
  },
);

it("writes NIP-CL labels only when the set changes, and admits only valid label tails", () => {
  const base = { ...draft, labels: ["for-you", "demo"] };
  const tagsOf = (labels?: readonly string[]) =>
    detailsTemplate(id, { ...draft, labels }, base).tags;
  // Absent or the same set (any order) sends no `t`, so the relay keeps it.
  expect(tagsOf(undefined).some(([key]) => key === "t")).toBe(false);
  expect(tagsOf(["demo", "for-you"]).some(([key]) => key === "t")).toBe(false);
  // A new set replaces it; an empty set clears it with one empty `t`.
  expect(tagsOf(["for-you", "app:records"]).slice(3)).toEqual([
    ["t", "for-you"],
    ["t", "app:records"],
  ]);
  expect(tagsOf([]).slice(3)).toEqual([["t", ""]]);
  for (const labels of [["for-you"], [], ["a", "b", "c"]]) {
    const template = detailsTemplate(id, { ...draft, labels }, base);
    expect(() => validateDetailsTemplate(template)).not.toThrow();
  }
  for (const labels of [["System"], ["stream"], ["x".repeat(65)], ["a b"]])
    expect(() => tagsOf(labels)).toThrow(/channel labels/);
  expect(() => tagsOf(Array.from({ length: 9 }, (_, n) => `l${n}`))).toThrow(
    /at most 8/,
  );
  const head = [
    ["h", id],
    ["name", "renamed"],
    ["about", ""],
  ];
  for (const tail of [
    [["t", "system"]],
    [
      ["t", "a"],
      ["t", "a"],
    ],
    [
      ["t", ""],
      ["t", "a"],
    ],
    [
      ["t", "a"],
      ["visibility", "open"],
    ],
    [["t", "a", "extra"]],
    Array.from({ length: 9 }, (_, n) => ["t", `l${n}`]),
  ])
    expect(() =>
      validateDetailsTemplate({
        kind: 9002,
        created_at: 1,
        content: "",
        tags: [...head, ...tail],
      }),
    ).toThrow();
  expect(() =>
    validateDetailsTemplate({
      kind: 9002,
      created_at: 1,
      content: "",
      tags: [...head, ["visibility", "open"], ["ttl", ""], ["t", "a"]],
    }),
  ).not.toThrow();
});

it("refuses a label change without signing when the relay does not advertise NIP-CL", async () => {
  const old = harness();
  const base = await old.owner.capability.load(id);
  expect(base.labels).toEqual([]);
  await expect(
    old.owner.capability.save(base, { ...draft, labels: ["for-you"] }),
  ).rejects.toThrow(/does not support channel labels/);
  expect(old.sign).not.toHaveBeenCalled();
  // Other edits still save, with the unchanged (empty) label set.
  await old.owner.capability.save(base, { ...draft, labels: [] });
  expect(old.publish).toHaveBeenCalledOnce();

  const supported = harness("owner", true);
  const current = await supported.owner.capability.load(id);
  await supported.owner.capability
    .save(current, { ...draft, labels: ["for-you"] })
    .catch(() => {});
  expect(supported.sign).toHaveBeenCalledOnce();
  expect(supported.sign.mock.calls[0]?.[0].tags).toContainEqual([
    "t",
    "for-you",
  ]);
});

it("rejects the Huddle marker before signing an ordinary channel edit", async () => {
  const h = harness();
  const base = await h.owner.capability.load(id);
  await expect(
    h.owner.capability.save(base, {
      ...draft,
      description: `Buzz Huddle (buzz.huddles/v1)\nparent:${id}`,
    }),
  ).rejects.toThrow("Buzz Huddle (");
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each([undefined, 600])(
  "Solo naming preserves other NIP-CL labels with lifetime %s",
  async (ttlSeconds) => {
    const h = harness("owner", true);
    const metadata = (name: string, ttl?: number) =>
      h.record(39000, [
        ["name", name],
        ["about", ""],
        ["private"],
        ["t", "stream"],
        ["t", SOLO_LABEL],
        ["t", "for-you"],
        ...(name === "Named" ? [["t", SOLO_NAMED_LABEL]] : []),
        ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
      ]);
    h.set([metadata("First prompt"), ...h.events().slice(1)]);
    const base = await h.owner.capability.load(id);
    expect(base.labels).toEqual([SOLO_LABEL, "for-you"]);
    h.publish.mockImplementationOnce(async () =>
      h.set([metadata("Named", ttlSeconds), ...h.events().slice(1)]),
    );
    await h.owner.capability.save(base, { ...base, name: "Named", ttlSeconds });
    const command = h.sign.mock.calls[0]?.[0];
    assert(command);
    expect(command.tags).toEqual([
      ["h", id],
      ["name", "Named"],
      ["about", ""],
      ...(ttlSeconds === undefined ? [] : [["ttl", String(ttlSeconds)]]),
      ["t", SOLO_LABEL],
      ["t", "for-you"],
      ["t", SOLO_NAMED_LABEL],
    ]);
    expect(() => validateDetailsTemplate(command)).not.toThrow();
    expect(h.acceptDiscovery).toHaveBeenLastCalledWith([h.events()[0]]);
    expect((await h.owner.capability.load(id)).labels).toEqual([
      SOLO_LABEL,
      "for-you",
      SOLO_NAMED_LABEL,
    ]);
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it.each(["away and back", "rejection", "disposal"] as const)(
  "retires the local Solo rename marker after %s",
  async (ending) => {
    const h = harness("owner", true);
    const details = h.owner.capability;
    h.set([
      h.metadata("First prompt", "", "private", "stream", [SOLO_LABEL]),
      ...h.events().slice(1),
    ]);
    const base = await details.load(id);
    const next = { ...base, name: "Release notes" };
    let name = base.name;
    const listeners = new Set<() => void>();
    const channels = {
      get: () => ({ id, name }),
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const observe = (title: string) => {
      name = title;
      for (const listener of listeners) listener();
    };
    const marker = () => details.localRename?.(id, next.name);
    h.publish.mockImplementationOnce(async () => {
      expect(marker()).toBeDefined();
      if (ending === "rejection") throw new PublishRejected("Not permitted");
      h.set([
        h.metadata(next.name, "", "private", "stream", [
          SOLO_LABEL,
          SOLO_NAMED_LABEL,
        ]),
        ...h.events().slice(1),
      ]);
      observe(next.name);
    });
    const save = details.save(base, next, undefined, undefined, channels);
    if (ending === "rejection") {
      await expect(save).rejects.toThrow("Not permitted");
    } else {
      await save;
      expect(marker()).toBeDefined();
      if (ending === "disposal") h.owner.dispose();
      else {
        observe(base.name);
        observe(next.name);
      }
    }
    expect(marker()).toBeUndefined();
    expect(listeners.size).toBe(0);
  },
);

it("refuses chosen-name label overflow before signing and retains the existing label set", async () => {
  const h = harness("owner", true);
  const labels = [
    SOLO_LABEL,
    ...Array.from({ length: 7 }, (_, i) => `label-${i}`),
  ];
  h.set([
    h.record(39000, [
      ["name", "Prompt"],
      ["about", ""],
      ["private"],
      ["t", "stream"],
      ...labels.map((label) => ["t", label]),
    ]),
    ...h.events().slice(1),
  ]);
  const base = await h.owner.capability.load(id);
  await expect(
    h.owner.capability.save(base, { ...base, name: "Chosen" }),
  ).rejects.toThrow("at most 8");
  expect(h.sign).not.toHaveBeenCalled();
  expect((await h.owner.capability.load(id)).labels).toEqual(labels);
});

it.each([false, true])(
  "keeps region labels during label replacement, including rename=%s",
  async (rename) => {
    const h = harness("owner", true);
    const region = "buzz.region:example:work";
    h.set([
      h.metadata("Original", "", "private", "stream", [SOLO_LABEL, region]),
      ...h.events().slice(1),
    ]);
    const base = await h.owner.capability.load(id);
    const name = rename ? "Renamed" : "Original";
    const expected = [
      SOLO_LABEL,
      "new-label",
      region,
      ...(rename ? [SOLO_NAMED_LABEL] : []),
    ];
    h.publish.mockImplementationOnce(async () =>
      h.set([
        h.metadata(name, "", "private", "stream", expected),
        ...h.events().slice(1),
      ]),
    );
    await h.owner.capability.save(base, {
      ...base,
      name,
      labels: [SOLO_LABEL, "new-label"],
    });
    expect(
      h.sign.mock.calls[0]?.[0].tags.filter(([tag]) => tag === "t"),
    ).toEqual(expected.map((label) => ["t", label]));
    expect((await h.owner.capability.load(id)).labels).toEqual(expected);
  },
);

it("keeps a region label when an editor replaces the label set with empty", async () => {
  const h = harness("owner", true);
  const region = "buzz.region:example:work";
  h.set([
    h.metadata("Original", "", "private", "stream", [SOLO_LABEL, region]),
    ...h.events().slice(1),
  ]);
  const base = await h.owner.capability.load(id);
  h.publish.mockImplementationOnce(async () =>
    h.set([
      h.metadata("Original", "", "private", "stream", [region]),
      ...h.events().slice(1),
    ]),
  );
  await h.owner.capability.save(base, { ...base, labels: [] });
  expect((await h.owner.capability.load(id)).labels).toEqual([region]);
});
