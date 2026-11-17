import type { ReactNode } from "react";

/** Non-interactive metadata; counts retain the dedicated CountBadge semantics. */
export function Badge({
  children,
  size = "xs",
  tone = "neutral",
}: {
  children: ReactNode;
  size?: "xs";
  tone?: "neutral" | "success";
}) {
  return (
    <span
      data-buzz-ui=""
      className="buzz-badge"
      data-size={size}
      data-tone={tone}
    >
      {children}
    </span>
  );
}
