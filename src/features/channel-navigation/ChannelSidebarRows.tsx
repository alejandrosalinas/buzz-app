import { useDndContext } from "@dnd-kit/core";
import { animate } from "motion/mini";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import styles from "./ChannelSidebarRows.module.css";

// Fast Refresh preserves refs; a replaced module must restart the prepared batch.
const animationGeneration = {};

type RowPositions = Map<HTMLElement, { index: number; top: number }>;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(change: () => void) {
  const media = window.matchMedia?.(reducedMotionQuery);
  media?.addEventListener("change", change);
  return () => media?.removeEventListener("change", change);
}
const prefersReducedMotion = () =>
  !!window.matchMedia?.(reducedMotionQuery).matches;

function clearSlide(node: HTMLElement) {
  if (node.style.transform && node.style.transform !== "none")
    node.style.transform = "none";
  if (node.hasAttribute("data-moving")) delete node.dataset.moving;
  if (node.style.zIndex) node.style.zIndex = "";
}

type Props = Record<string, unknown>;
const sameProps = (a: Props, b: Props) => {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
};

// The inventory builds fresh row elements on every render, so rows compare by
// type, key and props. Rows must render only from props, context and hooks.
const sameElement = (a: ReactElement, b: ReactElement | undefined) =>
  !!b &&
  a.type === b.type &&
  a.key === b.key &&
  sameProps(a.props as Props, b.props as Props);

type ChannelSidebarRowsProps = { children: ReactElement[]; open: boolean };

/** Keep local movement short; fade distant jumps between their endpoints. */
export const ChannelSidebarRows = memo(function ChannelSidebarRows({
  children,
  open,
}: ChannelSidebarRowsProps) {
  const { active } = useDndContext();
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
  );
  const animated = open && !active && !reducedMotion;
  const desired = JSON.stringify(children.map((child) => String(child.key)));
  const [order, setOrder] = useState(desired);
  const positions = useRef<RowPositions>(new Map()).current;
  const updateOrder = useCallback(
    (next: string) => {
      // Visibility and text scaling can change geometry without changing indices.
      // Read the live old slots together, immediately before React reorders them.
      for (const [node, position] of positions) position.top = node.offsetTop;
      setOrder(next);
    },
    [positions],
  );
  const [fading, setFading] = useState<ReadonlySet<string>>(() => new Set());
  const target = useRef(desired);
  const pending = useRef(new Set<string>());
  const batchStart = useRef<number | null>(null);
  const generation = useRef(animationGeneration);
  const ids: string[] = JSON.parse(order);
  const byId = new Map(children.map((child) => [String(child.key), child]));
  const sameMembers =
    ids.length === children.length && ids.every((id) => byId.has(id));
  useLayoutEffect(() => {
    if (
      !animated ||
      !sameMembers ||
      order === desired ||
      generation.current !== animationGeneration
    ) {
      generation.current = animationGeneration;
      target.current = desired;
      pending.current.clear();
      batchStart.current = null;
      if (order !== desired) updateOrder(desired);
      setFading((previous) => (previous.size ? new Set() : previous));
      return;
    }
    if (fading.size) return;
    const now = performance.now();
    batchStart.current ??= now;
    const timer = setTimeout(
      () => {
        batchStart.current = null;
        target.current = desired;
        const next: string[] = JSON.parse(desired);
        const positions = new Map(next.map((id, index) => [id, index]));
        const displayed: string[] = JSON.parse(order);
        const distant = new Set(
          displayed.filter(
            (id, index) => Math.abs((positions.get(id) ?? index) - index) > 2,
          ),
        );
        pending.current = new Set(distant);
        if (distant.size) setFading(distant);
        else updateOrder(desired);
      },
      Math.min(200, Math.max(0, 600 - (now - batchStart.current))),
    );
    return () => clearTimeout(timer);
  }, [animated, desired, fading.size, order, sameMembers, updateOrder]);
  // Finish the prepared batch; subsequent activity gets its own quiet period.
  const applyOrder = useCallback(
    (id: string) => {
      if (!pending.current.delete(id) || pending.current.size) return;
      updateOrder(target.current);
      setFading((previous) => (previous.size ? new Set() : previous));
    },
    [updateOrder],
  );
  // Membership changes render immediately, before their old slots can be read.
  // Preserve presence fades, but do not slide from an unverified baseline.
  const rows = sameMembers
    ? ids.flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
      })
    : children;
  return (
    <div className={styles.rows}>
      <AnimatePresence
        initial={false}
        mode="popLayout"
        presenceAffectsLayout={false}
      >
        {rows.map((child, index) => (
          <ChannelRow
            key={child.key}
            animated={animated}
            slide={animated && sameMembers}
            index={index}
            positions={positions}
            hiding={animated && sameMembers && fading.has(String(child.key))}
            onHidden={applyOrder}
          >
            {child}
          </ChannelRow>
        ))}
      </AnimatePresence>
    </div>
  );
}, sameRows);

function sameRows(
  previous: ChannelSidebarRowsProps,
  next: ChannelSidebarRowsProps,
) {
  return (
    previous.open === next.open &&
    previous.children.length === next.children.length &&
    previous.children.every((row, index) =>
      sameElement(row, next.children[index]),
    )
  );
}

type ChannelRowProps = {
  children: ReactElement;
  animated: boolean;
  slide: boolean;
  index: number;
  positions: RowPositions;
  hiding: boolean;
  onHidden: (id: string) => void;
};

function sameRow(
  { children: a, ...previous }: ChannelRowProps,
  { children: b, ...next }: ChannelRowProps,
) {
  return sameElement(a, b) && sameProps(previous, next);
}

const ChannelRow = memo(
  forwardRef<HTMLDivElement, ChannelRowProps>(function ChannelRow(
    { children, animated, slide, index, positions, hiding, onHidden },
    forwardedRef,
  ) {
    const ref = useRef<HTMLDivElement>(null);
    const playback = useRef<ReturnType<typeof animate> | null>(null);
    const present = useIsPresent();
    useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement);
    useEffect(() => {
      const node = ref.current;
      return () => {
        playback.current?.stop();
        if (node) positions.delete(node);
        if (node) clearSlide(node);
      };
    }, [positions]);
    useLayoutEffect(() => {
      const node = ref.current;
      if (!node) return;
      const previous = positions.get(node);
      const top = node.offsetTop;
      positions.set(node, { index, top });
      if (!present || !slide) {
        playback.current?.stop();
        clearSlide(node);
        return;
      }
      if (!previous || previous.index === index || previous.top === top) return;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      const delta = previous.top - top + matrix.m42;
      const rect = node.getBoundingClientRect();
      const visible =
        Math.max(rect.bottom - matrix.m42, rect.bottom + previous.top - top) >
          0 &&
        Math.min(rect.top - matrix.m42, rect.top + previous.top - top) <
          window.innerHeight;
      playback.current?.stop();
      if (!visible || Math.abs(previous.index - index) > 2 || delta === 0) {
        clearSlide(node);
        return;
      }
      // Nearby crossings retain an opaque backing. Distant rows never sweep
      // through their neighbors; their opacity transition owns the hidden swap.
      node.dataset.moving = "";
      node.style.zIndex = delta > 0 ? "2" : "1";
      node.style.transform = `translateY(${delta}px)`;
      const animation = animate(
        node,
        { transform: [`translateY(${delta}px)`, "translateY(0px)"] },
        { duration: 0.14, ease: "easeOut" },
      );
      playback.current = animation;
      void animation.then(() => {
        if (playback.current !== animation) return;
        delete node.dataset.moving;
        node.style.zIndex = "";
      });
    }, [slide, index, present, positions]);
    return (
      <motion.div
        ref={ref}
        className={styles.row}
        initial={{ opacity: animated ? 0 : 1 }}
        animate={{ opacity: hiding ? 0 : 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: animated ? 0.1 : 0 }}
        onAnimationComplete={() => {
          if (hiding && present) onHidden(String(children.key));
        }}
        inert={!present}
        aria-hidden={!present || undefined}
      >
        {children}
      </motion.div>
    );
  }),
  sameRow,
);
