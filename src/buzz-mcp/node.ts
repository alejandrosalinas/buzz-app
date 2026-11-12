// The Buzz tools' client for a standalone server: holds the agent's key from
// its environment, as a harness agent's is given, and talks to the community's
// HTTP API directly. Reads only files under `root`.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decode } from "nostr-tools/nip19";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import { CANVAS_MAX_EVENT_BYTES } from "../features/channel-templates/canvas-limits.ts";
import { eventsDto } from "../features/relay/events";
import {
  effectiveEditDto,
  effectiveEditFilter,
} from "../features/relay/effective-edit";
import type {
  BuzzClient,
  BuzzEvent,
  Media,
  Memory,
  Template,
  Upload,
} from "./client";

/** Most memory events one read asks for: the most the relay returns for one
 * query. A read that fills it may be missing older entries. */
const MEMORY_LIMIT = 1000;

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
/** The largest image an agent is shown inline. Claude takes 5 MiB of base64 on its
 * strictest hosts, and base64 is 4 characters per 3 bytes. */
const MEDIA_LIMIT = (5 * 1024 * 1024 * 3) / 4;
/** The largest file an agent saves: the community's largest upload, a video. */
const MEDIA_FILE_LIMIT = 500 * 1024 * 1024;
/** Images an agent can be shown. */
const SHOWN_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** The relay's own key, as its NIP-11 document at `relay` advertises it in
 * `self` (the operator-contact `pubkey` is not one): what relay-signed records,
 * such as channel rosters, are checked against.
 * `undefined` when it cannot be learned; the tools that need it then refuse. */
export async function relayAuthority(relay: string) {
  try {
    const response = await fetch(httpBase(relay), {
      headers: { Accept: "application/nostr+json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const nip11 = (await response.json()) as { self?: unknown } | null;
    const author = nip11?.self;
    return typeof author === "string" && /^[0-9a-f]{64}$/.test(author)
      ? author
      : undefined;
  } catch {
    return undefined;
  }
}

/** `relayAuthority` that asks again until the relay answers with a key, then
 * keeps it: a relay unreachable at startup does not disable its tools until restart. */
export function relayAuthorityLookup(relay: string) {
  let known: string | undefined;
  return async () => {
    if (known) return known;
    // An overlapping lookup may have learned the key while this one failed.
    const found = await relayAuthority(relay);
    known ??= found;
    return known;
  };
}

const httpBase = (relay: string) =>
  relay.replace(/^ws/, "http").replace(/\/+$/, "");

export function nodeClient(
  options: Readonly<{
    relay: string;
    /** The agent's secret key, hex. */
    key: string;
    /** The owner's NIP-OA `auth` tag, as JSON. */
    auth?: string;
    /** Files outside it cannot be read. */
    root: string;
    /** Where fetched media is saved; a temporary directory by default. */
    media?: string;
  }>,
): BuzzClient {
  const secret = options.key.startsWith("nsec1")
    ? (decode(options.key as `nsec1${string}`).data as Uint8Array)
    : hexToBytes(options.key);
  const pubkey = getPublicKey(secret);
  const base = httpBase(options.relay);
  const auth = options.auth
    ? (JSON.parse(options.auth) as string[])
    : undefined;
  const owner = auth?.[1];
  const sign = (event: Template, createdAt = now()) =>
    finalizeEvent(
      {
        kind: event.kind,
        content: event.content,
        tags: event.tags.map((tag) => [...tag]),
        created_at: createdAt,
      },
      secret,
    ) as BuzzEvent;
  // NIP-98 takes standard base64; Blossom takes it URL-safe and unpadded.
  const header = (event: BuzzEvent, encoding: "base64" | "base64url") =>
    `Nostr ${Buffer.from(JSON.stringify(event)).toString(encoding)}`;

  async function request(path: string, body: string) {
    return json(await send(path, body));
  }

  async function json(response: Response) {
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${response.status} ${text.slice(0, 300)}`.trim());
    return JSON.parse(text) as unknown;
  }

  function send(path: string, body: string) {
    const url = `${base}${path}`;
    const nip98 = sign({
      kind: 27235,
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", sha256(body)],
        ["nonce", randomUUID()],
      ],
    });
    return fetch(url, {
      method: "POST",
      headers: {
        authorization: header(nip98, "base64"),
        "content-type": "application/json",
        ...(options.auth ? { "x-auth-tag": options.auth } : {}),
      },
      body,
    });
  }

  async function post(event: BuzzEvent) {
    const reply = (await request("/events", JSON.stringify(event))) as {
      accepted?: boolean;
      message?: string;
    };
    if (!reply.accepted && !reply.message?.startsWith("duplicate"))
      throw new Error(reply.message || "The community refused the event");
    return event;
  }

  const conversation = () => {
    if (!owner) throw new Error("Memory needs BUZZ_AUTH_TAG");
    return getConversationKey(secret, owner);
  };

  return {
    pubkey,
    key: pubkey,
    query: async (filters) =>
      eventsDto(await request("/query", JSON.stringify(filters))),
    async effectiveEdit(id, channel) {
      return effectiveEditDto(
        await request(
          "/query",
          JSON.stringify(effectiveEditFilter(id, channel)),
        ),
        id,
        channel,
      );
    },
    async searchProfiles(query, limit) {
      const response = await send(
        "/profiles/search",
        JSON.stringify({ query, limit }),
      );
      // A community without profile name search.
      if (response.status === 404 || response.status === 405) return undefined;
      return eventsDto(await json(response));
    },
    publish(event) {
      const tags = event.tags.filter(
        (tag) => tag[0] !== "auth" && tag[0] !== "ms",
      );
      if (tags.some((tag) => tag[0] === "h"))
        tags.push(["ms", String(Date.now() % 1000)]);
      if (auth) tags.push(auth);
      const signed = sign({ ...event, tags });
      // Escaping can carry Canvas content within its limit past the frame.
      if (
        signed.kind === 40100 &&
        new TextEncoder().encode(JSON.stringify(signed)).length >
          CANVAS_MAX_EVENT_BYTES
      )
        throw new Error("The canvas event is too large to publish.");
      return post(signed);
    },
    async upload(data, mime) {
      const hash = sha256(data);
      const blossom = sign({
        kind: 24242,
        content: "Upload file",
        tags: [
          ["t", "upload"],
          ["x", hash],
          ["expiration", String(now() + 60)],
          ["server", new URL(base).host],
        ],
      });
      const response = await fetch(`${base}/upload`, {
        method: "PUT",
        headers: {
          authorization: header(blossom, "base64url"),
          "content-type": mime,
          "x-sha-256": hash,
          ...(options.auth ? { "x-auth-tag": options.auth } : {}),
        },
        body: data as Uint8Array<ArrayBuffer>,
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `Upload failed: ${response.status} ${text.slice(0, 300)}`,
        );
      return JSON.parse(text) as Upload;
    },
    async media(input) {
      // Only the community's own media, so the signature goes nowhere else.
      const prefix = `${base}/media/`;
      const name = input.trim().startsWith(prefix)
        ? input.trim().slice(prefix.length)
        : input.trim();
      if (!/^[0-9a-f]{64}(\.[a-z0-9]{1,8}|\.thumb\.(?:jpg|webp))?$/.test(name))
        throw new Error("Agents fetch only their community's media");
      const blossom = sign({
        kind: 24242,
        content: "Get media",
        tags: [
          ["t", "get"],
          ["expiration", String(now() + 60)],
          ["server", new URL(base).host],
        ],
      });
      const response = await fetch(`${base}/media/${name}`, {
        headers: {
          authorization: header(blossom, "base64url"),
          ...(options.auth ? { "x-auth-tag": options.auth } : {}),
        },
        redirect: "error",
      });
      if (!response.ok) {
        // Read a bounded part of the refusal, so no body is unbounded.
        const reader = response.body?.getReader();
        const first = reader ? await reader.read() : undefined;
        await reader?.cancel();
        const text = Buffer.from(first?.value ?? []).subarray(0, 300);
        throw new Error(`Media failed: ${response.status} ${text.toString()}`);
      }
      const type =
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() || "application/octet-stream";
      const shown = SHOWN_TYPES.includes(type);
      // The blob's own name, so the same media is saved once; with an
      // extension from its type when the URL gives none.
      const ext = type.split("/")[1] ?? "";
      const file =
        name.includes(".") || !/^[a-z0-9]{1,8}$/.test(ext)
          ? name
          : `${name}.${ext}`;
      const dir = options.media ?? join(tmpdir(), "buzz-agent-media");
      await mkdir(dir, { recursive: true });
      const partial = join(dir, `.${file}.${randomUUID()}`);
      const hash = createHash("sha256");
      const image: Uint8Array[] = [];
      let size = 0;
      try {
        // pipeline owns the file stream's errors (open, write, close), so a
        // full disk or denied folder becomes a tool error, not a crash.
        await pipeline(
          Readable.from(response.body ?? []),
          async function* (source: AsyncIterable<Uint8Array>) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > MEDIA_FILE_LIMIT)
                throw new Error("Media over 500 MiB cannot be saved");
              hash.update(chunk);
              if (shown && size <= MEDIA_LIMIT) image.push(chunk);
              yield chunk;
            }
          },
          createWriteStream(partial),
        );
        if (
          !/\.thumb\.(?:jpg|webp)$/.test(name) &&
          hash.digest("hex") !== name.slice(0, 64)
        )
          throw new Error("Media did not match its SHA-256");
        const path = join(dir, file);
        await rename(partial, path);
        return {
          path,
          type,
          size,
          ...(shown && size <= MEDIA_LIMIT
            ? { data: Buffer.concat(image).toString("base64") }
            : {}),
        } satisfies Media;
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
    },
    async read(path) {
      const full = await realpath(resolve(options.root, path));
      const inside = relative(await realpath(options.root), full);
      if (inside.startsWith("..") || isAbsolute(inside))
        throw new Error(`${path} is outside ${options.root}`);
      return new Uint8Array(await readFile(full));
    },
    async memories(slug) {
      const key = conversation();
      const events = eventsDto(
        await request(
          "/query",
          JSON.stringify([
            {
              kinds: [30174],
              authors: [pubkey],
              "#p": [owner],
              ...(slug ? { "#d": [memoryAddress(key, slug)] } : {}),
              limit: MEMORY_LIMIT,
            },
          ]),
        ),
      );
      const heads = new Map<string, BuzzEvent>();
      for (const event of events) {
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!d) continue;
        const head = heads.get(d);
        if (
          !head ||
          head.created_at < event.created_at ||
          (head.created_at === event.created_at && event.id < head.id)
        )
          heads.set(d, event);
      }
      const entries: Memory[] = [];
      const deleted: { slug: string; createdAt: number }[] = [];
      for (const event of heads.values()) {
        try {
          const entry = JSON.parse(decrypt(event.content, key));
          const body = entry.slug === "core" ? entry.profile : entry.value;
          if (typeof entry.slug !== "string") continue;
          if (typeof body === "string")
            entries.push({
              slug: entry.slug,
              body,
              createdAt: event.created_at,
            });
          // A write that recreates a deleted slug must follow its tombstone.
          else if (body === null && entry.slug !== "core")
            deleted.push({ slug: entry.slug, createdAt: event.created_at });
        } catch {}
      }
      return {
        entries: entries.sort((a, b) => a.slug.localeCompare(b.slug)),
        ...(deleted.length ? { deleted } : {}),
        partial: events.length >= MEMORY_LIMIT,
      };
    },
    async remember(slug, body, after) {
      const key = conversation();
      const d = memoryAddress(key, slug);
      const plaintext = JSON.stringify(
        slug === "core" ? { slug, profile: body } : { slug, value: body },
      );
      await post(
        sign(
          {
            kind: 30174,
            content: encrypt(plaintext, key),
            tags: [
              ["d", d],
              ["p", owner as string],
            ],
          },
          Math.max(now(), after + 1),
        ),
      );
    },
  };
}

/** The `d` tag of memory `slug`, an HMAC under the conversation key. */
function memoryAddress(key: Uint8Array, slug: string) {
  return createHmac("sha256", key)
    .update(`agent-memory/v1/d-tag\0${slug}`)
    .digest("hex");
}
