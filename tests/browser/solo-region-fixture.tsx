import type { BundledPlugin } from "../../src/plugins/manager";
import { useState, useSyncExternalStore } from "react";
import type {
  SoloRegionBinding,
  SoloRegionProps,
  SoloRegionSnapshot,
} from "../../src/features/channel-navigation/solo-navigation-contract";

declare global {
  interface Window {
    fixtureSoloRegion?: {
      classify(id: string): Promise<void>;
      createWorkspace(): Promise<void>;
      present(removed: string[], hidden: string[]): void;
      status(status: "ready" | "loading"): void;
      addTransientRegion(): Promise<void>;
      removeTransientRegion(): Promise<void>;
    };
  }
}

export const soloRegionFixture: BundledPlugin = {
  manifest: {
    id: "fixture.solo-region",
    name: "Solo region fixture",
    apiVersion: 1,
  },
  module: {
    inject: ["soloNavigation"],
    apply(ctx) {
      if (!new URL(location.href).searchParams.has("solo-region-fixture"))
        return;
      let binding: SoloRegionBinding;
      let snapshot: SoloRegionSnapshot;
      let removed: string[] = [],
        hidden: string[] = [];
      let notify = () => {};
      if (!ctx.soloNavigation) throw new Error("Solo navigation unavailable");
      const navigation = ctx.soloNavigation;
      const hitTargets = new URL(location.href).searchParams.has(
        "workspace-hit-targets",
      );
      function Workspaces({
        ui,
        binding,
      }: Pick<SoloRegionProps, "ui" | "binding">) {
        const [selected, select] = useState<string>();
        const workspaces = useSyncExternalStore(
          (notify) => navigation.workspaces.subscribe(binding, notify),
          () => navigation.workspaces.snapshot(binding),
        );
        return workspaces.workspaces.map((workspace) =>
          ui.Workspace ? (
            <ui.Workspace
              key={workspace.id}
              id={workspace.id}
              selected={selected === workspace.id}
              onSelect={() => select(workspace.id)}
              onNewTask={() => select(undefined)}
            >
              <button type="button">Workspace task</button>
            </ui.Workspace>
          ) : null,
        );
      }
      const composing = new URL(location.href).searchParams.has(
        "compose-workspaces",
      );
      const handle = ctx.soloNavigation.registerSource({
        ...(composing ? { composeWorkspaces: true } : {}),
        id: "work",
        title: "Solo",
        icon: null,
        bind(next) {
          binding = next;
          snapshot = { status: "ready", binding, revision: 1 };
        },
        read: () => snapshot,
        subscribe(listener) {
          notify = listener;
          return () => {
            notify = () => {};
          };
        },
        component: ({ ui, live, binding }) => (
          <>
            {hitTargets && <Workspaces ui={ui} binding={binding} />}
            {[...live]
              .filter((id) => !removed.includes(id))
              .map((id) => (
                <div
                  key={id}
                  style={hidden.includes(id) ? { display: "none" } : undefined}
                >
                  <ui.Conversation channelId={id}>
                    {(c) => (
                      <ui.Card>
                        <c.Menu>
                          <c.Link label={c.name} />
                          <c.Actions />
                        </c.Menu>
                      </ui.Card>
                    )}
                  </ui.Conversation>
                </div>
              ))}
            {composing && ui.Chats && <ui.Chats all={!hitTargets} />}
          </>
        ),
      });
      let disposeTransient = async () => {};
      window.fixtureSoloRegion = {
        createWorkspace: () =>
          navigation.workspaces.create(binding, {
            id: "fixture-workspace",
            name: "Work",
          }),
        async addTransientRegion() {
          const fiber = ctx.plugin({
            inject: ["soloNavigation"],
            apply(child) {
              let current: SoloRegionSnapshot;
              if (!child.soloNavigation)
                throw new Error("Solo navigation unavailable");
              child.soloNavigation.registerSource({
                id: "temporary",
                title: "Temporary",
                order: 100,
                icon: null,
                bind(binding) {
                  current = { status: "ready", binding, revision: 1 };
                },
                read: () => current,
                subscribe: () => () => {},
                component: () => null,
              });
            },
          });
          await fiber.await();
          disposeTransient = async () => {
            await fiber.dispose();
          };
        },
        removeTransientRegion: () => disposeTransient(),
        classify: (id) => handle.classify(binding, id),
        status(status) {
          snapshot = { ...snapshot, status, revision: snapshot.revision + 1 };
          notify();
        },
        present(nextRemoved, nextHidden) {
          removed = nextRemoved;
          hidden = nextHidden;
          snapshot = { ...snapshot, revision: snapshot.revision + 1 };
          notify();
        },
      };
      ctx.effect(() => () => {
        delete window.fixtureSoloRegion;
      });
    },
  },
};
