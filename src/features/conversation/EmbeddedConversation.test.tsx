// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../messages/composer-testing";
import type { ComposerInputElement } from "../messages/composer-dom";
import { PublishRejected } from "../relay/outbox";
import type { RelayEvent } from "../relay/events";
import { useChannelWindow } from "../relay/react";
import { createRelaySession } from "../relay/session";
import type { RelaySession } from "../relay/session";
import {
  bounds,
  keypair,
  message,
  metadata,
  roster,
  signed,
} from "../relay/testing";
import { ConversationPresentation } from "./ConversationPresentation";
import { EmbeddedConversation } from "./EmbeddedThread";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";

// The host's review viewer has its own suites; this proves which card's review opens.
vi.mock("../messages/MediaReviewViewer", () => ({
  MediaReviewViewer: (props: {
    channelId: string;
    messageId: string;
    close(): void;
  }) => (
    <section aria-label="Media review">
      <p>{`${props.channelId}:${props.messageId}`}</p>
      <button type="button" onClick={props.close}>
        Close review
      </button>
    </section>
  ),
}));

composerDOMFixture();
const owners: ReturnType<typeof createRelaySession>[] = [];
const runtimes: Context[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const owner of owners.splice(0)) owner.dispose();
  for (const root of runtimes.splice(0)) await root.fiber.dispose();
});
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const relay = keypair(),
    viewer = keypair();
  const posts = {
    alpha: message(viewer, "alpha", "Alpha note", 1700000000),
    beta: message(viewer, "beta", "Beta note", 1700000001),
  };
  const publications: {
    event: RelayEvent;
    result: ReturnType<typeof deferred>;
  }[] = [];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      async query(filters) {
        const filter = filters[0];
        assert.exists(filter);
        if (filter.kinds?.includes(39000) || filter.kinds?.includes(39002))
          return (["alpha", "beta"] as const).flatMap((id) => [
            metadata(relay, id, id === "alpha" ? "Alpha" : "Beta"),
            roster(relay, id, [viewer.pubkey]),
          ]);
        if (filter.kinds?.includes(9))
          return (["alpha", "beta"] as const)
            .filter((id) => !filter["#h"] || filter["#h"].includes(id))
            .flatMap((id) => [
              posts[id],
              bounds(relay, id, "head", { has_more: false, next_cursor: null }),
            ]);
        return [];
      },
      writer: {
        kinds: [9, 40003, 5],
        sign: async (template) => signed(viewer, template),
        publish(event) {
          const result = deferred();
          publications.push({ event, result });
          return result.promise;
        },
      },
    },
    {
      readStateFloor: () => 0,
      outboxStorage: { load: () => [], save() {} },
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  owners.push(owner);
  const live = owner.session;
  live.channels.ensureList();
  await waitFor(() => expect(live.channels.list().status).toBe("ready"));
  for (const id of ["alpha", "beta"]) live.channels.ensure(id);
  await waitFor(() => {
    expect(live.channels.window("alpha").rows).toHaveLength(1);
    expect(live.channels.window("beta").rows).toHaveLength(1);
  });
  // The session is frozen, so visit entry points are observed through delegates.
  const reads = {
    enterChannel: vi.fn(live.unread.enterChannel),
    leaveChannel: vi.fn(live.unread.leaveChannel),
    follow: vi.fn(live.unread.follow),
    markMessageRead: vi.fn(live.unread.markMessageRead),
    markChannelRead: vi.fn(live.unread.markChannelRead),
  };
  // An open channel reserves profile room for its roster; a no-visit scope holds none.
  const reserve = vi.fn(
    (members: number) => live.profiles.reserve?.(members) ?? (() => {}),
  );
  const session: RelaySession = {
    ...live,
    unread: { ...live.unread, ...reads },
    profiles: { ...live.profiles, reserve },
  };
  const root = new Context();
  new PluginRuntime(root, async () => ({ apply() {} }));
  runtimes.push(root);
  const service = new ConversationService(root);
  const scope = `wss://fixture.test:${viewer.pubkey}`;
  let connection: { status: string; session: RelaySession; scope: string } = {
    status: "ready",
    session,
    scope,
  };
  const noPanels: never[] = [];
  const host = {
    panels: {
      snapshot: () => noPanels,
      subscribe: () => () => {},
      resolve: () => undefined,
    },
    relay: { snapshot: () => connection },
    navigation: { open: vi.fn() },
  } as unknown as Context;
  const { Message, Composer } = service.ui;

  /** A fictional overview: one card per channel, rows and composer composed by the page. */
  function Card({
    channelId,
    scoped = true,
  }: {
    channelId: "alpha" | "beta";
    scoped?: boolean;
  }) {
    const { rows } = useChannelWindow(session.channels, channelId);
    const content = (
      onOpenMediaReview?: (id: string, attachment: never, at: number) => void,
    ) => (
      <>
        {rows.map((row) => (
          <Message
            key={row.id}
            row={row}
            session={session}
            scope={scope}
            profile={undefined}
            media={() => undefined}
            onOpenLink={() => false}
            day={false}
            retry={undefined}
          />
        ))}
        {onOpenMediaReview && rows[0] && (
          <button
            type="button"
            onClick={() =>
              onOpenMediaReview(
                rows[0]?.id ?? "",
                { url: "https://fixture.test/a.png" } as never,
                0,
              )
            }
          >
            Review media
          </button>
        )}
        <Composer
          session={session}
          scope={scope}
          channelId={channelId}
          channelName={channelId}
          editMessages={rows}
        />
      </>
    );
    // The scope renders recovery notices before its children, so the card frames both.
    return (
      <section aria-label={`Card ${channelId}`}>
        {scoped ? (
          <EmbeddedConversation
            session={session}
            scope={scope}
            channelId={channelId}
            host={host}
            extensions={service}
          >
            {(interactions) => content(interactions.onOpenMediaReview)}
          </EmbeddedConversation>
        ) : (
          content()
        )}
      </section>
    );
  }
  function Overview({
    presented = true,
    scoped = true,
  }: {
    presented?: boolean;
    scoped?: boolean;
  }) {
    return (
      <ConversationPresentation value={presented}>
        <Card channelId="alpha" scoped={scoped} />
        <Card channelId="beta" scoped={scoped} />
      </ConversationPresentation>
    );
  }
  return {
    session,
    service,
    posts,
    reads: { ...reads, reserve },
    publications,
    Overview,
    loseAccess() {
      connection = { ...connection, status: "connecting" };
    },
  };
}

const card = (id: string) =>
  within(screen.getByRole("region", { name: `Card ${id}` }));
async function openMenu(id: string) {
  fireEvent.click(
    card(id).getByRole("button", { name: "More message actions" }),
  );
  return within(await screen.findByRole("menu"));
}
function editor(id: string) {
  return card(id).getByRole<ComposerInputElement>("textbox", {
    name: "Edit message",
  });
}

it("adds native edit and delete to page rows without visiting, reading or following", async () => {
  const h = await fixture();
  const view = render(<h.Overview scoped={false} />);
  const bare = await openMenu("alpha");
  expect(bare.queryByRole("menuitem", { name: "Edit message" })).toBeNull();
  expect(bare.queryByRole("menuitem", { name: "Delete message" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  view.rerender(<h.Overview />);
  for (const id of ["alpha", "beta"]) {
    const menu = await openMenu(id);
    expect(menu.getByRole("menuitem", { name: "Edit message" })).toBeVisible();
    expect(
      menu.getByRole("menuitem", { name: "Delete message" }),
    ).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  view.rerender(<h.Overview presented={false} />);
  view.rerender(<h.Overview />);
  view.unmount();
  await act(async () => {});
  for (const spy of Object.values(h.reads)) expect(spy).not.toHaveBeenCalled();
  expect(h.publications).toHaveLength(0);
});

it("edits into the card's own composer and publishes to that card's channel", async () => {
  const h = await fixture();
  render(<h.Overview />);
  fireEvent.click(
    (await openMenu("beta")).getByRole("menuitem", { name: "Edit message" }),
  );
  await waitFor(() => expect(editor("beta")).toHaveValue("Beta note"));
  expect(
    card("alpha").queryByRole("textbox", { name: "Edit message" }),
  ).toBeNull();
  const field = editor("beta");
  act(() => {
    field.focus();
    field.value = "Beta corrected";
    field.setSelectionRange(14, 14);
  });
  fireEvent.input(field);
  const form = field.closest("form");
  assert.exists(form);
  fireEvent.submit(form);
  await waitFor(() => expect(h.publications).toHaveLength(1));
  const edit = h.publications[0];
  assert.exists(edit);
  expect(edit.event.kind).toBe(40003);
  expect(edit.event.tags).toContainEqual(["h", "beta"]);
  expect(edit.event.tags).toContainEqual(["e", h.posts.beta.id]);
  await act(async () => edit.result.resolve());
  await waitFor(() =>
    expect(h.session.channels.window("beta").rows[0]?.content).toBe(
      "Beta corrected",
    ),
  );
  expect(h.session.channels.window("alpha").rows[0]?.content).toBe(
    "Alpha note",
  );
  for (const spy of Object.values(h.reads)) expect(spy).not.toHaveBeenCalled();
});

it("confirms, cancels, recovers and retries a card's deletion", async () => {
  const h = await fixture();
  render(<h.Overview />);
  fireEvent.click(
    (await openMenu("alpha")).getByRole("menuitem", { name: "Delete message" }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "Delete message?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(h.publications).toHaveLength(0);

  fireEvent.click(
    (await openMenu("alpha")).getByRole("menuitem", { name: "Delete message" }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  await waitFor(() => expect(h.publications).toHaveLength(1));
  const first = h.publications[0];
  assert.exists(first);
  expect(first.event.kind).toBe(5);
  expect(first.event.tags).toContainEqual(["e", h.posts.alpha.id]);
  await act(async () =>
    first.result.reject(new PublishRejected("Deletion refused")),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByText("Close"),
  );
  // Recovery belongs to the card's channel, not every card on the page.
  expect(
    await card("alpha").findByText("Message deletion: Deletion refused"),
  ).toBeVisible();
  expect(card("beta").queryByText(/Message deletion/)).toBeNull();
  fireEvent.click(
    card("alpha").getByRole("button", { name: "Retry message update" }),
  );
  await waitFor(() => expect(h.publications).toHaveLength(2));
  expect(h.publications[1]?.event.id).toBe(first.event.id);
  await act(async () => h.publications[1]?.result.resolve());
  await waitFor(() =>
    expect(card("alpha").queryByText("Alpha note")).toBeNull(),
  );
  expect(card("beta").getByText("Beta note")).toBeVisible();
  for (const spy of Object.values(h.reads)) expect(spy).not.toHaveBeenCalled();
});

it("opens one card's media review over the page and ignores reviews after access loss", async () => {
  const h = await fixture();
  render(<h.Overview />);
  const opener = card("beta").getByRole("button", { name: "Review media" });
  opener.focus();
  fireEvent.click(opener);
  expect(
    screen.getByRole("region", { name: "Media review" }),
  ).toHaveTextContent(`beta:${h.posts.beta.id}`);
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  expect(screen.queryByRole("region", { name: "Media review" })).toBeNull();
  h.loseAccess();
  fireEvent.click(card("beta").getByRole("button", { name: "Review media" }));
  expect(screen.queryByRole("region", { name: "Media review" })).toBeNull();
  for (const spy of Object.values(h.reads)) expect(spy).not.toHaveBeenCalled();
});
