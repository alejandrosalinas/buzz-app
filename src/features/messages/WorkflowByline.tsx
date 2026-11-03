import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon } from "../../shared/design-system/icons";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../../shared/design-system/ui/Popover";
import { profileTarget } from "../profiles/target";
import styles from "./Messages.module.css";

export function WorkflowByline({
  ownerId,
  ownerName,
  ownerAgent,
  channelId,
  channelName,
  canOpenLink,
  onOpenLink,
}: {
  ownerId: string;
  ownerName: string;
  ownerAgent: boolean;
  channelId: string;
  channelName: string | undefined;
  canOpenLink?: ((url: string) => boolean) | undefined;
  onOpenLink(url: string): boolean;
}) {
  const target = profileTarget(ownerId, { agent: ownerAgent });
  // The message names no workflow or run, only its channel and owner.
  const workflows = `buzz://plugin?id=buzz.workflows&page=workflows&route.channel=${encodeURIComponent(channelId)}&route.owner=${ownerId}`;
  return (
    <span className={styles.workflowAttribution}>
      <strong className={styles.author}>Workflow</strong>
      <span className={styles.workflowOwner}>
        <span aria-hidden="true">· </span>owned by{" "}
        {target && canOpenLink?.(target) ? (
          <Button
            variant="link"
            size="inline"
            aria-label={`View workflow owner ${ownerName} profile`}
            onClick={() => onOpenLink(target)}
          >
            {ownerName}
          </Button>
        ) : (
          ownerName
        )}
      </span>
      <PopoverRoot>
        <PopoverTrigger
          openOnHover="preview"
          render={
            <IconButton
              size="xs"
              variant="ghost"
              aria-label="Workflow message details"
              icon={<InfoIcon />}
            />
          }
        />
        <PopoverPopup size="compact">
          <PopoverTitle>Workflow message</PopoverTitle>
          <PopoverDescription>
            Sent automatically by a workflow. Its owner set it up but didn’t
            send this message personally.
          </PopoverDescription>
          {/* A buzz:// link; hosts open those without a panel, as in bodies. */}
          <Button
            variant="link"
            size="inline"
            onClick={() => onOpenLink(workflows)}
          >
            View workflows in {channelName ? `#${channelName}` : "this channel"}
          </Button>
        </PopoverPopup>
      </PopoverRoot>
    </span>
  );
}
