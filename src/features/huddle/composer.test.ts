import { gifDraftPreview } from "../../bundled/emoji/GifDraftPreview";
import { useHuddleComposer } from "../../bundled/huddles/HuddleComposer";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import {
  act,
  cleanup as cleanupReact,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { attachmentDraft } from "../messages/attachment-draft";
import { MessageComposer } from "../messages/MessageComposer";
import { composerDOMFixture, typedDraft } from "../messages/composer-testing";
import { followupDraft, mentionDraft } from "../messages/mention-draft";
import { afterEach, expect, it, vi } from "vitest";
import {
  communityFromScope,
  gifMarkdown,
  relayGifRequests,
} from "../relay/gifs";
import { createRelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";
import { createHuddleComposerOwner } from "./composer-owner";
import { createHuddleComposerClient } from "./composer-client";
import type { ComposerCommand, ComposerResponse } from "./composer-contract";

composerDOMFixture();
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanupReact();
  for (const fn of cleanup.splice(0).reverse()) fn();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness(legacy = false, agents?: import("../agents/service").Agents) {
  const store = createRelaySession(null);
  const viewer = "ab".repeat(32),
    room = "room",
    parent = "parent",
    scope = `https://example.test:${viewer}`;
  let allowed = true;
  const metadata = {
    id: room,
    name: "Huddle",
    huddle: true as const,
    parentChannelId: legacy ? undefined : parent,
    members: [viewer],
  };
  const send = vi.fn(() => "accepted-id");
  const refresh = vi.fn(async () => {});
  const session = {
    ...store.session,
    viewer,
    scope,
    channels: { ...store.session.channels, get: () => metadata },
    attachments: {
      upload: vi.fn(async (file: File) => ({
        name: file.name,
        url: `https://example.test/media/${file.name}`,
        type: file.type,
        size: file.size,
        sha256: "ab".repeat(32),
      })),
    },
    messages: { ...store.session.messages, send },
    agentChoices: { ...store.session.agentChoices, refresh },
  };
  let verified = !legacy;
  let emojiEnabled = true;
  const owner = createHuddleComposerOwner(
    session,
    room,
    parent,
    {
      tools: {
        snapshot: () =>
          emojiEnabled
            ? [
                {
                  key: "buzz.emoji/picker",
                  id: "picker",
                  title: "Emoji",
                  pluginId: "buzz.emoji",
                  revision: "bundled",
                  component: () => null,
                },
              ]
            : [],
        subscribe: () => () => {},
      },
    },
    () => allowed,
    legacy ? () => verified : undefined,
    agents,
  );
  cleanup.push(
    () => store.dispose(),
    () => owner.dispose(),
  );
  const connect = async () => {
    const client = createHuddleComposerClient(owner.token);
    cleanup.push(() => client.dispose());
    await vi.waitFor(() => expect(client.snapshot().session).toBeDefined());
    const remote = client.snapshot().session;
    if (!remote) throw new Error("Missing session");
    return { client, remote };
  };
  return {
    owner,
    session,
    disableEmoji: () => {
      emojiEnabled = false;
    },
    verify: (value: boolean) => {
      verified = value;
      owner.refresh();
    },
    send,
    refresh,
    scope,
    connect,
    revoke: () => {
      allowed = false;
    },
  };
}
it("keeps drafts on rejection, clears persisted accepted intent in main, and refreshes mention evidence", async () => {
  const h = harness();
  const { remote, client } = await h.connect();
  expect(client.snapshot().data?.scope).toBe(h.scope);
  expect(communityFromScope(remote.scope)).toBe("https://example.test");
  const draft = { text: "Hello", recipients: [] };
  writeView(h.scope, "draft:room", draft);
  h.send.mockImplementationOnce(() => {
    throw new Error("Rejected");
  });
  await expect(remote.messages.send("room", "Hello")).rejects.toThrow(
    "Rejected",
  );
  expect(readView(h.scope, "draft:room", null)).toEqual(draft);
  await expect(remote.messages.send("room", "Hello")).resolves.toBe(
    "accepted-id",
  );
  expect(readView(h.scope, "draft:room", null)).toEqual({
    text: "",
    recipients: [],
  });
  await remote.agentChoices.refresh();
  expect(h.refresh).toHaveBeenCalledWith(true);
  h.revoke();
  await expect(remote.messages.send("room", "Again")).rejects.toThrow(
    "no longer available",
  );
  expect(h.send).toHaveBeenCalledTimes(2);
});
it("clears admitted drafts even when the child closes before acknowledgment and deduplicates request IDs", async () => {
  const h = harness();
  const peer = new BroadcastChannel(`buzz.huddle.composer.${h.owner.token}`);
  cleanup.push(() => peer.close());
  const responses: ComposerResponse[] = [];
  peer.onmessage = ({ data }) => responses.push(data);
  const post = (command: ComposerCommand) => peer.postMessage(command);
  post({ kind: "hello", client: "test" });
  await vi.waitFor(() =>
    expect(responses.some((r) => r.kind === "snapshot")).toBe(true),
  );
  const draft = { text: "Accepted before close", recipients: [] };
  writeView(h.scope, "draft:room", draft);
  const command: ComposerCommand = {
    kind: "request",
    client: "test",
    id: 1,
    op: "send",
    args: {
      text: draft.text,
      draft: JSON.stringify(draft),
      mentions: [],
      references: [],
      attachments: [],
    },
  };
  post(command);
  post(command);
  await vi.waitFor(() =>
    expect(responses.some((r) => r.kind === "result" && r.id === 1)).toBe(true),
  );
  expect(h.send).toHaveBeenCalledTimes(1);
  // Closing the renderer in the enqueue callback happens before main can reply.
  const next = { text: "Close immediately", recipients: [] };
  writeView(h.scope, "draft:room", next);
  h.send.mockImplementationOnce(() => {
    peer.close();
    return "second-id";
  });
  post({
    ...command,
    id: 2,
    args: { ...command.args, text: next.text, draft: JSON.stringify(next) },
  });
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
  expect(readView(h.scope, "draft:room", null)).toEqual({
    text: "",
    recipients: [],
  });
  const { remote } = await h.connect();
  expect(readView(h.scope, "draft:room", null)).toEqual({
    text: "",
    recipients: [],
  });
  await expect(remote.messages.send("other", "Wrong room")).rejects.toThrow(
    "destination changed",
  );
  expect(h.send).toHaveBeenCalledTimes(2);
});

it("keeps the legacy composer disabled until parent verification and rechecks before sending", async () => {
  const h = harness(true);
  const { client, remote } = await h.connect();
  await expect(remote.messages.send("room", "Unverified")).rejects.toThrow(
    "no longer available",
  );
  h.verify(true);
  await vi.waitFor(() => expect(client.snapshot().data?.writable).toBe(true));
  await expect(remote.messages.send("room", "Verified")).resolves.toBe(
    "accepted-id",
  );
  h.verify(false);
  await expect(remote.messages.send("room", "Revoked")).rejects.toThrow(
    "no longer available",
  );
  expect(h.send).toHaveBeenCalledTimes(1);
});

it("routes GIF discovery and search through the current room owner and enabled tool", async () => {
  const supports = vi
    .spyOn(relayGifRequests, "supports")
    .mockResolvedValue(true);
  const search = vi.spyOn(relayGifRequests, "search").mockResolvedValue([]);
  const h = harness();
  const { client } = await h.connect();
  await expect(client.gifs.supports("https://untrusted.test")).resolves.toBe(
    true,
  );
  await expect(
    client.gifs.search("https://untrusted.test", "hello"),
  ).resolves.toEqual([]);
  expect(supports).toHaveBeenCalledWith(
    "https://example.test",
    expect.any(AbortSignal),
  );
  expect(search).toHaveBeenCalledWith(
    "https://example.test",
    "hello",
    expect.any(AbortSignal),
  );
  await expect(
    client.gifs.search("https://example.test", "x".repeat(257)),
  ).rejects.toThrow("Invalid GIF search");
  expect(search).toHaveBeenCalledTimes(1);
  h.disableEmoji();
  await expect(client.gifs.supports("https://example.test")).rejects.toThrow(
    "unavailable",
  );
  expect(supports).toHaveBeenCalledTimes(1);
  h.revoke();
  await expect(
    client.gifs.search("https://example.test", "hello"),
  ).rejects.toThrow("no longer available");
  expect(search).toHaveBeenCalledTimes(1);
});

it.each(["cancel", "close"])(
  "cancels an owner GIF search on client %s and permits recovery",
  async (action) => {
    let signal: AbortSignal | undefined;
    const search = vi
      .spyOn(relayGifRequests, "search")
      .mockImplementationOnce((_community, _query, pending) => {
        signal = pending;
        return new Promise((_resolve, reject) =>
          pending?.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          ),
        );
      })
      .mockResolvedValue([]);
    const h = harness();
    const { client } = await h.connect();
    const controller = new AbortController();
    const pending = client.gifs.search(
      "https://example.test",
      "hello",
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    if (action === "cancel") controller.abort();
    else client.dispose();
    await rejected;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    const next = action === "close" ? (await h.connect()).client : client;
    await expect(
      next.gifs.search("https://example.test", "again"),
    ).resolves.toEqual([]);
  },
);

it.each([false, true])(
  "preserves the real owner's remembered-agent followup and concurrent drafts (changed=%s)",
  async (changed) => {
    const h = harness();
    const agent = { pubkey: "ef".repeat(32), name: "Helper" };
    const profiles = new Map([
      [agent.pubkey, { ...agent, isAgent: true as const }],
    ]);
    h.session.profiles = { ...h.session.profiles, snapshot: () => profiles };
    h.session.channels.get().members.push(agent.pubkey);
    const draft = typedDraft(followupDraft([agent]));
    writeView(h.scope, "draft:room", draft);
    const { remote } = await h.connect();
    const sent = vi.fn();
    const newer = { text: "New work from another editor", recipients: [] };
    if (changed)
      h.send.mockImplementationOnce(() => {
        writeView(h.scope, "draft:room", newer);
        return "accepted-id";
      });
    render(
      createElement(MessageComposer, {
        session: remote,
        scope: h.scope,
        channelId: "room",
        channelName: "Huddle",
        label: "Huddle draft",
        onSend: sent,
      }),
    );
    const editor = screen.getByRole("textbox", { name: "Huddle draft" });
    await waitFor(() => expect(editor).toHaveTextContent("Helper"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith("accepted-id"));
    await act(async () => {});
    expect(readView(h.scope, "draft:room", null)).toEqual(
      changed ? newer : mentionDraft(""),
    );
    expect(editor).toHaveTextContent(changed ? newer.text : "Helper");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith(
      "room",
      expect.any(String),
      [agent.pubkey],
      [],
      undefined,
      [],
      {},
    );
  },
);

it("retains valid voice metadata and releases enriched upload identities", async () => {
  // Node's BroadcastChannel does not preserve File instances as browsers do.
  // Keep message ordering while retaining files in this owner/client fixture.
  const peers = new Set<{
    name: string;
    onmessage?: (event: { data: unknown }) => void;
  }>();
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      constructor(readonly name: string) {
        peers.add(this);
      }
      postMessage(data: unknown) {
        for (const peer of peers)
          if (peer !== this && peer.name === this.name)
            queueMicrotask(() => {
              if (peers.has(peer)) peer.onmessage?.({ data });
            });
      }
      close() {
        peers.delete(this);
      }
    },
  );
  const h = harness();
  const { remote } = await h.connect();
  const file = new File([new Uint8Array(64)], "voice.wav", {
    type: "audio/wav",
  });
  if (!remote.attachments) throw new Error("Missing attachments");
  const draft = attachmentDraft(remote, "voice-regression", "room");
  cleanup.push(() => draft.clear());
  draft.add([file], { file, duration: 1, waveform: [0, 0.2, 0.8, 1] });
  const [upload] = await draft.prepareForSend(new AbortController().signal);
  if (!upload) throw new Error("Missing recorded upload");
  const voice = upload.voice;
  expect(voice).toEqual({ duration: 1, waveform: [0, 20, 80, 100] });
  if (!voice) throw new Error("Missing recorded metadata");
  for (const waveform of [[-1], [101], [0.5], [NaN], [Infinity], []]) {
    await expect(
      remote.messages.send(
        "room",
        "",
        [],
        [{ ...upload, voice: { ...voice, waveform } }],
      ),
    ).rejects.toThrow("Invalid voice");
  }
  await expect(
    remote.messages.send("room", "", [], [{ ...upload, voice }]),
  ).resolves.toBe("accepted-id");
  expect(h.send).toHaveBeenCalledWith(
    "room",
    "",
    [],
    [{ ...upload, voice }],
    undefined,
    [],
    {},
  );
  for (let i = 0; i < 22; i++) {
    const next = await remote.attachments.upload(
      new File([new Uint8Array(64)], `${i}.wav`, { type: "audio/wav" }),
      "room",
      new AbortController().signal,
    );
    remote.attachments.release?.({ ...next, voice });
  }
  const invalid = await remote.attachments.upload(
    file,
    "room",
    new AbortController().signal,
  );
  await expect(
    remote.messages.send(
      "room",
      "",
      [],
      [{ ...invalid, voice: { ...voice, duration: Infinity } }],
    ),
  ).rejects.toThrow("Invalid voice");
});

it("projects owned model choices and carries validated picks through the companion transport", async () => {
  const pubkey = "cd".repeat(32);
  const agent = { pubkey, name: "Helper", type: "fixture" };
  const models = vi.fn(async () => ({
    current: "fast",
    models: [
      { id: "fast", label: "Fast", efforts: [{ id: "high", label: "High" }] },
    ],
  }));
  const agents = {
    subscribe: () => () => {},
    snapshot: () => ({ agents: [agent] }),
    types: () => [{ key: "fixture", models }],
  } as unknown as import("../agents/service").Agents;
  const h = harness(false, agents);
  const { client, remote } = await h.connect();
  expect(await client.models([pubkey])).toEqual([
    expect.objectContaining({ pubkey, current: "fast" }),
  ]);
  const picks = { [pubkey]: { model: "fast", effort: "high" } };
  await remote.messages.send(
    "room",
    "Hello",
    [pubkey],
    [],
    undefined,
    [],
    picks,
  );
  expect(h.send).toHaveBeenLastCalledWith(
    "room",
    "Hello",
    [pubkey],
    [],
    undefined,
    [],
    picks,
  );
  await expect(
    remote.messages.send("room", "Hello", [], [], undefined, [], picks),
  ).rejects.toThrow("choices changed");
  await expect(
    remote.messages.send("room", "Hello", [pubkey], [], undefined, [], {
      [pubkey]: { model: "missing" },
    }),
  ).rejects.toThrow("choices changed");
  expect(h.send).toHaveBeenCalledTimes(1);
});

it("does not send after the companion closes during model resolution", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pubkey = "cd".repeat(32);
  const agent = { pubkey, name: "Helper", type: "fixture" };
  const models = vi.fn(async () => {
    await gate;
    return {
      current: "fast",
      models: [{ id: "fast", label: "Fast", efforts: [] }],
    };
  });
  const agents = {
    subscribe: () => () => {},
    snapshot: () => ({ agents: [agent] }),
    types: () => [{ key: "fixture", models }],
  } as unknown as import("../agents/service").Agents;
  const h = harness(false, agents);
  const { client, remote } = await h.connect();
  const sending = remote.messages.send(
    "room",
    "Hello",
    [pubkey],
    [],
    undefined,
    [],
    { [pubkey]: { model: "fast" } },
  );
  const rejected = expect(sending).rejects.toThrow();
  await vi.waitFor(() => expect(models).toHaveBeenCalled());
  client.dispose();
  await rejected;
  // A replacement handshake is a transport barrier after the old client left.
  const replacement = await h.connect();
  release();
  await replacement.client.models([pubkey]);
  expect(h.send).not.toHaveBeenCalled();
});

it("shows and refreshes model defaults in the standalone companion composer", async () => {
  const pubkey = "cd".repeat(32);
  const agent = { pubkey, name: "Helper", type: "fixture" };
  let current = "fast";
  const listeners = new Set<() => void>();
  const models = vi.fn(async () => ({
    current,
    sendDefaults: true,
    models: [
      { id: "fast", label: "Fast", efforts: [] },
      { id: "slow", label: "Slow", efforts: [] },
    ],
  }));
  const agents = {
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot: () => ({ agents: [agent] }),
    types: () => [{ key: "fixture", models }],
  } as unknown as import("../agents/service").Agents;
  const h = harness(false, agents);
  h.session.profiles = {
    ...h.session.profiles,
    snapshot: () => new Map([[pubkey, { ...agent, isAgent: true as const }]]),
  };
  h.session.channels.get().members.push(pubkey);
  writeView(h.scope, "draft:room", typedDraft(followupDraft([agent])));
  function Companion() {
    return useHuddleComposer(h.owner.token);
  }
  render(createElement(Companion));
  await screen.findByRole("button", {
    name: "Model and effort for the next run",
  });
  await act(async () => {
    current = "slow";
    for (const fn of listeners) fn();
  });
  await waitFor(() => expect(models).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(h.send).toHaveBeenCalledWith(
      "room",
      expect.any(String),
      [pubkey],
      [],
      undefined,
      [],
      { [pubkey]: { model: "slow" } },
    ),
  );
});

it("carries owner-authorized GIF media into companion previews across searches", async () => {
  const asset = {
    url: "https://example.test/hello(1).gif",
    width: 100,
    height: 100,
    size: 20,
  };
  const gif = {
    id: 1,
    slug: "hello",
    title: "Hello",
    preview: asset,
    original: asset,
  };
  const search = vi
    .spyOn(relayGifRequests, "search")
    .mockResolvedValueOnce([gif])
    .mockResolvedValue([]);
  const h = harness();
  const media = vi
    .spyOn(h.session, "media")
    .mockImplementation(
      (url) => `https://proxy.test/?url=${encodeURIComponent(url)}`,
    );
  const { client, remote } = await h.connect();
  const url = "https://example.test/hello%281%29.gif";
  expect(remote.media(url)).toBeUndefined();
  await client.gifs.search("https://example.test", "hello");
  const source = remote.media(url);
  expect(source).toBe(media(url));
  render(gifDraftPreview(url, gif.title, remote.media));
  expect(screen.getByRole("img", { name: "Hello" })).toHaveAttribute(
    "src",
    source,
  );
  await client.gifs.search("https://example.test", "other");
  expect(remote.media(url)).toBe(source);
  await remote.messages.send("room", gifMarkdown(gif));
  expect(h.send).toHaveBeenCalledWith(
    "room",
    `![Hello](${url})`,
    [],
    [],
    undefined,
    [],
    {},
  );
  expect(search).toHaveBeenCalledTimes(2);
  client.dispose();
  const next = await h.connect();
  expect(next.remote.media(url)).toBeUndefined();
});

// Picked assets need no `.gif` suffix; only the thumbnail depends on it.
it.each([
  ["https://example.test/chosen.gif", true],
  ["https://example.test/media/123", false],
])(
  "stages a selected GIF in the standalone composer and sends its Markdown: %s",
  async (url, thumbnail) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(relayGifRequests, "supports").mockResolvedValue(true);
    const asset = {
      url,
      width: 100,
      height: 100,
      size: 20,
    };
    const gif = {
      id: 1,
      slug: "chosen",
      title: "Chosen GIF",
      preview: asset,
      original: asset,
    };
    vi.spyOn(relayGifRequests, "search").mockResolvedValue([gif]);
    const h = harness();
    vi.spyOn(h.session, "media").mockImplementation((url) => url);
    function Companion() {
      return useHuddleComposer(h.owner.token);
    }
    render(createElement(Companion));
    const draft = await screen.findByRole("textbox", {
      name: "Message this Huddle",
    });
    fireEvent.keyDown(draft, { key: "g", ctrlKey: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Chosen GIF" }),
    );
    const row = await screen.findByRole("region", { name: "Attachments" });
    if (thumbnail)
      await waitFor(() =>
        expect(row.querySelector("img")).toHaveAttribute("src", asset.url),
      );
    else expect(row.querySelector("img")).toBeNull();
    expect(draft).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Remove Chosen GIF" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(draft, { key: "g", ctrlKey: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose Chosen GIF" }),
    );
    await screen.findByRole("button", { name: "Remove Chosen GIF" });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(h.send).toHaveBeenCalledWith(
        "room",
        gifMarkdown(gif),
        [],
        [],
        undefined,
        [],
        {},
      ),
    );
  },
);

it("carries the owner's profile purge generation so the companion rereads shown names", async () => {
  const h = harness();
  let generation = 0;
  const ensure = vi.fn(async () => {});
  h.session.profiles = {
    ...h.session.profiles,
    snapshot: () => new Map(),
    ensure,
    generation: () => generation,
  };
  const { client, remote } = await h.connect();
  expect(remote.profiles.generation?.()).toBe(0);
  const seen = vi.fn();
  cleanup.push(remote.profiles.subscribe(seen));
  await remote.profiles.ensure(["cd".repeat(32)], "background");
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
  // A purge in the main window advances its generation; the owner publishes.
  generation = 1;
  h.owner.refresh();
  await vi.waitFor(() => expect(remote.profiles.generation?.()).toBe(1));
  expect(client.snapshot().data?.profileGeneration).toBe(1);
  expect(seen).toHaveBeenCalled();
  await remote.profiles.ensure(["cd".repeat(32)], "background");
  await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(2));
});

it.each(["private", "dm", "solo", "public"] as const)(
  "resolves and discloses a detached %s forward in the owning session",
  async (privacy) => {
    const h = harness();
    const reference = {
      version: 1 as const,
      origin: "https://example.test",
      channelId: "source",
      id: "c".repeat(64),
    };
    const agent = "de".repeat(32);
    Object.assign(h.session, {
      agentLibrary: {
        snapshot: () => ({
          identities: [{ pubkey: agent, name: "Local Agent" }],
        }),
      },
    });
    let content = "Authorized source @Local Agent";
    const row = () => ({
      id: reference.id,
      channelId: "source",
      authorId: h.session.viewer,
      createdAt: 1,
      content,
      mentions: [agent],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    });
    const dispose = vi.fn();
    vi.spyOn(h.session, "thread").mockImplementation(
      () =>
        ({
          snapshot: () => ({
            status: "ready",
            targetStatus: "ready",
            target: row(),
            replies: [],
            canLoadMore: false,
          }),
          subscribe: () => () => {},
          refresh: async () => {},
          dispose,
        }) as unknown as ReturnType<typeof h.session.thread>,
    );
    vi.spyOn(h.session.messages, "forwardProblem").mockReturnValue(undefined);
    const forward = vi
      .spyOn(h.session.messages, "forward")
      .mockReturnValue("forwarded-id");
    Object.assign(h.session.channels, {
      resolve: async () => {},
      describe: () => ({
        state: "found",
        name: "Source",
        private: privacy === "private",
        hidden: false,
        archived: false,
        joined: true,
        channelType:
          privacy === "dm" || privacy === "solo" ? privacy : "stream",
      }),
    });
    let { remote } = await h.connect();
    expect(
      (
        await remote.forwarding?.resolve(
          reference,
          new AbortController().signal,
        )
      )?.row.content,
    ).toBe("Authorized source @Local Agent");
    expect(
      (
        await remote.forwarding?.resolve(
          reference,
          new AbortController().signal,
        )
      )?.privateSource,
    ).toBe(privacy !== "public");
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    function Companion() {
      return useHuddleComposer(h.owner.token);
    }
    const view = render(createElement(Companion));
    await screen.findByRole("textbox", { name: "Message this Huddle" });
    const { forwardClipboard } = await import("../messages/forward-clipboard");
    const payload = forwardClipboard(reference, "Untrusted clipboard text");
    fireEvent.paste(
      screen.getByRole("textbox", { name: "Message this Huddle" }),
      {
        clipboardData: {
          getData: (type: string) =>
            type === "text/html" ? payload.html : payload.text,
          items: [],
        },
      },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    expect(
      Boolean(
        within(screen.getByRole("form")).queryByText(
          /will be able to read this message/,
        ),
      ),
    ).toBe(privacy !== "public");
    if (privacy !== "public")
      expect(
        within(screen.getByRole("form")).getByText(
          /will be able to read this message/,
        ),
      ).toHaveTextContent("Everyone in this Huddle");
    view.unmount();
    // A detached host owns one bridge client at a time. Reconnect after closing it.
    ({ remote } = await h.connect());
    content = "Current authorized source @Local Agent";
    expect(
      await remote.forwarding?.send(reference, "Note", [], [], [], {}),
    ).toBe("forwarded-id");
    expect(forward).toHaveBeenCalledWith(
      "room",
      expect.objectContaining({
        content,
        mentionLabels: [{ id: agent, names: ["Local Agent"] }],
      }),
      expect.any(String),
      "Note",
      undefined,
      { mentions: [], attachments: [], references: [], picks: {} },
    );
    expect(dispose).toHaveBeenCalledTimes(4);
    await expect(
      remote.forwarding?.resolve(
        { ...reference, origin: "https://other.example" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/another community/);
    h.revoke();
    await expect(
      remote.forwarding?.send(reference, "", [], [], [], {}),
    ).rejects.toThrow();
    expect(forward).toHaveBeenCalledOnce();
  },
);
