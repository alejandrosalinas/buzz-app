import {
  CHANNEL_ID,
  type JsonValue,
  type OpenTarget,
} from "../../features/navigation/targets";
import { HEX, UUID } from "../../features/workflows/protocol";
import type { WorkflowReference } from "../../features/workflows/types";

/** Workflows in a channel, by an owner, or one workflow selected. */
export type WorkflowsRoute = Readonly<{
  channel?: string;
  owner?: string;
  workflow?: string;
}>;
export function workflowsRoute(
  value: JsonValue | undefined,
): WorkflowsRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  // Unknown params are ignored, as in links; the owner key is case-insensitive.
  const route = value as Readonly<Record<string, JsonValue>>;
  const { channel, workflow } = route;
  const owner =
    typeof route.owner === "string" ? route.owner.toLowerCase() : route.owner;
  if (
    (channel !== undefined &&
      (typeof channel !== "string" || !CHANNEL_ID.test(channel))) ||
    (owner !== undefined && (typeof owner !== "string" || !HEX.test(owner))) ||
    (workflow !== undefined &&
      (typeof workflow !== "string" ||
        !UUID.test(workflow) ||
        channel === undefined ||
        owner === undefined))
  )
    return;
  return {
    ...(typeof channel === "string" ? { channel } : {}),
    ...(typeof owner === "string" ? { owner } : {}),
    ...(typeof workflow === "string" ? { workflow } : {}),
  };
}
/** The workflow a route selects, if any. */
export function routedWorkflow(
  route: WorkflowsRoute | undefined,
): WorkflowReference | undefined {
  return route?.workflow && route.channel && route.owner
    ? { id: route.workflow, channelId: route.channel, owner: route.owner }
    : undefined;
}
/** The Workflows page `target` names, showing `route`; none shows the page as opened. */
export function workflowsTarget(
  target: Extract<OpenTarget, { kind: "page" }>,
  route?: WorkflowsRoute,
): OpenTarget {
  const { route: _route, ...page } = target;
  return route
    ? { ...page, route: { version: 1, params: { ...route } } }
    : page;
}
