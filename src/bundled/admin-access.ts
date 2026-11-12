import type { CommunityReader } from "../features/communities/service";
import { communityDestination } from "../features/communities/destination";
import { communityFromScope } from "../features/relay/gifs";
import type { RelayData } from "../features/relay/service";
import type { RelayStaffBackend } from "../features/relay-staff/contract";
import {
  createCommunityMembership,
  canManageMembership,
} from "./moderation/membership";
import { createStaff } from "./relay-staff/staff";

export type AdminAccessState =
  | "allowed"
  | "checking"
  | "denied"
  | "error"
  | "unavailable"
  | "no-community";

/** App-owned access checks outlive plugin activation; navigation and catalog share them. */
export function createAdminAccess(
  relay: RelayData,
  reader: CommunityReader,
  backend: RelayStaffBackend,
) {
  const membership = createCommunityMembership(relay);
  const staff = createStaff(backend, () => {
    const { selected, viewer } = reader.snapshot();
    if (!selected || !viewer) return null;
    try {
      return { relay: communityDestination(selected).url, signer: viewer };
    } catch {
      return null;
    }
  });
  const stop = reader.subscribe(staff.refresh);
  return {
    membership,
    staff,
    subscribe(listener: () => void) {
      const stops = [
        membership.subscribe(listener),
        staff.subscribe(listener),
        reader.subscribe(listener),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    ensure() {
      const releases = [membership.ensure(), staff.ensure()];
      return () => {
        for (const release of releases) release();
      };
    },
    status(id: string): AdminAccessState {
      const client = reader.snapshot();
      if (client.status === "loading") return "checking";
      if (client.status === "unavailable") return "unavailable";
      if (!client.selected) return "no-community";
      if (!client.viewer) return "unavailable";
      if (id === "buzz.relay-staff") return staff.availability();
      const connection = relay.snapshot();
      const state = membership.snapshot();
      if (
        connection.status === "error" ||
        connection.status === "disconnected" ||
        state.error
      )
        return "error";
      if (
        connection.status !== "ready" ||
        state.status === "idle" ||
        state.status === "loading" ||
        state.refreshing
      )
        return "checking";
      if (connection.viewer !== client.viewer || !connection.scope)
        return "checking";
      try {
        if (
          communityFromScope(connection.scope) !==
          communityDestination(client.selected).url
        )
          return "checking";
      } catch {
        return "unavailable";
      }
      if (!state.members) return "unavailable";
      return canManageMembership(state) ? "allowed" : "denied";
    },
    retry(id: string) {
      if (id === "buzz.relay-staff") staff.retry();
      else if (relay.snapshot().status !== "ready" || relay.snapshot().cached)
        relay.tryAgain();
      else void membership.refresh();
    },
    dispose() {
      stop();
      membership.dispose();
      staff.dispose();
    },
  };
}
export type AdminAccess = ReturnType<typeof createAdminAccess>;
export type AdminAccessReader = Pick<
  AdminAccess,
  "subscribe" | "ensure" | "status" | "retry"
>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    adminAccess: AdminAccess;
  }
}
