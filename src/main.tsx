// FOUNDATION: React startup. Keep initialization explicit and minimal.
// Establish host CSS layer order before product modules import component layers.
import "./shared/styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createServices } from "./app/services";
import { loadAgentStorage } from "./features/agents/state";
import { App } from "./app/App";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import { useKeyboardFocusVisibility } from "./shared/design-system/useKeyboardFocusVisibility";
import { useRejectUnclaimedDrops } from "./features/messages/use-file-drop";
import { TooltipProvider } from "./shared/design-system/ui/Tooltip";
import { clearReactDevMeasures } from "./features/developer/react-dev-timing";
import { showStartupFailure, startupHandedToReact } from "./app/launch";

// React dev builds otherwise fill the User Timing buffer without limit.
if (import.meta.env.DEV) clearReactDevMeasures();

const container = document.getElementById("root");

if (!container) {
  throw new Error('Missing <div id="root"> in index.html');
}

// Agent storage is read before any service, since its reads are synchronous.
// It settles, with localStorage at worst, so the window always starts.
// What stops startup shows "Buzz couldn’t open" from public/launch-init.js
// instead of a stuck launch or empty window; what unmounts the whole app once
// its launch has ended shows "Buzz stopped working" there.
void loadAgentStorage().finally(() => {
  try {
    const services = createServices();
    const root = createRoot(container, {
      onUncaughtError: (error, info) =>
        showStartupFailure(error, info.componentStack),
    });
    function HostApp() {
      useKeyboardFocusVisibility();
      useRejectUnclaimedDrops();
      return (
        <TooltipProvider>
          <App services={services} />
        </TooltipProvider>
      );
    }
    root.render(
      <StrictMode>
        <HostApp />
      </StrictMode>,
    );
    startupHandedToReact();

    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        root.unmount();
        void services.dispose().catch(console.error);
      });
    }
  } catch (error) {
    showStartupFailure(error);
  }
});
