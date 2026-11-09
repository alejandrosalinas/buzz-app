// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import userEvent from "@testing-library/user-event";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message, profile, signed } from "../relay/testing";
import { MediaReviewViewer } from "./MediaReviewViewer";
import { profileTarget } from "../profiles/target";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});

it("keeps fullscreen comment avatar hints in sync without loading the agent library", async () => {
  const viewer = keypair(),
    marked = keypair(),
    libraryAgent = keypair(),
    envelope = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const tags = [["e", root.id, "", "reply"]];
  const replies = [
    message(viewer, "one", "Human comment", 2, tags),
    message(marked, "one", "Profile agent comment", 3, tags),
    message(libraryAgent, "one", "Library agent comment", 4, tags),
    signed(envelope, {
      kind: 40002,
      content: JSON.stringify({ content: "Envelope agent comment" }),
      created_at: 5,
      tags: [["h", "one"], ...tags],
    }),
  ];
  let identities = [{ pubkey: libraryAgent.pubkey, name: "Library agent" }];
  const readAgentLibrary = vi.fn(async () => ({ definitions: [], identities }));
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(marked, { name: "Profile agent", is_agent: true }),
    profile(libraryAgent, { name: "Library agent" }),
    profile(envelope, { name: "Envelope agent" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    readAgentLibrary,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, ...replies].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return replies.filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor,
          );
        return [];
      });
    },
  });
  owners.push(owner);
  render(
    <StrictMode>
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope="avatar-test"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        onOpenLink={() => false}
        close={() => {}}
      />
    </StrictMode>,
  );
  const avatar = (text: string) =>
    screen
      .getByText(text)
      .closest("[data-message-id]")
      ?.querySelector("[data-avatar-shape]");
  await screen.findByText("Profile agent comment");
  await waitFor(() => {
    expect(avatar("Human comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Profile agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    expect(avatar("Library agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    expect(avatar("Envelope agent comment")).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
  });
  expect(readAgentLibrary).not.toHaveBeenCalled();
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  identities = [];
  await act(() => owner.session.agentLibrary.refresh());
  expect(avatar("Library agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "circle",
  );
  expect(avatar("Profile agent comment")).toHaveAttribute(
    "data-avatar-shape",
    "squircle",
  );
  expect(readAgentLibrary).toHaveBeenCalledTimes(2);
});

it("renders comment mentions as names even though comment links stay inert", async () => {
  const viewer = keypair(),
    tyler = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const replies = [
    message(viewer, "one", "I think @Tyler is looking at that", 2, [
      ["e", root.id, "", "reply"],
      ["p", tyler.pubkey],
    ]),
    // Edits carry mentions as explicit identity links instead of `p` tags.
    message(viewer, "one", `Ask [@Tyler](${profileTarget(tyler.pubkey)})`, 3, [
      ["e", root.id, "", "reply"],
    ]),
  ];
  const profiles = [
    profile(viewer, { name: "Human" }),
    profile(tyler, { name: "Tyler" }),
  ];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(0))
          return profiles.filter((event) =>
            filter.authors?.includes(event.pubkey),
          );
        if (filter.ids)
          return [root, ...replies].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return replies.filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor,
          );
        return [];
      });
    },
  });
  owners.push(owner);
  render(
    <MediaReviewViewer
      attachment={attachment}
      session={owner.session}
      scope="mention-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={() => false}
      close={() => {}}
    />,
  );
  await screen.findByText(/^Ask/);
  const mentions = [...document.querySelectorAll("[data-mention-kind]")];
  expect(mentions.map((mention) => mention.textContent)).toEqual([
    "Tyler",
    "Tyler",
  ]);
  for (const mention of mentions) {
    expect(mention).toHaveAttribute("data-mention-kind", "person");
    expect(mention.tagName).toBe("SPAN");
  }
  expect(
    screen.getByLabelText("Media comments", { selector: "section" }),
  ).not.toHaveTextContent("nostr:");
});

it("opens comments at the reply the reader was viewing behind the review", async () => {
  const viewer = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const replies = [2, 3, 4].map((at) =>
    message(viewer, "one", `Reply ${at}`, at, [["e", root.id, "", "reply"]]),
  );
  const reading = replies[1]?.id;
  // The thread behind the review is scrolled past the root to the second reply.
  const thread = document.createElement("div");
  thread.dataset.messageScroller = "";
  thread.innerHTML = `<div data-message-id="${root.id}"></div><div data-message-id="${reading}"></div>`;
  document.body.append(thread);
  const opener = document.createElement("button");
  thread.append(opener);
  const box = (top: number, bottom = top + 50) =>
    ({
      top,
      bottom,
      left: 0,
      right: 0,
      width: 0,
      height: bottom - top,
    }) as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this === thread) return box(100);
      const id = (this as HTMLElement).dataset?.messageId;
      if (id) return box(id === root.id ? 0 : 90, id === root.id ? 90 : 150);
      if ((this as HTMLElement).dataset?.reviewComment === reading)
        return box(240);
      return box(0, 0);
    },
  );
  const scrollTop = vi.spyOn(Element.prototype, "scrollTop", "set");
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.ids)
          return [root, ...replies].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit)
          return replies.filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor,
          );
        return [];
      });
    },
  });
  owners.push(owner);
  try {
    render(
      <MediaReviewViewer
        attachment={attachment}
        session={owner.session}
        scope="anchor-test"
        channelId="one"
        channelName="One"
        messageId={root.id}
        initialTime={0}
        restoreFocus={{ current: opener }}
        onOpenLink={() => false}
        close={() => {}}
      />,
    );
    await screen.findByText("Reply 4");
    const comments = screen.getByLabelText("Media comments", {
      selector: "section",
    });
    const writes = scrollTop.mock.calls.filter(
      (_, index) => scrollTop.mock.contexts[index] === comments,
    );
    expect(writes).toEqual([[240]]);
  } finally {
    vi.restoreAllMocks();
    thread.remove();
  }
});

it("wires image review links to the viewer host opener", async () => {
  const viewer = keypair();
  const image = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${image.url}`, "m image/png"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  const open = vi.fn(() => true);
  render(
    <MediaReviewViewer
      attachment={image}
      session={owner.session}
      scope="image-open-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={open}
      close={() => {}}
    />,
  );
  const link = await screen.findByRole("link", {
    name: "Open image in browser",
  });
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledWith(image.url);
});

it("excludes generic files from the image review grid", async () => {
  const viewer = keypair();
  const image = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const file = {
    url: "https://fixture.test/report.pdf",
    kind: "file" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${image.url}`, "m image/png"],
    ["imeta", `url ${file.url}`, "m application/pdf"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id)))
        return [root];
      return [];
    },
  });
  owners.push(owner);
  render(
    <MediaReviewViewer
      attachment={image}
      session={owner.session}
      scope="file-grid-test"
      channelId="one"
      channelName="One"
      messageId={root.id}
      initialTime={0}
      onOpenLink={() => false}
      close={() => {}}
    />,
  );
  const imageAttachment = await screen.findByAltText("Attachment preview");
  expect(imageAttachment).toHaveAttribute("src", image.url);
  expect(
    screen.queryByRole("button", { name: "Next image" }),
  ).not.toBeInTheDocument();
});

it("Escape closes media opened from a tab without closing the tab", async () => {
  const user = userEvent.setup();
  const viewer = keypair();
  const attachment = {
    url: "https://fixture.test/image.png",
    kind: "image" as const,
  };
  const root = message(viewer, "one", "Image", 1, [
    ["imeta", `url ${attachment.url}`, "m image/png"],
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      return filters.some((filter) => filter.ids?.includes(root.id))
        ? [root]
        : [];
    },
  });
  owners.push(owner);
  const closeTab = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(false);
    return (
      <PanelWorkspace
        value="one"
        select={() => {}}
        items={[
          {
            id: "one",
            label: "One",
            close: closeTab,
            content: (
              <>
                <button type="button" onClick={() => setOpen(true)}>
                  View image
                </button>
                {open && (
                  <MediaReviewViewer
                    attachment={attachment}
                    session={owner.session}
                    scope="tab-media"
                    channelId="one"
                    channelName="One"
                    messageId={root.id}
                    initialTime={0}
                    onOpenLink={() => false}
                    close={() => setOpen(false)}
                  />
                )}
              </>
            ),
          },
        ]}
      />
    );
  }
  render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: "View image" }));
  expect(
    await screen.findByRole("link", { name: "Open image in browser" }),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(closeTab).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("link", { name: "Open image in browser" }),
  ).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "View image" })).toHaveFocus(),
  );
  expect(screen.getByRole("tab", { name: "One" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(closeTab).toHaveBeenCalledTimes(1);
});
