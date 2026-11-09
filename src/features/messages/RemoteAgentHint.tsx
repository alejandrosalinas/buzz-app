import { useSyncExternalStore } from "react";
import { remoteExecutionDetail } from "../agents/execution-location";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import type { ComposerSession } from "./composer-session";
import { CloudIcon } from "../../shared/design-system/icons";
import iconStyles from "./RemoteAgentHint.module.css";
import styles from "./Messages.module.css";

const noSubscribe = () => () => {};

type RemoteAgentProps = {
  session?: Pick<ComposerSession, "viewer" | "agentChoices"> | undefined;
  viewer: string | undefined;
  pubkey: string;
};

/** Execution evidence in this inventory belongs to the session's owner. */
function useRemoteDetail({ session, viewer, pubkey }: RemoteAgentProps) {
  const choices =
    viewer && viewer === session?.viewer ? session?.agentChoices : undefined;
  return useSyncExternalStore(
    choices?.subscribe ?? noSubscribe,
    () => {
      const agent = choices
        ?.snapshot()
        .identities.find((choice) => choice.pubkey === pubkey);
      return remoteExecutionDetail(agent?.execution, agent?.runtime);
    },
    () => undefined,
  );
}

export function RemoteWorkIcon({
  active,
  ...props
}: RemoteAgentProps & { active: boolean }) {
  return useRemoteDetail(props) ? (
    <CloudIcon
      className={iconStyles.cloud}
      data-active={active || undefined}
      size={16}
      aria-hidden="true"
    />
  ) : null;
}

export function RemoteAgentHint(props: RemoteAgentProps) {
  const detail = useRemoteDetail(props);
  return detail ? (
    <Tooltip content={detail}>
      <span
        className={styles.authorOwner}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need access to the execution details in the tooltip.
        tabIndex={0}
      >
        <span aria-hidden="true">· </span>
        Remote
      </span>
    </Tooltip>
  ) : null;
}
