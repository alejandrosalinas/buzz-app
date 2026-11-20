import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { useTemplateAgents } from "./useTemplateAgents";

/** Why a template's save waits on its agents, with a retry once a read fails. */
export function TemplateAgentsStatus({
  setup,
}: {
  setup: ReturnType<typeof useTemplateAgents>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (!setup.pending) return null;
  if (setup.checking && !retrying)
    return (
      <p role="status" className="text-secondary">
        Checking this template’s agents…
      </p>
    );
  return (
    <div role="alert" className="flex items-center gap-2 text-secondary">
      <span>This template’s agents couldn’t be checked.</span>
      <Button
        variant="ghost"
        loading={retrying}
        onClick={() => {
          setRetrying(true);
          void setup.retry().finally(() => setRetrying(false));
        }}
      >
        Retry
      </Button>
    </div>
  );
}
