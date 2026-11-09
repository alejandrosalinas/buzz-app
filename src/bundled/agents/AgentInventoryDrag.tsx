import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDndMonitor,
  useSensor,
  useSensors,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { motion, useReducedMotion } from "motion/react";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "../../features/agents/service";
import { moveAgent } from "./agent-order";
import styles from "./AgentCard.module.css";

/** Owns only the temporary display preview; the inventory commits a completed move. */
export function AgentInventoryDrag({
  agents,
  enabled,
  onMove,
  overlay,
  children,
}: {
  agents: readonly Agent[];
  enabled: boolean;
  onMove(agents: readonly Agent[]): void;
  overlay(agent: Agent): ReactNode;
  children(agents: readonly Agent[], dragging: boolean): ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [activeKey, setActiveKey] = useState<string>();
  const [preview, setPreview] = useState<readonly string[]>();
  const byKey = new Map(agents.map((agent) => [agent.pubkey, agent]));
  const activeAgent = activeKey ? byKey.get(activeKey) : undefined;
  // Inventory changes discard only the transient preview, never mounted cards.
  const validPreview =
    preview?.length === agents.length && preview.every((key) => byKey.has(key));
  const shown = validPreview
    ? preview.flatMap((key) => byKey.get(key) ?? [])
    : agents;
  const current = useRef(shown);
  current.current = shown;
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
  const move = ({ active }: DragMoveEvent) => {
    const rect = active.rect.current.translated;
    const grid = root.current?.querySelector<HTMLElement>("[data-agent-grid]");
    if (!rect || !grid) return;
    const bounds = grid.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - bounds.left;
    const y = rect.top + rect.height / 2 - bounds.top;
    const slots = Array.from(
      grid.querySelectorAll<HTMLElement>("[data-agent-slot]"),
    );
    // Untransformed layout coordinates: animated neighbours must not move the target.
    let nearest = 0;
    let distance = Infinity;
    slots.forEach((slot, index) => {
      const next = Math.hypot(
        x - slot.offsetLeft - slot.offsetWidth / 2,
        y - slot.offsetTop - slot.offsetHeight / 2,
      );
      if (next < distance) {
        nearest = index;
        distance = next;
      }
    });
    const from = current.current.findIndex(
      (agent) => agent.pubkey === active.id,
    );
    if (from >= 0 && from !== nearest) {
      current.current = moveAgent(current.current, from, nearest);
      setPreview(current.current.map((agent) => agent.pubkey));
    }
  };
  const clear = () => {
    setActiveKey(undefined);
    setPreview(undefined);
  };
  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        container: document.body,
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${byKey.get(String(active.id))?.name ?? "agent"}. Escape cancels the move.`,
          onDragEnd: () => "Agent move ended.",
          onDragCancel: () => "Agent move cancelled.",
          onDragOver: () => undefined,
        },
      }}
      onDragStart={({ active }) => {
        setPreview(undefined);
        if (enabled) setActiveKey(String(active.id));
      }}
      onDragMove={move}
      onDragCancel={clear}
      onDragEnd={() => {
        if (validPreview && activeAgent) onMove(current.current);
        clear();
      }}
    >
      <div ref={root} className="contents">
        {children(shown, !!activeAgent)}
      </div>
      {createPortal(
        <DragOverlay
          // Matches duration-settle / easing-settle; pointer tracking itself is immediate.
          dropAnimation={
            reduced
              ? null
              : { duration: 220, easing: "cubic-bezier(.645,.045,.355,1)" }
          }
        >
          {activeAgent && (
            <div className={styles.lifted} aria-hidden="true">
              {overlay(activeAgent)}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** Card controls never activate the hold gesture, and keep their own tab stops. */
export function DraggableAgentRow({
  agent,
  enabled,
  children,
}: {
  agent: Agent;
  enabled: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const suppressClick = useRef(false);
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: agent.pubkey,
    disabled: !enabled,
  });
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === agent.pubkey) suppressClick.current = true;
    },
  });
  return (
    <motion.div
      ref={setNodeRef}
      role="row"
      className={styles.slot}
      data-agent-slot=""
      data-dragging={isDragging || undefined}
      layout={reduced ? false : "position"}
      // JS equivalent of duration-settle / easing-settle.
      transition={{
        layout: { duration: 0.22, ease: [0.645, 0.045, 0.355, 1] },
      }}
      onPointerDown={(event) => {
        // React portal events bubble here even when the control is outside this row.
        if (
          !(event.target instanceof Element) ||
          !event.currentTarget.contains(event.target)
        )
          return;
        suppressClick.current = false;
        if (
          event.pointerType === "touch" ||
          event.target.closest("[data-card-control], button, input")
        )
          return;
        listeners?.onPointerDown?.(event);
      }}
      onClickCapture={(event) => {
        // Escape can finish a drag before mouseup, after dnd-kit's click guard expires.
        if (
          suppressClick.current &&
          event.detail !== 0 &&
          event.target instanceof Node &&
          event.currentTarget.contains(event.target)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </motion.div>
  );
}
