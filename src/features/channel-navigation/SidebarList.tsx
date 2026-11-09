import { useCallback, type ReactNode, type RefObject } from "react";
import styles from "../../bundled/channels/Channels.module.css";
import { useScrollEdges } from "../../shared/design-system/ui/useScrollEdges";

type Props = {
  children: ReactNode;
  navigation?: {
    label: string;
    ref?: RefObject<HTMLElement | null>;
  };
  contentRef?: RefObject<HTMLDivElement | null>;
  overlay?: ReactNode;
};

export function SidebarList({
  children,
  navigation,
  contentRef,
  overlay,
}: Props) {
  const edges = useScrollEdges("block");
  const navigationRef = navigation?.ref;
  // Stable, so React does not detach and reattach the list on every render.
  const listRef = useCallback(
    (node: HTMLElement | null) => {
      edges(node);
      if (navigationRef) navigationRef.current = node;
    },
    [edges, navigationRef],
  );
  const content = (
    <div ref={contentRef} className={styles.channelListContent}>
      {children}
    </div>
  );
  return (
    <div className={styles.channelListFrame}>
      {navigation ? (
        <nav
          ref={listRef}
          className={styles.channelList}
          data-scroll-fade="scrolled"
          aria-label={navigation.label}
        >
          {content}
        </nav>
      ) : (
        <div
          ref={edges}
          className={styles.channelList}
          data-scroll-fade="scrolled"
        >
          {content}
        </div>
      )}
      {overlay}
    </div>
  );
}
