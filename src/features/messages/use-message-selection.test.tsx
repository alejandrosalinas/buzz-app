// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { MessageManagement } from "./MessageManagement";
import { useMessageEditScope } from "./MessageEditScope";
import { captureSelectedQuote, quoteSelection } from "./selection-quote";
import { selectNewestMessage } from "./message-selection";
import { useMessageSelection } from "./use-message-selection";

afterEach(cleanup);

const message = (id: string, createdAt: number, createdAtMs?: number) =>
  ({ id, createdAt, createdAtMs }) as ChannelMessage;

function List({
  rows,
  session = {} as RelaySession,
  conversationId = "room",
}: {
  rows: readonly ChannelMessage[];
  session?: RelaySession;
  conversationId?: string;
}) {
  const list = useRef<HTMLElement>(null);
  useMessageSelection(list, rows, session, conversationId);
  return (
    <section ref={list} aria-label="Messages">
      {rows.map((row) => (
        <div key={row.id} data-message-id={row.id}>
          <div data-layout="timeline">{row.id}</div>
        </div>
      ))}
    </section>
  );
}

function newestSelected(rows: readonly ChannelMessage[]) {
  const { getByRole } = render(<List rows={rows} />, { reactStrictMode: true });
  expect(selectNewestMessage(getByRole("region", { name: "Messages" }))).toBe(
    true,
  );
  return document.activeElement?.closest<HTMLElement>("[data-message-id]")
    ?.dataset.messageId;
}

it("selects the latest message of a same-second burst by send ms, then id", () => {
  expect(
    newestSelected([message("z", 100, 100_100), message("a", 100, 100_200)]),
  ).toBe("a");
  cleanup();
  expect(newestSelected([message("a", 100), message("b", 100)])).toBe("b");
});

it("keeps a managed quote through outbox settlement but rejects conversation and session replacement", async () => {
  const viewer = keypair(),
    relay = keypair();
  const events = [
    metadata(relay, "room", "Room"),
    roster(relay, "room", [viewer.pubkey]),
  ];
  let accept!: () => void;
  const publication = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const publish = vi.fn(() => publication);
  const createOwner = () =>
    createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope: "https://quote.test",
        media: () => undefined,
        query: async (filters) =>
          events.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        writer: {
          kinds: [9],
          sign: async (template) => signed(viewer, template),
          publish,
        },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
  const first = createOwner(),
    replacement = createOwner();
  const insertQuote = vi.fn(() => true);
  const source = { ...message("a".repeat(64), 100), channelId: "room" };
  const rows = [source];
  function Draft() {
    const scope = useMessageEditScope();
    return (
      <textarea
        aria-label="Draft"
        ref={(input) => {
          if (scope) scope.input.current = input;
          if (input) Object.assign(input, { insertQuote });
        }}
      />
    );
  }
  function Surface({
    session,
    conversationId = "room",
  }: {
    session: RelaySession;
    conversationId?: string;
  }) {
    return (
      <MessageManagement
        session={session}
        channelId={conversationId}
        active={false}
      >
        <List rows={rows} session={session} conversationId={conversationId} />
        <Draft />
      </MessageManagement>
    );
  }
  try {
    first.session.channels.ensureList();
    await waitFor(() =>
      expect(first.session.channels.list().status).toBe("ready"),
    );
    const view = render(<Surface session={first.session} />, {
      reactStrictMode: true,
    });
    const element = view.getByRole("region", { name: "Messages" });
    const capture = () => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("[data-layout]") as Node);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      const quote = captureSelectedQuote();
      expect(quote?.list.canQuote()).toBe(true);
      return quote;
    };
    const quote = capture();
    let id = "";
    act(() => {
      id = first.session.messages.send("room", "Unrelated send");
    });
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await act(async () => accept());
    await waitFor(() =>
      expect(
        first.session.outbox?.snapshot().find((item) => item.event.id === id)
          ?.delivery,
      ).toBe("accepted"),
    );
    expect(quoteSelection(quote)).toBe(true);
    expect(insertQuote).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(source.id),
      [`buzz://message?channel=room&id=${source.id}`],
    );
    const oldConversation = capture();
    view.rerender(<Surface session={first.session} conversationId="other" />);
    expect(element.isConnected).toBe(true);
    expect(quoteSelection(oldConversation)).toBe(false);
    const oldSession = capture();
    view.rerender(
      <Surface session={replacement.session} conversationId="other" />,
    );
    expect(replacement.session.scope).toBe(first.session.scope);
    expect(element.isConnected).toBe(true);
    expect(quoteSelection(oldSession)).toBe(false);
    expect(insertQuote).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    document.getSelection()?.removeAllRanges();
    first.dispose();
    replacement.dispose();
  }
});

it("selects the latest message across seconds and skips membership notices", () => {
  const notice = {
    ...message("notice", 300),
    membership: {},
  } as ChannelMessage;
  expect(
    newestSelected([message("old", 100), message("new", 200), notice]),
  ).toBe("new");
});
