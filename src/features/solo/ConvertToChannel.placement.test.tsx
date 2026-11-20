// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import { coordinate, kitTag, type KitRecord } from "../channel-templates/model";
import { ConvertToChannel } from "./ConvertToChannel";
import { SOLO_LABEL } from "./labels";
import { chatConversion } from "./conversion";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://conversion.test";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
function fixture() {
  const viewer = keypair(),
    relayKey = keypair();
  let clock = 1_700_000_000;
  let labels = [SOLO_LABEL, "label"];
  const original: KitRecord = {
    version: 1,
    community,
    deleted: false,
    value: {
      type: "groups",
      id: "me",
      groups: [{ id: "work", name: "Work", defaultTemplateId: "template" }],
      assignments: { [id]: "work", [other]: "work" },
    },
  };
  const originalEvent = signed(viewer, {
    kind: 30078,
    created_at: clock,
    tags: [
      ["d", coordinate(original)],
      ["t", kitTag(original)],
    ],
    content: JSON.stringify(original),
  });
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9002) {
      labels = event.tags.flatMap(([tag, value]) =>
        tag === "t" && value ? [value] : [],
      );
      clock++;
    }
  });
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: community,
      media: () => undefined,
      query: async (filters) => {
        return [
          metadata(relayKey, id, "Work", clock, [
            ["t", "stream"],
            ...labels.map((label) => ["t", label]),
            ["private"],
            ["about", "Notes"],
            ["P", viewer.pubkey],
            ["ttl", "86400"],
          ]),
          signed(relayKey, {
            kind: 39001,
            created_at: clock,
            content: "",
            tags: [
              ["d", id],
              ["p", viewer.pubkey, "owner"],
            ],
          }),
          signed(relayKey, {
            kind: 39002,
            created_at: clock,
            content: "",
            tags: [
              ["d", id],
              ["p", viewer.pubkey, "", "owner"],
            ],
          }),
          originalEvent,
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: { sign: async (event) => signed(viewer, event), publish },
      decodeSidebarPreferences: async () => ({
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { [id]: "work", [other]: "work" },
        starred: [],
        muted: [],
      }),
      writer: {
        kinds: [30078],
        sign: async (event) => signed(viewer, event),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const close = vi.fn(),
    converted = vi.fn();
  const mount = async () => {
    await owner.session.sidebarPreferences.ensure();
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(
        owner.session.channels
          .list()
          .channels.find((channel) => channel.id === id),
      ).toBeDefined(),
    );
    return render(
      <ConvertToChannel
        session={owner.session}
        id={id}
        close={close}
        onConverted={converted}
      />,
    );
  };
  return {
    session: owner.session,
    publish,
    converted,
    mount,
  };
}
async function submit() {
  const confirm = screen.getByRole("button", { name: "Convert to channel" });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
}
it("converts the label and preserves both conversations’ workspace assignments", async () => {
  const f = fixture();
  await f.mount();
  await submit();
  await waitFor(() => expect(f.converted).toHaveBeenCalledOnce());
  expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([9002]);
  expect(f.publish.mock.calls[0]?.[0].tags).toEqual([
    ["h", id],
    ["name", "Work"],
    ["about", "Notes"],
    ["t", "label"],
  ]);
  expect(f.session.sidebarPreferences.snapshot().data?.assignments).toEqual({
    [id]: "work",
    [other]: "work",
  });
  const details = await f.session.channelDetails.load(id);
  expect(details).toMatchObject({
    name: "Work",
    description: "Notes",
    ttlSeconds: 86400,
    labels: ["label"],
  });
  expect(chatConversion(f.session, id)).toBeUndefined();
});
