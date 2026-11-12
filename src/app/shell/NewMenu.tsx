import { createPortal } from "react-dom";
import { useRef, useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import { CreateChannelDialog } from "../../bundled/channels/CreateChannelDialog";
import { revealCreatedChannel } from "../../features/channel-navigation/created-channel";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import type { Navigation } from "../../features/navigation/controller";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { splitPartition } from "../../features/relay/partition";
import { NewWorkspace } from "../../features/solo/NewWorkspace";
import { resetNewChatProject } from "../../features/solo/SoloDraft";
import { soloDraftTarget } from "../../features/channel-navigation/routes";
import { useSoloNavigation } from "../../features/channel-navigation/solo-navigation-react";
import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import styles from "./NewMenu.module.css";
import { PlusIcon } from "../../shared/design-system/icons";

type Props = {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  triggerContainer?: HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

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
  useSyncExternalStore(
    session.soloPreferences.subscribe,
    session.soloPreferences.snapshot,
  );
  const preferences = useSidebarPreferences(session.sidebarPreferences);
  const regions = useSoloNavigation(session);
  const composing = !!regions.regions.find((region) => region.source)?.source
    ?.composeWorkspaces;
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const scope = splitPartition(session.scope);
  const current = () => relay.snapshot().session === session;
  const menuTrigger = (
    <MenuTrigger
      render={
        <IconButton
          hint="familiar"
          ref={trigger}
          disabled={!available}
          aria-label="New"
          title="New"
          variant="inset"
          shape="round"
          size="sm"
          icon={<PlusIcon className={styles.createIcon} size={16} />}
        />
      }
    />
  );
  return (
    <>
      <MenuRoot open={open} onOpenChange={onOpenChange}>
        {triggerContainer === undefined
          ? menuTrigger
          : triggerContainer && createPortal(menuTrigger, triggerContainer)}
        <MenuPopup>
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Solo</MenuGroupLabel>
            {!composing && (
              <MenuItem
                onClick={() => {
                  if (current())
                    void navigator.open(soloDraftTarget(session.scope));
                }}
              >
                New chat
              </MenuItem>
            )}
            <MenuItem
              disabled={!session.soloPreferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingProject(true);
              }}
            >
              New workspace
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel emphasis="quiet">Team</MenuGroupLabel>
            <MenuItem
              disabled={!scope}
              onClick={() => {
                if (scope && current())
                  void navigator.open({
                    version: 1,
                    kind: "page",
                    pluginId: "buzz.channels",
                    pageId: "channels",
                    scope,
                    route: { version: 1, params: "new-message" },
                  });
              }}
            >
              New DM
            </MenuItem>
            <MenuItem
              disabled={!session.channelCreation.available}
              onClick={() => {
                if (current()) setCreatingChannel(true);
              }}
            >
              New channel
            </MenuItem>
            <MenuItem
              disabled={!preferences.sectionCreationWritable}
              onClick={() => {
                if (current()) setCreatingSection(true);
              }}
            >
              New section
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </MenuRoot>
      <CreateChannelDialog
        open={creatingChannel}
        onOpenChange={setCreatingChannel}
        session={session}
        agents={agents}
        finalFocus={trigger}
        destinations={preferences.data?.sections ?? []}
        initialGroup=""
        groupsReady={preferences.writable}
        onCreate={async (input) => {
          const channelId = await session.channelCreation.create(input);
          revealCreatedChannel(relay, session, navigator, input, channelId);
        }}
      />
      {creatingSection && (
        <CreateSidebarSection
          writable={preferences.sectionCreationWritable}
          refreshing={preferences.status === "loading"}
          retry={preferences.reload}
          finalFocus={trigger}
          close={() => setCreatingSection(false)}
          create={async (section) => {
            if (
              !current() ||
              !session.sidebarPreferences.sectionCreationWritable
            )
              return false;
            await preferences.createSection(section);
            if (current()) setCreatingSection(false);
            return true;
          }}
        />
      )}
      {creatingProject && (
        <NewWorkspace
          session={session}
          create={(section) => session.soloPreferences.createSection(section)}
          close={() => setCreatingProject(false)}
          finalFocus={trigger}
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
