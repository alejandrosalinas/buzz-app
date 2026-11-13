// The real find bar over a page with a long code block in its own scroller,
// and the shared Dialog. `openFind` runs the registered shortcut's action.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FindInPage } from "../../src/app/shell/FindInPage";
import type { ShortcutsService } from "../../src/features/shortcuts/service";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import "../../src/shared/styles/globals.css";

declare global {
  interface Window {
    openFind: () => void;
    setModal: (open: boolean) => void;
  }
}

const shortcuts = {
  registerHost(shortcut) {
    window.openFind = shortcut.run;
    return () => {};
  },
} as Pick<ShortcutsService, "registerHost">;

const lines = [
  "first needle",
  ...Array.from({ length: 120 }, (_, line) => `filler line ${line}`),
  `${"wide ".repeat(80)}farright ${"tail ".repeat(20)}`,
  "last needle",
];

function Page() {
  const [modal, setModal] = useState(false);
  window.setModal = setModal;
  return (
    <>
      <div
        data-testid="reader"
        style={{ height: 300, marginTop: 140, overflowY: "auto" }}
      >
        <pre style={{ overflowX: "auto" }}>
          <code>{lines.join("\n")}</code>
        </pre>
      </div>
      <Dialog
        open={modal}
        title="Members"
        motion="none"
        onOpenChange={setModal}
      >
        <input aria-label="Dialog field" />
        <p>dialog needle</p>
      </Dialog>
      <FindInPage shortcuts={shortcuts} />
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Page />);
