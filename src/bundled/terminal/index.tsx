import { useLayoutEffect } from "react";
import { TerminalWindowIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { PluginModule } from "../../plugins/api";
import type { ChannelLauncherProps } from "../../features/panels/service";
import {
  formatBinding,
  isApplePlatform,
} from "../../features/shortcuts/format";
import { nativeBridge } from "./bridge";
import { createSessions } from "./sessions";
import { TerminalPanel } from "./TerminalPanel";
import { createTerminalFontPreference } from "./font-preference";
import {
  createTerminalSettingsDraft,
  TerminalSettings,
} from "./TerminalSettings";

export const inject = ["panels", "shortcuts", "relay", "settingsCards"];
const TOGGLE_BINDING = { key: "j", mod: true } as const;
export const apply: PluginModule["apply"] = (ctx) => {
  // No unusable launcher or reserved shortcut in a browser-only host.
  if (!nativeBridge.available) return;
  const font = createTerminalFontPreference();
  const drafts = createTerminalSettingsDraft();
  const sessions = createSessions(
    nativeBridge,
    async () => {
      const { createScreen } = await import("./renderer");
      return (input, resize) => createScreen(input, resize, font);
    },
    ctx.relay.snapshot,
  );
  let binding: { toggle(): void; available(): boolean } | undefined;
  ctx.effect(() => () => {
    binding = undefined;
    font.dispose();
    return sessions.dispose();
  });
  ctx.settingsCards.register({
    id: "settings",
    title: "Terminal",
    icon: TerminalWindowIcon,
    group: "Plugins",
    component: (props) => (
      <TerminalSettings {...props} font={font} drafts={drafts} />
    ),
  });
  ctx.shortcuts.register({
    id: "toggle",
    title: "Toggle channel terminal",
    binding: TOGGLE_BINDING,
    // Plugin Settings order: the terminal action is the category's primary action.
    order: 10,
    allowInEditable: true,
    when: () => !!binding?.available(),
    run: () => binding?.toggle(),
  });
  function Launcher({
    context,
    toggle,
    pressed,
    available,
  }: ChannelLauncherProps) {
    const target = JSON.stringify(context);
    useLayoutEffect(() => {
      const current = { toggle: () => toggle(target), available };
      binding = current;
      return () => {
        if (binding === current) binding = undefined;
      };
    }, [toggle, target, available]);
    return (
      <IconButton
        size="toolbar"
        icon={<TerminalWindowIcon size={16} aria-hidden="true" />}
        aria-label="Toggle channel terminal"
        title={`Terminal (${formatBinding(TOGGLE_BINDING, isApplePlatform(navigator.platform)).text})`}
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          toggle(target);
        }}
      />
    );
  }
  ctx.panels.register({
    id: "terminal",
    title: "Terminal",
    matches: () => false,
    channelLauncher: Launcher,
    component: (props) => <TerminalPanel {...props} sessions={sessions} />,
  });
};
