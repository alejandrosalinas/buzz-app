// FOUNDATION: Public Solo region contract. Ownership stays label-based and host-enforced.
import type { ComponentType, ReactElement, ReactNode } from "react";
import type { JsonValue } from "../navigation/targets";

export type SoloRegionBinding = Readonly<{
  scope: string;
  viewer: string;
  incarnation: string;
}>;
export type SoloRegionSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable";
  binding: SoloRegionBinding;
  revision: number;
  model?: unknown;
  notice?: string;
}>;
export type SoloRegionAction = Readonly<{
  id: string;
  label: string;
  icon: ReactElement | "plus" | "view";
  onSelect: () => void | Promise<void>;
  menu?: () => readonly Readonly<{
    id: string;
    label: string;
    checked?: boolean;
    group?: string;
    onSelect: () => void | Promise<void>;
  }>[];
}>;
export type SoloRegionSource = Readonly<{
  id: string;
  title: string;
  icon: ReactNode;
  order?: number;
  bind(binding: SoloRegionBinding, signal: AbortSignal): void;
  subscribe(listener: () => void): () => void;
  read(binding: SoloRegionBinding): SoloRegionSnapshot;
  component: ComponentType<SoloRegionProps>;
  /** Compose tasks with ordinary chats in the host's existing workspace inventory. */
  composeWorkspaces?: true;
  /** Select a newly created host workspace using this source’s own selection policy. */
  openWorkspace?(
    binding: SoloRegionBinding,
    workspaceId: string,
  ): Promise<void>;
  actions?: (binding: SoloRegionBinding) => readonly SoloRegionAction[];
  /** Agents a draft from `openDraft` may address. Without it, any available agent. */
  draftAgent?(binding: SoloRegionBinding, pubkey: string): boolean;
  /** Show and change this chat's workspace in its composer. Read from local
   * state; a change shows through `read`'s next revision. */
  workspace?(
    binding: SoloRegionBinding,
    channelId: string,
  ): SoloChatWorkspace | undefined;
}>;
/** A region chat's personal Solo workspace. */
export type SoloChatWorkspace = Readonly<{
  id?: string;
  /** Files the chat, or with no ID removes it; rejects with the reason to show. */
  file(workspaceId: string | undefined): Promise<void>;
}>;
/** How a chat this device sent from `openDraft` was started. */
export type SoloDraftStart = Readonly<{ workspace?: string; lead?: true }>;
export type SoloChatInput = Readonly<{
  channelId: string;
  title: string;
  members: readonly string[];
  named?: boolean;
  ttlSeconds?: number;
}>;
export type SoloRegionHandle = Readonly<{
  label: string;
  /** The same device state as component props, available before mount. */
  state(binding: SoloRegionBinding): SoloRegionProps["state"];
  /** Open New chat for this region. Its first send creates the chat with this
   * region's label; until then it is only a draft. With `lead`, the chat starts
   * as the workspace's lead while the draft still targets that workspace. */
  openDraft(
    binding: SoloRegionBinding,
    input?: Readonly<{ workspace?: string; lead?: true }>,
  ): void;
  /** This device's record of a chat started from `openDraft`, kept until `forget`. */
  started(
    binding: SoloRegionBinding,
    channelId: string,
  ): SoloDraftStart | undefined;
  forget(binding: SoloRegionBinding, channelId: string): void;
  createChat(binding: SoloRegionBinding, input: SoloChatInput): Promise<void>;
  classify(binding: SoloRegionBinding, channelId: string): Promise<void>;
}>;
export type SoloRegionProps = Readonly<{
  binding: SoloRegionBinding;
  snapshot: SoloRegionSnapshot & Readonly<{ status: "ready" }>;
  live: ReadonlySet<string>;
  current?: string;
  revealRequests: Readonly<{
    subscribe(listener: (channelId: string) => void): () => void;
  }>;
  state: Readonly<{
    get(): JsonValue | undefined;
    set(value: JsonValue): boolean;
    subscribe(listener: () => void): () => void;
  }>;
  ui: Readonly<{
    Conversation: ComponentType<SoloConversationProps>;
    Card: ComponentType<SoloCardProps>;
    Disclosure: ComponentType<SoloDisclosureProps>;
    Workspace?: ComponentType<SoloWorkspaceProps>;
    Chats?: ComponentType<Readonly<{ all?: boolean }>>;
  }>;
}>;
export type SoloWorkspaceProps = Readonly<{
  id: string;
  /** The workspace whose lead draft, from `openDraft` with `lead`, selects this row. */
  leadWorkspaceId?: string;
  selected?: boolean;
  onSelect?(): void;
  onNewTask?(): void;
  /** Reveal a moved or externally opened child; selecting the lead does not expand. */
  reveal?: string;
  dropTarget?: boolean;
  children?: ReactNode;
}>;
/** Host conversation behavior. The source composes the presentation from its parts. */
export type SoloConversationProps = Readonly<{
  channelId: string;
  menuActions?: readonly SoloRegionAction[];
  /** Not called for a conversation outside this region. Renaming replaces it with the host editor. */
  children(conversation: SoloConversation): ReactNode;
}>;
export type SoloConversation = Readonly<{
  name: string;
  preview?: string;
  selected: boolean;
  /** Bound to this conversation. Put one primary Link and Actions inside Menu. */
  Link: ComponentType<SoloConversationLinkProps>;
  /** Context menu region with the standard chat actions and menuActions. */
  Menu: ComponentType<Readonly<{ children: ReactNode }>>;
  /** The overflow menu button. Pointer devices show it only while the Menu is active. */
  Actions: ComponentType;
  /** Shows content only at rest, or only while the Menu is hovered, focused, or open. Hidden content keeps its space. */
  Reveal: ComponentType<
    Readonly<{ on: "rest" | "active"; children: ReactNode }>
  >;
  Unread: ComponentType;
}>;
export type SoloConversationLinkProps = Readonly<{
  label: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  multiline?: boolean;
  /** Navigates without focus identity, current state or rename. */
  secondary?: boolean;
  /** Double-click renames the primary link unless false. */
  rename?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}>;
/** The shared navigation card; it owns hover, selection and drag-target paint. */
export type SoloCardProps = Readonly<{
  tone?: "default" | "tonal" | "inset";
  dropTarget?: boolean;
  footer?: ReactNode;
  body?: ReactNode;
  children: ReactNode;
}>;
export type SoloDisclosureProps = Readonly<{
  label: string;
  summary: string;
  expanded: boolean;
  controls: string;
  onToggle(): void;
}>;
export type SoloNavigation = Readonly<{
  version: 2;
  workspaces: SoloWorkspaces;
  registerSource(source: SoloRegionSource): SoloRegionHandle;
}>;

export type SoloWorkspaceSnapshot = Readonly<{
  status: "loading" | "ready" | "unavailable";
  workspaces: readonly Readonly<{ id: string; name: string }>[];
  canCreate: boolean;
  error?: string;
}>;
/** Personal Solo workspaces. Region task filing stays with the region owner. */
export type SoloWorkspaces = Readonly<{
  snapshot(binding: SoloRegionBinding): SoloWorkspaceSnapshot;
  subscribe(binding: SoloRegionBinding, listener: () => void): () => void;
  refresh(binding: SoloRegionBinding): Promise<void>;
  /** Retain the same id/name after an uncertain outcome; refresh before retrying. */
  create(
    binding: SoloRegionBinding,
    input: Readonly<{ id: string; name: string }>,
  ): Promise<void>;
}>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    soloNavigation?: SoloNavigation;
  }
}
