// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, assert, expect, it, vi } from "vitest";
import { readSnapshot } from "../../features/agents/agent-share";
import { agentAvatars } from "../../features/agents/avatar-packs";
import foilTextureUrl from "../../features/agents/assets/card-foil.webp";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentShareDialog } from "./AgentShareDialog";

const desktop = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.tauri,
  invoke: desktop.invoke,
}));

const bea = { pubkey: "b".repeat(64), name: "Bea" };
const cy = { pubkey: "c".repeat(64), name: "Cy" };
const design = {
  id: "d".repeat(36),
  name: "design",
  channelType: "stream",
  members: ["f".repeat(64)],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom has no object URLs; the preview only needs a name for its image.
URL.createObjectURL ??= () => "blob:card";
URL.revokeObjectURL ??= () => {};

/** A 1×1 PNG, as a canvas that draws would give back. */
const PIXEL = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** Lets the card draw, as jsdom's canvas can't; says what text it drew. */
function drawable() {
  const text: string[] = [];
  const context = new Proxy(
    {},
    {
      get: (_, key) =>
        key === "measureText"
          ? (value: string) => ({ width: value.length * 10 })
          : key === "createLinearGradient"
            ? () => ({ addColorStop() {} })
            : key === "fillText"
              ? (value: string) => text.push(value)
              : () => {},
      set: () => true,
      has: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob([PIXEL], { type: "image/png" })),
  );
  vi.stubGlobal(
    "Path2D",
    class {
      moveTo() {}
      arc() {}
      rect() {}
    },
  );
  return text;
}

/** Export's preview, once the card is drawn. */
const saveCard = async () => {
  const save = await screen.findByRole("button", { name: "Save card" });
  await vi.waitFor(() => expect(save).toBeEnabled());
  return save;
};

const owner = "f".repeat(64);
const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
};
const echo = {
  key: "test/echo",
  title: "Echo",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;

/** A community whose catalog holds the heads its outbox accepted. */
let communities = 0;
function community() {
  const heads: EventData[] = [];
  const listeners = new Set<() => void>();
  let pending: { event: EventData; delivery: string } | undefined;
  // Messages the outbox holds, kept across reloads as the journal is.
  const journal: {
    event: EventData;
    delivery: string;
    recovery?: { key: string; value: string } | undefined;
  }[] = [];
  const outbox = {
    supports: (kind: number) => kind === 30175,
    ready: async () => {},
    send: vi.fn((input: Pick<EventData, "kind" | "content" | "tags">) => {
      const event = {
        ...input,
        id: String(heads.length + 1).repeat(64),
        pubkey: owner,
        created_at: heads.length + 1,
      } as EventData;
      pending = { event, delivery: "sending" };
      return event.id;
    }),
    snapshot: () => [...journal, ...(pending ? [pending] : [])],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // As the outbox does: a receipt is let go once delivered, and removed
    // by hand only once it has definitively failed.
    acknowledge: vi.fn(async (id: string) => {
      const at = journal.findIndex((item) => item.event.id === id);
      const item = journal[at];
      if (!item?.recovery) return;
      if (item.delivery !== "accepted" && item.delivery !== "seen")
        throw new Error("Confirm delivery before completing this message");
      journal.splice(at, 1);
    }),
    dismiss: vi.fn(async (id: string) => {
      const at = journal.findIndex((item) => item.event.id === id);
      if (journal[at]?.recovery && journal[at]?.delivery !== "failed")
        throw new Error(
          "Confirm this message in New message before removing it",
        );
      if (at >= 0) journal.splice(at, 1);
    }),
  };
  /** The relay accepts what was sent. */
  const accept = () => {
    if (pending) heads.push(pending.event);
    pending = undefined;
    for (const listener of listeners) listener();
  };
  /** The relay never answers, whether or not it `landed`. */
  const lose = (landed: boolean) => {
    if (!pending) return;
    if (landed) heads.push(pending.event);
    pending = { ...pending, delivery: "unknown" };
    for (const listener of listeners) listener();
  };
  const read = vi.fn(async () => [...heads]);
  const channels = { channels: [design] };
  const directMessages = {
    available: true,
    people: vi.fn(async () => ({
      people: [
        bea,
        cy,
        { pubkey: "e".repeat(64), name: "Echo", isAgent: true },
      ],
      hasMore: false,
    })),
    open: vi.fn(async ([pubkey]: string[]) => `dm-${pubkey?.[0]}`),
    delivered: vi.fn(
      async (_id: string, _channel: string, _signal?: AbortSignal) => {},
    ),
    delivery: vi.fn((_id: string) => "accepted"),
  };
  const attachments = {
    upload: vi.fn(async (file: File, _channel: string) => ({
      name: file.name,
      url: "https://media.example/ada.agent.png",
      type: file.type,
      size: file.size,
      sha256: "0".repeat(64),
    })),
  };
  const messages = {
    send: vi.fn(
      (
        channel: string,
        _content: string,
        _mentions: string[],
        _attachments: unknown[],
        recovery?: { key: string; value: string },
      ) => {
        const again = journal.filter((item) =>
          item.event.id.startsWith(`sent-${channel}`),
        ).length;
        const id = `sent-${channel}${again ? `-${again}` : ""}`;
        journal.push({
          event: { id, kind: 9, tags: [["h", channel]] } as EventData,
          delivery: "unknown",
          recovery,
        });
        return id;
      },
    ),
  };
  return {
    session: {
      read,
      outbox,
      viewer: owner,
      // Each test's community is its own.
      scope: `https://relay${++communities}.example ${owner}`,
      directMessages: {
        ...directMessages,
        // Confirming follows the outbox, which records the delivery.
        delivered: async (id: string, channel: string, signal: AbortSignal) => {
          await directMessages.delivered(id, channel, signal);
          const item = journal.find((entry) => entry.event.id === id);
          if (item) item.delivery = "accepted";
        },
      },
      attachments,
      messages,
      channels: {
        list: () => channels,
        subscribeList: () => () => {},
      },
      media: (url: string) => url,
    } as unknown as RelaySession,
    heads,
    outbox,
    journal,
    accept,
    lose,
    read,
    directMessages,
    attachments,
    messages,
  };
}

function share(
  session: RelaySession,
  overrides: Partial<Agent> = {},
  type: RegisteredAgentType = echo,
) {
  return render(
    <AgentShareDialog
      agent={{ ...agent, ...overrides }}
      type={type}
      session={session}
      onClose={() => {}}
    />,
    { wrapper: ToastProvider },
  );
}

/** The Marketplace switch, once the listing has been read. */
async function listing() {
  const toggle = await screen.findByRole("switch", {
    name: /^Publish(ed)? to Marketplace$/,
  });
  await vi.waitFor(() =>
    expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
  );
  return toggle;
}

/** A person or channel among the results, ready to choose. */
const choice = (name: string) =>
  screen.findByRole("button", { name, pressed: false });

/** The footer's export, which saves an image unless JSON is chosen. */
const exportButton = (name = "Ada") =>
  screen.getByRole("button", { name: `Export ${name} as an agent card` });

const sharedContent = JSON.stringify({
  display_name: "Ada",
  system_prompt: "Review pull requests.",
  acp_command: "buzz-acp",
  runtime: "echo",
  model: "echo-1",
});

const LISTING_NOTE =
  "Anyone in this community can add a copy, instructions included. Memories and chats stay with you.";
const toggle = () =>
  screen.getByRole("switch", { name: /^Publish(ed)? to Marketplace$/ });
/** Done applies what the switch asks for. */
const done = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Done" }));

it("publishes on Done when switched on, and removes what it published when switched off", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept } = community();
  const onClose = vi.fn();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    await within(screen.getByRole("dialog", { name: "Share Ada" })).findByText(
      LISTING_NOTE,
    ),
  ).toBeInTheDocument();
  await user.click(await listing());
  // The switch only asks; nothing is published until Done.
  expect(toggle()).toBeChecked();
  expect(toggle()).toHaveAccessibleName("Publish to Marketplace");
  expect(outbox.send).not.toHaveBeenCalled();
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  // The switch shows what it asked for while the relay answers.
  expect(toggle()).toBeChecked();
  expect(toggle()).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Publishing…")).toBeInTheDocument();
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
    },
    undefined,
    expect.any(Function),
  );
  expect(onClose).not.toHaveBeenCalled();
  accept();
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  // Coming back, it says what it is.
  expect(toggle()).toBeChecked();
  expect(toggle()).toHaveAccessibleName("Published to Marketplace");

  await user.click(await listing());
  expect(outbox.send).toHaveBeenCalledTimes(1);
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Removing…")).toBeInTheDocument();
  // Removing replaces the shared head with what it shared.
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [["d", agent.pubkey]],
      supersedes: 1,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await screen.findByText("Removed Ada from the Marketplace."),
  ).toBeInTheDocument();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(toggle()).not.toBeChecked();
});

it("closes on Done without publishing when the switch is unchanged", async () => {
  const user = userEvent.setup();
  const { session, outbox } = community();
  const onClose = vi.fn();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  // Switched on and back off is no change.
  await user.click(await listing());
  await user.click(toggle());
  await done(user);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(outbox.send).not.toHaveBeenCalled();
});

it("opens a published agent in the Marketplace from its toast", async () => {
  const user = userEvent.setup();
  const { session, accept } = community();
  const onViewListing = vi.fn();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onViewListing={onViewListing}
      onClose={() => {}}
    />,
    { wrapper: ToastProvider },
  );
  await user.click(await listing());
  await done(user);
  accept();
  await screen.findByText("Published Ada to the Marketplace.");
  // A toast captures the pointer, which jsdom lacks; click it directly.
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  expect(onViewListing).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: `${owner}:${agent.pubkey}`,
      name: "Ada",
      instructions: "Review pull requests.",
    }),
  );
});

it("says up front why an agent can't be shared, before anything is sent", async () => {
  const { session, outbox, read } = community();
  share(session, {
    config: { instructions: "password: hunter2hunter2", model: "" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Ada can’t be shared. Portable configuration appears to contain a credential. Remove it before sharing or exporting.",
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await screen.findByText(LISTING_NOTE);
  expect(toggle()).toHaveAttribute("aria-disabled", "true");
  expect(exportButton()).toBeDisabled();
  expect(await choice("Bea")).toBeDisabled();
  expect(outbox.send).not.toHaveBeenCalled();
});

it("asks the relay what an unanswered publish did before saying it failed", async () => {
  const user = userEvent.setup();
  const { session, outbox, lose } = community();
  share(session);
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  lose(true);
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  // The switch keeps what was asked for, so Done tries again.
  expect(await listing()).not.toBeChecked();
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(3));
});

/** Publishes Ada, then switches the listing off. */
async function publishThenRemove(
  user: ReturnType<typeof userEvent.setup>,
  { outbox, accept }: ReturnType<typeof community>,
) {
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  accept();
  await screen.findByText("Published Ada to the Marketplace.");
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
}

it("says removing failed when a newer shared head wins over the accepted one", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenRemove(user, fixture);
  // Another device shared it again, later, before this removal landed.
  const shared = fixture.heads[0];
  if (shared)
    fixture.heads.push({ ...shared, id: "9".repeat(64), created_at: 99 });
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  expect(await listing()).not.toBeChecked();
});

it("keeps the confirmed state when the relay cannot say which head won", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenRemove(user, fixture);
  fixture.read.mockRejectedValueOnce(new Error("offline"));
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  expect(await listing()).not.toBeChecked();
});

it("reads the listing again after the first read fails, leaving Export usable", async () => {
  const user = userEvent.setup();
  const { session, read } = community();
  read.mockRejectedValueOnce(new Error("offline"));
  share(session);
  expect(
    await screen.findByText("Couldn’t check the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: /^Publish(ed)? to Marketplace$/ }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(exportButton()).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await listing();
  expect(
    screen.queryByText("Couldn’t check the Marketplace."),
  ).not.toBeInTheDocument();
});

it("exports the agent as an .agent.json snapshot", async () => {
  const user = userEvent.setup();
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:snapshot";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Ada.agent.json");
      expect(this.href).toBe("blob:snapshot");
    });
  share(community().session);
  await user.click(
    screen.getByRole("button", { name: "Choose an export format" }),
  );
  // The menu says what an agent card is before offering the backup format.
  expect(
    await screen.findByText(
      "An agent card is an image that holds the agent’s setup, so anyone can add it to Buzz.",
    ),
  ).toBeInTheDocument();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "JSON file" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Export Ada as a JSON file" }),
  );
  expect(await screen.findByText("Saved Ada.")).toBeInTheDocument();
  expect(click).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await blobs[0]?.text()) ?? "")).toEqual({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Ada",
      systemPrompt: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    },
    profile: { displayName: "Ada" },
    memory: { level: "none", entries: [] },
  });
  click.mockRestore();
});

it("shows the card and what it does before exporting it", async () => {
  const user = userEvent.setup();
  const text = drawable();
  share(community().session);
  await user.click(exportButton());
  expect(
    await screen.findByRole("dialog", { name: "Export Ada" }),
  ).toHaveAccessibleDescription(
    "Anyone with this card can add Ada, instructions and settings included. Memories and chats stay with you.",
  );
  expect(
    await screen.findByRole("img", { name: "Ada’s agent card" }),
  ).toBeInTheDocument();
  // Its name and stats; the echo type has no summary, so its default model.
  expect(text).toEqual(
    expect.arrayContaining([
      "BUZZ AGENT",
      "ADA",
      "HARNESS",
      "Echo",
      "MODEL",
      "Default",
    ]),
  );
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("dialog", { name: "Share Ada" }),
  ).toBeInTheDocument();
  expect(exportButton()).toBeEnabled();
  // Escape leaves the preview for sharing rather than closing Share.
  await user.click(exportButton());
  await screen.findByRole("dialog", { name: "Export Ada" });
  await user.keyboard("{Escape}");
  expect(
    await screen.findByRole("dialog", { name: "Share Ada" }),
  ).toBeInTheDocument();
});

it("names the model the agent runs, even when it is the harness's default", async () => {
  const user = userEvent.setup();
  const text = drawable();
  // Nothing chosen: the harness reports the model it runs by default.
  const models = vi.fn(async () => ({
    current: "echo-pro",
    models: [{ id: "echo-pro", label: "Echo Pro 2", efforts: [] }],
  }));
  share(community().session, {}, {
    ...echo,
    summary: () => "Echo",
    models,
  } as RegisteredAgentType);
  await user.click(exportButton());
  await screen.findByRole("img", { name: "Ada’s agent card" });
  expect(text).toEqual(expect.arrayContaining(["MODEL", "Pro 2"]));
  expect(text).not.toContain("Default");
});

it("says when the card can't be drawn, and draws it again", async () => {
  const user = userEvent.setup();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  share(community().session);
  await user.click(exportButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t draw the card.",
  );
  // Saving still keeps the agent's setup, without the card's artwork, and a
  // save that fails too says why beside the card's own warning.
  desktop.tauri = true;
  desktop.invoke.mockRejectedValueOnce(new Error("Disk full."));
  try {
    await user.click(screen.getByRole("button", { name: "Save card" }));
    await vi.waitFor(() =>
      expect(
        screen.getAllByRole("alert").map((alert) => alert.textContent),
      ).toEqual([
        expect.stringContaining("Couldn’t draw the card."),
        expect.stringContaining("Couldn’t export Ada."),
      ]),
    );
  } finally {
    desktop.tauri = false;
  }
  drawable();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  // Focus waits on Back while the card is drawn again, then moves to Save.
  expect(
    await screen.findByRole("img", { name: "Ada’s agent card" }),
  ).toBeInTheDocument();
  expect(await saveCard()).toBeEnabled();
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Save card" })).toHaveFocus(),
  );
});

it("shows only the latest agent's card, and lets go of each card it replaces", async () => {
  const user = userEvent.setup();
  drawable();
  // Each drawing waits until released, in the order they began.
  const held: ((blob: Blob | null) => void)[] = [];
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((done) => {
    held.push(done);
  });
  // Each card's link names its size, so the old drawing tells from the new.
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation((blob) => `blob:${(blob as Blob).size}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const stale = new Blob(["old"], { type: "image/png" });
  const card = (bytes: BlobPart) => new Blob([bytes], { type: "image/png" });
  const { session } = community();
  const view = share(session);
  const edit = (instructions: string) =>
    view.rerender(
      <AgentShareDialog
        agent={{ ...agent, config: { model: "echo-1", instructions } }}
        type={echo}
        session={session}
        onClose={() => {}}
      />,
    );
  await user.click(exportButton());
  await vi.waitFor(() => expect(held).toHaveLength(1));
  // The agent changes while its first card is still being drawn, and that
  // drawing finishes after the second began.
  edit("Review pull requests and docs.");
  await vi.waitFor(() => expect(held).toHaveLength(2));
  held[0]?.(stale);
  held[1]?.(card(PIXEL));
  expect(
    await screen.findByRole("img", { name: "Ada’s agent card" }),
  ).toHaveAttribute("src", `blob:${PIXEL.length}`);
  expect(create).toHaveBeenCalledOnce();
  // A later change replaces the shown card, letting go of the old one.
  edit("Review everything.");
  await vi.waitFor(() =>
    expect(revoke).toHaveBeenCalledWith(`blob:${PIXEL.length}`),
  );
  await vi.waitFor(() => expect(held).toHaveLength(3));
  held[2]?.(card(new Uint8Array([...PIXEL, 0])));
  expect(
    await screen.findByRole("img", { name: "Ada’s agent card" }),
  ).toHaveAttribute("src", `blob:${PIXEL.length + 1}`);
  // Closing lets go of the last.
  view.unmount();
  expect(revoke).toHaveBeenLastCalledWith(`blob:${PIXEL.length + 1}`);
});

it("stops saving, and says why, when the agent can't be shared while previewed", async () => {
  const user = userEvent.setup();
  drawable();
  const { session } = community();
  const view = share(session);
  await user.click(exportButton());
  expect(await saveCard()).toBeEnabled();
  // Its synced configuration becomes unavailable while the preview is open.
  view.rerender(
    <AgentShareDialog
      agent={{ ...agent, configProblem: "Its configuration is unavailable." }}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ada can’t be shared. Its configuration is unavailable.",
  );
  expect(screen.getByRole("button", { name: "Save card" })).toBeDisabled();
});

it("names a desktop export so every platform accepts it", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockClear();
  try {
    const names: [string, string][] = [
      ["Con", "Con-agent.agent.png"],
      ["lpt1", "lpt1-agent.agent.png"],
      ["Console", "Console.agent.png"],
      ["x".repeat(128), `${"x".repeat(64)}.agent.png`],
    ];
    drawable();
    for (const [name, file] of names) {
      share(community().session, { name });
      await user.click(exportButton(name));
      await user.click(await saveCard());
      expect(
        await screen.findByText(`Saved an agent card for ${name}.`),
      ).toBeInTheDocument();
      expect(desktop.invoke.mock.lastCall?.[2]).toEqual({
        headers: { "x-buzz-file-name": file },
      });
      cleanup();
    }
  } finally {
    desktop.tauri = false;
  }
});

it("exports without the picture when it does not load in time", async () => {
  desktop.tauri = true;
  desktop.invoke.mockClear();
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = () =>
        this.src === foilTextureUrl
          ? Promise.reject(new Error("not drawn in jsdom"))
          : new Promise(() => {});
    },
  );
  drawable();
  try {
    share(community().session, { picture: "https://media.example/ada.png" });
    // Only the wait for the picture runs on a controlled clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(exportButton());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByRole("status")).toHaveTextContent("Drawing the card…");
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    await vi.advanceTimersByTimeAsync(3999);
    expect(screen.getByRole("button", { name: "Save card" })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    fireEvent.click(await saveCard());
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledOnce());
    expect(
      await readSnapshot(new Blob([desktop.invoke.mock.calls[0]?.[1]])),
    ).toMatchObject({ name: "Ada", picture: "https://media.example/ada.png" });
  } finally {
    desktop.tauri = false;
    vi.useRealTimers();
  }
});

it("draws pack art from the app's own copy, since its CDN can't be read back", async () => {
  const pack = agentAvatars[0];
  if (!pack?.preview) throw new Error("Bundled avatar catalog is empty");
  const sources: string[] = [];
  vi.stubGlobal(
    "Image",
    class {
      crossOrigin = "";
      set src(value: string) {
        if (value) sources.push(value);
      }
      decode = () => Promise.reject(new Error("not drawn in jsdom"));
    },
  );
  drawable();
  share(community().session, { picture: `${pack.url}#buzz-anim=x` });
  fireEvent.click(exportButton());
  fireEvent.click(await saveCard());
  expect(
    await screen.findByText("Saved an agent card for Ada."),
  ).toBeInTheDocument();
  expect(sources).toEqual([pack.preview, foilTextureUrl]);
});

it("saves an .agent.png natively on desktop, never through a blob link", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockResolvedValueOnce("/Users/ada/Downloads/Ada.agent.png");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
  try {
    drawable();
    share(community().session);
    await user.click(exportButton());
    await user.click(await saveCard());
    // Desktop says where the file went.
    expect(
      await screen.findByText(
        "Saved an agent card for Ada to /Users/ada/Downloads/Ada.agent.png.",
      ),
    ).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    expect(desktop.invoke).toHaveBeenCalledOnce();
    const [command, bytes, options] = desktop.invoke.mock.calls[0] ?? [];
    expect(command).toBe("file_download");
    expect(options).toEqual({
      headers: { "x-buzz-file-name": "Ada.agent.png" },
    });
    expect(await readSnapshot(new Blob([bytes]))).toEqual({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    });
  } finally {
    desktop.tauri = false;
    click.mockRestore();
  }
});

it("updates a listing older than the agent, keeping it listed", async () => {
  const user = userEvent.setup();
  const { session, heads, outbox, accept } = community();
  heads.push({
    id: "9".repeat(64),
    pubkey: owner,
    created_at: 0,
    kind: 30175,
    tags: [
      ["d", agent.pubkey],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: "Ada", system_prompt: "Old." }),
  });
  share(session);
  expect(
    await screen.findByText(
      "Your latest changes aren’t in the Marketplace yet.",
    ),
  ).toBeInTheDocument();
  await user.click(
    await screen.findByRole("button", { name: "Update Marketplace" }),
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
      supersedes: 0,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Update Marketplace" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: /^Publish(ed)? to Marketplace$/ }),
  ).toBeChecked();
});

it("says an update failed when the listed head is not what it sent", async () => {
  const user = userEvent.setup();
  const { session, heads, outbox, lose } = community();
  heads.push({
    id: "9".repeat(64),
    pubkey: owner,
    created_at: 0,
    kind: 30175,
    tags: [
      ["d", agent.pubkey],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: "Ada", system_prompt: "Old." }),
  });
  share(session);
  await user.click(
    await screen.findByRole("button", { name: "Update Marketplace" }),
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  // It never landed, and the old listing is still shared.
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t publish Ada. Try again.",
  );
  expect(
    await screen.findByText(
      "Your latest changes aren’t in the Marketplace yet.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Update Marketplace" }),
  ).toBeEnabled();
  expect(toggle()).toBeChecked();
});

it("sends each person a message with one uploaded copy of the agent", async () => {
  const user = userEvent.setup();
  const { session, directMessages, attachments, messages, outbox, journal } =
    community();
  share(session);
  // With nobody chosen, the window just closes.
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  expect(
    screen.queryByRole("button", { name: "Done" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByText("Sent Ada to Bea and Cy."),
  ).toBeInTheDocument();
  expect(directMessages.open.mock.calls.map(([people]) => people)).toEqual([
    [bea.pubkey],
    [cy.pubkey],
  ]);
  // Community media is readable from any conversation, so one upload serves.
  expect(attachments.upload).toHaveBeenCalledOnce();
  const [file, channel] = attachments.upload.mock.calls[0] ?? [];
  expect(channel).toBe("dm-b");
  expect(file?.name).toBe("Ada.agent.png");
  expect(await readSnapshot(file as File)).toMatchObject({
    name: "Ada",
    instructions: "Review pull requests.",
  });
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual(["dm-b", "dm-c"]);
  expect(messages.send.mock.calls[0]?.[1]).toContain("Choose the card");
  expect((messages.send.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual([
    expect.objectContaining({ name: "Ada.agent.png" }),
  ]);
  expect(directMessages.delivered).toHaveBeenCalledWith(
    "sent-dm-c",
    "dm-c",
    expect.any(AbortSignal),
  );
  // Delivered, each message leaves the outbox.
  expect(outbox.acknowledge.mock.calls.map(([id]) => id)).toEqual([
    "sent-dm-b",
    "sent-dm-c",
  ]);
  expect(journal).toEqual([]);
  // Everyone was reached, so the window is ready to close.
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: /^Sending to/ }),
  ).not.toBeInTheDocument();
});

it("keeps who it couldn't reach, then confirms their message instead of resending it", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages } = community();
  directMessages.delivered.mockImplementation(async (id) => {
    if (id === "sent-dm-c") throw new Error("Not delivered");
  });
  share(session);
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Cy. Not delivered.",
  );
  expect(screen.getByText("Sent Ada to Bea.")).toBeInTheDocument();
  const chosen = screen.getByRole("region", { name: "Sending to · 1" });
  expect(
    within(chosen).getByRole("button", { name: "Cy", pressed: true }),
  ).toBeInTheDocument();
  // The relay may still have it, so trying again waits on the same message.
  directMessages.delivered.mockResolvedValue(undefined);
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Cy.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("sends to the rest when one upload fails, and reuses the next upload", async () => {
  const user = userEvent.setup();
  const { session, attachments, messages } = community();
  attachments.upload.mockRejectedValueOnce(new Error("Upload refused"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Upload refused.",
  );
  expect(screen.getByText("Sent Ada to Cy.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(attachments.upload).toHaveBeenCalledTimes(2);
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual(["dm-c", "dm-b"]);
  // With everyone reached, focus lands on Done.
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" })).toHaveFocus(),
  );
});

it("confirms an unconfirmed message after a reload rather than sending it again", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages, attachments, outbox } =
    community();
  directMessages.delivered.mockRejectedValueOnce(new Error("Offline"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Offline.",
  );
  cleanup();
  // A reload keeps only what the outbox saved, under a new session.
  share({ ...session, scope: "reloaded" } as RelaySession);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledOnce();
  expect(attachments.upload).toHaveBeenCalledOnce();
  expect(directMessages.delivered).toHaveBeenLastCalledWith(
    "sent-dm-b",
    "dm-b",
    expect.any(AbortSignal),
  );
  expect(outbox.acknowledge).toHaveBeenCalledWith("sent-dm-b");
});

it("sends anew once a failed message is removed from the outbox", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages, outbox, journal } = community();
  directMessages.delivered.mockRejectedValueOnce(new Error("Refused"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Refused.",
  );
  // Undecided, it stays; refused for good, it can be removed.
  await expect(outbox.dismiss("sent-dm-b")).rejects.toThrow();
  const [sent] = journal;
  assert.exists(sent);
  sent.delivery = "failed";
  await outbox.dismiss("sent-dm-b");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(2);
  expect(directMessages.delivered).toHaveBeenLastCalledWith(
    "sent-dm-b",
    "dm-b",
    expect.any(AbortSignal),
  );
});

it("keeps a delivered message for confirming when the outbox can't let it go", async () => {
  const user = userEvent.setup();
  const { session, messages, outbox } = community();
  outbox.acknowledge.mockRejectedValueOnce(new Error("Storage is full"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Storage is full.",
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledOnce();
});

it("sends an edited agent anew rather than confirming an earlier copy", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages, attachments } = community();
  directMessages.delivered.mockRejectedValueOnce(new Error("Offline"));
  const first = share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Offline.",
  );
  first.unmount();
  share(session, {
    config: { instructions: "Review small pull requests.", model: "echo-1" },
  });
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(2);
  expect(attachments.upload).toHaveBeenCalledTimes(2);
  // The edited copy is what was uploaded the second time.
  const card = attachments.upload.mock.calls[1]?.[0] as File;
  expect((await readSnapshot(card)).instructions).toBe(
    "Review small pull requests.",
  );
});

it("posts to a channel the viewer belongs to, and never offers agents", async () => {
  const user = userEvent.setup();
  const { session, directMessages, attachments, messages } = community();
  share(session);
  // Search opens ready to type, and narrows people and channels together.
  const field = screen.getByRole("searchbox", {
    name: "Search people and channels",
  });
  await vi.waitFor(() => expect(field).toHaveFocus());
  await choice("Bea");
  expect(
    screen.queryByRole("button", { name: "Echo" }),
  ).not.toBeInTheDocument();
  await user.type(field, "#des");
  await user.click(await choice("#design"));
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Bea" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to #design.")).toBeInTheDocument();
  // A channel gets one message in it, not a direct message to each member.
  expect(directMessages.open).not.toHaveBeenCalled();
  expect(attachments.upload.mock.calls[0]?.[1]).toBe(design.id);
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual([design.id]);
});
