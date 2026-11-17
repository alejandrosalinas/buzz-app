import type { PluginModule } from "../../plugins/api";
import { TelescopeIcon } from "../../shared/design-system/icons/index";
import { FocusBanner, FocusDialog, startFocus } from "./FocusDialog";
import { FocusSettings } from "./FocusSettings";
import { createPreferences } from "./preferences";
import { createFocus } from "./state";
import { bindFocusStatus, soloConversation } from "./status";

export const inject = [
  "accountActions",
  "communityReader",
  "notifications",
  "sidebarScope",
  "relay",
  "shortcuts",
  "settingsCards",
];

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const focus = createFocus();
  const preferences = createPreferences();
  // Focus is saved on this device, so it outlives a restart, an update and
  // turning the plugin off and on. 🔭 expires on its own at the deadline.
  ctx.effect(() => {
    const status = bindFocusStatus(focus, relay);
    return () => {
      status();
      focus.dispose();
      preferences.dispose();
    };
  });
  const banner = () => <FocusBanner focus={focus} />;
  // Register the gate and the sidebar restriction only while Focus is on, so
  // disabling the plugin releases both even mid-Focus.
  ctx.effect(() => {
    let release: (() => void) | undefined;
    const sync = () => {
      const on = focus.snapshot().until !== undefined;
      if (!on) {
        release?.();
        release = undefined;
      } else if (!release) {
        const ungate = ctx.notifications.gate({
          id: "solo",
          allows: (target) =>
            soloConversation(
              target.kind === "conversation"
                ? ctx.communityReader.retained(target.scope)
                : undefined,
              target,
            ),
        });
        const unrestrict = ctx.sidebarScope.restrict({
          id: "focus",
          scope: "solo",
          banner,
        });
        release = () => {
          ungate();
          unrestrict();
        };
      }
    };
    const stop = focus.subscribe(sync);
    sync();
    return () => {
      stop();
      release?.();
    };
  });
  ctx.shortcuts.register({
    id: "toggle",
    title: "Start or end Focus",
    // Option types "ƒ" on a US Mac layout, so the key is listed both ways.
    binding: [
      { key: "f", alt: true },
      { key: "ƒ", alt: true },
    ],
    allowInEditable: true,
    run: () => {
      if (focus.snapshot().until !== undefined) focus.end();
      else startFocus(focus, preferences.snapshot().length);
    },
  });
  ctx.accountActions.register({
    id: "focus",
    title: "Focus",
    icon: <TelescopeIcon size={17} />,
    component: (props) => (
      <FocusDialog {...props} focus={focus} preferences={preferences} />
    ),
  });
  ctx.settingsCards.register({
    id: "focus",
    title: "Focus",
    group: "Plugins",
    icon: TelescopeIcon,
    component: ({ active }) => (
      <FocusSettings preferences={preferences} active={active} />
    ),
  });
};
