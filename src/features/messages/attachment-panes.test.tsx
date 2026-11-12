import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { File as NodeFile } from "node:buffer";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useRef, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelsPage } from "../../bundled/channels/ChannelsPage";
import type { PageNavigation } from "../navigation/service";
import { conversationTarget } from "../channel-navigation/routes";
import { SOLO_LABEL } from "../solo/labels";
import { createRelaySession } from "../relay/session";
import { bounds, keypair, message, roster, signed } from "../relay/testing";
import { MessageComposer } from "./MessageComposer";
import { MediaReviewViewer } from "./MediaReviewViewer";
import { composerDOMFixture } from "./composer-testing";
import { useFileDrop, useRejectUnclaimedDrops } from "./use-file-drop";

composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const empty: readonly never[] = [];
const contributions = { snapshot: () => empty, subscribe: () => () => {} };
const extensions = { tools: contributions, inline: contributions };
const image = { kind: "image" as const, url: "https://fixture.test/image.png" };
const file = () =>
  new NodeFile(["notes"], "notes.txt", {
    type: "text/plain",
  }) as unknown as File;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(archived = false) {
  // jsdom has no layout observer; these assertions concern event ownership, not geometry.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    relay = keypair();
  const root = message(
    viewer,
    "11111111-1111-4111-8111-111111111111",
    "Image",
    1,
    [["imeta", `url ${image.url}`, "m image/png"]],
  );
  const comment = message(
    viewer,
    "11111111-1111-4111-8111-111111111111",
    "Existing review comment",
    2,
    [["e", root.id, "", "reply"]],
  );
  const membership = roster(relay, "11111111-1111-4111-8111-111111111111", [
    viewer.pubkey,
  ]);
  const channel = signed(relay, {
    kind: 39000,
    content: "",
    tags: [
      ["d", "11111111-1111-4111-8111-111111111111"],
      ["name", "Work"],
      ["t", "stream"],
      ["private"],
      ["t", SOLO_LABEL],
      ...(archived ? [["archived", "true"]] : []),
    ],
  });
  const uploaded = {
    name: "notes.txt",
    type: "text/plain",
    size: 5,
    sha256: "a".repeat(64),
    url: `https://fixture.test/media/${"a".repeat(64)}.txt`,
  };
  const upload = vi.fn(async (_file: File, _signal: AbortSignal) => uploaded);
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://fixture.test",
      media: (url) => url,
      uploadAttachment: upload,
      query: async (filters) =>
        filters.flatMap((filter) => {
          if (filter.kinds?.some((kind) => kind === 39000 || kind === 39002))
            return [channel, membership];
          if (filter.ids)
            return [root, comment].filter((event) =>
              filter.ids?.includes(event.id),
            );
          if (filter.top_level)
            return [
              root,
              bounds(relay, "11111111-1111-4111-8111-111111111111", "head", {
                has_more: false,
                next_cursor: null,
              }),
            ];
          if (filter.depth_limit)
            return filter.thread_cursor === undefined ||
              filter.thread_cursor < comment.created_at
              ? [comment]
              : [];
          return [];
        }),
      writer: {
        kinds: [9],
        sign: async (event) => signed(viewer, event),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  await waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(1),
  );
  const scope = `https://fixture.test:${viewer.pubkey}`;
  const snapshot = {
    status: "ready" as const,
    generation: 0,
    scope,
    session: owner.session,
    viewer: viewer.pubkey,
  };
  const relayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: owner.clearCache,
  };
  return { owner, scope, relayData, upload, uploaded, root };
}
function OuterComposer({
  children,
  attach,
}: {
  children: ReactNode;
  attach(files: readonly File[]): void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  useFileDrop(ref, true, attach);
  useRejectUnclaimedDrops();
  return (
    <div data-attachment-drop-zone="">
      <form ref={ref} aria-label="Other composer" />
      {children}
    </div>
  );
}
function drop(target: HTMLElement, type: "drop" | "dragOver" = "drop") {
  const transfer = {
    types: ["Files"],
    files: [file()],
    dropEffect: "uninitialized",
  };
  const event = createEvent[type](target, {
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return { event, transfer };
}

it.each([false, true])(
  "the production Solo timeline owns drops and rejects an unavailable composer (archived=%s)",
  async (archived) => {
    const h = await fixture(archived);
    const relayData = h.relayData;
    const navigation: PageNavigation = {
      entryId: "visit",
      target: conversationTarget(
        h.scope,
        "11111111-1111-4111-8111-111111111111",
      ),
      signal: new AbortController().signal,
      position: () => undefined,
      savePosition() {},
      forSession: () => navigation,
      passThrough: () => () => {},
      complete: () => true,
      resolve: () => true,
    };
    const other = vi.fn();
    render(
      <StrictMode>
        <OuterComposer attach={other}>
          <ChannelsPage
            navigator={
              createNavigationController(createMemoryHistory()).navigation
            }
            panels={{
              snapshot: () => empty,
              subscribe: () => () => {},
              register() {},
              resolve: () => undefined,
              requestOpen: () => false,
              handleOpenRequests: () => () => {},
            }}
            relay={relayData}
            extensions={extensions}
            navigation={navigation}
          />
        </OuterComposer>
      </StrictMode>,
    );
    const timeline = await screen.findByLabelText("Channel message history");
    if (archived) {
      expect(
        screen.queryByRole("form", { name: "Send a message to Work" }),
      ).toBeNull();
      expect(
        screen.getByRole("region", { name: "Archived chat" }),
      ).toHaveTextContent("This chat is archived");
    } else {
      const form = screen.getByRole("form", { name: "Send a message to Work" });
      await waitFor(() =>
        expect(
          within(form).getByRole("button", { name: "Attach files" }),
        ).toBeEnabled(),
      );
    }
    expect(timeline.closest("form")).toBeNull();
    const over = drop(timeline, "dragOver");
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe(archived ? "none" : "copy");
    expect(drop(timeline).event.defaultPrevented).toBe(true);
    if (archived) {
      expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
      expect(h.upload).not.toHaveBeenCalled();
    } else {
      const form = screen.getByRole("form", { name: "Send a message to Work" });
      await waitFor(() =>
        expect(
          within(form).getByRole("status", { name: "" }),
        ).toHaveTextContent("notes.txt: 1 KB · Ready"),
      );
      expect(h.upload).toHaveBeenCalledTimes(1);
    }
    expect(other).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "the portaled media comments own drops, including when their composer is absent (unavailable=%s)",
  async (unavailable) => {
    const h = await fixture();
    const other = vi.fn();
    const session = unavailable
      ? {
          ...h.owner.session,
          thread() {
            throw new Error("Unavailable review");
          },
        }
      : h.owner.session;
    const view = render(
      <StrictMode>
        <OuterComposer attach={other}>
          <MediaReviewViewer
            attachment={image}
            session={session}
            scope={h.scope}
            channelId="11111111-1111-4111-8111-111111111111"
            channelName="Work"
            messageId={h.root.id}
            initialTime={0}
            close={() => {}}
            onOpenLink={() => false}
          />
        </OuterComposer>
      </StrictMode>,
    );
    const pane = await screen.findByRole("complementary", {
      name: "Media comments",
    });
    expect(view.container.contains(pane)).toBe(false); // Actual document.body portal.
    const target = unavailable
      ? within(pane).getByText("Error: Unavailable review")
      : await within(pane).findByText("Existing review comment");
    expect(target.closest("form")).toBeNull();
    if (!unavailable)
      await waitFor(() =>
        expect(
          within(pane).getByRole("button", { name: "Attach files" }),
        ).toBeEnabled(),
      );
    const over = drop(target, "dragOver");
    expect(over.event.defaultPrevented).toBe(true);
    expect(over.transfer.dropEffect).toBe(unavailable ? "none" : "copy");
    expect(drop(target).event.defaultPrevented).toBe(true);
    if (unavailable) {
      expect(pane.querySelector("form")).toBeNull();
      expect(h.upload).not.toHaveBeenCalled();
    } else {
      await waitFor(() =>
        expect(
          within(pane).getByRole("status", { name: "" }),
        ).toHaveTextContent("notes.txt: 1 KB · Ready"),
      );
      expect(h.upload).toHaveBeenCalledTimes(1);
    }
    expect(other).not.toHaveBeenCalled();
  },
);

it("announces eager preparation, then background upload after Send, while editor focus stays put", async () => {
  const h = await fixture();
  const header = deferred<ArrayBuffer>();
  const upload = deferred<typeof h.uploaded>();
  h.upload.mockImplementation(() => upload.promise);
  const source = file();
  vi.spyOn(source, "slice").mockReturnValue({
    arrayBuffer: () => header.promise,
  } as Blob);
  render(
    <MessageComposer
      session={h.owner.session}
      scope={h.scope}
      channelId="11111111-1111-4111-8111-111111111111"
      channelName="Work"
    />,
  );
  const editor = screen.getByRole("textbox");
  editor.focus();
  fireEvent.paste(editor, {
    clipboardData: { items: [{ kind: "file", getAsFile: () => source }] },
  });
  const status = screen.getByRole("status", { name: "" });
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(status).toHaveTextContent("notes.txt: 1 KB · Preparing…");
  expect(editor).toHaveFocus();
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toBeEnabled();
  expect(h.upload).not.toHaveBeenCalled();

  fireEvent.click(send);
  // The file leaves the composer; the background pill announces its phases.
  await waitFor(() => expect(status).not.toBeInTheDocument());
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
    /^Preparing upload to Work$/,
  );
  expect(editor).toHaveFocus();
  await act(async () => {
    header.resolve(new ArrayBuffer(0));
  });
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
    /^Uploading to Work$/,
  );
  expect(editor).toHaveFocus();
  await act(async () => {
    upload.resolve(h.uploaded);
  });
  await waitFor(() =>
    expect(screen.queryByRole("status", { name: "" })).toBeNull(),
  );
  expect(editor).toHaveFocus();
  expect(
    screen.queryByRole("region", { name: "Attachments" }),
  ).not.toBeInTheDocument();
});
