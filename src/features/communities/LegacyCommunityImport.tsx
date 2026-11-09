import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { importLegacyCommunities } from "./legacy-communities";
import type { Communities } from "./service";

/** Old storage cannot distinguish a removed community from a new one. */
export function LegacyCommunityImport({
  communities,
}: {
  communities: Communities;
}) {
  const [request, setRequest] = useState<{
    origins: string[];
    resolve(approved: boolean): void;
  }>();
  const proceed = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let answer: ((approved: boolean) => void) | undefined;
    const dispose = importLegacyCommunities(
      communities,
      (origins) =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
          setRequest({ origins, resolve });
        }),
    );
    return () => {
      dispose();
      answer?.(false);
    };
  }, [communities]);
  if (!request) return null;
  const respond = (approved: boolean) => {
    setRequest(undefined);
    request.resolve(approved);
  };
  return (
    <AlertDialog
      title="Import communities from old Buzz?"
      description="Add these saved communities to your list and account. This may restore communities you previously removed."
      initialFocus={proceed}
      onClose={() => respond(false)}
      actions={
        <>
          <Button type="button" onClick={() => respond(false)}>
            Skip import
          </Button>
          <Button
            ref={proceed}
            type="button"
            variant="prominent"
            onClick={() => respond(true)}
          >
            Import communities
          </Button>
        </>
      }
    >
      <ul
        aria-label="Communities to import"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded list must support keyboard scrolling.
        tabIndex={0}
        className="max-h-48 overflow-y-auto break-words text-body-sm"
      >
        {request.origins.map((origin) => (
          <li key={origin}>{origin}</li>
        ))}
      </ul>
    </AlertDialog>
  );
}
