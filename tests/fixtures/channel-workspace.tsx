// Use the production sidebar/page ownership with real navigation in standalone fixtures.
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ChannelNavigationProvider } from "../../src/features/channel-navigation/ChannelNavigationState";
import { PrimarySidebar } from "../../src/app/shell/sidebar-section-testing";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import type { RelayData } from "../../src/features/relay/service";
import type { Panels } from "../../src/features/panels/service";
import type { PagesReader } from "../../src/features/pages/service";
import type {
  PageNavigation,
  provideNavigation,
} from "../../src/features/navigation/service";

export function ChannelWorkspaceFixture({
  relay,
  panels,
  pages,
  host,
}: {
  relay: RelayData;
  panels: Panels;
  pages: PagesReader;
  host: ReturnType<typeof provideNavigation>;
}) {
  const state = useSyncExternalStore(
    host.navigation.subscribe,
    host.navigation.snapshot,
  );
  const [presentation, setPresentation] = useState<{
    attempt: typeof state.attempt;
    request: PageNavigation;
  }>();
  useLayoutEffect(() => {
    const { request, dispose } = host.request(state.attempt, {
      valid: () => true,
      subscribe: () => () => {},
    });
    setPresentation({ attempt: state.attempt, request });
    return dispose;
  }, [host, state.attempt]);
  const navigation =
    presentation?.attempt === state.attempt ? presentation.request : undefined;
  return (
    <ChannelNavigationProvider relay={relay}>
      <div style={{ display: "flex", height: "100%", minWidth: 0 }}>
        <PrimarySidebar
          relay={relay}
          navigator={host.navigation}
          target={state.entry.target}
        >
          {null}
        </PrimarySidebar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChannelsPage
            relay={relay}
            panels={panels}
            pages={pages}
            navigator={host.navigation}
            navigation={navigation}
          />
        </div>
      </div>
    </ChannelNavigationProvider>
  );
}
