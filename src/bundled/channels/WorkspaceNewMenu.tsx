import { useRef, useState } from "react";
import {
  ChatCircleIcon,
  ChatsCircleIcon,
  HashIcon,
} from "../../shared/design-system/icons";
import type { ButtonProps } from "../../shared/design-system/ui/Button";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { SplitButton } from "../../shared/design-system/ui/SplitButton";
import { readView, writeView } from "../../shared/view-state";

const labels = {
  chat: "New chat",
  channel: "New channel",
  dm: "New DM",
} as const;

export type WorkspaceNewAction = keyof typeof labels;
const actions = ["chat", "channel", "dm"] as const;
const icons = { chat: ChatCircleIcon, channel: HashIcon, dm: ChatsCircleIcon };

export function WorkspaceNewMenu({
  scope,
  workspace,
  name,
  channelAvailable,
  dmAvailable,
  choose,
}: {
  scope: string;
  workspace: string;
  name: string;
  channelAvailable: boolean;
  dmAvailable: boolean;
  choose: (action: WorkspaceNewAction, trigger: HTMLButtonElement) => void;
}) {
  const key = `workspace-new-action:${workspace}`;
  const [action, setAction] = useState<WorkspaceNewAction>(() => {
    const saved = readView<unknown>(scope, key, "chat");
    return saved === "channel" || saved === "dm" ? saved : "chat";
  });
  const primary = useRef<HTMLButtonElement>(null);
  const enabled = (choice: WorkspaceNewAction) =>
    choice === "chat" ||
    (choice === "channel" ? channelAvailable : dmAvailable);
  // An unavailable remembered action falls back to New chat, always enabled.
  const shown = enabled(action) ? action : "chat";
  const Icon = icons[shown];
  const label = `${labels[shown]} in ${name}`;
  const primaryProps = {
    ref: primary,
    "aria-label": label,
    title: label,
    onClick: (event) => choose(shown, event.currentTarget),
    children: <Icon aria-hidden="true" />,
  } satisfies ButtonProps;
  return (
    <SplitButton
      {...primaryProps}
      variant="ghost"
      size="sm"
      icon
      menuLabel={`New options in ${name}`}
      menu={actions.map((choice) => (
        <MenuItem
          key={choice}
          disabled={!enabled(choice)}
          onClick={() => {
            const trigger = primary.current;
            if (!trigger) return;
            setAction(choice);
            writeView(scope, key, choice);
            choose(choice, trigger);
          }}
        >
          {labels[choice]}
        </MenuItem>
      ))}
    />
  );
}
