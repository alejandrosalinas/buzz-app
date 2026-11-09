import type { JsonValue, OpenTarget } from "../../features/navigation/targets";

type BestiePageTarget = Extract<OpenTarget, { kind: "page" }>;
export type BestieRoute = {
  channelId: string;
  messageId: string;
  threadRootId: string;
};
const hex = /^[0-9a-f]{64}$/;

export function bestieRoute(
  value: JsonValue | undefined,
): BestieRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(route).length !== 3 ||
    typeof route.channelId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(route.channelId) ||
    typeof route.messageId !== "string" ||
    !hex.test(route.messageId) ||
    typeof route.threadRootId !== "string" ||
    !hex.test(route.threadRootId)
  )
    return;
  return {
    channelId: route.channelId,
    messageId: route.messageId,
    threadRootId: route.threadRootId,
  };
}

export function bestieThreadTarget(
  target: BestiePageTarget,
  route: BestieRoute,
): BestiePageTarget {
  return {
    ...target,
    route: { version: 1, params: { ...route } },
  };
}

export function bestieBaseTarget(target: BestiePageTarget): BestiePageTarget {
  const { route: _route, ...base } = target;
  return base;
}

export type BestieDetailRoute = {
  channelId: string;
  detail: string;
  rootId?: string;
};

/** Read-only panel address; the panel registry still decides what can open. */
export function bestieDetailRoute(
  value: JsonValue | undefined,
): BestieDetailRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const route = value as Readonly<Record<string, JsonValue>>;
  if (
    Object.keys(route).some(
      (key) => !["channelId", "detail", "rootId"].includes(key),
    ) ||
    typeof route.channelId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(route.channelId) ||
    typeof route.detail !== "string" ||
    !route.detail.trim() ||
    route.detail.length > 8192 ||
    (route.rootId !== undefined &&
      (typeof route.rootId !== "string" || !hex.test(route.rootId)))
  )
    return;
  return {
    channelId: route.channelId,
    detail: route.detail,
    ...(typeof route.rootId === "string" && { rootId: route.rootId }),
  };
}

export function bestieDetailTarget(
  target: BestiePageTarget,
  route: BestieDetailRoute,
): BestiePageTarget {
  return { ...target, route: { version: 1, params: { ...route } } };
}
