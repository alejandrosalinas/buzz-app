import type { AgentViewProps } from "../../features/agents/service";
import { AGENT_CARD_ID } from "../../features/navigation/buzz-links";
import type { Navigation } from "../../features/navigation/controller";
import type {
  JsonValue,
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";

import {
  historySelection,
  historySelectionKey,
  type HistorySelection,
} from "../../features/agents/history-presentation";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;
const providerKey = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export function agentProviderRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const provider = (value as Readonly<Record<string, JsonValue>>).provider;
  return keys.length === 1 &&
    keys[0] === "provider" &&
    typeof provider === "string" &&
    providerKey.test(provider)
    ? provider
    : undefined;
}

/** `value`'s `key`, alone or with a version `revision`, when `valid`. */
function subjectRoute(
  value: JsonValue | undefined,
  key: "agent" | "team",
  valid: RegExp,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const params = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(params);
  const subject = params[key];
  return (keys.length === 1 ||
    (keys.length === 2 &&
      (params.revision === "" || !!historySelection(params.revision)))) &&
    keys.includes(key) &&
    typeof subject === "string" &&
    valid.test(subject)
    ? subject
    : undefined;
}

/** An agent of yours to open, as `{ agent: pubkey }`. */
export const agentRoute = (value: JsonValue | undefined) =>
  subjectRoute(value, "agent", /^[0-9a-f]{64}$/);

/** A team of yours to open, as `{ team: id }`. */
export const teamRoute = (value: JsonValue | undefined) =>
  subjectRoute(
    value,
    "team",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

/** A published agent card to start an agent from, as `{ card: id }`. */
export function agentCardRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const card = (value as Readonly<Record<string, JsonValue>>).card;
  return keys.length === 1 &&
    keys[0] === "card" &&
    typeof card === "string" &&
    AGENT_CARD_ID.test(card)
    ? card
    : undefined;
}

export const availableAgentProviderRoute = (value: JsonValue) =>
  Boolean(
    agentProviderRoute(value) ??
      agentRoute(value) ??
      teamRoute(value) ??
      agentCardRoute(value),
  );

/** The Agents page with `pubkey` open. */
export const agentTarget = (pubkey: string) =>
  ({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    route: { version: 1, params: { agent: pubkey } },
  }) as const;

export function agentProviderTarget(
  target: PageTarget,
  provider?: string,
): PageTarget {
  const { route: _route, ...page } = target;
  return provider
    ? { ...page, route: { version: 1, params: { provider } } }
    : page;
}

/** Opens an activity turn's channel, or its thread at the root, in `scope`'s
 * community; undefined where the host can't navigate there. */
export function conversationOpener(
  navigation: Navigation | undefined,
  scope: NavigationScope | undefined,
): AgentViewProps["openConversation"] {
  if (!navigation || !scope) return undefined;
  return (channelId, threadRootId) =>
    void navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(threadRootId ? { messageId: threadRootId, threadRootId } : {}),
    });
}

/** A version address preserves the agent or team and the page's
 * account/community scope. */
export function historyTarget(
  target: PageTarget,
  subject: Readonly<{ agent: string } | { team: string }>,
  selected?: HistorySelection,
): PageTarget {
  return {
    ...target,
    route: {
      version: 1,
      params: {
        ...subject,
        revision: selected ? historySelectionKey(selected) : "",
      },
    },
  };
}

/** The version a route opens, with `route` its agent or team route. */
export function historyRoute(
  value: JsonValue | undefined,
  route: (value: JsonValue | undefined) => string | undefined,
) {
  return route(value) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? historySelection((value as Record<string, JsonValue>).revision)
    : undefined;
}

export function historyActive(
  value: JsonValue | undefined,
  route: (value: JsonValue | undefined) => string | undefined,
) {
  return (
    !!route(value) &&
    value !== null &&
    typeof value === "object" &&
    "revision" in value
  );
}
