// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { eventDto } from "../relay/events";
import { createProfileDirectory } from "../relay/profile-directory";
import { keypair, signed } from "../relay/testing";
import type { VerifiedProfile } from "../relay/verified-profile";
import { setNamePreference } from "./name-preference";
import {
  useVerifiedNames,
  withVerifiedNames,
  type VerifiedNamesSession,
} from "./useVerifiedNames";

const key = (n: number) => n.toString(16).padStart(64, "0");
const name = (displayName: string, fullName?: string): VerifiedProfile => ({
  displayName,
  username: displayName,
  ...(fullName ? { fullName } : {}),
  issuerLabel: "Block",
  verifiedAt: 1,
  status: "checked",
  multipleIssuers: false,
});

function fake(shared = new Map<string, { verified?: VerifiedProfile }>()) {
  let authority: { pubkey: string; multipleIssuers: boolean } | undefined = {
    pubkey: key(99),
    multipleIssuers: false,
  };
  const listeners = new Set<() => void>();
  const held = new Set<string>();
  // The revision each held head arrived in, as the shared directory keeps it.
  const arrived = new Map<string, number>();
  let revision = 0;
  const reads: { subjects: readonly string[]; signal: AbortSignal }[] = [];
  let release = () => {};
  let hold = false;
  const verified = vi.fn(
    async (subjects: readonly string[], signal: AbortSignal) => {
      reads.push({ subjects, signal });
      const asked = authority;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return asked
        ? {
            authority: asked,
            profiles: new Map(
              subjects.map((subject) => [subject, name(`v${subject.at(-1)}`)]),
            ),
          }
        : undefined;
    },
  );
  const session = {
    profiles: {
      snapshot: () => shared,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
      verifiedAuthority: () => authority,
      verifiedHeld: (pubkey: string) => held.has(pubkey),
      verifiedRevision: () => revision,
      verifiedSince: (pubkey: string, since: number) =>
        (arrived.get(pubkey) ?? 0) > since,
    },
    directMessages: { verified },
  } as unknown as VerifiedNamesSession;
  return {
    session,
    reads,
    verified,
    holdReads() {
      hold = true;
    },
    release: () => release(),
    /** The shared directory takes a head for `pubkey`, verified or not. */
    hold(pubkey: string) {
      held.add(pubkey);
      arrived.set(pubkey, ++revision);
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    /** The shared cache evicts that head. */
    evict(pubkey: string) {
      held.delete(pubkey);
      revision++;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    setAuthority(next: typeof authority) {
      authority = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("reads unasked people once per session, skipping agents and shared names, across remounts", async () => {
  const shared = new Map([[key(2), { verified: name("known") }]]);
  const t = fake(shared);
  const people = [
    { pubkey: key(1) },
    { pubkey: key(2) },
    { pubkey: key(3), isAgent: true },
  ];
  const first = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(first.result.current.get(key(1))).toBeDefined());
  expect(t.reads.map((read) => read.subjects)).toEqual([[key(1)]]);
  first.unmount();
  // A composer completion remounts per keystroke; it does not ask again.
  const second = renderHook(() => useVerifiedNames(t.session, people));
  expect(second.result.current.get(key(1))?.displayName).toBe("v1");
  expect(t.verified).toHaveBeenCalledOnce();
});

it("cancels a read when the people change, and names nothing for a withdrawn authority until checked again", async () => {
  const t = fake();
  t.holdReads();
  let people = [{ pubkey: key(1) }];
  const hook = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(t.reads).toHaveLength(1));
  people = [{ pubkey: key(2) }];
  hook.rerender();
  expect(t.reads[0]?.signal.aborted).toBe(true);
  await waitFor(() => expect(t.reads).toHaveLength(2));
  await act(async () => t.release());
  await waitFor(() => expect(hook.result.current.get(key(2))).toBeDefined());
  t.setAuthority(undefined);
  expect(hook.result.current.size).toBe(0);
  // Re-enabled, the same key is a new authority object: it reads again.
  t.setAuthority({ pubkey: key(99), multipleIssuers: false });
  await waitFor(() => expect(t.reads).toHaveLength(3));
  expect(hook.result.current.size).toBe(0);
  await act(async () => t.release());
  await waitFor(() => expect(hook.result.current.get(key(2))).toBeDefined());
});

it("reads nothing where the session cannot check verified names", () => {
  const t = fake();
  const session = { ...t.session, directMessages: {} };
  const hook = renderHook(() =>
    useVerifiedNames(session, [{ pubkey: key(1) }]),
  );
  expect(hook.result.current.size).toBe(0);
  expect(t.verified).not.toHaveBeenCalled();
});

it("names people by shared, then searched, verified names and keeps what found them", () => {
  const people = [
    { pubkey: key(1), name: "Fake", username: "fak" },
    { pubkey: key(2), name: "Bea" },
    { pubkey: key(3), name: "Cy" },
  ];
  const page = new Map([
    [key(1), name("page")],
    [key(2), name("bname", "Bea Name")],
  ]);
  const shared = new Map([[key(1), { verified: name("fname", "Fake Name") }]]);
  expect(withVerifiedNames(people, page, shared)).toEqual([
    {
      pubkey: key(1),
      name: "fname",
      username: "fname",
      fullName: "Fake Name",
      profileNames: ["Fake", "fak"],
    },
    {
      pubkey: key(2),
      name: "bname",
      username: "bname",
      fullName: "Bea Name",
      profileNames: ["Bea"],
    },
    people[2],
  ]);
  // Nobody verified: the same array.
  expect(withVerifiedNames(people, new Map(), new Map())).toBe(people);
});

it("asks every page of a longer list, and asks again once a lookup is stale", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const t = fake();
    const people = Array.from({ length: 45 }, (_, n) => ({
      pubkey: key(n + 1),
    }));
    const hook = renderHook(() => useVerifiedNames(t.session, people));
    await waitFor(() => expect(hook.result.current.size).toBe(45));
    expect(t.reads.map((read) => read.subjects.length)).toEqual([30, 15]);
    // Within the discovery refresh interval a remount asks nobody.
    hook.unmount();
    renderHook(() => useVerifiedNames(t.session, people)).unmount();
    expect(t.reads).toHaveLength(2);
    vi.advanceTimersByTime(5 * 60_000);
    const later = renderHook(() => useVerifiedNames(t.session, people));
    await waitFor(() => expect(t.reads).toHaveLength(4));
    expect(later.result.current.size).toBe(45);
  } finally {
    vi.useRealTimers();
  }
});

it("starts no read until the list settles, and a new query cancels a held one", async () => {
  const t = fake();
  t.holdReads();
  const people = [{ pubkey: key(1) }];
  let options = { key: "fak", settled: false };
  const hook = renderHook(() => useVerifiedNames(t.session, people, options));
  expect(t.reads).toHaveLength(0);
  options = { key: "fak", settled: true };
  hook.rerender();
  await waitFor(() => expect(t.reads).toHaveLength(1));
  // Typing on: the same page stays shown while the next one loads.
  options = { key: "kevi", settled: false };
  hook.rerender();
  expect(t.reads[0]?.signal.aborted).toBe(true);
  expect(t.reads).toHaveLength(1);
});

it("asks each person of a list larger than the cache once, and stops", async () => {
  const t = fake();
  const people = Array.from({ length: 1050 }, (_, n) => ({
    pubkey: key(n + 1),
  }));
  const hook = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(hook.result.current.size).toBe(1024));
  // Settle any further passes before counting.
  await act(async () => {});
  const asked = t.reads.flatMap((read) => read.subjects);
  expect(t.reads).toHaveLength(35);
  expect(new Set(asked).size).toBe(asked.length);
  expect(asked).toHaveLength(1024);
});

it("yields to a head the shared directory holds, so a later revocation is not undone", async () => {
  const t = fake();
  const people = [{ pubkey: key(1) }, { pubkey: key(2) }];
  const hook = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(hook.result.current.size).toBe(2));
  // A newer inactive head reaches the shared directory: its profile has no
  // verified name, and the search's older answer must not bring one back.
  t.hold(key(1));
  expect([...hook.result.current.keys()]).toEqual([key(2)]);
});

it("retires a searched name a shared head superseded, so evicting the head while unmounted does not bring it back", async () => {
  const t = fake();
  const people = [{ pubkey: key(1) }];
  const first = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(first.result.current.size).toBe(1));
  first.unmount();
  // With no search open, a revoking head arrives and the shared cache evicts it.
  t.hold(key(1));
  t.evict(key(1));
  const second = renderHook(() => useVerifiedNames(t.session, people));
  // The superseded answer is gone, so the person is asked again.
  expect(second.result.current.size).toBe(0);
  await waitFor(() => expect(t.reads).toHaveLength(2));
  expect(t.reads[1]?.subjects).toEqual([key(1)]);
});

it.each([
  ["after", false],
  ["before", true],
])(
  "keeps no answer for a person whose shared head arrived during the read, evicted %s it lands",
  async (_, early) => {
    const t = fake();
    t.holdReads();
    const people = [{ pubkey: key(1) }];
    const hook = renderHook(() => useVerifiedNames(t.session, people));
    await waitFor(() => expect(t.reads).toHaveLength(1));
    t.hold(key(1));
    if (early) t.evict(key(1));
    await act(async () => t.release());
    if (!early) t.evict(key(1));
    expect(hook.result.current.size).toBe(0);
  },
);

it.each([
  ["landed", false],
  ["out", true],
])(
  "keeps no answer whose shared head the cache evicted before publishing it, with the read %s",
  async (_, pending) => {
    vi.useFakeTimers();
    const relay = keypair(),
      person = keypair();
    const authority = { pubkey: relay.pubkey, multipleIssuers: false };
    let sink: { event(event: unknown): void; eose(): void } | undefined;
    const directory = createProfileDirectory(
      { read: async () => [] } as never,
      undefined,
      undefined,
      {
        authority,
        subscribe: (_filter, next) => {
          sink ??= next;
          return () => {};
        },
      },
    );
    try {
      directory.accept([
        eventDto(
          signed(person, {
            kind: 0,
            content: JSON.stringify({ name: "Profile" }),
            tags: [],
            created_at: 1,
          }),
        ),
      ]);
      await directory.ensure([person.pubkey]);
      await act(async () => {});
      sink?.eose();
      await act(async () => vi.runOnlyPendingTimersAsync());
      let release = () => {};
      const session = {
        profiles: directory.queries,
        directMessages: {
          verified: async () => {
            if (pending) await new Promise<void>((done) => (release = done));
            return {
              authority,
              profiles: new Map([[person.pubkey, name("fname")]]),
            };
          },
        },
      };
      const hook = renderHook(() =>
        useVerifiedNames(session, [{ pubkey: person.pubkey }]),
      );
      await act(async () => {});
      if (!pending)
        expect(hook.result.current.get(person.pubkey)?.displayName).toBe(
          "fname",
        );
      await act(async () => {
        sink?.event(
          eventDto(
            signed(relay, {
              kind: 30382,
              content: "",
              created_at: 2,
              tags: [
                ["d", person.pubkey],
                ["p", person.pubkey],
                ["active", "false"],
              ],
            }),
          ),
        );
        expect(directory.queries.verifiedHeld?.(person.pubkey)).toBe(true);
        // Unrelated people evict the revoking head before it is published.
        await directory.ensure(
          Array.from({ length: 1024 }, (_, n) => key(n + 1)),
        );
        expect(directory.queries.verifiedHeld?.(person.pubkey)).toBe(false);
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => release());
      expect(hook.result.current.has(person.pubkey)).toBe(false);
    } finally {
      cleanup();
      directory.dispose();
      vi.useRealTimers();
    }
  },
);

it("drops a searched name when the shared directory's first head for that person is inactive", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    person = keypair();
  const authority = { pubkey: relay.pubkey, multipleIssuers: false };
  let sink: { event(event: unknown): void; eose(): void } | undefined;
  const directory = createProfileDirectory({} as never, undefined, undefined, {
    authority,
    subscribe: (_filter, next) => {
      sink = next;
      return () => {};
    },
  });
  try {
    directory.accept([
      eventDto(
        signed(person, {
          kind: 0,
          content: JSON.stringify({ name: "Profile" }),
          tags: [],
          created_at: 1,
        }),
      ),
    ]);
    await directory.ensure([person.pubkey]);
    await act(async () => {});
    sink?.eose();
    await act(async () => vi.runOnlyPendingTimersAsync());
    const session = {
      profiles: directory.queries,
      directMessages: {
        verified: async () => ({
          authority,
          profiles: new Map([[person.pubkey, name("old")]]),
        }),
      },
    };
    const hook = renderHook(() =>
      useVerifiedNames(session, [{ pubkey: person.pubkey }]),
    );
    await act(async () => {});
    expect(hook.result.current.get(person.pubkey)?.displayName).toBe("old");
    const before = directory.queries.snapshot();
    await act(async () => {
      sink?.event(
        eventDto(
          signed(relay, {
            kind: 30382,
            content: "",
            created_at: 2,
            tags: [
              ["d", person.pubkey],
              ["p", person.pubkey],
              ["active", "false"],
            ],
          }),
        ),
      );
      await vi.runOnlyPendingTimersAsync();
    });
    // The shared profile is unchanged, yet the revoking head now decides.
    expect(directory.queries.snapshot()).toBe(before);
    expect(directory.queries.verifiedHeld?.(person.pubkey)).toBe(true);
    expect(hook.result.current.has(person.pubkey)).toBe(false);
  } finally {
    cleanup();
    directory.dispose();
    vi.useRealTimers();
  }
});

it("names verified people by full name on a device that prefers it, and refolds shared names when the choice changes", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    person = keypair();
  const authority = { pubkey: relay.pubkey, multipleIssuers: false };
  let sink: { event(event: unknown): void; eose(): void } | undefined;
  const directory = createProfileDirectory({} as never, undefined, undefined, {
    authority,
    subscribe: (_filter, next) => {
      sink = next;
      return () => {};
    },
  });
  try {
    directory.accept([
      eventDto(
        signed(person, {
          kind: 0,
          content: JSON.stringify({ name: "Profile" }),
          tags: [],
          created_at: 1,
        }),
      ),
    ]);
    await directory.ensure([person.pubkey]);
    sink?.eose();
    await act(async () => {
      sink?.event(
        eventDto(
          signed(relay, {
            kind: 30382,
            content: "",
            created_at: 2,
            tags: [
              ["d", person.pubkey],
              ["p", person.pubkey],
              ["active", "true"],
              ["display_name", "ada"],
              ["username", "ada"],
              ["full_name", "Ada Lovelace"],
              ["issuer_label", "Block"],
              ["verified_at", "1"],
            ],
          }),
        ),
      );
      await vi.runOnlyPendingTimersAsync();
    });
    const shown = () => directory.queries.snapshot().get(person.pubkey)?.name;
    expect(shown()).toBe("ada");
    act(() => setNamePreference("full-name"));
    expect(shown()).toBe("Ada Lovelace");
    expect(
      withVerifiedNames(
        [{ pubkey: key(1), name: "Profile" }],
        new Map([[key(1), name("bea", "Bea Name")]]),
        new Map(),
      )[0]?.name,
    ).toBe("Bea Name");
    act(() => setNamePreference("username"));
    expect(shown()).toBe("ada");
  } finally {
    setNamePreference("username");
    directory.dispose();
    vi.useRealTimers();
  }
});
