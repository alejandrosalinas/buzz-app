import type { EventData } from "./events";

/** The id in a message's signed `plugin-request` tag. The `plugin_request`
 * tool writes it; the plugin request card reads it. */
export function pluginRequestId(event: EventData) {
  const id = event.tags.find(([name]) => name === "plugin-request")?.[1];
  return id && /^[\w-]{1,64}$/.test(id) ? id : undefined;
}
