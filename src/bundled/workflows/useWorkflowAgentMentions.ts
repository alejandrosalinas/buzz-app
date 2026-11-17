import { useEffect, useState } from "react";
import { nativeIdentityEnabled } from "../../features/identity/service";
import { communityFromScope } from "../../features/relay/gifs";
import { nativeRelayInfo } from "../../features/relay/native";
import {
  workflowAgentMentions,
  type WorkflowAgentMentions,
} from "./workflowAgentMentionWarning";

/** One shared NIP-11 read per community. A failed read is dropped, so the
 * next mount retries it. */
const lookups = new Map<string, Promise<WorkflowAgentMentions>>();

function lookup(community: string) {
  let pending = lookups.get(community);
  if (!pending) {
    pending = nativeRelayInfo(community).then(workflowAgentMentions);
    pending.catch(() => lookups.delete(community));
    lookups.set(community, pending);
  }
  return pending;
}

/** The active community's NIP-11 mode. `any` until read, when unreadable, and
 * on hosts with no NIP-11 reader. */
export function useWorkflowAgentMentions(scope: string): WorkflowAgentMentions {
  const community = communityFromScope(scope);
  const [mode, setMode] = useState<{
    community: string;
    mode: WorkflowAgentMentions;
  }>();
  useEffect(() => {
    if (!community || !nativeIdentityEnabled()) return;
    let live = true;
    lookup(community).then(
      (mode) => live && setMode({ community, mode }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [community]);
  return mode?.community === community ? mode.mode : "any";
}
