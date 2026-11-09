// Agent mode on the app's bundled goose-acp, pointed at this community's leased
// Mesh route. Each turn starts its own goose process and one ACP session, then
// stops it: the turn's prompt is rebuilt from the relay conversation, so nothing
// carries between turns. goose's built-in OpenAI provider talks to the loopback
// lease route; the Buzz tools are the same in-process handlers the Goose plugin
// serves over a loopback MCP server. No Buzz key reaches goose.
import type { AgentHandle } from "../../features/agents/service";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import { errorText, respond } from "../../buzz-mcp/rpc";
import {
  GooseProcess,
  type PlatformExtension,
  type ServeMcp,
  type ToolServer,
} from "../goose/goose";
import {
  type InlineTurn,
  type MeshAgentDeps,
  resolveWorkspace,
} from "./meshAgent";
import {
  gooseTurns,
  type GooseTranscript,
  type MeshHistoryRow,
} from "./meshTranscript";

type Message = Parameters<typeof gooseTurns>[0][number];
type Saved = {
  agent: string;
  row: MeshHistoryRow;
  messages: Message[];
};

/** Where goose keeps its config and sessions for Mesh turns, apart from the
 * owner's own goose. */
const GOOSE_ROOT = ".buzz/.mesh-goose";

/** goose's tools for Mesh turns beside the Buzz tools: a shell and skills.
 * Small models do better with a short tool list. */
const MESH_EXTENSIONS: readonly PlatformExtension[] = [
  { type: "platform", name: "developer", available_tools: ["shell"] },
  { type: "platform", name: "skills" },
];

/** goose's environment for one turn on `baseUrl`
 * (`http://127.0.0.1:<port>/<lease>/v1`). */
export function meshGooseEnv(
  baseUrl: string,
  root: string,
): Record<string, string> {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return {
    GOOSE_PATH_ROOT: root,
    GOOSE_DISABLE_KEYRING: "1",
    OPENAI_HOST: url.origin,
    OPENAI_BASE_PATH: `${path}/chat/completions`,
    // The loopback route takes no key; goose needs one to start the provider.
    OPENAI_API_KEY: "mesh-local",
  };
}

export class MeshGoose {
  private saved = new Map<string, Saved>();
  private active = new Set<AbortController>();
  constructor(
    private readonly deps: Pick<
      MeshAgentDeps,
      "spawn" | "resolveDirectory" | "current" | "memories" | "remembered"
    > & { serve: ServeMcp },
  ) {}

  dispose() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.saved.clear();
  }

  async run(input: InlineTurn): Promise<{ text: string; answered: boolean }> {
    const { delivery, inference, cwd, context, system, prompt } = input;
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([delivery.signal, controller.signal]);
    const live = () => {
      signal.throwIfAborted();
      if (delivery.current && !delivery.current())
        throw new Error("Agent turn ended");
    };
    const check = async () => {
      live();
      if (!(await this.deps.current(inference.lease)))
        throw new Error("Mesh selection retired");
      live();
    };
    const guarded: AgentHandle = {
      ...delivery.agent,
      publish: async (event, beforeSign) => {
        await check();
        return delivery.agent.publish(event, () => {
          live();
          beforeSign?.();
        });
      },
      query: async (filters) => {
        await check();
        return delivery.agent.query(filters);
      },
      upload: async (data, mime) => {
        await check();
        return delivery.agent.upload(data, mime);
      },
      media: async (url) => {
        await check();
        return delivery.agent.media(url);
      },
      remember: async (slug, body, after) => {
        await check();
        return delivery.agent.remember(slug, body, after);
      },
    };
    const client = appClient(guarded, {
      read: (path) => readFile(this.deps.spawn, cwd, path, signal),
      signal,
      check: () => {
        if (delivery.current && !delivery.current())
          throw new Error("Agent turn ended");
      },
      memories: (slug) =>
        this.deps.memories?.(delivery.agent.key, signal, slug) ??
        Promise.resolve({ entries: [], partial: false }),
      remembered: () => this.deps.remembered?.(delivery.agent.key),
    });
    const tools: ToolServer = (_conversation, message) =>
      respond(client, context, message);

    const id = crypto.randomUUID();
    const saved: Saved = {
      agent: delivery.agent.key,
      row: {
        sessionId: id,
        title: "goose on shared compute (this app session)",
        at: Date.now(),
        channelId: context.channel ?? "",
        ...(context.root ? { root: context.root } : {}),
      },
      messages: [
        {
          role: "user",
          created: Math.floor(Date.now() / 1000),
          content: [{ type: "text", text: prompt }],
        },
      ],
    };
    this.remember(id, saved);

    let goose: GooseProcess | undefined;
    const stop = () => {
      void goose?.kill().catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      await check();
      const root = `${await resolveWorkspace(this.deps, "~")}/${GOOSE_ROOT}`;
      goose = await GooseProcess.start(this.deps.spawn, {
        cwd,
        env: meshGooseEnv(inference.baseUrl, root),
        serve: this.deps.serve,
        signal,
      });
      signal.throwIfAborted();
      const session = await goose.open({
        cwd,
        systemPrompt: system,
        tools,
        platform: MESH_EXTENSIONS,
        // goose's own prompt is ~6.7 KB; with it Gemma writes tool calls as
        // fenced text the mesh does not parse.
        replacePrompt: true,
        choice: () => ({ provider: "openai", model: inference.model }),
      });
      await check();
      const settled = await session.send(prompt);
      signal.throwIfAborted();
      if (!settled.ok) throw new Error(settled.error || "goose ended the turn");
      const text = settled.text?.trim() ?? "";
      saved.messages.push({
        role: "assistant",
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: "text",
            text: text || "(answered with Buzz tools)",
          },
        ],
      });
      await check();
      // Empty model output alone is not evidence of a Buzz answer.
      return { text, answered: settled.answered === true };
    } catch (error) {
      saved.messages.push({
        role: "assistant",
        created: Math.floor(Date.now() / 1000),
        content: [
          {
            type: "text",
            text: `Turn ended: ${errorText(error)}. Earlier tool effects may have occurred; do not assume they were rolled back.`,
          },
        ],
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
      controller.abort();
      this.active.delete(controller);
    }
  }

  private remember(id: string, saved: Saved) {
    this.saved.set(id, saved);
    for (const oldest of this.saved.keys()) {
      if (this.saved.size <= 50) break;
      this.saved.delete(oldest);
    }
  }

  async recent(agent: string, _workspace: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return [...this.saved.values()]
      .filter((s) => s.agent === agent)
      .map((s) => s.row)
      .sort((a, b) => b.at - a.at);
  }

  async transcript(
    agent: string,
    _workspace: string,
    row: MeshHistoryRow,
    signal: AbortSignal,
  ): Promise<GooseTranscript> {
    signal.throwIfAborted();
    const saved = this.saved.get(row.sessionId);
    if (!saved || saved.agent !== agent)
      throw new Error("This session transcript is no longer available");
    return {
      turns: gooseTurns(saved.messages, row, true),
      more: false,
    };
  }
}
