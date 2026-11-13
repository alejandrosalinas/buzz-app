import type { PluginModule } from "../../plugins/api";
import { NotesPage } from "./NotesPage";
import { notesRoute } from "./routes";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "panels",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.pages.register({
    id: "notes",
    title: "Shared notes",
    layout: "workspace",
    primary: true,
    placement: "dock",
    route: { version: 1, validate: (params) => !!notesRoute(params) },
    component: (props) => (
      <NotesPage
        {...props}
        relay={relay}
        navigator={ctx.navigation}
        panels={ctx.panels}
        codeBlocks={ctx.conversation.codeBlocks}
      />
    ),
  });
};
