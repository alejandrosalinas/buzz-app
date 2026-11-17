import type { ComponentProps } from "react";
import { SidebarFrame } from "../channel-navigation/SidebarFrame";
import { ResizableSidebar } from "../channel-navigation/ResizableSidebar";

export function SidebarContextFrame({
  resizable = false,
  scope = "disconnected",
  ...props
}: ComponentProps<typeof SidebarFrame> & {
  resizable?: boolean;
  scope?: string;
}) {
  const frame = <SidebarFrame {...props} />;
  return resizable ? (
    <ResizableSidebar scope={scope} className="shell-sidebar">
      {frame}
    </ResizableSidebar>
  ) : (
    <div className="shell-sidebar-default">{frame}</div>
  );
}
