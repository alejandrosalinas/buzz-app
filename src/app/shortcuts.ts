import { isTauri } from "@tauri-apps/api/core";
import { isApplePlatform } from "../features/shortcuts/format";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { Appearance } from "../shared/theme/service";
import { statusShortcut } from "../features/user-status/status-shortcut";
import {
  activeMessageList,
  reactionTrigger,
  replyTrigger,
  selectedMessage,
  selectNewestMessage,
} from "../features/messages/message-selection";
import {
  composerFocusTarget,
  focusKeyboardTarget,
  paneFocusTarget,
} from "./focus-navigation";

/** Host actions use the same binding/dispatch rules as plugins, without fake plugin ownership. */
// Settings presents the host category in functional sections: navigation,
// interface sizing, search/settings, tab/focus actions, then app reload.
export const HOST_SHORTCUT_ORDER = {
  home: 10,
  navigationBack: 20,
  navigationForward: 30,
  textSizeIncrease: 40,
  textSizeDecrease: 50,
  textSizeReset: 60,
  search: 70,
  settings: 80,
  shortcutsHelp: 81,
  status: 83,
  nextTab: 82,
  previousTab: 84,
  close: 85,
  focus: 86,
  editMessage: 87,
  reactToMessage: 88,
  reactToLatest: 89,
  replyToMessage: 91,
  markMessageUnread: 92,
  deleteMessage: 93,
  reload: 95,
} as const;

export function registerAppShortcuts(
  shortcuts: ShortcutsService,
  appearance: Appearance,
  openSettings: () => void,
  ready: boolean,
) {
  const apple = isApplePlatform(navigator.platform);
  const remove = [
    shortcuts.registerHost({
      id: "focus-composer",
      title: "Focus message box",
      binding: { key: "l", mod: true },
      order: HOST_SHORTCUT_ORDER.focus,
      allowInEditable: true,
      when: () =>
        !document.activeElement?.closest(".xterm") && !!composerFocusTarget(),
      run: () => focusKeyboardTarget(composerFocusTarget()),
    }),
    ...(apple ? (["main", "side"] as const) : [undefined]).map((pane) =>
      shortcuts.registerHost({
        id: pane ? `focus-${pane}-pane` : "focus-pane",
        title: pane ? `Focus ${pane} pane` : "Focus next pane",
        binding: pane
          ? {
              key: { main: "h", side: "l" }[pane],
              mod: true,
              shift: true,
            }
          : [{ key: "F8" }, { key: "F8", shift: true }],
        order: HOST_SHORTCUT_ORDER.focus,
        allowInEditable: true,
        when: () => !!paneFocusTarget(pane),
        run: () => focusKeyboardTarget(paneFocusTarget(pane)),
      }),
    ),
    shortcuts.registerHost({
      id: "set-status",
      title: "Set a status",
      binding: { key: "y", mod: true, shift: true },
      order: HOST_SHORTCUT_ORDER.status,
      // The message editor keeps this chord as Redo; elsewhere it opens status.
      allowInEditable: true,
      when: () => ready && !!statusShortcut.current,
      run: () => {
        statusShortcut.current?.();
      },
    }),
    shortcuts.registerHost({
      id: "settings",
      title: "Open Settings",
      binding: { key: ",", mod: true },
      order: HOST_SHORTCUT_ORDER.settings,
      allowInEditable: true,
      when: () => ready,
      run: openSettings,
    }),
    ...(
      [
        [
          "font-increase",
          "Increase interface size",
          HOST_SHORTCUT_ORDER.textSizeIncrease,
          [
            { key: "=", mod: true },
            { key: "=", mod: true, shift: true },
            { key: "+", mod: true },
            { key: "+", mod: true, shift: true },
          ],
          () => appearance.setFontScale(appearance.snapshot().fontScale + 0.1),
        ],
        [
          "font-decrease",
          "Decrease interface size",
          HOST_SHORTCUT_ORDER.textSizeDecrease,
          { key: "-", mod: true },
          () => appearance.setFontScale(appearance.snapshot().fontScale - 0.1),
        ],
        [
          "font-reset",
          "Reset interface size",
          HOST_SHORTCUT_ORDER.textSizeReset,
          { key: "0", mod: true },
          () => appearance.setFontScale(1),
        ],
      ] as const
    ).map(([id, title, order, binding, run]) =>
      shortcuts.registerHost({
        id,
        title,
        order,
        binding,
        run,
        allowInEditable: true,
        allowInModal: true,
        repeat: true,
      }),
    ),
  ];
  remove.push(...registerMessageShortcuts(shortcuts));
  remove.push(
    shortcuts.registerHost({
      id: "app-reload",
      title: "Reload Buzz",
      binding: { key: "r", mod: true },
      order: HOST_SHORTCUT_ORDER.reload,
      allowInEditable: true,
      allowInModal: true,
      run: () => window.location.reload(),
    }),
  );
  // macOS owns Close and tab switching in its native menu; browser builds keep
  // browser shortcuts.
  if (isTauri() && !isApplePlatform(navigator.platform)) {
    remove.push(
      shortcuts.registerHost({
        id: "close-tab",
        title: "Close tab",
        binding: { key: "w", mod: true },
        order: HOST_SHORTCUT_ORDER.close,
        allowInEditable: true,
        // xterm hands keys to this dispatcher before writing PTY bytes. Keep
        // Ctrl+W as shell word deletion in both the terminal tab and drawer.
        when: () => !document.activeElement?.closest(".xterm"),
        // Only ever closes a tab: with nothing to close, the window stays.
        run: () => {
          window.dispatchEvent(
            new Event("buzz:close-active-tab", { cancelable: true }),
          );
        },
      }),
      ...(
        [
          ["next-tab", "Show next tab", HOST_SHORTCUT_ORDER.nextTab, false],
          [
            "previous-tab",
            "Show previous tab",
            HOST_SHORTCUT_ORDER.previousTab,
            true,
          ],
        ] as const
      ).map(([id, title, order, shift]) =>
        shortcuts.registerHost({
          id,
          title,
          binding: { key: "Tab", mod: true, shift },
          order,
          allowInEditable: true,
          repeat: true,
          run: () => {
            window.dispatchEvent(new Event(`buzz:${id}`, { cancelable: true }));
          },
        }),
      ),
    );
  }
  // macOS Buzz → Settings… runs the Open Settings shortcut, with its own
  // eligibility.
  const settings = () => shortcuts.runHost("settings");
  window.addEventListener("buzz:open-settings", settings);
  remove.push(() => window.removeEventListener("buzz:open-settings", settings));
  return () => {
    for (const dispose of remove) dispose();
  };
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Selecting a message mounts its action bar; give the picker a few frames. */
async function openReactionPicker() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const selected = selectedMessage();
    if (!selected) return;
    const trigger = reactionTrigger(selected.element);
    if (trigger) {
      trigger.click();
      return;
    }
    await nextFrame();
  }
}

/** Slack's message keys: Up from an empty composer selects, these act on it. */
function registerMessageShortcuts(shortcuts: ShortcutsService) {
  return [
    shortcuts.registerHost({
      id: "edit-message",
      title: "Edit selected message",
      binding: { key: "e" },
      order: HOST_SHORTCUT_ORDER.editMessage,
      when: () => {
        const selected = selectedMessage();
        return !!selected && selected.list.canEdit(selected.row);
      },
      run: () => {
        const selected = selectedMessage();
        if (selected?.list.canEdit(selected.row))
          selected.list.edit(selected.row);
      },
    }),
    shortcuts.registerHost({
      id: "react-to-message",
      title: "React to selected message",
      binding: { key: "r" },
      order: HOST_SHORTCUT_ORDER.reactToMessage,
      when: () => {
        const selected = selectedMessage();
        return !!selected && !!reactionTrigger(selected.element);
      },
      run: openReactionPicker,
    }),
    shortcuts.registerHost({
      id: "reply-to-message",
      title: "Reply in thread to selected message",
      binding: [{ key: "t" }, { key: "ArrowRight" }],
      order: HOST_SHORTCUT_ORDER.replyToMessage,
      when: () => {
        const selected = selectedMessage();
        return !!selected && !!replyTrigger(selected.element);
      },
      run: () => {
        const selected = selectedMessage();
        if (selected) replyTrigger(selected.element)?.click();
      },
    }),
    shortcuts.registerHost({
      id: "mark-message-unread",
      title: "Mark unread from selected message",
      binding: { key: "u" },
      order: HOST_SHORTCUT_ORDER.markMessageUnread,
      when: () => {
        const selected = selectedMessage();
        return !!selected && selected.list.canMarkUnread(selected.row);
      },
      run: () => {
        const selected = selectedMessage();
        if (selected?.list.canMarkUnread(selected.row))
          selected.list.markUnread(selected.row);
      },
    }),
    shortcuts.registerHost({
      id: "delete-message",
      title: "Delete selected message",
      // Mac keyboards' Delete key reports Backspace.
      binding: [{ key: "Delete" }, { key: "Backspace" }],
      order: HOST_SHORTCUT_ORDER.deleteMessage,
      when: () => {
        const selected = selectedMessage();
        return !!selected && selected.list.canDelete(selected.row);
      },
      run: () => {
        const selected = selectedMessage();
        if (selected?.list.canDelete(selected.row))
          selected.list.remove(selected.row);
      },
    }),
    shortcuts.registerHost({
      id: "react-to-latest",
      title: "React to latest message",
      // Shift turns Backslash into a bar on common layouts.
      binding: [
        { key: "\\", mod: true, shift: true },
        { key: "|", mod: true, shift: true },
      ],
      order: HOST_SHORTCUT_ORDER.reactToLatest,
      allowInEditable: true,
      when: () => !!activeMessageList(),
      run: async () => {
        // Always the latest, even from another selected message; R reacts to that.
        if (!selectNewestMessage(activeMessageList())) return;
        await openReactionPicker();
      },
    }),
  ];
}

export function registerNavigationShortcuts(
  shortcuts: ShortcutsService,
  navigation: import("../features/navigation/controller").Navigation,
) {
  const remove = [
    shortcuts.registerHost({
      id: "home",
      title: "Home",
      order: HOST_SHORTCUT_ORDER.home,
      // Placeholder chord: Slack's ⌘⇧A belongs to Inbox's unread view.
      binding: { key: "o", mod: true, shift: true },
      allowInEditable: true,
      run: () =>
        navigation.open({ version: 1, kind: "home" }).then(() => undefined),
    }),
    shortcuts.registerHost({
      id: "shortcuts-help",
      title: "Show keyboard shortcuts",
      order: HOST_SHORTCUT_ORDER.shortcutsHelp,
      // Not Mod+Shift+? too: macOS reserves it for Help menu search.
      binding: { key: "/", mod: true },
      allowInEditable: true,
      run: () =>
        navigation
          .open({ version: 1, kind: "settings", section: "shortcuts" })
          .then(() => undefined),
    }),
    shortcuts.registerHost({
      id: "navigation-back",
      title: "Go back",
      order: HOST_SHORTCUT_ORDER.navigationBack,
      binding: { key: "[", mod: true },
      allowInEditable: true,
      // Back closes a dialog that is its own visit (docs/navigation-history.md).
      allowInVisit: true,
      when: () => navigation.snapshot().canGoBack,
      run: navigation.back,
    }),
    shortcuts.registerHost({
      id: "navigation-forward",
      title: "Go forward",
      order: HOST_SHORTCUT_ORDER.navigationForward,
      binding: { key: "]", mod: true },
      allowInEditable: true,
      allowInVisit: true,
      when: () => navigation.snapshot().canGoForward,
      run: navigation.forward,
    }),
  ];
  // macOS mouse back/forward a focused browser page left unhandled runs the
  // Back/Forward shortcut, with its own eligibility.
  const history = (id: string) => (event: Event) => {
    if (!event.defaultPrevented && shortcuts.runHost(id))
      event.preventDefault();
  };
  const historyBack = history("navigation-back");
  const historyForward = history("navigation-forward");
  window.addEventListener("buzz:history-back", historyBack);
  window.addEventListener("buzz:history-forward", historyForward);
  return () => {
    window.removeEventListener("buzz:history-back", historyBack);
    window.removeEventListener("buzz:history-forward", historyForward);
    for (const dispose of remove) dispose();
  };
}
