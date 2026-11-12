import { useRef, useState } from "react";
import { ArrowsOutIcon } from "../../shared/design-system/icons";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Chart } from "./Chart";

/** Opens a chart at full size. The host's copy button copies its fenced JSON. */
export function ChartExpand({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const expand = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        hint="familiar"
        ref={expand}
        aria-label="Expand chart"
        title="Expand chart"
        icon={<ArrowsOutIcon />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Chart"
        size="expanded"
        closeLabel="Close chart"
        finalFocus={expand}
      >
        <Chart code={code} expanded />
      </Dialog>
    </>
  );
}
