import { expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import {
  decodeSidebarPreferences,
  assertSidebarAssignmentIntent,
  prepareSidebarAssignment,
  mutateSidebarAssignment,
} from "./sidebar-preferences.mjs";

const secret = generateSecretKey();
const id = "12345678-1234-1234-1234-123456789abc";
const emptyWorkspace = { sections: [], assignments: {} };
const intent = { channelId: "alpha", createSection: { id, name: " Launch " } };
function event(blob, coordinate = "channel-workspaces") {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return finalizeEvent(
      {
        kind: 30078,
        created_at: 5,
        tags: [["d", coordinate]],
        content: nip44.v2.encrypt(
          JSON.stringify(
            coordinate === "channel-workspaces"
              ? { sectionOrder: [], ...blob }
              : blob,
          ),
          key,
        ),
      },
      secret,
    );
  } finally {
    key.fill(0);
  }
}
function decode(record) {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return JSON.parse(nip44.v2.decrypt(record.content, key));
  } finally {
    key.fill(0);
  }
}
it("creates and assigns together in one compact record and keeps retry idempotent", () => {
  const blob = {
    version: 1,
    future: { enabled: true },
    sections: [{ id: "work", name: "Work", order: 3, future: "keep" }],
    assignments: { beta: "work", hidden: "missing" },
  };
  const created = prepareSidebarAssignment([event(blob)], intent, secret);
  expect(decode(created.event)).toEqual({
    version: 1,
    sectionOrder: [],
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id, name: "Launch", order: 1 },
    ],
    assignments: { beta: "work", alpha: id },
    unifiedOnly: "BQ", // Sorted section and filing bits for Launch and alpha.
  });
  expect(
    prepareSidebarAssignment([created.event], intent, secret).event,
  ).toBeUndefined();
  expect(() =>
    prepareSidebarAssignment(
      [created.event],
      { ...intent, createSection: { id, name: "Different" } },
      secret,
    ),
  ).toThrow("changed");
});
it.each(["📚", ":books:"])(
  "creates and confirms the requested %s icon",
  (icon) => {
    const create = {
      createSection: { id, name: " Launch ", icon },
    };
    const created = prepareSidebarAssignment(
      [],
      create,
      secret,
      Date.now(),
      emptyWorkspace,
    );
    const saved = decode(created.event);
    expect(saved.sections).toEqual([{ id, name: "Launch", icon, order: 0 }]);
    expect(
      prepareSidebarAssignment([created.event], create, secret).event,
    ).toBeUndefined();
    expect(
      prepareSidebarAssignment(
        [created.event],
        { createSection: { id, name: "Launch" } },
        secret,
      ).event,
    ).toBeUndefined();
    expect(() =>
      prepareSidebarAssignment(
        [created.event],
        { createSection: { id, name: "Launch", icon: "Other" } },
        secret,
      ),
    ).toThrow("changed");
  },
);

it.each([
  { ...intent, createSection: { id, name: " " } },
  { ...intent, createSection: { id, name: "Launch", icon: " " } },
  { ...intent, createSection: { id, name: "Launch", icon: null } },
  { ...intent, createSection: { id: "__proto__", name: "Launch" } },
  { ...intent, createSection: { id, name: "Launch", position: "last" } },
  { ...intent, createSection: { id, name: "Launch", position: 0 } },
])("rejects malformed create intent before writing: %j", (value) => {
  expect(() => assertSidebarAssignmentIntent(value)).toThrow("Invalid");
});
it("enforces section limits and refuses an invalid or unreadable current head", () => {
  const full = {
    version: 1,
    sections: Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: String(i),
      order: i,
    })),
    assignments: {},
  };
  expect(() => prepareSidebarAssignment([event(full)], intent, secret)).toThrow(
    "Unsupported",
  );
  expect(() =>
    prepareSidebarAssignment([event({ ...full, version: 2 })], intent, secret),
  ).toThrow("Unsupported");
  const unreadable = event({ version: 1, sections: [], assignments: {} });
  expect(() =>
    prepareSidebarAssignment(
      [{ ...JSON.parse(JSON.stringify(unreadable)), content: "broken" }],
      intent,
      secret,
    ),
  ).toThrow("Invalid");
});
it.each([intent, { createSection: intent.createSection }])(
  "failed confirmation may follow publication; retry confirms the same section without another write: %j",
  async (creation) => {
    let head;
    let reads = 0;
    let publications = 0;
    const read = async () => {
      if (++reads === 2) throw new Error("confirmation offline");
      return head ? [head] : [];
    };
    const publish = async (value) => {
      publications++;
      head = value;
    };
    await expect(
      mutateSidebarAssignment(creation, secret, read, publish, emptyWorkspace),
    ).rejects.toThrow("confirmation offline");
    expect(decode(head).sections).toEqual([{ id, name: "Launch", order: 0 }]);
    const groups = await mutateSidebarAssignment(
      creation,
      secret,
      read,
      publish,
    );
    expect(groups.sections).toEqual([{ id, name: "Launch", order: 0 }]);
    expect(groups.assignments).toEqual(creation.channelId ? { alpha: id } : {});
    expect(publications).toBe(1);
  },
);
it("a failed initial read never seeds or publishes", async () => {
  let publications = 0;
  await expect(
    mutateSidebarAssignment(
      intent,
      secret,
      async () => {
        throw new Error("offline");
      },
      async () => {
        publications++;
      },
    ),
  ).rejects.toThrow("offline");
  expect(publications).toBe(0);
});

it("decodes all encrypted preferences despite oversized deleted text without rewriting it", () => {
  const reg = (value) => [100, "1111111111111111", value];
  const blob = {
    version: 1,
    sections: [{ id: "stale", name: "Stale", order: 0 }],
    assignments: {},
    meta: {
      v: 1,
      s: {
        work: { name: reg("Work"), order: reg(0), live: reg(true) },
        dead: {
          name: reg("x".repeat(257)),
          icon: reg("i".repeat(129)),
          live: reg(false),
        },
      },
      a: { alpha: reg("work"), beta: reg("dead") },
    },
  };
  const head = event(blob);
  expect(
    decodeSidebarPreferences(
      [
        head,
        event(
          { version: 1, channels: { alpha: { starred: true, updatedAt: 1 } } },
          "channel-stars",
        ),
        event(
          { version: 1, channels: { beta: { muted: true, updatedAt: 1 } } },
          "channel-mutes",
        ),
        event({ version: 1, groups: { channels: "recent" } }, "channel-sort"),
      ],
      secret,
    ),
  ).toEqual({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
    sectionOrder: [],
    starred: ["alpha"],
    muted: ["beta"],
    sort: { channels: "recent" },
  });
  expect(decode(head)).toEqual({ ...blob, sectionOrder: [] });
});

it("creates at the top in one event, preserves existing orders and keeps retry idempotent", () => {
  const first = {
    ...intent,
    createSection: { ...intent.createSection, position: "first" },
  };
  const created = prepareSidebarAssignment(
    [
      event({
        version: 1,
        sections: [{ id: "work", name: "Work", order: -7 }],
        assignments: {},
      }),
    ],
    first,
    secret,
  );
  const saved = decode(created.event);
  expect(saved.sections.map(({ id }) => id)).toEqual([id, "work"]);
  expect(saved.assignments).toEqual({ alpha: id });
  expect(
    prepareSidebarAssignment([created.event], first, secret).event,
  ).toBeUndefined();
});

it("appends after the rounded order imported from a fractional legacy head", () => {
  const created = prepareSidebarAssignment(
    [
      event({
        version: 1,
        sections: [{ id: "work", name: "Work", order: 0.5 }],
        assignments: {},
      }),
    ],
    intent,
    secret,
  );
  const saved = decode(created.event);
  expect(saved.sections).toEqual([
    { id: "work", name: "Work", order: 0 },
    { id, name: "Launch", order: 1 },
  ]);
});

it.each([
  { assignment: undefined, oversized: false },
  { assignment: null, oversized: false },
  { assignment: "dead", oversized: false },
  { assignment: undefined, oversized: true },
  { assignment: null, oversized: true },
  { assignment: "dead", oversized: true },
])(
  "does not publish an already-clear assignment: %j",
  async ({ assignment, oversized }) => {
    const reg = (value) => [100, "1111111111111111", value];
    const blob = {
      version: 1,
      sections: [{ id: "stale", name: "Stale", order: 0 }],
      assignments: { alpha: "stale" },
      meta: {
        v: 1,
        s: {
          work: { name: reg("Work"), live: reg(true), order: reg(0) },
          dead: {
            name: reg(oversized ? "x".repeat(257) : "Deleted"),
            live: reg(false),
          },
        },
        a: {
          ...(assignment === undefined ? {} : { alpha: reg(assignment) }),
          beta: reg("work"),
        },
      },
    };
    let head = event(blob);
    const publications = [];
    const groups = await mutateSidebarAssignment(
      { channelId: "alpha" },
      secret,
      async () => [head],
      async (value) => {
        publications.push(value);
        head = value;
      },
    );
    expect(groups).toMatchObject({
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { beta: "work" },
    });
    expect(publications).toEqual([]);
    expect(decode(head)).toEqual({ ...blob, sectionOrder: [] });
  },
);

it("creates an empty section without changing any assignments, and confirms the same ID on retry", async () => {
  const create = { createSection: { id, name: " Launch " } };
  let head = event({
    version: 1,
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
  });
  const publications = [];
  const read = async () => [head];
  const publish = async (record) => {
    publications.push(record);
    head = record;
  };
  const groups = await mutateSidebarAssignment(create, secret, read, publish);
  expect(groups.sections).toEqual([
    { id: "work", name: "Work", order: 0 },
    { id, name: "Launch", order: 1 },
  ]);
  expect(groups.assignments).toEqual({ alpha: "work" });
  expect(decode(head).assignments).not.toHaveProperty("undefined");
  expect(await mutateSidebarAssignment(create, secret, read, publish)).toEqual(
    groups,
  );
  expect(publications).toHaveLength(1);
});

it.each([
  {},
  { sectionId: "work" },
  { createSection: { id, name: " " } },
  { channelId: null, createSection: { id, name: "Launch" } },
])("rejects invalid empty-section envelopes: %j", (intent) => {
  expect(() => assertSidebarAssignmentIntent(intent)).toThrow("Invalid");
});
