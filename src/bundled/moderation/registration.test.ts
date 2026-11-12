import { provideNavigation } from "../../features/navigation/service";
import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { MEMBERSHIP_SECTION } from "../../features/communities/CommunityPickerItem";
import type { RelayData } from "../../features/relay/service";
import { flush } from "../../features/relay/testing";
import { SettingsCardsService } from "../../features/settings/service";
import { createAdminAccess } from "../admin-access";
import type { CommunityReader } from "../../features/communities/service";
import type { RelayStaffBackend } from "../../features/relay-staff/contract";
import { apply, inject } from "./index";
import manifest from "./manifest.json";

const relayKey = "f".repeat(64);
const owner = "0".repeat(64);

/** A ready connection whose relay-signed roster names the viewer an owner. */
function relay(): RelayData {
  const session = {
    relayAuthor: relayKey,
    subscribeLive: () => () => {},
    read: async () => [
      {
        id: "e".repeat(64),
        kind: 13534,
        pubkey: relayKey,
        created_at: 1,
        content: "",
        sig: "",
        tags: [["-"], ["member", owner, "owner"]],
      },
    ],
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${owner}`,
    viewer: owner,
    session,
  };
  return {
    snapshot: () => value,
    subscribe: () => () => {},
  } as unknown as RelayData;
}

// The community rail addresses this plugin's Membership card by contribution
// key from another module, so a renamed card could leave Invite to community
// pointing at a section that no longer exists while the rail's own tests still
// pass. Resolve the rail's key through the plugin's real registration, the way
// Settings navigation does, under the id the real manifest gives the plugin.
it("registers the Membership card under the key the community rail opens", async () => {
  const root = new Context();
  provideNavigation(root);
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const data = relay();
  root.provide("relay", data);
  const access = createAdminAccess(
    data,
    {
      snapshot: () => ({
        status: "ready",
        selected: "https://primary.example",
        viewer: owner,
      }),
      subscribe: () => () => {},
    } as unknown as CommunityReader,
    { available: false } as RelayStaffBackend,
  );
  root.provide("adminAccess", access);
  const cards = new SettingsCardsService(root);
  const releaseVisibility = cards.retainVisibility();
  const fiber = root
    .extend({ pluginOwner: { id: manifest.id, revision: "one" } })
    .plugin({ name: manifest.id, inject, apply });
  await fiber.await();
  await flush();

  // Navigation reports a section whose visibility is `false` as unavailable,
  // whether it was never registered or the viewer cannot see it.
  await vi.waitFor(() =>
    expect(cards.visibility(MEMBERSHIP_SECTION)).toBe(true),
  );
  expect(
    cards.snapshot().find((card) => card.key === MEMBERSHIP_SECTION),
  ).toMatchObject({
    title: "Membership",
    section: "administration",
    pluginId: manifest.id,
  });

  await fiber.dispose();
  releaseVisibility();
  await root.fiber.dispose();
  access.dispose();
});
