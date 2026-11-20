import { writeView } from "../../shared/view-state";
import type { Navigation } from "../navigation/controller";
import type { JsonValue, OpenTarget } from "../navigation/targets";
import { splitPartition } from "../relay/partition";
import { regionLabels } from "../solo/region-labels";
import type { SoloDraftStart } from "./solo-navigation-contract";
import { newMessage } from "./new-message-route";

export {
  type MessageIntent,
  newMessage,
  newMessageTarget,
  nextMessageIntent,
} from "./new-message-route";

/** An unsent Solo conversation: nothing exists on the relay until its first send. */
export type SoloDraft = Readonly<{
  project?: string;
  agent?: string;
  linked?: string;
  /** The Solo region label whose source opened this draft. */
  region?: string;
  /** Source-owned context and identity for this unsent region draft. */
  draft?: NonNullable<SoloDraftStart["draft"]>;
}>;

const agentKey = /^[0-9a-f]{64}$/;

export function soloDraft(
  params: JsonValue | undefined,
): SoloDraft | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  if (value.kind !== "solo-draft") return;
  if (
    !value.region &&
    Object.keys(value).some(
      (key) =>
        key !== "kind" &&
        key !== "project" &&
        key !== "agent" &&
        key !== "linked" &&
        key !== "region" &&
        key !== "draft",
    )
  )
    return;
  const { project, agent, linked, region, draft } = value;
  if (
    region !== undefined &&
    (typeof region !== "string" ||
      !regionLabels([region]).length ||
      linked !== undefined)
  )
    return;
  if (
    "draft" in value &&
    (!region ||
      !draft ||
      typeof draft !== "object" ||
      Array.isArray(draft) ||
      Object.keys(draft).some((key) => key !== "key" && key !== "context") ||
      ("key" in draft &&
        (typeof draft.key !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(draft.key))) ||
      !("context" in draft))
  )
    return;
  if (
    linked !== undefined &&
    (typeof linked !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        linked,
      ))
  )
    return;
  if (
    project !== undefined &&
    (typeof project !== "string" || !project || project.length > 256)
  )
    return;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || !agentKey.test(agent))
  )
    return;
  return {
    ...(project ? { project } : {}),
    ...(agent ? { agent } : {}),
    ...(linked ? { linked } : {}),
    ...(region ? { region } : {}),
    ...(draft
      ? { draft: draft as NonNullable<SoloDraftStart["draft"]> }
      : region
        ? // Preserve prior source fields without interpreting their meaning.
          { draft: { context: { saved: value } } }
        : {}),
  };
}

export function isChannelRoute(params: JsonValue) {
  return (
    newMessage(params) !== undefined ||
    params === "empty" ||
    soloDraft(params) !== undefined
  );
}

/** A new Solo conversation, optionally filed in a project or starting with an agent. */
export function soloDraftTarget(
  scope: string,
  draft: SoloDraft = {},
): OpenTarget {
  const parts = splitPartition(scope);
  const params = { kind: "solo-draft", ...draft };
  if (!parts || !soloDraft(params)) throw new Error("Invalid Solo destination");
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    scope: parts,
    route: { version: 1, params },
  };
}

/** New focuses an already open ordinary draft, including its route context. */
export function resumeSoloDraftTarget(
  scope: string,
  current: OpenTarget | undefined,
  project?: string,
): OpenTarget {
  const parts = splitPartition(scope);
  if (
    current?.kind === "page" &&
    current.pluginId === "buzz.channels" &&
    current.pageId === "channels" &&
    parts &&
    current.scope?.communityOrigin === parts.communityOrigin &&
    current.scope?.viewer === parts.viewer
  ) {
    const draft = soloDraft(current.route?.params);
    if (draft && !draft.region && (!project || draft.project === project))
      return current;
  }
  return soloDraftTarget(scope, project ? { project } : {});
}

export function conversationTarget(
  scope: string,
  channelId: string,
): OpenTarget {
  const parts = splitPartition(scope);
  if (!parts) throw new Error("Invalid conversation destination");
  return { version: 1, kind: "conversation", scope: parts, channelId };
}

/** The sidebar reads only which conversation is open, never what is open
 * within it: a thread, message, panel or detail there is not a destination. */
export function sidebarTarget(target: OpenTarget): OpenTarget {
  if (target.kind !== "conversation") return target;
  const { version, kind, scope, channelId } = target;
  return { version, kind, scope, channelId };
}

/** A reopened conversation must still belong to this community and viewer. */
export function matchesConversation(
  target: OpenTarget | undefined,
  scope: string,
  channelId: string,
): boolean {
  const parts = splitPartition(scope);
  return (
    target?.kind === "conversation" &&
    target.channelId === channelId &&
    target.scope.communityOrigin === parts?.communityOrigin &&
    target.scope.viewer === parts?.viewer
  );
}

/** Where leaving the open channel lands without a sidebar neighbor: the empty
 * Channels page, with its saved selection forgotten so it is not reopened. */
export function openEmptyChannels(navigator: Navigation, scope: string) {
  writeView(scope, "selected-channel", undefined);
  void navigator.open({
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    route: { version: 1, params: "empty" },
  });
}
