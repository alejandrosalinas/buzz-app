import type { PluginModule } from "../../plugins/api";
import { CommunityAdmin } from "./CommunityAdmin";
import { canManageMembership } from "./membership";

export const inject = ["relay", "settingsCards", "adminAccess", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const membership = ctx.adminAccess.membership;
  // Registered in every build. The card hides unsupported member changes
  // itself, so a Settings section, history entry or in-app locator naming it
  // still opens the roster and invite controls in native builds.
  ctx.settingsCards.register({
    id: "membership",
    title: "Membership",
    section: "administration",
    visibility: {
      snapshot: () => {
        const connection = relay.snapshot();
        const state = membership.snapshot();
        if (canManageMembership(state)) return true;
        if (
          connection.status === "error" ||
          connection.status === "disconnected" ||
          state.error
        )
          return "error";
        if (
          state.status === "idle" ||
          state.status === "loading" ||
          state.refreshing
        )
          return "pending";
        return false;
      },
      subscribe: membership.subscribe,
      ensure: membership.ensure,
    },
    component: ({ active, community, navigation }) => (
      <CommunityAdmin
        relay={relay}
        membership={membership}
        {...(community ? { communityName: community.name } : {})}
        active={active}
        selectedMethod={
          navigation?.target.kind === "settings" &&
          navigation.target.route?.version === 1 &&
          (navigation.target.route.params === "invite" ||
            navigation.target.route.params === "direct")
            ? navigation.target.route.params
            : "members"
        }
        onMethodChange={(method) => {
          if (!active() || navigation?.signal.aborted) return;
          if (navigation?.target.kind !== "settings") return;
          void ctx.navigation.open(
            { ...navigation.target, route: { version: 1, params: method } },
            { focus: "preserve" },
          );
        }}
      />
    ),
  });
};
