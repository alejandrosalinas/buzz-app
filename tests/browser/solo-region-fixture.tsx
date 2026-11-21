import type { BundledPlugin } from "../../src/plugins/manager";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { StarFilledIcon } from "../../src/shared/design-system/icons";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import type {
  SoloRegionBinding,
  SoloRegionProps,
  SoloRegionSnapshot,
} from "../../src/features/channel-navigation/solo-navigation-contract";

function HeaderAccessory({ label }: { label: string }) {
  const [marked, setMarked] = useState(false);
  return (
    <div className="flex min-w-16 justify-end">
      <IconButton
        size="compact"
        variant={marked ? "tint" : "ghost"}
        aria-label={label}
        aria-pressed={marked}
        icon={<StarFilledIcon size={15} />}
        onClick={() => setMarked(!marked)}
      />
    </div>
  );
}

function useHeaderSummary(label: string) {
  const [opened, setOpened] = useState(false);
  const [hovered, setHovered] = useState(false);
  return {
    icon: <StarFilledIcon size={15} aria-hidden="true" />,
    label: `${opened ? "Reopen" : "Open"} ${label} summary`,
    onActivate: () => setOpened((value) => !value),
    wrapControls: (controls: ReactNode) => (
      <span
        className="inline-flex shrink-0"
        data-fixture-summary-anchor=""
        data-hovered={hovered || undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        {controls}
      </span>
    ),
  };
}

declare global {
  interface Window {
    fixtureSoloRegion?: {
      state(): SoloRegionProps["state"];
      classify(id: string): Promise<void>;
      createWorkspace(): Promise<void>;
      present(removed: string[], hidden: string[], first?: string): void;
      showHeaderMetadata(visible: boolean): void;
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
        hidden: string[] = [],
        first: string | undefined;
      let headerMetadataVisible = true;
      let notify = () => {};
      if (!ctx.soloNavigation) throw new Error("Solo navigation unavailable");
      const navigation = ctx.soloNavigation;
      const hitTargets = new URL(location.href).searchParams.has(
        "workspace-hit-targets",
      );
      const headerAccessories = new URL(location.href).searchParams.has(
        "header-accessories",
      );
      const leadingHeader = new URL(location.href).searchParams.has(
        "leading-header",
      );
      function Workspaces({
        ui,
        binding,
      }: Pick<SoloRegionProps, "ui" | "binding">) {
        const [selected, select] = useState<string>();
        const summary = useHeaderSummary("Work");
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
              headerLeading={
                leadingHeader && workspace.id === "work" ? summary : undefined
              }
              headerAccessory={
                headerAccessories &&
                !leadingHeader &&
                workspace.id === "work" ? (
                  <HeaderAccessory label={`Mark ${workspace.name} workspace`} />
                ) : undefined
              }
              headerMetadata={
                headerMetadataVisible &&
                headerAccessories &&
                (workspace.id === "work" ||
                  (leadingHeader && workspace.id === "other")) ? (
                  <time dateTime="PT3M">3m</time>
                ) : undefined
              }
            >
              <button type="button">Workspace task</button>
            </ui.Workspace>
          ) : null,
        );
      }
      function ChannelGroup({
        ui,
        id,
      }: Pick<SoloRegionProps, "ui"> & { id: string }) {
        const [expanded, setExpanded] = useState(false);
        const [selected, select] = useState(false);
        const summary = useHeaderSummary("Alpha");
        if (!ui.ChannelGroup) return null;
        return (
          <ui.ChannelGroup
            channelId={id}
            selected={selected}
            onSelect={() => select(true)}
            expanded={expanded}
            controls={`fixture-group-${id}`}
            disclosureLabel={`Toggle ${id} tasks`}
            onToggle={() => setExpanded(!expanded)}
            onNewTask={() => select(false)}
            headerLeading={
              leadingHeader && id === "alpha" ? summary : undefined
            }
            headerAccessory={
              !leadingHeader && id === "alpha" ? (
                <HeaderAccessory label="Mark Alpha channel" />
              ) : undefined
            }
            headerMetadata={
              headerMetadataVisible &&
              (id === "alpha" || (leadingHeader && id === "gamma")) ? (
                <time dateTime="P1D">1d</time>
              ) : undefined
            }
          >
            <button type="button">Channel task</button>
          </ui.ChannelGroup>
        );
      }
      const composing = new URL(location.href).searchParams.has(
        "compose-workspaces",
      );
      const stateFixture = new URL(location.href).searchParams.has(
        "region-state-fixture",
      );
      function SavedState({ state }: Pick<SoloRegionProps, "state">) {
        const value = useSyncExternalStore(
          state.subscribe,
          () => JSON.stringify(state.get()) ?? "absent",
        );
        return <output aria-label="Region state">{value}</output>;
      }
      const handle = ctx.soloNavigation.registerSource({
        ...(composing ? { composeWorkspaces: true } : {}),
        id: "work",
        title: "Solo",
        icon: null,
        bind(next) {
          binding = next;
          snapshot = {
            status: stateFixture ? "loading" : "ready",
            binding,
            revision: 1,
          };
        },
        read: () => snapshot,
        subscribe(listener) {
          notify = listener;
          return () => {
            notify = () => {};
          };
        },
        component: ({ ui, live, binding, state }) => (
          <>
            {stateFixture && <SavedState state={state} />}
            {hitTargets && <Workspaces ui={ui} binding={binding} />}
            {headerAccessories && (
              <>
                <ChannelGroup ui={ui} id="alpha" />
                <ChannelGroup ui={ui} id="gamma" />
              </>
            )}
            {/* A source can retain a keyed conversation across roster changes. */}
            {(first
              ? [first, ...[...live].filter((id) => id !== first)]
              : [...live]
            )
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
        state: () => handle.state(binding),
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
        showHeaderMetadata(visible) {
          headerMetadataVisible = visible;
          snapshot = { ...snapshot, revision: snapshot.revision + 1 };
          notify();
        },
        status(status) {
          snapshot = { ...snapshot, status, revision: snapshot.revision + 1 };
          notify();
        },
        present(nextRemoved, nextHidden, nextFirst) {
          removed = nextRemoved;
          hidden = nextHidden;
          first = nextFirst;
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
