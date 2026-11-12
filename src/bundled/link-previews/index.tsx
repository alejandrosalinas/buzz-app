import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { LinkPreview } from "./LinkPreview";
import { createLoader } from "./loader";
import { previewable } from "./safety";

export const inject = ["conversation", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  const loader = createLoader(ctx.host);
  ctx.effect(() => () => loader.stop());
  if (!isTauri() || !loader.available) return;
  ctx.conversation.registerLinkPreview({
    id: "web",
    title: "Web page preview",
    matches: (url) => !!previewable(url),
    // The catch-all band: a plugin that previews its own sites claims them
    // at the default, 0.
    order: 100,
    component: (props) => <LinkPreview {...props} loader={loader} />,
  });
};
