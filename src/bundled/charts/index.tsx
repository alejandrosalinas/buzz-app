import type { PluginModule } from "../../plugins/api";
import { Chart } from "./Chart";
import { ChartExpand } from "./ChartExpand";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCodeBlock({
    id: "buzz-chart",
    title: "Chart",
    matches: (language) => language.toLowerCase() === "buzz-chart",
    component: Chart,
    action: ChartExpand,
  });
};
