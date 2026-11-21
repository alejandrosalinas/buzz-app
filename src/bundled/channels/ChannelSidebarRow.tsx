import { FadingLabel } from "./FadingLabel";
import { activeChannelRows } from "../../features/channel-navigation/active-channel-rows";
import {
  captureSidebarDeparture,
  recoverSidebarFocus,
} from "../../features/channel-navigation/sidebar-focus-recovery";
import { useSoloRowActivation } from "../../features/channel-navigation/useSoloRowActivation";
import { useSpringLoaded } from "../../features/messages/spring-loaded-drag";
import type { Navigation } from "../../features/navigation/controller";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { BellSlashIcon, XIcon } from "../../shared/design-system/icons/index";
import { useIsPresent } from "motion/react";
import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  icon,
  nameAccessory,
  title,
  badge,
  working = false,
  ordinary = false,
  muted = false,
  dmVisualSpacing = false,
  wrapSelect,
  selected,
  presenceDescription,
  sharedDescription,
  sharedAction,
  menuAction,
  onSelect,
  navigation,
  onRename,
  pendingClick,
  onPrepare,
  onHideDm,
}: {
  channel: ChannelSummary;
  icon: ReactNode;
  nameAccessory?: ReactNode;
  /** Rendered in place of the channel name, which stays its text. */
  title?: ReactNode;
  badge?: ReactNode;
  /** Agents are working here; the badge reserves its own trailing space. */
  working?: boolean;
  /** Ordinary unread backlog emphasises the label. */
  ordinary?: boolean;
  muted?: boolean;
  dmVisualSpacing?: boolean;
  wrapSelect?: ((trigger: ReactElement) => ReactNode) | undefined;
  selected?: string | undefined;
  presenceDescription?: string | undefined;
  sharedDescription?: string | undefined;
  sharedAction?: ReactNode;
  menuAction?: ReactNode;
  onSelect: (id: string) => void;
  navigation?: Navigation | undefined;
  onRename?: ((id: string) => boolean) | undefined;
  pendingClick?: RefObject<ReturnType<typeof setTimeout> | undefined>;
  onPrepare: (id: string) => void;
  onHideDm?: (id: string) => void;
}) {
  const selectRef = useRef<HTMLButtonElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const button = selectRef.current;
    if (!button || !present) return;
    const document = button.ownerDocument;
    const section = button.closest("[data-sidebar-section]");
    return () => {
      if (document.activeElement !== button) return;
      const rows = [
        ...(section?.querySelectorAll<HTMLElement>("button[data-channel-id]") ??
          []),
      ];
      const index = rows.indexOf(button);
      const neighborIds = [
        ...rows.slice(index + 1),
        ...rows.slice(0, index).reverse(),
      ].map((row) => row.dataset.channelId ?? "");
      // A plugin wrapper can remount this row and its neighbors. Resolve them
      // after the commit, excluding retained exits and focus moved elsewhere.
      recoverSidebarFocus(captureSidebarDeparture(button), (sidebar) => {
        if (
          (document.activeElement !== document.body &&
            document.activeElement !== button) ||
          (button.isConnected && !button.closest("[inert]")) ||
          !sidebar?.isConnected
        )
          return;
        const liveRows = activeChannelRows(sidebar);
        const sectionRows = activeChannelRows(section);
        return [
          liveRows.find(
            (row) =>
              row.dataset.channelId === channel.id &&
              (channel.channelType !== "solo" ||
                row.dataset.soloDestinationId === channel.id),
          ),
          ...neighborIds.map((id) =>
            sectionRows.find((row) => row.dataset.channelId === id),
          ),
          section?.querySelector<HTMLElement>("details > summary"),
        ];
      });
    };
  }, [channel.id, channel.channelType, present]);
  const presenceId = useId();
  const activate = () => onSelect(channel.id);
  const soloActivation = useSoloRowActivation(
    navigation,
    pendingClick,
    activate,
    onRename ? () => onRename(channel.id) : undefined,
  );
  const springLoaded = useSpringLoaded(activate, selected === channel.id);
  const selectButton = (
    <NavigationItem
      ref={selectRef}
      type="button"
      data-channel-id={channel.id}
      data-solo-destination-id={
        channel.channelType === "solo" ? channel.id : undefined
      }
      data-working={working || undefined}
      aria-current={selected === channel.id ? "page" : undefined}
      aria-describedby={presenceDescription ? presenceId : sharedDescription}
      onPointerEnter={() => onPrepare(channel.id)}
      onFocus={() => onPrepare(channel.id)}
      {...(onRename ? soloActivation : { onClick: activate })}
      {...springLoaded}
      selected={selected === channel.id}
      label={
        <span
          className={styles.nameContent}
          data-name-accessory={muted || nameAccessory ? "" : undefined}
        >
          <FadingLabel className={styles.label}>
            {title ?? channel.name}
          </FadingLabel>
          {muted && (
            <span className={styles.muted} role="img" aria-label="Muted">
              <BellSlashIcon size={14} />
            </span>
          )}
          {nameAccessory}
        </span>
      }
      icon={
        <span
          className={styles.iconSpace}
          data-channel-row-icon=""
          data-dm-visual={dmVisualSpacing || undefined}
        >
          {icon}
        </span>
      }
      trailing={
        badge && (
          <span className={styles.badges} data-working={working || undefined}>
            {badge}
          </span>
        )
      }
    />
  );
  return (
    <div
      className={styles.row}
      data-channel-sidebar-row=""
      data-ordinary={ordinary || undefined}
      data-selected={selected === channel.id || undefined}
    >
      <div className={styles.select}>
        {wrapSelect ? wrapSelect(selectButton) : selectButton}
        {presenceDescription && (
          <span className="sr-only" id={presenceId}>
            {presenceDescription}
          </span>
        )}
      </div>

      {sharedAction}

      {menuAction}
      {channel.channelType === "dm" && onHideDm && (
        <span className={`${styles.more} ${styles.remove}`}>
          <IconButton
            type="button"
            size="compact"
            aria-label={`Remove ${channel.name} from DMs`}
            onClick={(event) => {
              const section = event.currentTarget.closest(
                "[data-sidebar-section]",
              );
              const rows = activeChannelRows(section);
              const index = rows.findIndex(
                (row) => row.dataset.channelId === channel.id,
              );
              const otherSection = [
                ...(section?.parentElement?.querySelectorAll<HTMLElement>(
                  "details > summary",
                ) ?? []),
              ].find((summary) => summary.parentElement !== section);
              (rows[index + 1] ?? rows[index - 1] ?? otherSection)?.focus();
              onHideDm(channel.id);
            }}
            icon={<XIcon size={15} aria-hidden="true" />}
          />
        </span>
      )}
    </div>
  );
}
