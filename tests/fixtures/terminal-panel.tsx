import { Context } from "@deepseek-ai/cordis";
import { ShortcutsService } from "../../src/features/shortcuts/service";
import { createShortcutBindings } from "../../src/features/shortcuts/preferences";
import { ShortcutSettings } from "../../src/app/ShortcutSettings";
import type { PluginManager } from "../../src/plugins/manager";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { useChannelPanels } from "../../src/bundled/channels/useChannelPanels";
import channelStyles from "../../src/bundled/channels/Channels.module.css";
import { apply } from "../../src/bundled/terminal";
import { nativeBridge } from "../../src/bundled/terminal/bridge";
import type { TerminalBridge } from "../../src/bundled/terminal/bridge";
import { SettingsCardsService } from "../../src/features/settings/service";
import type {
  Panel,
  Panels,
  RegisteredPanel,
  ChannelPanelContext,
} from "../../src/features/panels/service";

// Production plugin, controls and renderer; only the native shell is replaced.
const context: ChannelPanelContext = {
  scope: "fixture",
  viewer: "01".repeat(32),
  channelId: "terminal-fixture",
  channelName: "a-channel-with-a-long-name-for-terminal-layout",
  relayUrl: "wss://example.invalid",
  threadId: "ab".repeat(32),
};
let serial = 0;
let output = false;
let failClose = false;
let closing: Promise<void> | undefined;
let releaseClose: (() => void) | undefined;
let closePending = false;
let written = "";
let toggles = 0;
const bindings = createShortcutBindings(window);
const scope = new Context();
scope.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
const shortcuts = new ShortcutsService(scope, window, bindings);
const settingsCards = new SettingsCardsService(scope);
Object.assign(window, {
  terminalPanel: {
    written: () => written,
    toggles: () => toggles,
    spawns: () => serial,
    dispose: () => scope.fiber.dispose(),
    holdClose() {
      closing = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
    closePending: () => closePending,
    releaseClose() {
      releaseClose?.();
      closing = undefined;
    },
  },
});
const bridge: TerminalBridge = {
  available: true,
  createOwner: async () => "fixture-owner",
  spawn: async () => {
    output = true;
    return String(++serial);
  },
  read: async () => {
    const data = new TextEncoder().encode(
      output ? "FIXTURE_SHELL_READY\r\n" : "",
    );
    output = false;
    return { data, exited: false };
  },
  write: async (_owner, _id, data) => {
    written += data;
  },
  resize: async () => {},
  close: async () => {
    closePending = true;
    try {
      await (closing ?? new Promise((resolve) => setTimeout(resolve, 250)));
      if (failClose)
        throw new Error("Fixture close failed. Try End session again.");
    } finally {
      closePending = false;
    }
  },
  closeOwner: async () => {},
};
Object.assign(nativeBridge, bridge);
let contribution: Panel | undefined;
scope.provide("panels", {
  register: (panel: Panel) => {
    contribution = panel;
  },
} as unknown as typeof scope.panels);
scope.provide("relay", {
  snapshot: () => ({
    scope: context.scope,
    viewer: context.viewer,
    status: "ready",
  }),
} as unknown as typeof scope.relay);
await scope
  .extend({ pluginOwner: { id: "buzz.terminal", revision: "fixture" } })
  .plugin((ctx) => apply(ctx))
  .await();
const pluginState = { configuration: { status: "loading" } };
const plugins = {
  subscribe: () => () => {},
  snapshot: () => pluginState,
} as unknown as Pick<PluginManager, "subscribe" | "snapshot">;
if (!contribution?.channelLauncher)
  throw new Error("Missing terminal contribution");
const Launcher = contribution.channelLauncher;
const Content = contribution.component;
const FontSettings = settingsCards
  .snapshot()
  .find((card) => card.title === "Terminal")?.component;
if (!FontSettings) throw new Error("Missing terminal settings card");
function Fixture() {
  useKeyboardFocusVisibility();
  const [visible, show] = useState(false);
  const [settings, showSettings] = useState(false);
  const [fontSettings, showFontSettings] = useState(false);
  return (
    <>
      <button type="button" onClick={() => showFontSettings((value) => !value)}>
        Terminal font settings
      </button>
      {fontSettings && FontSettings && (
        <div style={{ maxWidth: "48rem", padding: "var(--space-4)" }}>
          <FontSettings active={() => true} />
        </div>
      )}
      <button type="button" onClick={() => showSettings((value) => !value)}>
        Shortcut settings
      </button>
      {settings && (
        // Bounded, so the read-only formatting group can't push the drawer
        // out of the viewport, where xterm has no rows to render.
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          <ShortcutSettings
            shortcuts={shortcuts}
            bindings={bindings}
            plugins={plugins}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode =
            document.documentElement.dataset.colorMode === "dark"
              ? "light"
              : "dark";
        }}
      >
        Toggle theme
      </button>
      <button
        type="button"
        onClick={() =>
          document.documentElement.style.setProperty("--buzz-text-scale", "1.5")
        }
      >
        Enlarge text
      </button>
      <button
        type="button"
        onClick={() => {
          failClose = !failClose;
        }}
      >
        Toggle close failure
      </button>
      <div className={channelStyles.root}>
        <nav
          className={channelStyles.heading}
          aria-label="Legacy channel header"
        >
          <Launcher
            context={context}
            pressed={visible}
            available={() => true}
            toggle={() => {
              toggles++;
              show((value) => !value);
            }}
          />
        </nav>
        {visible && (
          <section
            aria-label="Terminal drawer"
            className={channelStyles.channelDrawer}
            style={{
              width: "100%",
              height: new URLSearchParams(location.search).has("short")
                ? 180
                : 360,
            }}
          >
            <Content
              target="fixture"
              channelContext={context}
              close={() => show(false)}
            />
          </section>
        )}
      </div>
    </>
  );
}
// Motion coverage exercises the production drawer owner as well as the plugin.
const registered: RegisteredPanel = {
  ...contribution,
  key: "buzz.terminal/terminal",
  pluginId: "buzz.terminal",
  revision: "fixture",
};
const entries = [registered];
const panels: Panels = {
  snapshot: () => entries,
  subscribe: () => () => {},
  register: () => {},
  resolve: () => registered,
};
function MotionFixture() {
  useKeyboardFocusVisibility();
  const drawer = useChannelPanels(panels, context);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {drawer.launchers}
      <div style={{ flex: 1 }}>Conversation</div>
      {drawer.content}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  new URLSearchParams(location.search).has("motion") ? (
    <MotionFixture />
  ) : (
    <Fixture />
  ),
);
