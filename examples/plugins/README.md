# Example plugins

All example plugins live here with `manifest.json` and prebuilt `plugin.js` files:

- `counter` and `notes`: offline playgrounds.
- `shortcut-counter`: offline keyboard-shortcut consumer; Command+Shift+G /
  Control+Shift+G increments through the injected host service. Requires `shortcuts`.
- `broken-page`: intentionally fails when its page renders to exercise error handling.

## Try the offline playgrounds

Counter and Notes are readable API v1 modules that need no
build tools or runtime dependencies. They use the host's React instance and page service. Neither
makes network requests, writes files, nor reads your account. Plugins generally are
trusted unsandboxed code; these examples do not change that trust model.

These unsigned examples can be installed by default. If you launch Buzz with
`BUZZ_REQUIRE_PLUGIN_SIGNATURES=1`, first set up your Buzz identity and sign each
example you want to install with the matching `buzzodz` CLI:

```sh
buzzodz plugin sign examples/plugins/counter
buzzodz plugin sign examples/plugins/notes
```

1. Open the desktop app → Settings → Plugins → **Load from folder**.
2. Choose this `examples/plugins` folder to see the examples, or choose
   `counter` / `notes` directly for a single result.
3. Choose **Counter playground**, then **Install plugin**. It starts disabled.
4. Enable it in the plugin list, then open its navigation tab and click the counter.
5. Return to Settings, load this parent folder again, install and enable **Notes
   playground**, then type a scratch note on its page.
6. Disable either plugin to remove only its tab; Delete removes its installation.

Counter and note state are ephemeral and reset when leaving their page. To try an
update, change visible text in `counter/plugin.js`, sign that folder again if you
previously signed it, load it, and choose **Update plugin**. An enabled plugin
stays enabled and its replacement can run immediately. **Roll back** restores the previous installed revision. Source files
are copied into the installation snapshot, not watched.

To try Git import with a signed plugin, include the generated `plugin.artifact.json`
and `plugin.signature.json` in your repository. Unsigned plugins need only
`manifest.json` and `plugin.js`. Enter that repository's supported
HTTPS/SSH URL and its branch/tag, then select `examples/plugins/counter` or
`examples/plugins/notes`. Private HTTPS authentication is not provided by this
slice; use authenticated SSH with an existing agent and known host when available.

## Add discovery metadata and a README

The checked-in manifests are minimal. On a host that supports discovery metadata,
you can extend `counter/manifest.json` like this:

```json
{
  "id": "example.counter",
  "name": "Counter playground",
  "apiVersion": 1,
  "description": "Try a click counter to explore plugin pages.",
  "discovery": {
    "category": "developer-tools-and-integrations",
    "tags": ["Examples", "React"]
  }
}
```

Choose the category from the [recognized Settings categories](../../docs/plugin-architecture.md#writing-plugin-discovery-metadata).
The description explains the behavior; tags add useful search terms. These
optional fields do not change the runtime API version.
Older hosts reject `description` and `discovery`, so omit both when targeting them.

You can package `counter/README.md` beside its manifest and prebuilt module.
Settings does not display external plugin READMEs, including this one. Keep the
guide in the same short shape used for bundled plugins, for example:

```markdown
# Counter playground

Explore a plugin page with a simple click counter.

## Getting started

1. Enable the plugin in Settings → Plugins, then open **Counter playground**
   from page navigation.
2. Click the counter button to increment the count.
```

See [plugin README guidance](../../docs/plugin-architecture.md#writing-the-plugin-readme)
and [packaging limits](../../docs/plugin-architecture.md#loading-from-folders-and-repositories)
before adding README or branding files to a build.
