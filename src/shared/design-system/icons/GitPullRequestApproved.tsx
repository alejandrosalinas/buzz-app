import { forwardRef, useId } from "react";
import type { IconProps } from "./createDecorativeIcon";

/** Tabler's pull request glyph with its head dot replaced by a solid check
 * badge. The check is cut out with a mask, so the bubble behind it shows
 * through whatever its color. */
export const GitPullRequestApprovedArtwork = forwardRef<
  SVGSVGElement,
  IconProps
>(function GitPullRequestApprovedArtwork({ size = "1em", ...props }, ref) {
  const checkCutout = useId();
  return (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <mask id={checkCutout}>
        <rect width="24" height="24" fill="white" stroke="none" />
        <path
          d="M15.5 18l1.75 1.75l3.25 -3.5"
          stroke="black"
          strokeWidth="1.75"
        />
      </mask>
      <path d="M4 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M4 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M6 8v8" />
      <path d="M11 6h5a2 2 0 0 1 2 2v5" />
      <path d="M14 9l-3 -3l3 -3" />
      <circle
        cx="18"
        cy="18"
        r="5"
        fill="currentColor"
        stroke="none"
        mask={`url(#${checkCutout})`}
      />
    </svg>
  );
});
