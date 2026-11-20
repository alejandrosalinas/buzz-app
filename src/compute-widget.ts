import { createAppearance } from "./shared/theme/service";
import "./shared/design-system/styles/tokens.css";
import "../public/compute-widget.js";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MenuIcon } from "./shared/design-system/icons";
import { isTauri } from "@tauri-apps/api/core";

// The macOS window frame supplies its own rounded outline.
if (isTauri() && /Mac/.test(navigator.platform))
  document.body.classList.add("native-window-frame");

const menu = document.getElementById("settings-toggle");
if (menu) createRoot(menu).render(createElement(MenuIcon, { size: 16 }));

const appearance = createAppearance();
window.addEventListener("pagehide", () => appearance.dispose(), { once: true });
