import { fixtureAliases } from "../relay-config.ts";
import { build } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The browser build swaps a fixture for the pairing screen the mobile card shows.
const PAIRING_CARD = "src/bundled/pairing/MobileApp.tsx";
const PAIRING_IMPORT = 'import { PairingSettings } from "./PairingSettings";';

const root = fileURLToPath(new URL("../../", import.meta.url));

// Playwright owns this worker-scoped build. Only compiled assets are shared;
// each test still owns its server, identities, relay state and browser storage.
export async function buildApp(
  {
    developmentReact,
    builderlabLogin,
    federatedIdentity,
    pluginFixtures,
    companionFixture,
    localAgentActivity,
    pairingFixture,
    startupFailureFixture,
  },
  use,
) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-build-"));
  let pairingSwapped = false;
  try {
    const config = {
      root,
      mode: "production",
      configFile: false,
      envFile: false, // Never read the developer's live identity configuration.
      logLevel: "error",
      plugins: [
        react(),
        ...(pairingFixture
          ? [
              {
                name: "pairing-fixture",
                transform(code, id) {
                  if (id !== join(root, PAIRING_CARD)) return;
                  if (!code.includes(PAIRING_IMPORT))
                    throw new Error(
                      `${PAIRING_CARD} no longer imports PairingSettings as the pairing fixture expects.`,
                    );
                  pairingSwapped = true;
                  return code.replace(
                    PAIRING_IMPORT,
                    `import { PairingFixture as PairingSettings } from ${JSON.stringify(join(root, "tests/browser/pairing-fixture.tsx"))};`,
                  );
                },
                buildEnd(error) {
                  // A moved card would otherwise build the real pairing screen.
                  if (!error && !pairingSwapped)
                    throw new Error(
                      `The pairing fixture never replaced ${PAIRING_CARD}.`,
                    );
                },
              },
            ]
          : []),
        ...(pluginFixtures || companionFixture
          ? [
              {
                name: "fixture-installed-plugins",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/index.ts")) return;
                  const source = pluginFixtures
                    ? "plugin-fixtures"
                    : "companion-fixture";
                  const exported = pluginFixtures
                    ? "fixturePlugins"
                    : "companionPlugins";
                  // Keep the companion after the built-ins so catalog scrolling
                  // remains part of its focus-restoration journey.
                  const injected = pluginFixtures
                    ? code.replace("= [", `= [ ...${exported},`)
                    : code.replace(/\];\s*$/, `].concat(${exported});`);
                  return `import { ${exported} } from ${JSON.stringify(join(root, `tests/browser/${source}.tsx`))};\n${injected}`;
                },
              },
            ]
          : []),
      ],
      define: {
        ...(builderlabLogin
          ? {
              "import.meta.env.VITE_BUZZ_BUILDERLAB_URL":
                '"https://app.builderlab.xyz"',
            }
          : {}),
        ...(federatedIdentity
          ? { "import.meta.env.VITE_BUZZ_FEDERATED_IDENTITY": '"1"' }
          : {}),
        ...(developmentReact ? { "import.meta.env.DEV": "true" } : {}),
        "import.meta.env.VITE_BUZZ_LIVE": '"1"',
        "import.meta.env.VITE_BUZZ_TEST_RESUME_AGENTS": JSON.stringify(
          localAgentActivity === "resumable",
        ),
        "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
          JSON.stringify(fixtureAliases),
        ...(developmentReact
          ? { "process.env.NODE_ENV": '"development"' }
          : {}),
      },
      build: { outDir: join(directory, "dist"), emptyOutDir: true },
    };
    // Fixture histories are signed in 2023, so the 30-day read floor would read
    // every one of them. Journeys assert unread behavior, not retention; the
    // floor itself is covered by read-state unit tests.
    config.plugins.push({
      name: "fixture-read-floor",
      enforce: "pre",
      transform(code, id) {
        if (id !== join(root, "src/features/relay/read-state.ts")) return;
        const seam = "floor = () => now() - READ_RETENTION_SECONDS,";
        if (!code.includes(seam)) throw new Error("Missing read floor seam");
        return code.replace(seam, "floor = () => 0,");
      },
    });
    if (startupFailureFixture)
      config.plugins.push({
        name: "fixture-startup-failure",
        // Before TypeScript is stripped, so the seams are the source's.
        enforce: "pre",
        transform(code, id) {
          const seams = {
            [join(root, "src/app/services.ts")]: [
              [
                "export function createServices() {",
                "services",
                "Fixture startup failure: storage unavailable",
              ],
            ],
            [join(root, "src/app/App.tsx")]: [
              [
                "export function App({ services }: { services: AppServices }) {",
                "render",
                "Fixture startup failure: render",
              ],
              // Renders again on each navigation, with no boundary above it.
              [
                "function ConnectedAppContent({ services }: { services: AppServices }) {",
                "running",
                "Fixture crash after launch",
              ],
            ],
          };
          const file = seams[id];
          if (!file) return;
          for (const [line, where, message] of file) {
            if (!code.includes(line))
              throw new Error(`Missing startup failure seam in ${id}`);
            code = code.replace(
              line,
              `${line}\n  if (window.__buzzFixtureStartupFailure === ${JSON.stringify(where)}) throw new Error(${JSON.stringify(message)});`,
            );
          }
          return code;
        },
      });
    if (localAgentActivity)
      config.plugins.push({
        name: "fixture-local-agent",
        transform(code, id) {
          const fixture = JSON.stringify(
            join(root, "tests/browser/local-agents-fixture.ts"),
          );
          if (id === join(root, "src/features/agents/native.ts")) {
            const start = code.indexOf("export const nativeAgents =");
            if (start < 0) throw new Error("Missing native Agents seam");
            return (
              code.slice(0, start) +
              `import { localAgentsNative } from ${fixture};\nexport const nativeAgents = localAgentsNative;`
            );
          }
          if (id === join(root, "src/bundled/index.ts"))
            return (
              `import { localAgentPlugin } from ${fixture};\n` +
              code.replace("= [", "= [localAgentPlugin,")
            );
        },
      });
    const start = performance.now();
    await build(config);
    await use({ config, durationMs: performance.now() - start });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
