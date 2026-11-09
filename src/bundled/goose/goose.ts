// goose on the shared ACP client: one `goose-acp` process, with goose's
// extensions for the system prompt, steering, and per-turn provider and model
// picks. Each session's Buzz tools reach goose over HTTP MCP, never a Buzz key.
import {
  AcpProcess,
  REQUEST_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
} from "../../features/agent-harness/acp/process";
import type {
  AcpSession,
  ConfigOptions,
} from "../../features/agent-harness/acp/session";
import { errorMessage } from "../../features/agent-harness/acp/steps";
import type {
  AcpHooks,
  ServeMcp,
  Spawn,
} from "../../features/agent-harness/acp/types";

export {
  REQUEST_TIMEOUT_MS,
  TOOL_SERVER,
} from "../../features/agent-harness/acp/process";
export { stepLabel } from "../../features/agent-harness/acp/steps";
export type {
  ActivityReceipt,
  Choice,
  ServeMcp,
  Settled,
  Spawn,
  ToolServer,
} from "../../features/agent-harness/acp/types";

export type GooseProcess = AcpProcess;
export type GooseSession = AcpSession;
/** The desktop host's `spawn` and `resolveDirectory`, which goose starts with. */
export type GooseHost = Readonly<{
  spawn: Spawn;
  resolveDirectory(path: string): Promise<string>;
}>;

/** A goose built-in extension for `session/new`; `available_tools` limits it
 * to the listed tools. */
export type PlatformExtension = Readonly<{
  type: "platform";
  name: string;
  available_tools?: readonly string[];
}>;

const DEVELOPER: PlatformExtension = { type: "platform", name: "developer" };
/** goose's provider id for the provider and model its config picks. */
const CONFIGURED = "goose";

/** What every `goose-acp` runs with: tools run without asking, and no Buzz
 * identity reaches it from the app's environment. Nor does a provider or
 * model, which goose would prefer to each session's. */
export const ENV: Readonly<Record<string, string | null>> = {
  GOOSE_MODE: "auto",
  BUZZ_PRIVATE_KEY: null,
  BUZZ_AUTH_TAG: null,
  BUZZ_RELAY_URL: null,
  GOOSE_PROVIDER: null,
  GOOSE_MODEL: null,
};

/** A packaged Databricks workspace, which goose prefers to its own config. */
const databricks = (): Record<string, string> => {
  const host = import.meta.env.VITE_BUZZ_DATABRICKS_HOST;
  return host ? { DATABRICKS_HOST: host } : {};
};

export const GOOSE: AcpHooks = {
  label: "goose",
  program: "goose",
  missing: "goose-acp is missing from this Buzz build.",
  env: ENV,
  // goose is asked to close every session, advertised or not.
  closeSession: "always",
  // goose names an untitled session with a model call, unless its config
  // sets `GOOSE_DISABLE_SESSION_NAMING`.
  names: (goose) =>
    goose
      .request(
        "_goose/unstable/config/read",
        { key: "GOOSE_DISABLE_SESSION_NAMING", isSecret: false },
        REQUEST_TIMEOUT_MS,
      )
      .then(
        (result) => {
          const { value } = result as { value?: unknown };
          return value !== true && value !== "true";
        },
        () => true,
      ),
  newSessionMeta: (buzz, { title, provider, platform }) => ({
    // The session's whole tool set: goose's developer tools and the Buzz
    // tools, so extensions in the owner's goose config and plugins never load
    // into a Buzz agent. The pinned Goose persists this list, including the
    // Buzz MCP token; aaif-goose/goose#12908 is not in v1.57.0. Keep the entry
    // until upstream supports client MCP servers alongside this allowlist.
    // The non-persistence acceptance test remains a known failure.
    // Mesh sessions pass a narrower `platform` set (see mesh-compute).
    enabledExtensions: buzz
      ? [...(platform ?? [DEVELOPER]), { type: "mcp", server: buzz }]
      : [],
    ...(title ? { sessionTitle: title } : {}),
    // On the provider's default model, whatever goose's config holds.
    ...(provider ? { provider } : {}),
  }),
  // Appended under goose's own prompt, which carries each extension's
  // instructions. `set` replaces that prompt and renders the text as a
  // template, so ours goes in raw.
  systemPrompt: async (goose, sessionId, text, replace) => {
    await goose.request(
      "_goose/unstable/session/system-prompt/set",
      replace
        ? {
            sessionId,
            mode: "set",
            text: `{% raw %}${text.replace(/{%-?\s*endraw\s*-?%}/g, "")}{% endraw %}`,
          }
        : { sessionId, mode: "append", key: "buzz", text },
      REQUEST_TIMEOUT_MS,
    );
  },
  steering: {
    runId: (update) => {
      if (update.sessionUpdate !== "session_info_update") return null;
      const goose = (update._meta as { goose?: { activeRunId?: unknown } })
        ?.goose;
      if (!goose || !("activeRunId" in goose)) return null;
      return typeof goose.activeRunId === "string"
        ? goose.activeRunId
        : undefined;
    },
    steer: async (goose, sessionId, runId, text) => {
      await goose.request("_goose/unstable/session/steer", {
        sessionId,
        prompt: [{ type: "text", text }],
        expectedRunId: runId,
      });
    },
  },
  select: async (goose, session, want) => {
    const configure = async (configId: string, value: string) => {
      try {
        session.offer(
          (await goose.request("session/set_config_option", {
            sessionId: session.id,
            configId,
            value,
          })) as ConfigOptions,
        );
      } catch (error) {
        throw new Error(
          `goose could not switch its ${configId} to ${value}: ${errorMessage(error)}`,
        );
      }
    };
    if (
      want.provider !== session.chosen.provider ||
      (session.chosen.model && !want.model)
    ) {
      // goose keeps the model when the provider stays the same.
      if (want.provider && want.provider === session.chosen.provider)
        await configure("model", await defaultModel(goose, want.provider));
      else await configure("provider", want.provider || CONFIGURED);
      session.chosen = {
        ...session.chosen,
        provider: want.provider,
        model: "",
      };
    }
    if (want.model !== session.chosen.model) {
      await configure("model", want.model);
      session.chosen = { ...session.chosen, model: want.model };
    }
    // goose keeps the level across models and providers. It has no value
    // for its own default, so a session put on a level is reopened for it.
    if (want.effort && want.effort !== session.chosen.effort) {
      await configure("thinking_effort", want.effort);
      session.chosen = { ...session.chosen, effort: want.effort };
    }
  },
};

/** Starts `goose-acp` and checks it can reach the Buzz tools. */
export const GooseProcess = {
  start: async (
    spawn: Spawn,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
      protected?: boolean;
      signal?: AbortSignal;
      onProcess?: (goose: AcpProcess) => void;
      agent?: Readonly<{ pubkey: string; relay: string }>;
    }>,
  ) => {
    const goose = await AcpProcess.start(spawn, GOOSE, {
      ...launch,
      env: {
        ...databricks(),
        ...launch.env,
        ...(launch.protected && { GOOSE_DISABLE_SESSION_NAMING: "true" }),
      },
    });
    const cancel = () => void goose.kill();
    launch.signal?.addEventListener("abort", cancel, { once: true });
    try {
      launch.signal?.throwIfAborted();
      if (launch.protected) {
        const capability = (await goose.request(
          "_buzz/security/capabilities",
          {},
          REQUEST_TIMEOUT_MS,
        )) as { version?: number; enabled?: boolean };
        if (capability.version !== 2)
          throw new Error("This Goose build lacks mandatory security hooks");
        // The engine gates exactly when Buzz gives it the security bridge.
        // Engines released before it reported this omit `enabled`.
        if (
          capability.enabled !== undefined &&
          capability.enabled !== (launch.env?.BUZZ_SECURITY_URL != null)
        )
          throw new Error(
            "Protected Goose's security gate is in the wrong state",
          );
      }
      launch.signal?.throwIfAborted();
      return goose;
    } catch (error) {
      // Rejects once it has exited or `STOP_TIMEOUT_MS` has passed.
      await goose.stop(STOP_TIMEOUT_MS);
      throw error;
    } finally {
      launch.signal?.removeEventListener("abort", cancel);
    }
  },
};

async function defaultModel(goose: AcpProcess, provider: string) {
  const { entries } = (await goose.request("_goose/unstable/providers/list", {
    providerIds: [provider],
  })) as { entries: { providerId: string; defaultModel?: string }[] };
  const model = entries.find(
    (entry) => entry.providerId === provider,
  )?.defaultModel;
  if (!model) throw new Error(`goose has no default model for ${provider}`);
  return model;
}
