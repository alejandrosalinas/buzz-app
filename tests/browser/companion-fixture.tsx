// Generic launcher coverage remains independent of bundled Bestie visibility.
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../src/features/panels/service";
import type { BundledPlugin } from "../../src/plugins/manager";

// A channel-header side panel, opted in per test, for generic side-panel focus.
function SidePanelLauncher({ context, toggle, pressed }: ChannelLauncherProps) {
  return (
    <button
      type="button"
      data-channel-panel-toggle=""
      aria-label="Toggle side panel fixture"
      aria-expanded={pressed}
      onClick={(event) => {
        event.currentTarget.focus();
        toggle(context.channelId);
      }}
    >
      Side panel
    </button>
  );
}

export const companionPlugins: readonly BundledPlugin[] = [
  {
    manifest: {
      id: "fixture.companion",
      name: "Companion fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["panels"],
      apply(ctx) {
        ctx.panels.register({
          id: "companion",
          title: "Companion fixture",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "fixture-companion" },
          component: () => <p>Companion fixture content</p>,
        });
      },
    },
  },

  {
    manifest: {
      id: "fixture.side-panel",
      name: "Side panel fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      inject: ["panels"],
      apply(ctx) {
        ctx.panels.register({
          id: "side",
          title: "Side fixture",
          matches: () => false,
          channelLauncher: SidePanelLauncher,
          channelPlacement: "side",
          component: ({ close }: PanelProps) => (
            <button type="button" onClick={close}>
              Hide side panel fixture
            </button>
          ),
        });
      },
    },
  },
];
