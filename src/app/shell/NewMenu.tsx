import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import {
  resetNewChatProject,
  soloDraftInput,
} from "../../features/solo/SoloDraft";
import {
  soloDraftTarget,
  resumeSoloDraftTarget,
} from "../../features/channel-navigation/routes";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import {
  ChatCircleIcon,
  FolderSimpleIcon,
  HashIcon,
  PlusIcon,
  UserCircleIcon,
} from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const actions = {
  chat: { label: "New chat", icon: ChatCircleIcon },
  channel: { label: "New channel", icon: HashIcon },
  dm: { label: "New DM", icon: UserCircleIcon },
} as const;
type Action = keyof typeof actions;

export function NewMenu(props: Props) {
  const connection = useRelayConnection(props.relay);
  return (
    <ReadyNewMenu
      {...props}
      key={connection.scope ?? "disconnected"}
      session={connection.session}
      available={connection.status === "ready" || !!connection.cached}
    />
  );
}

function ReadyNewMenu({
  relay,
  navigator,
  agents,
  session,
  available,
  triggerContainer,
  open,
  onOpenChange,
}: Props & { session: RelaySession; available: boolean }) {
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const scope = splitPartition(session.scope);
  const [channelGroup, setChannelGroup] = useState<string>();
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const finalFocus = useRef<HTMLElement>(null);
  const [draftFocus, setDraftFocus] = useState<HTMLElement | null>(null);
  const current = () => relay.snapshot().session === session;
  const disabled = (kind: Action) =>
    !available ||
    (kind === "channel" && !session.channelCreation.available) ||
    (kind === "dm" && !scope);
  const run = (kind: Action) => {
    if (!current() || disabled(kind)) return;
    finalFocus.current = caret.current;
    if (kind === "channel") {
      setChannelGroup("");
      return;
    }
    if (kind === "dm") {
      if (scope)
        void navigator.open({
          version: 1,
          kind: "page",
          pluginId: "buzz.channels",
          pageId: "channels",
          scope,
          route: { version: 1, params: "new-message" },
        });
      return;
    }
    const target = navigator.snapshot().entry?.target;
    const destination = resumeSoloDraftTarget(session.scope, target);
    const input = destination === target ? soloDraftInput() : null;
    if (input) {
      setDraftFocus(input);
      return;
    }
    void navigator.open(destination);
  };
  const controls = (
    <MenuTrigger
      render={
        <IconButton
          ref={caret}
          disabled={!available}
          aria-label="New options"
          title="New options"
          shape="round"
          size="md"
          icon={<PlusIcon strokeWidth={2.5} size={18} />}
        />
      }
    />
  );
  return (
    <>
      <MenuRoot
        open={open}
        onOpenChange={(next) => {
          if (next) setDraftFocus(null);
          onOpenChange?.(next);
        }}
      >
        {triggerContainer === undefined
          ? controls
          : triggerContainer && createPortal(controls, triggerContainer)}
        <MenuPopup
          finalFocus={
            draftFocus
              ? () => (draftFocus.isConnected ? draftFocus : false)
              : channelGroup !== undefined || creatingWorkspace
                ? false
                : undefined
          }
        >
          {(["chat", "channel", "dm"] as const).map((kind) => {
            const { label, icon: Icon } = actions[kind];
            return (
              <MenuItem
                key={kind}
                disabled={disabled(kind)}
                onClick={() => run(kind)}
              >
                <MenuIcon>
                  <Icon size={16} />
                </MenuIcon>
                {label}
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem
            disabled={!preferences.sectionCreationWritable}
            onClick={() => {
              if (!current()) return;
              finalFocus.current = caret.current;
              setCreatingWorkspace(true);
            }}
          >
            <MenuIcon>
              <FolderSimpleIcon size={16} />
            </MenuIcon>
            New workspace
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      <CreateChannelDialog
        open={channelGroup !== undefined}
        onOpenChange={(next) => {
          if (!next) setChannelGroup(undefined);
        }}
        session={session}
        agents={agents}
        finalFocus={finalFocus}
        destinations={preferences.data?.sections ?? []}
        initialGroup={channelGroup ?? ""}
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingWorkspace && (
        <NewWorkspace
          session={session}
          create={(section) =>
            session.sidebarPreferences.createSection(section)
          }
          close={() => setCreatingWorkspace(false)}
          finalFocus={finalFocus}
          onCreated={async (id) => {
            if (!current()) return;
            if (await soloNavigationFor(session)?.openCreatedWorkspace(id))
              return;
            if (!current()) return;
            resetNewChatProject(session.scope, id);
            void navigator.open(
              soloDraftTarget(session.scope, { project: id }),
            );
          }}
        />
      )}
    </>
  );
}
