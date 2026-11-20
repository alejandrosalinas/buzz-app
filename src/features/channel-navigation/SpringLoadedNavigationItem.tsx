import type { ComponentProps } from "react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useSpringLoaded } from "../messages/spring-loaded-drag";

/** A sidebar row that also opens when a file drag rests on it; see `useSpringLoaded`. */
export function SpringLoadedNavigationItem({
  onSpring,
  ...props
}: ComponentProps<typeof NavigationItem> & {
  /** Opens the row's destination as its click would. Omit to stay a plain row. */
  onSpring: (() => void) | undefined;
}) {
  const spring = useSpringLoaded(() => onSpring?.(), !!props.selected);
  return <NavigationItem {...props} {...(onSpring ? spring : {})} />;
}
