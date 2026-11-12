# Add your own Pi extensions to Buzz

Buzz's Pi agents run on [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md),
not on the `pi` coding agent, so extensions written for `pi`, which export
`(pi) => { ... }`, don't load in Buzz. A Pi package can also hold parts written
for Pi durable, and Buzz loads those:

- **Extensions:** tools, prompt sections and hooks, such as a hook that blocks a
  command. Every Pi agent on this computer gets them.
- **Providers:** models from a provider Pi doesn't have built in. You choose
  them for an agent like any other provider.

## 1. Make a package

A package is a folder with a `package.json` that lists its Pi durable entry
under `pi.durable`:

```json
{
  "name": "guard",
  "private": true,
  "type": "module",
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-durable": "*",
    "@earendil-works/pi-schema": "*"
  },
  "pi": { "durable": ["./durable.ts"] }
}
```

The entry's default export returns what the package adds,
`{ extensions?, providers? }`, and may be `async`. This `durable.ts` blocks
recursive deletes, adds a house rule to the system prompt, and adds a
`word_count` tool:

```ts
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

const wordCount = defineTool({
  name: "word_count",
  description: "Count the words in a text",
  parameters: obj({ text: str() }),
  execute: async (args: { text: string }) => ({
    output: [{ type: "text", text: `${args.text.trim().split(/\s+/).filter(Boolean).length} words` }],
  }),
});

export default () => ({
  extensions: [
    defineExtension({
      name: "guard",
      sections: [section("house-rules", () => "House rule: never delete files recursively.")],
      tools: [wordCount],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) =>
            call.name === "bash" && /\brm\s+-\w*r/.test(String(call.arguments?.command ?? ""))
              ? { block: "The guard package blocks recursive deletes" }
              : undefined,
        }),
      ],
    }),
  ],
});
```

The durable README's
[Extensions](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#extensions)
section lists everything an extension can hold.

Things to know:

- **Pi comes from Buzz.** A package gets Buzz's own copy of the
  `@earendil-works` packages, the versions in
  [`deps/package.json`](deps/package.json), so list them as
  `peerDependencies`. Install any other dependencies in the package's folder
  with `npm install --ignore-scripts --legacy-peer-deps`, which leaves the peers
  out.
- **TypeScript runs without a build**, in the subset Node runs as is:
  - Import types with `import type`.
  - Write relative imports with their `.ts` extension.
  - Don't use `enum` or `namespace`.
- **Names.** An extension can't be named `buzz`, `coding-tools`,
  `tool-search` or the name of another package's extension. Tools and
  sections aren't checked: packages load after Pi's own tools, in the order
  they're listed, and one with the same name as a tool or section loaded
  before it replaces that one for every agent. A tool named `bash`, `read`,
  `write` or `edit` replaces Pi's, so to change one of Pi's tools, use
  `wrapTool` instead. Buzz's own tools (named `buzz_…`) and section
  (`buzz-tools`) load last, so a package's tool or section with one of those
  names never runs.
- **`pi` ignores `pi.durable`.** It reads only the `extensions`, `skills`,
  `prompts` and `themes` lists under `pi`, so a package with only `pi.durable`
  gives `pi` nothing. One package can serve both: keep a `pi.extensions` entry
  for `pi` next to `pi.durable`.

## 2. Add a provider (optional)

To add models, return a [pi-ai](https://github.com/earendil-works/pi/tree/main/packages/ai)
provider in `providers`. This one adds a model from an OpenAI-compatible
endpoint:

```ts
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const baseUrl = "https://llm.example.com/v1";

export default () => ({
  providers: [
    createProvider({
      id: "example-gateway",
      name: "Example gateway",
      baseUrl,
      // Buzz asks for the key; EXAMPLE_GATEWAY_API_KEY works for `pi`.
      auth: { apiKey: envApiKeyAuth("Example gateway API key", ["EXAMPLE_GATEWAY_API_KEY"]) },
      api: openAICompletionsApi(),
      models: [
        {
          id: "example-model",
          name: "Example model",
          api: "openai-completions",
          provider: "example-gateway",
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    }),
  ],
});
```

Buzz uses the models a provider lists when it loads. It doesn't run a
provider's `fetchModels`, so list every model in `models`.

A provider takes the place of any with the same `id`, whether one of Pi's own
or one from a package earlier in the list, so give yours an `id` of its own.

Buzz's provider settings take only API keys. For a provider whose sign-in
opens a browser:

- Give its `auth` an `oauth` method too, which Buzz uses to refresh the
  sign-in.
- Sign in with `pi`: run `pi`, then `/login`. `pi` signs in only to providers
  it has, so the package must also register the provider, with the same `id`,
  in a `pi.extensions` entry. Pi's
  [custom provider guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md#provide-authentication)
  shows how.

Buzz and `pi` share Pi's `auth.json`, so a sign-in or key saved in one works in
both.

## 3. List the package in Pi's settings

Add the package's folder to `packages` in `~/.pi/agent/settings.json`, the list
`pi install` writes to. A path can be absolute, start with `~/`, or be relative
to `~/.pi/agent`:

```json
{
  "packages": ["~/pi-packages/guard", "~/pi-packages/example-gateway"]
}
```

Buzz loads only packages in a local folder. It leaves out packages that
`pi install` fetched from npm or git, and loads nothing from packages without
a `pi.durable` entry.

## 4. Restart Buzz

Quit Buzz and open it again. Buzz loads the packages when it first starts Pi,
such as for an agent's first turn or its provider settings, and keeps them
until it quits.

## 5. Use it

- **Extensions** apply to every Pi agent, with nothing to choose. To try the
  guard, ask an agent to run `echo rm -rf ./nothing` with bash. The command
  would only print, but the guard blocks it, and the agent says so. Ask it for
  its house rules to see the section.
- **Providers** appear in the **Provider** list with Pi's own. For a new agent,
  choose **New agent** → **Create a new agent**, pick **Pi** as the
  **Harness**, then choose the provider, enter its key, and choose a model.
  For an existing agent, choose the provider in the agent's **Identity** tab,
  and enter its key in the agent's **Settings** tab. **Test connection** checks
  that the model answers.

## When something doesn't load

Buzz leaves out a package that fails to load and still loads the others. A
package fails when:

- Its setup throws or takes longer than 30 seconds.
- An extension has a problem Pi durable rejects, such as a section key that
  isn't lowercase, or a name that's already taken.
- A provider lacks an `id`, `name`, `auth` or `getModels`, which one made
  with `createProvider` always has, or lists no models.
- Its source isn't a local folder, or its `pi.durable` isn't a list.

When a provider is missing from the **Provider** list, its package didn't load.
An agent set to use it fails its next turn, with an error that names each
package that didn't load and why. Buzz doesn't yet say when a package with only
extensions didn't load: if a tool or rule doesn't show up, check the package
against the list above.

## Limits

- Every Pi agent gets every package's extensions. An agent can't opt out.
- A change to a package or to the list takes effect after Buzz restarts.
- Removing a package takes its tools and hooks out of existing conversations
  without telling the agent: a removed guard stops guarding. An agent whose
  provider came from a removed package stops answering until you choose
  another provider.
- Package code runs with your permissions, in the one process that runs every
  Pi agent. Install only packages you trust.
- Buzz runs a package's setup once for all Pi agents, so anything it keeps in
  memory is shared by every agent. Keep a conversation's state in a Pi durable
  [document](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#your-own-state).
