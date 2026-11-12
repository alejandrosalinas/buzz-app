# Buzz tools

The tools in this directory are the reference interface for Buzz agents, local
and remote. Remote agents run on another host with similar tools, so a prompt
or skill that works for a local agent works for a remote one. Change them
deliberately.

## Files

- `tools.ts`: each tool's name, description and schema in `TOOLS`, and its
  behavior in `HANDLERS`.
- `attention.ts`: the attention tools (`interest_*`, `watch_*`).
- `solo-worker.ts`: the Solo worker tools (`solo_worker_*`), which ask an
  owner's Buzz to run its workers; `solo-worker-protocol.ts` is their wire
  contract, pinned by `solo-worker-vectors.json`.
- `plugins.ts`: the plugin tools (`plugin_*`), which read this device's plugins
  and ask the owner to change them, which also posts the request's card message
  into the conversation; `src/plugins/requests.ts` owns the requests.
- `settings.ts`: the settings tools (`settings_list`, `settings_get`,
  `settings_set`). The settings themselves are the host's catalog
  (`src/app/device-settings.ts`); the tools never name one.
- `session-tools.ts`: what a session lists, each tool's `load` (`always` or
  `search`), and the server instructions that cover the whole tool set.
- `prompt.md`: the posting conventions every agent gets after the shared base
  prompt, `src/features/agent-harness/base_prompt.md`. A turn a mention or DM
  starts also gets `mention_prompt.md` beside it. All of them name tools.

## Interface

A tool's interface is its name, description, arguments (names, types,
descriptions, which are required), defaults such as `channel` and `reply`
defaulting to the current conversation, result shape, error text and `load`
mode.

## Design rules

1. **Many small tools are fine** as long as each has a clear name, a precise
   description and explicit parameters. Prefer `canvas_get` and `canvas_set` to
   one `canvas(action, …)` tool.
2. **Don't hide tools behind a discovery meta tool**, such as a `search_tools`
   or `run_tool(name, args)` wrapper. List each tool with its real schema, and
   use `load: "search"` for tools that don't need to load up front.
3. **Don't bloat descriptions or schemas.** A description says what the tool
   does and anything the model can't guess. Routing, etiquette and workflow
   guidance go in the server instructions or `prompt.md`, not in every tool.
   Describe an argument only when its name and type don't make its meaning
   clear.
4. **Mark writes accurately** with MCP tool annotations where possible.
5. **Use server instructions** for guidance that covers the whole tool set:
   which tool to reach for, how tools relate, and shared conventions.

## Remote agents

A remote agent's tools can differ: its host may add tools or arguments, for
example for its sandbox, or leave out an argument it can't support. Keep the
differences small so agents work the same way on any host.
