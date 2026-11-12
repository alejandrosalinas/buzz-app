import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { createGit } from "./git";
import { ChangesetPanel } from "./Panel";
import { TurnCards } from "./Card";
import { parseTarget } from "./target";
import { createTurns } from "./turns";

export const inject = ["panels", "host", "conversation", "relay"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { host } = ctx;
  if (!isTauri() || !host.spawn) return;
  const turns = createTurns(createGit(host.spawn.bind(host)));
  ctx.effect(() => {
    let release: (() => void) | undefined;
    let bound: unknown;
    const bind = () => {
      const connection = ctx.relay.snapshot();
      const next =
        connection.status === "ready" ? connection.session : undefined;
      if (next === bound) return;
      release?.();
      bound = next;
      release = next && turns.watch(next, connection.origin);
    };
    const stop = ctx.relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
      turns.flush();
    };
  });
  ctx.conversation.registerAccessory({
    id: "changes",
    title: "Changed files",
    placement: "message",
    component: (props) => <TurnCards {...props} turns={turns} />,
  });
  ctx.panels.register({
    id: "changes",
    title: "Changes",
    matches: (url) => !!parseTarget(url),
    component: ({ target }) => <ChangesetPanel target={target} turns={turns} />,
  });
};
