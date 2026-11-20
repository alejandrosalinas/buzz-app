import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SpringLoadedNavigationItem } from "./SpringLoadedNavigationItem";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import styles from "../../bundled/channels/Channels.module.css";
import type { Navigation } from "../navigation/controller";
import { targetKey, type OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSections,
} from "./sidebar-sections-service";
import { DroppableSidebarSection } from "./ChannelSidebarDnd";
import { sidebarTarget } from "./routes";

function isSelectedDestination(destination: OpenTarget, target: OpenTarget) {
  const selectedKey = targetKey(target);
  if (targetKey(destination) === selectedKey) return true;
  if (
    destination.kind === "conversation" &&
    target.kind === "conversation" &&
    destination.messageId === undefined &&
    destination.panel === undefined
  ) {
    const conversationKey = (conversation: typeof destination) =>
      targetKey({
        version: 1,
        kind: "conversation",
        scope: conversation.scope,
        channelId: conversation.channelId,
      });
    return conversationKey(destination) === conversationKey(target);
  }
  if (
    destination.kind !== "page" ||
    target.kind !== "page" ||
    destination.scope !== undefined ||
    target.scope === undefined ||
    target.scope === null
  )
    return false;

  // An omitted page scope retains the current community.
  return targetKey({ ...destination, scope: target.scope }) === selectedKey;
}

export function SidebarContributionSection({
  entry,
  registry,
  navigator,
  target,
  open,
  onToggle,
  groupIndex,
  reorderable,
  move,
  onRowsCommitted,
}: {
  entry: RegisteredSidebarSection;
  registry: SidebarSections;
  navigator: Navigation;
  target: OpenTarget;
  open: boolean;
  onToggle: (open: boolean) => void;
  groupIndex: number;
  reorderable: boolean;
  move: { up?: () => void; down?: () => void } | undefined;
  onRowsCommitted?: () => void;
}) {
  // A failed section stops observing its rows; Retry renders it again.
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<HTMLButtonElement>(null);
  const sectionKey = `plugin:${entry.key}`;
  useLayoutEffect(() => {
    // Retry remounts the section: focus the new Retry, or the recovered header.
    if (!attempt || document.activeElement !== document.body) return;
    (
      retry.current ??
      document.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(sectionKey)}"] details > summary`,
      )
    )?.focus({ preventScroll: true });
  }, [attempt, sectionKey]);
  return (
    <OwnedContribution
      entry={entry}
      registry={registry}
      resetIdentity={attempt}
      fallback={
        <DroppableSidebarSection
          disabled={false}
          reorderable={reorderable}
          groupIndex={groupIndex}
          groupDomain="contributions"
          sectionKey={sectionKey}
          title={entry.title}
          open={open}
          onToggle={onToggle}
          move={move}
          hideMoreActions={!reorderable}
        >
          <p role="alert">
            {entry.title} is unavailable. Other sidebar sections remain
            available.
          </p>
          <Button
            ref={retry}
            size="sm"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </Button>
        </DroppableSidebarSection>
      }
    >
      {(section, active) => (
        <SectionContents
          entry={section}
          active={active}
          navigator={navigator}
          target={target}
          open={open}
          onToggle={onToggle}
          groupIndex={groupIndex}
          reorderable={reorderable}
          move={move}
          onRowsCommitted={onRowsCommitted}
        />
      )}
    </OwnedContribution>
  );
}

function SectionContents({
  entry,
  active,
  navigator,
  target,
  open,
  onToggle,
  groupIndex,
  reorderable,
  move,
  onRowsCommitted,
}: {
  entry: RegisteredSidebarSection;
  active: () => boolean;
  navigator: Navigation;
  target: OpenTarget;
  open: boolean;
  onToggle: (open: boolean) => void;
  groupIndex: number;
  reorderable: boolean;
  move: { up?: () => void; down?: () => void } | undefined;
  onRowsCommitted: (() => void) | undefined;
}) {
  const subscribe = useCallback(
    (listener: () => void) => entry.rows.subscribe(listener),
    [entry.rows],
  );
  const snapshot = useCallback(() => entry.rows.snapshot(), [entry.rows]);
  const rows = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The sidebar's target names only the open conversation; a row may name a
  // message or thread in it. Elsewhere, as under Settings, keep the target:
  // there a conversation's rows stay current, but a message's do not.
  const current = useSyncExternalStore(navigator.subscribe, () => {
    const open = navigator.snapshot().entry.target;
    return targetKey(sidebarTarget(open)) === targetKey(target) ? open : target;
  });
  // The external-store update rerenders this child, not the reveal owner.
  useLayoutEffect(() => {
    onRowsCommitted?.();
  });
  const [actionError, setActionError] = useState(false);
  if (!Array.isArray(rows)) throw new Error("Sidebar rows must be an array");
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.label !== "string" ||
      !row.label.trim()
    )
      throw new Error("Sidebar rows need unique ids and non-empty labels");
    ids.add(row.id);
  }
  const select = (destination: OpenTarget) => {
    if (!active()) return;
    setActionError(false);
    try {
      void navigator.open(destination).catch(() => setActionError(true));
    } catch {
      setActionError(true);
    }
  };
  const actions = (entry.actions ?? []).map((action) => (
    <IconButton
      key={action.id}
      size="compact"
      aria-label={action.label}
      title={action.label}
      icon={action.icon}
      onClick={() => {
        if (!active()) return;
        setActionError(false);
        try {
          void Promise.resolve(action.onSelect()).catch(() =>
            setActionError(true),
          );
        } catch {
          setActionError(true);
        }
      }}
    />
  ));
  return (
    <DroppableSidebarSection
      groupDomain="contributions"
      disabled={false}
      reorderable={reorderable}
      groupIndex={groupIndex}
      sectionKey={`plugin:${entry.key}`}
      title={entry.title}
      icon={entry.icon}
      open={open}
      onToggle={onToggle}
      move={move}
      hideMoreActions={!reorderable}
      headerActions={actions}
      headerNotice={
        actionError && (
          <p className={styles.contributionFeedback} role="alert">
            This sidebar action couldn’t finish.
          </p>
        )
      }
    >
      {rows.map((row) => {
        const trailing = [
          row.badge,
          typeof row.count === "number" && Number.isFinite(row.count)
            ? new Intl.NumberFormat().format(row.count)
            : undefined,
          row.status,
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" · ");
        const destination = entry.select(row);
        return (
          <div key={row.id} className={styles.contributionNavigationItem}>
            <SpringLoadedNavigationItem
              label={row.label}
              icon={row.icon}
              trailing={
                trailing ? (
                  <span className={styles.contributionMetadata}>
                    {trailing}
                  </span>
                ) : undefined
              }
              selected={isSelectedDestination(destination, current)}
              onClick={() => select(destination)}
              // Only a conversation has a composer for the dragged files.
              onSpring={
                destination.kind === "conversation"
                  ? () => select(destination)
                  : undefined
              }
            />
          </div>
        );
      })}
    </DroppableSidebarSection>
  );
}
