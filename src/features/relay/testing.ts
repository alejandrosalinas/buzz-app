import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "nostr-tools/utils";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools";
import type { ReadFilter, RelayEvent } from "./events";
import { PublishRejected } from "./outbox";
import { authTagOwner } from "../agents/owner-attestation";
import type { ReadTransport, Signer } from "./transport";

/** Test-only signing helpers. Real signatures so the transport's verification stays on. */
export function keypair() {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
}
export type Key = ReturnType<typeof keypair>;
export function signed(
  key: Key,
  template: Omit<EventTemplate, "created_at"> & { created_at?: number },
): RelayEvent {
  return finalizeEvent({ created_at: 1_700_000_000, ...template }, key.secret);
}
/** The native `relay_verify_signatures` command, with real BIP-340 checks. */
export const nativeSignatureChecks = (args: unknown) =>
  (
    args as { claims: { id: string; pubkey: string; sig: string }[] }
  ).claims.map(({ id, pubkey, sig }) =>
    schnorr.verify(hexToBytes(sig), hexToBytes(id), hexToBytes(pubkey)),
  );
/** Production-shaped host signer: the host authenticates and sends the exact
 * bytes, as the native adapter does. The default host forwards to the test's
 * stubbed `fetch`; credentials never reach JavaScript. */
export function hostSigner(
  key: Key = keypair(),
  request: Signer["request"] = (url, body, signal) =>
    fetch(url, { method: "POST", body, signal: signal ?? null }),
) {
  return {
    key,
    getPublicKey: async () => key.pubkey,
    signEvent: async (template: Parameters<typeof signed>[1]) =>
      signed(key, template),
    request,
  };
}
export function message(
  key: Key,
  channelId: string,
  content: string,
  created_at: number,
  extraTags: string[][] = [],
): RelayEvent {
  return signed(key, {
    kind: 9,
    content,
    created_at,
    tags: [["h", channelId], ...extraTags],
  });
}
export function bounds(
  relay: Key,
  channelId: string,
  cursorSuffix: string,
  body: {
    has_more: boolean;
    next_cursor: { created_at: number; id: string } | null;
  },
): RelayEvent {
  return signed(relay, {
    kind: 39006,
    content: JSON.stringify(body),
    tags: [
      ["h", channelId],
      ["d", `${channelId}:${cursorSuffix}`],
    ],
  });
}
export function summary(
  relay: Key,
  channelId: string,
  rowId: string,
  body: Record<string, unknown>,
): RelayEvent {
  return signed(relay, {
    kind: 39005,
    content: JSON.stringify(body),
    tags: [
      ["e", rowId],
      ["d", rowId],
      ["h", channelId],
    ],
  });
}
export function roster(
  relay: Key,
  channelId: string,
  members: readonly string[],
  created_at = 1_700_000_000,
): RelayEvent {
  return signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [["d", channelId], ...members.map((member) => ["p", member])],
  });
}
export function metadata(
  relay: Key,
  channelId: string,
  name: string,
  created_at = 1_700_000_000,
  extra: readonly string[][] = [],
): RelayEvent {
  return signed(relay, {
    kind: 39000,
    content: JSON.stringify({ name }),
    created_at,
    tags: [["d", channelId], ["name", name], ...extra],
  });
}
export function profile(
  key: Key,
  body: Record<string, unknown>,
  created_at = 1_700_000_000,
): RelayEvent {
  return signed(key, {
    kind: 0,
    content: JSON.stringify(body),
    created_at,
    tags: [],
  });
}

/** Unsigned kind 0s named `${label}${index}` for large rosters. The profile
 * directory folds without checking signatures, and signing thousands of
 * profiles makes a test slow under a loaded run. Use only where nothing
 * checks the signature. */
export function unsignedProfiles(count: number, label = "P"): RelayEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const tag = [...label].map((c) => c.charCodeAt(0).toString(16)).join("");
    const pubkey = tag.padEnd(32, "0") + index.toString(16).padStart(32, "0");
    return {
      id: pubkey,
      pubkey,
      kind: 0,
      created_at: 1_700_000_000,
      tags: [],
      content: JSON.stringify({ name: `${label}${index}` }),
      sig: "0".repeat(128),
    } as unknown as RelayEvent;
  });
}

export type Scripted = {
  filters: readonly ReadFilter[];
  respond: (events: RelayEvent[]) => void;
  fail: (error: unknown) => void;
  signal: AbortSignal | undefined;
};
/** A window's separate membership notice read (see `noticeFilter`). */
export const isNoticeRead = (filters: readonly ReadFilter[]) =>
  filters.length > 0 &&
  filters.every(
    (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 40099,
  );
/** A transport whose responses the test releases explicitly, so ordering and cancellation are observable.
 * Membership notice reads answer empty at once unless `notices` scripts them too. */
export function scriptedTransport(
  viewer: string,
  relayAuthor: string,
  { notices = false }: { notices?: boolean } = {},
) {
  const pending: Scripted[] = [];
  const transport: ReadTransport = {
    viewer,
    relayAuthor,
    media: (url) => (/^https:\/\//.test(url) ? url : undefined),
    query(filters, signal) {
      if (!notices && isNoticeRead(filters)) return Promise.resolve([]);
      return new Promise<RelayEvent[]>((resolve, reject) => {
        const entry: Scripted = {
          filters,
          respond: resolve,
          fail: reject,
          signal,
        };
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
        pending.push(entry);
      });
    },
  };
  return {
    transport,
    pending,
    next: () => {
      const entry = pending.shift();
      if (!entry) throw new Error("No pending query");
      return entry;
    },
  };
}
export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Fixture relay for NIP-IA requests: applies accepted 9035/9036 events to its
 * relay-signed 13535 snapshot. `hold`/`fail`/`apply` script the publish outcome.
 * `channels` maps channel IDs to relay-signed 39002 members; `removal` scripts
 * accepted 9001 removals the same way. */
export function archiveRelay(
  viewer: Key,
  relay: Key,
  profiles: readonly RelayEvent[] = [],
  roles: Readonly<Record<string, string>> = {},
  channels: Record<string, string[]> = {},
) {
  /** Profiles as the relay holds them; `publishProfile` adds a newer one. */
  const live = [...profiles];
  const archived = new Set<string>();
  /** Channel IDs whose metadata is archived; the relay refuses 9001 there. */
  const archivedChannels = new Set<string>();
  /** NIP-09 coordinates the relay accepted for deletion. */
  const deleted = new Set<string>();
  const published: RelayEvent[] = [];
  const signedBy: string[] = [];
  const script: { hold?: Promise<void>; fail?: Error; apply: boolean } = {
    apply: true,
  };
  /** `failKind` limits `fail` to one writer kind, such as 5 or 9001. */
  const removal: {
    hold?: Promise<void>;
    fail?: Error;
    failKind?: number;
    apply: boolean;
  } = {
    apply: true,
  };
  let time = 1;
  const roster = (id: string) =>
    signed(relay, {
      kind: 39002,
      created_at: time,
      content: "",
      tags: [["d", id], ...(channels[id] ?? []).map((key) => ["p", key])],
    });
  const snapshot = () =>
    signed(relay, {
      kind: 13535,
      created_at: time,
      content: "",
      tags: [["-"], ...[...archived].map((key) => ["p", key])],
    });
  const transport: ReadTransport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    archiveAuthority: relay.pubkey,
    media: () => undefined,
    query: async (filters) =>
      filters.flatMap((filter) => {
        if (filter.kinds?.includes(13535)) return [snapshot()];
        if (filter.kinds?.includes(13534))
          return [
            signed(relay, {
              kind: 13534,
              content: "",
              tags: Object.entries(roles).map(([key, role]) => [
                "member",
                key,
                role,
              ]),
            }),
          ];
        if (filter.kinds?.includes(0))
          return live.filter((event) => filter.authors?.includes(event.pubkey));
        if (filter.kinds?.includes(39000))
          return Object.keys(channels)
            .filter((id) => !filter["#d"] || filter["#d"].includes(id))
            .map((id) =>
              signed(relay, {
                kind: 39000,
                created_at: time,
                content: "",
                tags: [
                  ["d", id],
                  ["name", id.slice(0, 8)],
                  ...(archivedChannels.has(id) ? [["archived", "true"]] : []),
                ],
              }),
            );
        if (filter.kinds?.includes(39002))
          return Object.keys(channels)
            .filter(
              (id) =>
                (!filter["#d"] || filter["#d"].includes(id)) &&
                (!filter["#p"] ||
                  filter["#p"].some((key) => channels[id]?.includes(key))),
            )
            .map(roster);
        return [];
      }),
    writer: {
      kinds: [9001, 5, 30177],
      async sign(template) {
        return finalizeEvent({ ...template }, viewer.secret);
      },
      async publish(event) {
        await removal.hold;
        if (
          removal.fail &&
          (removal.failKind === undefined || removal.failKind === event.kind)
        )
          throw removal.fail;
        published.push(event);
        if (!removal.apply || event.kind === 30177) return;
        if (event.kind === 5) {
          for (const [name, value] of event.tags)
            if (name === "a" && value) deleted.add(value);
          return;
        }
        const tag = (name: string) =>
          event.tags.find(([key]) => key === name)?.[1] ?? "";
        if (archivedChannels.has(tag("h"))) {
          published.pop();
          throw new PublishRejected("invalid: channel is archived");
        }
        channels[tag("h")] = (channels[tag("h")] ?? []).filter(
          (key) => key !== tag("p"),
        );
        time += 1;
      },
    },
    identityArchive: {
      async sign(template) {
        signedBy.push(viewer.pubkey);
        return finalizeEvent(template, viewer.secret);
      },
      async publish(event) {
        await script.hold;
        if (script.fail) throw script.fail;
        const target = event.tags.find(([name]) => name === "p")?.[1] ?? "";
        if (!(await consents(event, target)))
          throw new PublishRejected("invalid: missing auth tag");
        published.push(event);
        if (!script.apply) return;
        if (event.kind === 9035) archived.add(target);
        else archived.delete(target);
        time += 1;
      },
    },
  };
  /** The relay's owner-consent rule: an owner or admin role stands alone;
   * otherwise the request and the target's latest profile both carry an
   * owner proof naming the requester. */
  async function consents(event: RelayEvent, target: string) {
    const requester = event.pubkey;
    if (requester === target) return true;
    if (roles[requester] === "owner" || roles[requester] === "admin")
      return true;
    const names = async (tags: readonly string[][] | undefined) => {
      const auth = tags?.find(([name]) => name === "auth");
      return !!auth && (await authTagOwner(target, auth)) === requester;
    };
    const profile = live
      .filter((item) => item.kind === 0 && item.pubkey === target)
      .reduce<RelayEvent | undefined>(
        (newest, item) =>
          !newest || item.created_at > newest.created_at ? item : newest,
        undefined,
      );
    return (await names(event.tags)) && (await names(profile?.tags));
  }
  const publishProfile = (event: RelayEvent) => {
    live.push(event);
  };
  /** An out-of-band relay change publishes a newer snapshot, never a same-time fork. */
  const archiveExternally = (target: string) => {
    archived.add(target);
    time += 1;
  };
  const unarchiveExternally = (target: string) => {
    archived.delete(target);
    time += 1;
  };
  return {
    transport,
    archived,
    publishProfile,
    archiveExternally,
    unarchiveExternally,
    published,
    signedBy,
    script,
    channels,
    archivedChannels,
    removal,
    deleted,
  };
}
