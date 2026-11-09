import { AgentAvatarArtworkProvider } from "../../features/agents/AgentAvatarArtworkProvider";
import "../../shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { TooltipProvider } from "../../shared/design-system/ui/Tooltip";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { HuddleWindowView } from "./HuddleWindowView";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import { clearReactDevMeasures } from "../../features/developer/react-dev-timing";

// React dev builds otherwise fill the User Timing buffer without limit.
if (import.meta.env.DEV) clearReactDevMeasures();

function Companion() {
  useKeyboardFocusVisibility();
  const [view, setView] = useState<HuddleView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let mounted = true;
    const updates = new Channel<HuddleView & { discussionOpen: boolean }>();
    updates.onmessage = (next) => {
      if (!mounted) return;
      document.documentElement.classList.toggle("dark", next.dark);
      setView((previous) => ({
        ...next,
        discussion: next.discussionOpen
          ? (next.discussion ??
            (previous?.id === next.id ? previous.discussion : undefined))
          : undefined,
      }));
    };
    void invoke("huddle_window_watch", { updates }).catch(() => {
      if (mounted)
        setError("This Huddle window is unavailable. Reopen it from Buzz.");
    });
    return () => {
      mounted = false;
    };
  }, []);
  const act = (action: HuddleAction, text?: string) => {
    if (!view) return;
    setError(undefined);
    void invoke("huddle_window_action", { id: view.id, action, text }).catch(
      () => setError("Couldn’t update the call. Try again from Buzz."),
    );
  };
  return view ? (
    <ToastProvider>
      <HuddleWindowView view={view} act={act} error={error} />
    </ToastProvider>
  ) : error ? (
    <p role="alert" className="p-6 text-body text-secondary">
      {error}
    </p>
  ) : null;
}
const container = document.getElementById("root");
if (container) {
  container.style.height = "100dvh";
  createRoot(container).render(
    <AgentAvatarArtworkProvider>
      <TooltipProvider>
        <Companion />
      </TooltipProvider>
    </AgentAvatarArtworkProvider>,
  );
}
