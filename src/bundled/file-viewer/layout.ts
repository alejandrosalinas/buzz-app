import { useEffect, useLayoutEffect, useState } from "react";

/** The node's inner size, kept current as the panel resizes. */
export function useSize(node: HTMLElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!node) return;
    const measure = () =>
      setSize((old) =>
        old.width === node.clientWidth && old.height === node.clientHeight
          ? old
          : { width: node.clientWidth, height: node.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size;
}

/** True while `node` is within `reach` pixels above or below what `root`
 * shows. In pixels, because a rootMargin percentage is of the root's width. */
export function useNear(
  node: HTMLElement | null,
  root: HTMLElement | null,
  reach: number,
) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!node || !root) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(!!entries.at(-1)?.isIntersecting),
      { root, rootMargin: `${reach}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, root, reach]);
  return near;
}
