import { createContext, useContext, type ReactNode } from "react";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import type { NavigationSectionTrailing } from "../../shared/design-system/ui/NavigationSection";
import {
  Cube3dSphereIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons";
import { SoloDisclosure } from "./SoloDisclosure";
import type { SoloWorkspaceProps } from "./solo-navigation-contract";
import styles from "./WorkspaceComposition.module.css";

export type WorkspaceHeaderTrailing = NavigationSectionTrailing & {
  hasInteractiveDecoration: boolean;
};

/** The existing Solo inventory retains every row, menu, mutation and disclosure. */
export type WorkspaceComposition = Readonly<{
  ordinary: ReactNode;
  chats: ReactNode;
  chatList: ReactNode;
  workspaces: readonly Readonly<{
    id: string;
    name: string;
    open: boolean;
    toggle(open: boolean): void;
    frame(children: ReactNode): ReactNode;
    header(
      primary: ReactNode,
      newTask?: ReactNode,
      actions?: ReactNode,
      trailing?: WorkspaceHeaderTrailing,
    ): ReactNode;
    panel(before?: ReactNode): ReactNode;
  }>[];
}>;
export type ComposeWorkspaces = (parts: WorkspaceComposition) => ReactNode;
export const WorkspaceCompositionContext = createContext<
  WorkspaceComposition | undefined
>(undefined);

/** Ordinary chats remain available in task views that group by status or time. */
export function RegionChats({ all = false }: { all?: boolean }) {
  const parts = useContext(WorkspaceCompositionContext);
  return (all ? parts?.ordinary : parts?.chats) ?? null;
}

/** All ordinary chats without workspace headings or collapse controls. */
export function RegionChatList() {
  const list = useContext(WorkspaceCompositionContext)?.chatList;
  return list ? <div data-solo-chat-list="">{list}</div> : null;
}

/** One shared workspace surface. A source supplies its tasks and selection. */
export function RegionWorkspace(props: SoloWorkspaceProps) {
  const parts = useContext(WorkspaceCompositionContext);
  const workspace = parts?.workspaces.find(
    (item) => item.id === (props.id ?? ""),
  );
  if (!workspace || !props.id) return null;
  const title = props.id ? workspace.name : "Unfiled";
  const leading = props.headerLeading;
  const accessory =
    props.headerAccessory != null && typeof props.headerAccessory !== "boolean"
      ? props.headerAccessory
      : undefined;
  const disclosure = (
    <SoloDisclosure
      leading={leading}
      label={`${workspace.open ? "Hide" : "Show"} tasks and chats in ${title}`}
      summary={props.id ? "" : title}
      expanded={workspace.open}
      controls={`workspace-${workspace.id || "unfiled"}`}
      onToggle={() => workspace.toggle(!workspace.open)}
    />
  );
  const primary = props.id ? (
    <div className={styles.heading}>
      {leading && disclosure}
      <NavigationItem
        label={title}
        icon={leading && <Cube3dSphereIcon size={14} aria-hidden="true" />}
        selected={!!props.selected}
        data-solo-workspace-id={workspace.id}
        onClick={() => props.onSelect?.()}
      />
      {!leading && disclosure}
    </div>
  ) : (
    disclosure
  );
  return workspace.frame(
    <div data-solo-workspace={workspace.id}>
      <NavigationCard
        tone="tonal"
        data-drop-target={props.dropTarget || undefined}
        body={workspace.panel(props.children)}
      >
        {workspace.header(
          primary,
          props.onNewTask && (
            <IconButton
              size="compact"
              data-solo-workspace-new-task=""
              aria-label={`New task in ${title}`}
              title="New task"
              icon={<PencilSimpleIcon size={15} />}
              onClick={props.onNewTask}
            />
          ),
          <>
            {leading && (
              <MenuItem onClick={leading.onActivate}>{leading.label}</MenuItem>
            )}
            {props.onNewTask && (
              <MenuItem onClick={props.onNewTask}>New task</MenuItem>
            )}
          </>,
          {
            accessory,
            metadata: props.headerMetadata,
            hasInteractiveDecoration: !!leading || accessory != null,
          },
        )}
      </NavigationCard>
    </div>,
  );
}
