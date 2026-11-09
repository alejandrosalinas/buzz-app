// The Buzz tools' client inside the app: the agent's native-held key signs and
// reads through its Agents handle, files are read as its plugin reads them, and
// memory is read back through the owner's own session, to whom it is
// encrypted.
import type { BuzzClient, Memories } from "./client";
import { prepareAttachment } from "../features/messages/prepare-attachment";
import type { AgentHandle, AgentHandoff } from "../features/agents/service";
import type {
  HostProcess,
  HostProcessOptions,
  ProcessProtection,
} from "../features/host/service";
type Spawn = (id: string, options?: HostProcessOptions) => Promise<HostProcess>;

/** The largest file a tool reads: the community's upload limit. */
export const READ_LIMIT = 50 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;

export function appClient(
  agent: AgentHandle,
  options: Readonly<{
    /** The file at `path`, absolute, `~/…` or relative to the agent's working
     * directory. */
    read(path: string): Promise<Uint8Array>;
    relayAuthor?: string | undefined;
    signingAuthority?: string | undefined;
    memories(slug?: string): Promise<Memories>;
    /** Forget a read that may have started before a successful memory write. */
    remembered?(): void;
    /** Reject operations after the owning turn or community has ended. */
    check?(): void;
    signal?: AbortSignal;
    protectionContext?(): Promise<unknown>;
    /** The runtime reviews each tool call itself before Buzz dispatches it. */
    nativeToolGate?: boolean;
  }>,
): BuzzClient {
  const check = () => {
    options.signal?.throwIfAborted();
    options.check?.();
  };
  const tabs = () => {
    check();
    const found = agent.tabs();
    if (!found) throw new Error("Your community is not connected.");
    return found;
  };
  const handoff = agent.handoff;
  const plugins = agent.plugins;
  const { settings, ownerAccess } = agent;
  /** An owner read, only while the turn still holds before and after it. */
  const owned = async <T>(read: (signal?: AbortSignal) => Promise<T>) => {
    check();
    const result = await read(options.signal);
    check();
    return result;
  };
  return {
    ...(agent.protection
      ? {
          protect: async (
            action: import("../features/agent-protection/service").ProtectionAction,
          ) => {
            check();
            if (
              action.kind === "tool" &&
              agent.protection?.phases?.tool !== false
            ) {
              if (!options.protectionContext)
                throw new Error(
                  "The protected tool has no native conversation context",
                );
              action = {
                ...action,
                content: {
                  ...(action.content as object),
                  conversation: await options.protectionContext(),
                },
              };
            }
            await agent.protection?.check(
              action,
              options.signal ?? new AbortController().signal,
            );
            check();
          },
          ...(options.nativeToolGate ? { nativeToolGate: true as const } : {}),
        }
      : {}),
    pubkey: agent.pubkey,
    key: agent.key,
    owner: agent.owner,
    ...(ownerAccess && {
      ownerAccess: {
        channels: () => owned((signal) => ownerAccess.channels(signal)),
        channel: (id) => owned((signal) => ownerAccess.channel(id, signal)),
        members: (id, page) =>
          owned((signal) => ownerAccess.members(id, page, signal)),
        messages: (request) =>
          owned((signal) => ownerAccess.messages(request, signal)),
        canvas: (channel, revision) =>
          owned((signal) => ownerAccess.canvas(channel, revision, signal)),
        canvasHistory: (channel, cursor) =>
          owned((signal) => ownerAccess.canvasHistory(channel, cursor, signal)),
        held: (execution) => {
          check();
          ownerAccess.held(execution);
        },
      },
    }),
    relayAuthor: options.relayAuthor,
    signingAuthority: options.signingAuthority,
    attention: agent.attention && {
      enabled: () => {
        check();
        return agent.attention.enabled();
      },
      classifier: () => {
        check();
        return agent.attention.classifier();
      },
      interests: (search) => {
        check();
        return agent.attention.interests(search);
      },
      watches: (filter) => {
        check();
        return agent.attention.watches(filter);
      },
      show: async (slug, interest) => {
        check();
        const result = await agent.attention.show(slug, interest);
        check();
        return result;
      },
      write: async (slug, value, options) => {
        check();
        const result = await agent.attention.write(slug, value, options, check);
        check();
        return result;
      },
    },
    query: async (filters) => {
      check();
      const events = await agent.query(filters);
      check();
      return events;
    },
    searchProfiles: (query, limit) => {
      check();
      return agent.searchProfiles(query, limit);
    },
    publish: (event) => {
      check();
      return agent.publish(event, check);
    },
    upload: (data, mime) => {
      check();
      return agent.upload(toBase64(data), mime);
    },
    uploadPicture: async (data, mime) => {
      check();
      const file = new File([new Uint8Array(data)], "picture", { type: mime });
      const picture = await prepareAttachment(
        file,
        options.signal ?? new AbortController().signal,
        true,
      );
      // It returns a file it doesn't recognize as an image unprepared.
      if (picture === file)
        throw new Error("picture must be a PNG, JPEG, GIF or WebP image");
      check();
      const upload = await agent.upload(
        toBase64(new Uint8Array(await picture.arrayBuffer())),
        picture.type,
      );
      // A turn stopped during the upload proposes nothing.
      check();
      return upload;
    },
    media: (url) => {
      check();
      return agent.media(url);
    },
    gitAuth: (owner, repo) => {
      check();
      return agent.gitAuth(owner, repo);
    },
    read: async (path) => {
      check();
      agent.protection?.assertAvailable();
      const bytes = await options.read(path);
      check();
      agent.protection?.assertAvailable();
      return bytes;
    },
    memories: async (slug) => {
      check();
      const result = await options.memories(slug);
      check();
      return result;
    },
    remember: async (slug, body, after) => {
      check();
      await agent.remember(slug, body, after);
      check();
      options.remembered?.();
    },
    agentTypes: async () => {
      check();
      if (!agent.agentTypes)
        throw new Error("Agent creation is unavailable on this host");
      return agent.agentTypes();
    },
    createAgent: async (input) => {
      check();
      if (!agent.createAgent)
        throw new Error("Agent creation is unavailable on this host");
      return agent.createAgent(input);
    },
    updateAgent: async (input) => {
      check();
      if (!agent.updateAgent)
        throw new Error("Agent changes are unavailable on this host");
      return agent.updateAgent(input);
    },
    readAgents: async (target) => {
      check();
      if (!agent.readAgents)
        throw new Error("Agent reads are unavailable on this host");
      return agent.readAgents(target);
    },
    readTeams: async (target) => {
      check();
      if (!agent.readTeams)
        throw new Error("Team reads are unavailable on this host");
      return agent.readTeams(target);
    },
    updateTeam: async (input) => {
      check();
      if (!agent.updateTeam)
        throw new Error("Team changes are unavailable on this host");
      return agent.updateTeam(input);
    },
    ...(plugins && {
      plugins: {
        list: () => {
          check();
          return plugins.list();
        },
        discover: (repository, reference) => {
          check();
          return plugins.discover(repository, reference);
        },
        disable: (id) => {
          check();
          return plugins.disable(id);
        },
        request: (input) => {
          check();
          return plugins.request(input);
        },
        status: (requestId) => {
          check();
          return plugins.status(requestId);
        },
      },
    }),
    ...(handoff
      ? {
          handoff: (wake: AgentHandoff) => {
            check();
            handoff(wake);
          },
        }
      : {}),
    templates: async () => {
      check();
      return agent.templates();
    },
    tabs: {
      list: (channel) => tabs().list(channel),
      open: (channel, root) => tabs().open(channel, root),
      close: (channel, root) => tabs().close(channel, root),
      rename: (channel, root, name) => tabs().rename(channel, root, name),
    },
    ...(settings
      ? {
          settings: {
            list: () => {
              check();
              return settings.list();
            },
            get: (key) => {
              check();
              return settings.get(key);
            },
            // Synchronous, so the check holds until the write is read back.
            set: (key, value) => {
              check();
              return settings.set(key, value);
            },
          },
        }
      : {}),
  };
}

/** Reads a file with the plugin's declared `read` process (`base64 -i`),
 * which passes binary files through intact, or another that prints base64
 * given the path and `args`. */
export async function readFile(
  spawn: Spawn,
  cwd: string,
  path: string,
  signal?: AbortSignal,
  protection?: ProcessProtection,
  process = protection ? "read-protected" : "read",
  args: string[] = [],
) {
  // `-` would wait on stdin.
  if (path.trim() === "-" || !path.trim())
    throw new Error(`Cannot read ${path}`);
  let output = "";
  let error = "";
  let large = false;
  let child: Awaited<ReturnType<Spawn>> | undefined;
  child = await spawn(process, {
    args: [path, ...args],
    cwd,
    ...(protection ? { protection: structuredClone(protection) } : {}),
    onStdout: (data) => {
      output += data;
      if (output.length > (READ_LIMIT / 3) * 4 + 1024 && !large) {
        large = true;
        void child?.kill();
      }
    },
    onStderr: (data) => {
      error += data;
    },
  });
  const abort = () => void child?.kill();
  signal?.addEventListener("abort", abort, { once: true });
  if (large || signal?.aborted) abort();
  const timer = setTimeout(() => void child?.kill(), READ_TIMEOUT_MS);
  let code: number | null;
  try {
    code = await child.exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  if (large) throw new Error(`${path} is larger than 50 MB`);
  if (code !== 0) throw new Error(error.trim() || `Could not read ${path}`);
  return fromBase64(output.replace(/\s/g, ""));
}

function toBase64(data: Uint8Array) {
  let binary = "";
  for (let i = 0; i < data.length; i += 0x8000)
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string) {
  const binary = atob(text);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return data;
}
