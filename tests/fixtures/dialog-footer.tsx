// Browser-only geometry fixture using the production modal and controls.
import "../../src/shared/styles/globals.css";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  Dialog,
  type DialogProps,
} from "../../src/shared/design-system/ui/Dialog";
import { AlertDialog } from "../../src/shared/design-system/ui/AlertDialog";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Field } from "../../src/shared/design-system/ui/Field";
import { Input } from "../../src/shared/design-system/ui/Input";
import { Select } from "../../src/shared/design-system/ui/Select";
import { Switch } from "../../src/shared/design-system/ui/Switch";

const params = new URLSearchParams(location.search);
const layout = params.get("layout") ?? "flow";
const content = params.get("content") ?? "buttons";
const fields = Array.from({ length: 16 }, (_, index) => `Field ${index + 1}`);
document.documentElement.dataset.colorMode = params.get("theme") ?? "dark";
document.documentElement.style.setProperty(
  "--buzz-text-scale",
  params.get("scale") ?? "1",
);

function Fixture() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [choice, setChoice] = useState("one");
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const leading =
    content === "mixed" ? (
      <div className="flex flex-wrap items-center gap-3">
        <span>Footer status</span>
        <a href="#details">Details</a>
        <Switch
          label="Enable plugin"
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </div>
    ) : content === "leading-only" ? (
      <Button onClick={() => setSaved(saved + 1)}>Leading action</Button>
    ) : undefined;
  const controls = (
    <>
      {content === "mixed" && (
        <Select
          label="Footer choice"
          value={choice}
          onValueChange={setChoice}
          groups={[
            {
              label: "Choices",
              options: [
                { value: "one", label: "One" },
                { value: "two", label: "Two" },
              ],
            },
          ]}
        />
      )}
      <Button disabled>Unavailable</Button>
      <Button onClick={() => setSaved(saved + 1)}>
        {content === "overflow" ? "Publish profile & open" : "Save"}
      </Button>
    </>
  );
  const actions =
    content === "leading-only" ? undefined : content === "portal" ? (
      <>
        <div ref={setPortal} className="contents" />
        {portal && createPortal(controls, portal)}
      </>
    ) : content === "wrapped" ? (
      <div className="flex flex-wrap gap-3">{controls}</div>
    ) : (
      controls
    );
  const body = fields.map((label) => (
    <Field key={label} label={label}>
      <Input />
    </Field>
  ));
  const props: Partial<DialogProps> = {
    ...(layout === "padded" ? { chromeSpacing: "padded" } : {}),
    ...(layout === "stable" ? { height: "stable" } : {}),
    ...(layout === "stable-tall" ? { height: "stable-tall" } : {}),
    ...(layout === "flex" ? { bodyLayout: "flex", height: "stable" } : {}),
    ...(layout === "right" ? { placement: "right" } : {}),
    ...(layout === "expanded" ? { size: "expanded" } : {}),
    ...(layout === "compact" ? { size: "compact" } : {}),
    ...(layout === "wide" ? { size: "wide" } : {}),
    ...(layout === "stepped" ? { step: { key: "first", scale: 1 } } : {}),
    ...(layout === "search" ? { presentation: "search" } : {}),
    ...(layout === "navigation"
      ? { navigation: { label: "Sections", content: <Button>Section</Button> } }
      : {}),
  };
  const children: ReactNode =
    layout === "header-only" ? undefined : (
      <div className="space-y-section-gap">{body}</div>
    );
  return (
    <>
      <output aria-label="Saved count">{saved}</output>
      {layout === "alert" ? (
        open && (
          <AlertDialog
            title="Footer test"
            description="Confirm this example"
            onClose={() => setOpen(false)}
            actions={controls}
          >
            {children}
          </AlertDialog>
        )
      ) : (
        <Dialog
          {...props}
          open={open}
          onOpenChange={setOpen}
          title="Footer test"
          leadingActions={leading}
          actions={actions}
        >
          {children}
        </Dialog>
      )}
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
