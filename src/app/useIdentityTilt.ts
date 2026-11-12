import type { PointerEvent } from "react";
import { useReducedMotion, useSpring, useTransform } from "motion/react";

/** The physical Identity cards share one pointer response and motion preference. */
export function useIdentityTilt() {
  const reducedMotion = useReducedMotion();
  const x = useSpring(0, { stiffness: 220, damping: 26 });
  const y = useSpring(0, { stiffness: 220, damping: 26 });
  const rotateX = useTransform(y, [-1, 1], [3, -3]);
  const rotateY = useTransform(x, [-1, 1], [-3, 3]);
  return {
    x,
    y,
    reducedMotion,
    style: {
      rotateX: reducedMotion ? 0 : rotateX,
      rotateY: reducedMotion ? 0 : rotateY,
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== "mouse" || reducedMotion) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      x.set(((event.clientX - bounds.left) / bounds.width - 0.5) * 2);
      y.set(((event.clientY - bounds.top) / bounds.height - 0.5) * 2);
    },
    onPointerLeave() {
      x.set(0);
      y.set(0);
    },
  };
}
