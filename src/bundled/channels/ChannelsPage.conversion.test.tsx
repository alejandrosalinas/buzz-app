import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import type { PageNavigation } from "../../features/navigation/service";
import { keypair, metadata, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChannelsPage } from "./ChannelsPage";
import { SOLO_LABEL } from "../../features/solo/labels";
import type { RelayEvent } from "../../features/relay/events";

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const id = "11111111-1111-4111-8111-111111111111";
const empty: readonly never[] = [];
const contribution = { snapshot: () => empty, subscribe: () => () => {} };
function fixture() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relayKey = keypair();
  let clock = 1_700_000_000;
  let labels = [SOLO_LABEL];
  const sign = vi.fn(async (event: import("nostr-tools").EventTemplate) =>
    signed(viewer, event),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    labels = event.tags.flatMap(([tag, value]) =>
      tag === "t" && value ? [value] : [],
    );
    clock++;
  });
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: "https://conversion.test",
      media: () => undefined,
      query: async (filters) =>
        [
          metadata(relayKey, id, "Work", clock, [
            ["t", "stream"],
            ...labels.map((label) => ["t", label]),
            ["private"],
            ["P", viewer.pubkey],
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
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      channelDetails: { sign, publish },
      writer: { kinds: [9, 9000], sign, publish },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const confirmed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // Hold the capability's return only after the real details owner has admitted
  // signed stream metadata. React must commit that change before completion.
  const save = vi.fn(
    async (...args: Parameters<typeof owner.session.channelDetails.save>) => {
      await owner.session.channelDetails.save(...args);
      reached();
      await held;
    },
  );
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [id]: "g" });
  const unfiledProjects = projects({});
  let filed = true;
  const unfile = vi.fn(async () => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  const session = {
    ...owner.session,
    channelDetails: { ...owner.session.channelDetails, save },
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => (filed ? filedProjects : unfiledProjects),
      refresh: async () => {},
      assign: unfile,
    },
  };
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: session.scope,
    viewer: viewer.pubkey,
    session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    async clearCache() {},
  };
  const visit = new AbortController();
  const navigation: PageNavigation = {
    entryId: "messages-visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: id,
      scope: {
        viewer: viewer.pubkey,
        communityOrigin: "https://conversion.test",
      },
    },
    signal: visit.signal,
    position: () => undefined,
    savePosition() {},
    forSession: () => navigation,
    passThrough: () => () => {},
    complete: () => true,
    resolve: () => true,
  };
  const view = render(
    <StrictMode>
      <ToastProvider>
        <ChannelsPage
          navigator={
            createNavigationController(createMemoryHistory()).navigation
          }
          relay={relay}
          panels={{
            ...contribution,
            register() {},
            resolve: () => undefined,
            requestOpen: () => false,
            handleOpenRequests: () => () => {},
          }}
          navigation={navigation}
        />
      </ToastProvider>
    </StrictMode>,
  );
  return {
    session,
    save,
    unfile,
    sign,
    publish,
    view,
    visit,
    release,
    confirmed,
  };
}
async function openConversion() {
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Chat actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Convert to channel" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Convert to channel",
  });
  const confirm = within(dialog).getByRole("button", {
    name: "Convert to channel",
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  return { user, trigger, dialog, confirm };
}
it("Messages conversion survives signed type replacement, announces completion and focuses the channel composer", async () => {
  const t = fixture();
  const { user, dialog, confirm } = await openConversion();
  try {
    await user.click(confirm);
    await act(async () => {
      await t.confirmed;
    });
    expect(
      screen.getByRole("button", { name: /Manage members of/, hidden: true }),
    ).toBeInTheDocument();
    expect(
      t.session.channels.list().channels.find((channel) => channel.id === id)
        ?.channelType,
    ).toBe("stream");
    expect(dialog).toBeVisible();
    expect(confirm).toBeDisabled();
    expect(screen.queryByText("Converted to channel.")).toBeNull();
  } finally {
    await act(async () => {
      t.release();
    });
  }
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(await screen.findByText("Converted to channel.")).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message Work" })).toHaveFocus(),
  );
  expect(t.sign).toHaveBeenCalledOnce();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("Messages conversion Cancel restores chat actions without publishing", async () => {
  const t = fixture();
  const { user, dialog, trigger } = await openConversion();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(t.publish).not.toHaveBeenCalled();
  t.release();
});
it("a retired Messages visit receives no late conversion completion", async () => {
  const t = fixture();
  const { user, confirm } = await openConversion();
  try {
    await user.click(confirm);
    await act(async () => {
      await t.confirmed;
    });
    act(() => {
      t.visit.abort();
      t.view.unmount();
    });
  } finally {
    await act(async () => {
      t.release();
      await t.save.mock.results[0]?.value;
    });
  }
  expect(screen.queryByText("Converted to channel.")).toBeNull();
  expect(t.publish).toHaveBeenCalledOnce();
});

it("Messages header reopens unfiling recovery after confirmed metadata and a failed project save", async () => {
  const t = fixture();
  t.unfile.mockRejectedValueOnce(new Error("Project save failed"));
  const { user, confirm, dialog } = await openConversion();
  try {
    await user.click(confirm);
    await act(async () => {
      await t.confirmed;
    });
  } finally {
    await act(async () => {
      t.release();
    });
  }
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Project save failed",
  );
  const closeButton = within(dialog)
    .getAllByRole("button", { name: "Close" })
    .at(-1);
  if (!closeButton) throw new Error("Close missing");
  await user.click(closeButton);
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Finish conversion" }),
  );
  const reopened = await screen.findByRole("dialog", {
    name: "Convert to channel",
  });
  await user.click(
    within(reopened).getByRole("button", { name: "Finish conversion" }),
  );
  await waitFor(() => expect(reopened).not.toBeInTheDocument());
  expect(t.unfile).toHaveBeenCalledTimes(2);
  expect(t.publish).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message Work" })).toHaveFocus(),
  );
});
