import type { GifRequests } from "../relay/gifs";
import { readView } from "../../shared/view-state";
import type { ComposerSession } from "../messages/composer-session";
import { createNameProvider } from "../identity-names/directory";
import { resolveIdentityNames } from "../identity-names/policy";
import type { IdentityNameView } from "../identity-names/service";
import type {
  ComposerCommand,
  ComposerOperation,
  ComposerOperations,
  ComposerResponse,
  ComposerSnapshot,
} from "./composer-contract";

/** The detached editor has no relay transport, signer, or outbox of its own. */
export function createHuddleComposerClient(token: string) {
  const channel = new BroadcastChannel(`buzz.huddle.composer.${token}`);
  const client = crypto.randomUUID();
  let next = 0;
  let data: ComposerSnapshot | undefined;
  let session: ComposerSession | undefined;
  let error: string | undefined;
  let revision = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const waiting = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const changed = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const post = (value: ComposerCommand) => channel.postMessage(value);
  function stop(reason: string) {
    if (closed) return;
    error = reason;
    closed = true;
    clearTimeout(deadline);
    for (const pending of waiting.values()) {
      pending.cleanup();
      pending.reject(new Error(reason));
    }
    waiting.clear();
    channel.close();
    changed();
  }
  function request<K extends ComposerOperation>(
    op: K,
    args: ComposerOperations[K]["args"],
    signal?: AbortSignal,
  ): Promise<ComposerOperations[K]["result"]> {
    if (closed) return Promise.reject(new Error(error));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++next;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        waiting.delete(id);
        signal?.removeEventListener("abort", cancel);
        post({ kind: "cancel", client, id });
        reject(signal?.reason ?? new Error("Cancelled"));
      };
      waiting.set(id, {
        resolve: (value) => resolve(value as ComposerOperations[K]["result"]),
        reject,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        post({ kind: "request", client, id, op, args } as ComposerCommand);
      } catch {
        waiting.delete(id);
        signal?.removeEventListener("abort", cancel);
        reject(
          new Error(
            "Could not transfer this composer request. Your draft is kept.",
          ),
        );
      }
    });
  }
  function build(initial: ComposerSnapshot): ComposerSession {
    let latest = initial;
    const value = () => {
      latest = data ?? latest;
      return latest;
    };
    const unavailable = () => {
      throw new Error("This operation is not available in a Huddle composer.");
    };
    const emptyRows = {
      channelId: initial.room,
      loadingOlder: false,
      error: undefined,
      status: "ready" as const,
      rows: [],
      hasMore: false,
    };
    const emptyOutbox: ReturnType<
      NonNullable<ComposerSession["outbox"]>["snapshot"]
    > = [];
    const invokeRead = (
      op: "emoji" | "archives" | "channels",
      refresh = false,
    ) => request(op, refresh);
    const provider = createNameProvider({
      id: "huddle",
      resolve: resolveIdentityNames,
    });
    const scope: IdentityNameView["scope"] = (keys, facts) => {
      const resolve = provider.scope(result, keys, facts);
      return (key) => {
        const found = resolve(key);
        return found ? { ...found, source: "public-profile" } : undefined;
      };
    };
    const names: IdentityNameView = {
      scope,
      lookup: (key, keys, facts) => scope(keys, facts)(key),
      resolve: (key, fallback, keys, facts) =>
        scope(keys, facts)(key)?.name ?? fallback,
      snapshot: () => revision,
      subscribe,
    };
    const result: ComposerSession = {
      viewer: initial.viewer,
      scope: initial.scope,
      media: (url, size) => value().media.get(size ? `${url}:${size}` : url),
      names,
      channels: {
        list: () => value().channels,
        subscribeList: subscribe,
        get: (id) => value().channels.channels.find((c) => c.id === id),
        window: () => emptyRows,
        ensureList: () => {
          void invokeRead("channels").catch(() => {});
        },
        refreshList: () => invokeRead("channels", true),
      },
      profiles: {
        snapshot: () => value().profiles,
        subscribe,
        ensure: (keys) => request("profiles", keys),
        generation: () => value().profileGeneration,
      },
      emoji: {
        snapshot: () => value().emoji,
        subscribe,
        ensure: () => invokeRead("emoji"),
        refresh: () => invokeRead("emoji", true),
      },
      archives: {
        snapshot: () => value().archives,
        subscribe,
        ensure: () => invokeRead("archives"),
        refresh: () => invokeRead("archives", true),
        state: (key) =>
          value().archives.archived.includes(key)
            ? "archived"
            : value().archives.status === "ready"
              ? "not-archived"
              : "unknown",
      },
      agentChoices: {
        snapshot: () => value().agents,
        subscribe,
        retain: () => () => {},
        ensure: (legacy = true) => {
          void request("agents", { refresh: false, legacy }).catch(() => {});
        },
        refresh: (legacy = true) =>
          request("agents", { refresh: true, legacy }),
      },
      agentLibrary: {
        snapshot: () => value().library,
        subscribe,
        retain: () => () => {},
        refresh: () => request("agents", { refresh: true, legacy: true }),
      },
      typing: { snapshot: () => value().typing, subscribe },
      directMessages: {
        people: (query, page, signal) =>
          request("people", { query, page }, signal),
      },
      memberAdditions: {
        add: (room, key) => {
          if (room !== initial.room)
            return Promise.reject(new Error("Huddle destination changed."));
          return request("add", key);
        },
      },
      channelWrites: { refreshMembership: unavailable, addAgents: unavailable },
      outbox: {
        snapshot: () => emptyOutbox,
        subscribe,
        supports: (kind) => kind === 9 || (kind === 9000 && value().canAdd),
        retry: unavailable,
      },
      attachments: initial.uploads
        ? {
            // Native conversion and upload happen together in the main window.
            prepare: async (file) => file,
            release: (file) => {
              void request("release", file).catch(() => {});
            },
            upload: (file, room, signal) => {
              if (room !== initial.room)
                return Promise.reject(new Error("Huddle destination changed."));
              return request("upload", file, signal);
            },
          }
        : undefined,
      forwarding: {
        resolve: (reference, signal) =>
          request("forwardSource", reference, signal),
        send: (reference, text, mentions, attachments, references, picks) =>
          request("send", {
            forward: reference,
            text,
            mentions,
            attachments,
            references,
            picks,
            draft: JSON.stringify(
              readView(initial.scope, `draft:${initial.room}`, null),
            ),
          }),
      },
      messages: {
        send: (
          room,
          text,
          mentions = [],
          attachments = [],
          _tags,
          references = [],
          picks = {},
        ) => {
          if (room !== initial.room)
            return Promise.reject(new Error("Huddle destination changed."));
          return request("send", {
            text,
            picks,
            mentions,
            attachments,
            references,
            draft: JSON.stringify(
              readView(initial.scope, `draft:${initial.room}`, null),
            ),
          });
        },
        reply: unavailable,
        edit: unavailable,
      },
      repositories: {
        peekHome: () => undefined,
        home: (_room, signal) => request("repositoriesHome", undefined, signal),
        load: (route, signal) => request("repositoriesLoad", route, signal),
      },
    };
    return result;
  }
  channel.onmessage = ({ data: response }: MessageEvent<ComposerResponse>) => {
    if (closed || response.client !== client) return;
    if (response.kind === "closed") {
      stop("This Huddle conversation has closed.");
      return;
    }
    if (response.kind === "snapshot") {
      data = response.value;
      session ??= build(data);
      clearTimeout(deadline);
      changed();
    } else {
      const pending = waiting.get(response.id);
      if (!pending) return;
      waiting.delete(response.id);
      pending.cleanup();
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.value);
    }
  };
  channel.onmessageerror = () =>
    stop(
      "Could not connect the Huddle composer. Close and reopen Huddle chat.",
    );
  const deadline = setTimeout(
    () =>
      stop(
        "Could not connect the Huddle composer. Close and reopen Huddle chat.",
      ),
    10000,
  );
  post({ kind: "hello", client });
  return {
    models: (pubkeys: readonly string[]) => request("models", pubkeys),
    gifs: {
      supports: (_community, signal?: AbortSignal) =>
        request("gifSupport", undefined, signal),
      search: (_community, query, signal?: AbortSignal) =>
        request("gifSearch", query, signal),
    } satisfies GifRequests,
    subscribe,
    revision: () => revision,
    snapshot: () => ({ session, data, error }),
    dispose() {
      if (!closed) post({ kind: "bye", client });
      stop("Huddle composer closed.");
    },
  };
}
