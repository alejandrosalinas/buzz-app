import { useState, useSyncExternalStore } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { Agents, TeamUpdateRequest } from "../../features/agents/service";

/** The owner reviews an agent's proposed team name and instructions, one
 * request at a time, and saves only what they reviewed. */
export function TeamUpdateReview({ agents }: { agents: Agents }) {
  const [request] = useSyncExternalStore(
    agents.subscribe,
    agents.teamUpdateRequests,
  );
  return request ? (
    <TeamUpdateDialog key={request.id} agents={agents} request={request} />
  ) : null;
}

function TeamUpdateDialog({
  agents,
  request,
}: {
  agents: Agents;
  request: TeamUpdateRequest;
}) {
  const [name, setName] = useState(request.name ?? request.base.name);
  const [instructions, setInstructions] = useState(
    request.instructions ?? request.base.instructions,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setPending(true);
    setError("");
    try {
      await agents.approveTeamUpdate(request.id, {
        name: name.trim(),
        instructions,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) agents.dismissTeamUpdate(request.id);
      }}
      title={`Edit ${request.base.name}`}
      description={`${request.requesterName} proposed these changes. Nothing changes until you save.`}
      height="content"
      chromeSpacing="padded"
      actions={
        <Button
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          Save
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">
          <Input
            value={name}
            disabled={pending}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Instructions">
          <Textarea
            rows={8}
            value={instructions}
            disabled={pending}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
