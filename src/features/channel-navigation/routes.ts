import type { JsonValue, OpenTarget } from "../navigation/targets";
import { splitPartition } from "../relay/partition";
import { regionLabels } from "../solo/region-labels";
import type { SoloDraftStart } from "./solo-navigation-contract";

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
    params === "new-message" ||
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

export function conversationTarget(
  scope: string,
  channelId: string,
): OpenTarget {
  const parts = splitPartition(scope);
  if (!parts) throw new Error("Invalid conversation destination");
  return { version: 1, kind: "conversation", scope: parts, channelId };
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
