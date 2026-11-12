import type { PluginModule } from "../../plugins/api";
import { nativeBuilderlab } from "../builderlab/session";
import { MobileSettings } from "./MobileApp";
import { DeviceMobileIcon } from "../../shared/design-system/icons";
// A Builderlab build also offers the mobile app's own sign-in. It watches that
// session through its own installation and asks the app-owned
// `builderlabPhone` whether the phone would restore this key; see
// MobileSettings.
const builderlab = nativeBuilderlab();
export const inject = [
  "settingsCards",
  "communityReader",
  ...(builderlab ? ["federatedIdentity", "builderlabPhone"] : []),
];
export const apply: PluginModule["apply"] = (ctx) => {
  const communities = ctx.communityReader;
  const federatedIdentity = builderlab ? ctx.federatedIdentity : undefined;
  const phone = builderlab ? ctx.builderlabPhone : undefined;
  ctx.settingsCards.register({
    id: "mobile",
    title: builderlab ? "Mobile app" : "Pair mobile",
    icon: DeviceMobileIcon,
    // Pairing needs a community address, not a selected community.
    personal: true,
    component: ({ active }) => (
      <MobileSettings
        communities={communities}
        active={active}
        federatedIdentity={federatedIdentity}
        phone={phone}
      />
    ),
  });
};
