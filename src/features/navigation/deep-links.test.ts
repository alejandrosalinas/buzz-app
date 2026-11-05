import { takeSignInRequest } from "../identity/sign-in-requests";
import { afterEach, expect, it, vi } from "vitest";
import type { ClientSnapshot } from "../communities/service";
import {
  bindDeepLinks,
  createDeepLinkShell,
  deepLinkStep,
  type DeepLinkShell,
} from "./deep-links";
import type { OpenTarget } from "./targets";
import {
  createNavigationController,
  type NavigationOpenOptions,
  type OpenFailure,
  type OpenResult,
} from "./controller";
import { createMemoryHistory } from "./history";

const native = vi.hoisted(() => ({ value: false }));
const invoked = vi.hoisted(() => ({
  fn: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => []),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.value,
  invoke: (command: string, args?: unknown) => invoked.fn(command, args),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
afterEach(() => {
  native.value = false;
  invoked.fn.mockReset();
  invoked.fn.mockImplementation(async () => []);
  vi.restoreAllMocks();
});

const viewer = "a".repeat(64);
const origin = "https://deep-link.example";
const elsewhere = "https://elsewhere.example";
const message =
  "9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
const root = "b".repeat(64);
const client = { viewer, selected: origin };
const messageLink = `buzz://message?channel=general&id=${message}&thread=${root}`;
// The retired `buzz://open?target=…` locator is an unknown host like any other.
const locator =
  "buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22home%22%7D";
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("binds message and channel links to the selected community and viewer", () => {
  expect(deepLinkStep(messageLink, client)).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
      threadRootId: root,
    },
  });
  expect(deepLinkStep("buzz://channel/general", client)).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
    },
  });
  expect(
    deepLinkStep(
      `buzz://message?channel=general&id=${message.toUpperCase()}`,
      client,
    ),
  ).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
    },
  });
});
it("fails as unavailable without a selected community or identity, never inventing one", () => {
  expect(
    deepLinkStep("buzz://channel/general", { viewer, selected: null }),
  ).toEqual({ fail: "unavailable" });
  expect(deepLinkStep(messageLink, { selected: origin })).toEqual({
    fail: "unavailable",
  });
});
it.each([
  // The retired locator is not a Buzz link however well-formed its JSON target,
  // whether unscoped or scoped to a community as early Copy link output was.
  locator,
  "buzz://",
  "buzz:",
  "buzz://channel/",
  "buzz://message?channel=general",
  `buzz://message?id=${message}`,
  "buzz://message?channel=general&id=not-an-event",
  "buzz://channel/%E0%A4%A",
  `buzz://open?target=%7B%22version%22%3A1%2C%22kind%22%3A%22conversation%22%2C%22scope%22%3A%7B%22communityOrigin%22%3A%22https%3A%2F%2Felsewhere.example%22%7D%2C%22channelId%22%3A%22general%22%2C%22messageId%22%3A%22${message}%22%7D`,
  "buzz://join?relay=example&code=abc123",
  "buzz://unknown/general",
  `buzz:agent-activity?agent=${"a".repeat(64)}`,
  // Only the exact buzz scheme: no other case, prefix, suffix or padding.
  "BUZZ://channel/general",
  `Buzz://message?channel=general&id=${message}`,
  "buzz-app://channel/general",
  "buzz-dev-3fa9c1://channel/general",
  "xbuzz://channel/general",
  " buzz://channel/general",
  "buzz",
  "https://example.com/?next=buzz://channel/general",
  "javascript:alert(1)",
  "",
  "not a url",
  `buzz://channel/${"g".repeat(40_000)}`,
])(
  "fails an unsupported or unparseable OS link as invalid-target instead of dropping it: %s",
  (url) => {
    expect(deepLinkStep(url, client)).toEqual({ fail: "invalid-target" });
  },
);
it("rejects non-string shell payloads the same way", () => {
  expect(deepLinkStep(42 as unknown as string, client)).toEqual({
    fail: "invalid-target",
  });
});

type Client = Pick<ClientSnapshot, "status" | "viewer" | "selected">;
function harness(initial: Client, pending: string[] = []) {
  const queue = [...pending];
  const watchers = new Set<() => void>();
  const take = vi.fn(async (): Promise<readonly string[]> => queue.splice(0));
  const shell: DeepLinkShell = {
    take,
    watch(listener) {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
  };
  let client = initial;
  const clientListeners = new Set<() => void>();
  const log: string[] = [];
  let inboxStatus: "loading" | "on" | "off" = "on";
  const inboxListeners = new Set<() => void>();
  const controller = createNavigationController(createMemoryHistory());
  const host = {
    navigation: {
      ...controller.navigation,
      open: vi.fn(
        async (target: OpenTarget, options?: NavigationOpenOptions) => {
          log.push(`open:${JSON.stringify(target)}`);
          const result = controller.navigation.open(target, options);
          controller.complete(controller.navigation.snapshot().attempt, {
            status: "opened",
          });
          return result;
        },
      ),
    },
    fail: vi.fn((reason: OpenFailure, retry?: () => Promise<OpenResult>) => {
      log.push(`fail:${reason}`);
      controller.fail(reason, retry);
    }),
    rejected: vi.fn(() => {
      log.push("rejected");
    }),
    inbox: {
      status: vi.fn((): "loading" | "on" | "off" => inboxStatus),
      subscribe(fn: () => void) {
        inboxListeners.add(fn);
        return () => {
          inboxListeners.delete(fn);
        };
      },
    },
    accepted: vi.fn(),
    authorize: vi.fn(),
  };
  const stop = bindDeepLinks(
    host,
    {
      snapshot: () => client,
      subscribe(fn) {
        clientListeners.add(fn);
        return () => {
          clientListeners.delete(fn);
        };
      },
    },
    shell,
  );
  return {
    controller,
    host,
    take,
    log,
    stop() {
      stop();
      controller.dispose();
    },
    watchers,
    arrive(...urls: unknown[]) {
      queue.push(...(urls as string[]));
      for (const fn of watchers) fn();
    },
    become(next: Partial<Client>) {
      client = { ...client, ...next };
      for (const fn of clientListeners) fn();
    },
    inbox(status: typeof inboxStatus) {
      inboxStatus = status;
      for (const fn of inboxListeners) fn();
    },
  };
}
const inboxOn = { status: () => "on" as const, subscribe: () => () => {} };
const ready: Client = { status: "ready", viewer, selected: origin };
const loading: Client = { status: "loading", selected: null };

it("holds external authorization through startup without adding handshake data to navigation", async () => {
  const link = `buzz://mcp-authorize?${new URLSearchParams({ version: "1", client: "Test app", callback: "http://127.0.0.1:1234/buzz/authorize", state: "A".repeat(43), scope: "read post", code_challenge: "A".repeat(43), code_challenge_method: "S256" })}`;
  const t = harness(loading, [link]);
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalled());
    expect(t.host.authorize).not.toHaveBeenCalled();
    t.become({ status: "ready", viewer, selected: null });
    await vi.waitFor(() => expect(t.host.authorize).toHaveBeenCalledOnce());
    expect(t.host.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ client: "Test app", scope: ["read", "post"] }),
      viewer,
    );
    expect(t.host.navigation.open).not.toHaveBeenCalled();
    expect(JSON.stringify(t.controller.navigation.snapshot())).not.toContain(
      "code_challenge",
    );
  } finally {
    t.stop();
  }
});
const channelOpen = `open:${JSON.stringify({
  version: 1,
  kind: "conversation",
  scope: { viewer, communityOrigin: origin },
  channelId: "general",
})}`;
const inbox = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
  scope: { viewer, communityOrigin: origin },
} as const;
const inboxOpen = `open:${JSON.stringify(inbox)}`;

it.each([""])(
  "holds a cold invite through identity setup without claiming (path %j)",
  async (path) => {
    const queue = [
      `buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=v2.invite`,
    ];
    let listener: () => void = () => {};
    let client: Client = { status: "loading", selected: null };
    const changed = new Set<() => void>();
    const invite = vi.fn();
    const host = createNavigationController(createMemoryHistory());
    const fail = vi.fn();
    const rejected = vi.fn();
    const stop = bindDeepLinks(
      {
        navigation: host.navigation,
        fail,
        invite,
        rejected,
        inbox: inboxOn,
        accepted: vi.fn(),
      },
      {
        snapshot: () => client,
        subscribe(fn) {
          changed.add(fn);
          return () => changed.delete(fn);
        },
      },
      {
        take: async () => queue.splice(0),
        watch(fn) {
          listener = fn;
          return () => {
            listener = () => {};
          };
        },
      },
    );
    try {
      await vi.waitFor(() => expect(queue).toEqual([]));
      client = { status: "unavailable", selected: null };
      for (const fn of changed) fn();
      expect(invite).not.toHaveBeenCalled();
      client = { status: "ready", viewer, selected: null };
      for (const fn of changed) fn();
      expect(invite).toHaveBeenCalledWith(
        { community: "https://relay.example", code: "v2.invite" },
        viewer,
      );
      expect(fail).not.toHaveBeenCalled();
      expect(rejected).not.toHaveBeenCalled();
      expect(host.navigation.snapshot().entry.target).toEqual({
        version: 1,
        kind: "home",
      });
      listener();
      await settle();
      expect(invite).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      host.dispose();
    }
  },
);

it.each([""])(
  "offers a warm invite and rejects malformed join links (path %j)",
  async (path) => {
    const queue: string[] = [];
    let ping: () => void = () => {};
    const invite = vi.fn();
    const host = createNavigationController(createMemoryHistory());
    const fail = vi.fn();
    const rejected = vi.fn();
    const stop = bindDeepLinks(
      {
        navigation: host.navigation,
        fail,
        invite,
        rejected,
        inbox: inboxOn,
        accepted: vi.fn(),
      },
      { snapshot: () => ready, subscribe: () => () => {} },
      {
        take: async () => queue.splice(0),
        watch(fn) {
          ping = fn;
          return () => {};
        },
      },
    );
    try {
      await settle();
      queue.push(`buzz://join${path}?relay=wss%3A%2F%2Frelay.example&code=x`);
      ping();
      await vi.waitFor(() => expect(invite).toHaveBeenCalledTimes(1));
      expect(invite).toHaveBeenCalledWith(
        { community: "https://relay.example", code: "x" },
        viewer,
      );
      queue.push(`buzz://join${path}?relay=example&code=x`);
      ping();
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
      expect(host.navigation.snapshot().entry.target).toEqual({
        version: 1,
        kind: "home",
      });
      expect(fail).not.toHaveBeenCalled();
    } finally {
      stop();
      host.dispose();
    }
  },
);

it("drains the shell at startup and opens a held link only once the client is ready", async () => {
  const t = harness(loading, ["buzz://channel/general"]);
  await settle();
  expect(t.take).toHaveBeenCalledTimes(1);
  expect(t.log).toEqual([]);
  t.become({ status: "ready", viewer, selected: origin });
  expect(t.log).toEqual([channelOpen]);
  t.stop();
});
it("hands the sign-in link to first-run without holding, binding or rejecting it", async () => {
  const t = harness(loading, ["buzz://sign-in"]);
  await settle();
  expect(takeSignInRequest()).toBe(true);
  t.become(ready);
  await settle();
  expect(t.log).toEqual([]);
  expect(t.host.rejected).not.toHaveBeenCalled();
  expect(t.host.fail).not.toHaveBeenCalled();
  t.stop();
});
it("holds a malformed cold-start link until Inbox can open, then explains it once", async () => {
  const t = harness(loading, ["buzz://join?relay=example"]);
  await settle();
  t.become({ status: "unavailable" });
  t.become({ status: "ready", viewer });
  expect(t.log).toEqual([]);
  t.become(ready);
  expect(t.log).toEqual(["rejected", inboxOpen]);
  expect(t.host.navigation.snapshot().entry.target).toEqual(inbox);
  expect(t.host.fail).not.toHaveBeenCalled();
  t.become({ selected: elsewhere });
  expect(t.log).toEqual(["rejected", inboxOpen]);
  t.stop();
});
it.each([
  "buzz://",
  "buzz://message?channel=general",
  "buzz://message?channel=general&id=not-an-event",
  "buzz://channel/%E0%A4%A",
  "buzz://unknown/general",
])(
  "explains a malformed or unsupported warm link over the current page: %s",
  async (url) => {
    const t = harness(ready);
    await settle();
    await t.host.navigation.open({ version: 1, kind: "settings" });
    const before = t.host.navigation.snapshot();
    t.arrive(url);
    await settle();
    expect(t.host.rejected).toHaveBeenCalledTimes(1);
    expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
    expect(t.host.fail).not.toHaveBeenCalled();
    expect(t.host.inbox.status).not.toHaveBeenCalled();
    expect(t.host.navigation.snapshot()).toMatchObject({
      entry: { id: before.entry.id },
      status: "opened",
      canGoForward: false,
    });
    t.stop();
  },
);
it("explains each repeated malformed warm link without adding visits, then opens a valid one", async () => {
  const t = harness(ready);
  await settle();
  t.arrive("buzz://");
  await settle();
  t.arrive("buzz://");
  await settle();
  expect(t.log).toEqual(["rejected", "rejected"]);
  expect(t.host.accepted).not.toHaveBeenCalled();
  t.arrive("buzz://channel/general");
  await settle();
  expect(t.host.accepted).toHaveBeenCalledTimes(1);
  expect(t.log).toEqual(["rejected", "rejected", channelOpen]);
  t.host.navigation.back();
  expect(t.host.navigation.snapshot().entry.target).toEqual({
    version: 1,
    kind: "home",
  });
  t.stop();
});
it("explains a malformed launch link over the start page, adding no visit, when Inbox is turned off", async () => {
  const t = harness(loading, ["buzz://"]);
  t.inbox("off");
  await settle();
  const before = t.host.navigation.snapshot();
  t.become(ready);
  expect(t.host.rejected).toHaveBeenCalledTimes(1);
  expect(t.host.navigation.open).not.toHaveBeenCalled();
  expect(t.host.navigation.snapshot()).toMatchObject({
    entry: { id: before.entry.id },
    canGoForward: false,
  });
  t.stop();
});
it.each(["on", "off"] as const)(
  "holds a malformed launch link until Inbox availability settles (%s)",
  async (settled) => {
    const t = harness(loading, ["buzz://"]);
    t.inbox("loading");
    await settle();
    const before = t.host.navigation.snapshot();
    t.become(ready);
    expect(t.log).toEqual([]);
    t.inbox(settled);
    t.inbox(settled);
    if (settled === "on") expect(t.log).toEqual(["rejected", inboxOpen]);
    else {
      expect(t.log).toEqual(["rejected"]);
      expect(t.host.navigation.snapshot()).toMatchObject({
        entry: { id: before.entry.id },
        canGoForward: false,
      });
    }
    t.stop();
  },
);
it("a newer user visit cancels a malformed launch link waiting for Inbox", async () => {
  const t = harness(loading, ["buzz://"]);
  t.inbox("loading");
  await settle();
  t.become(ready);
  await t.host.navigation.open({ version: 1, kind: "home" });
  t.inbox("on");
  expect(t.host.rejected).not.toHaveBeenCalled();
  expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
  t.stop();
});
it("never reports a held malformed link as denied when the account changes", async () => {
  const other = "f".repeat(64);
  const t = harness({ ...ready, status: "loading" }, ["buzz://"]);
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
    await settle();
    t.become({ status: "ready", viewer: other, selected: elsewhere });
    expect(t.host.fail).not.toHaveBeenCalled();
    expect(t.log).toEqual([
      "rejected",
      `open:${JSON.stringify({
        ...inbox,
        scope: { viewer: other, communityOrigin: elsewhere },
      })}`,
    ]);
  } finally {
    t.stop();
  }
});
it("a newer user visit cancels a malformed link waiting for a community", async () => {
  const t = harness({ status: "ready", viewer, selected: null }, ["buzz://"]);
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
    await settle();
    await t.host.navigation.open({ version: 1, kind: "home" });
    t.become(ready);
    expect(t.host.rejected).not.toHaveBeenCalled();
    expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
  } finally {
    t.stop();
  }
});
it("opens an OS message link carrying unknown query parameters as the bound conversation", async () => {
  const t = harness(ready);
  await settle();
  t.arrive(`${messageLink}&foo=bar&foo=baz`);
  await settle();
  expect(t.log).toEqual([
    `open:${JSON.stringify({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
      threadRootId: root,
    })}`,
  ]);
  expect(t.host.fail).not.toHaveBeenCalled();
  expect(t.host.navigation.snapshot().entry.target).toEqual({
    version: 1,
    kind: "conversation",
    scope: { viewer, communityOrigin: origin },
    channelId: "general",
    messageId: message,
    threadRootId: root,
  });
  t.stop();
});
it("opens the latest intent from a burst without presenting superseded destinations", async () => {
  const t = harness(ready);
  await settle();
  t.arrive("buzz://channel/general", locator, messageLink);
  await settle();
  expect(t.log).toEqual([
    `open:${JSON.stringify({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      channelId: "general",
      messageId: message,
      threadRootId: root,
    })}`,
  ]);
  t.stop();
});
it("retains the incoming message for Retry after community selection", async () => {
  const t = harness({ status: "ready", viewer, selected: null });
  await settle();
  t.arrive(messageLink);
  await settle();
  expect(t.log).toEqual(["fail:unavailable"]);
  t.become({ selected: origin });
  expect(t.log).toEqual(["fail:unavailable"]);
  await expect(t.host.navigation.retry()).resolves.toEqual({
    status: "opened",
  });
  expect(t.host.navigation.snapshot().entry.target).toMatchObject({
    messageId: message,
    threadRootId: root,
  });
  t.stop();
});
it("waits for an identity and community, then retries the incoming URL rather than Home", async () => {
  const t = harness({ status: "unavailable", selected: null }, [messageLink]);
  try {
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().retryable).toBe(true),
    );
    t.become(ready);
    await expect(t.host.navigation.retry()).resolves.toEqual({
      status: "opened",
    });
    expect(t.host.navigation.snapshot().entry.target).toMatchObject({
      kind: "conversation",
      scope: { viewer, communityOrigin: origin },
      messageId: message,
    });
  } finally {
    t.stop();
  }
});
it("retains only the latest URL across repeated drains while loading", async () => {
  const t = harness(loading, [messageLink]);
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 40; i++) {
      t.arrive(`buzz://channel/channel-${i}`);
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(i + 2));
    }
    t.become(ready);
    expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
    expect(t.host.navigation.snapshot().entry.target).toMatchObject({
      channelId: "channel-39",
    });
  } finally {
    t.stop();
  }
});
it.each(["viewer", "selected"] as const)(
  "rejects obsolete intent when the bound %s changes during loading",
  async (key) => {
    const t = harness({ ...ready, status: "loading" }, [messageLink]);
    try {
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
      t.become({
        ...ready,
        [key]: key === "viewer" ? "f".repeat(64) : elsewhere,
      });
      await expect(t.host.navigation.retry()).resolves.toEqual({
        status: "failed",
        reason: "denied",
      });
      expect(t.host.navigation.open).not.toHaveBeenCalled();
    } finally {
      t.stop();
    }
  },
);
it("a newer user visit dismisses a recoverable incoming URL", async () => {
  const t = harness({ status: "ready", viewer, selected: null }, [messageLink]);
  try {
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().retryable).toBe(true),
    );
    await t.host.navigation.open({ version: 1, kind: "home" });
    t.become(ready);
    expect(t.host.navigation.snapshot().entry.target).toEqual({
      version: 1,
      kind: "home",
    });
    expect(t.host.navigation.snapshot().ingress).toBeUndefined();
    expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
  } finally {
    t.stop();
  }
});
it("a malformed newer arrival replaces retained recovery without reviving the old URL", async () => {
  const t = harness({ status: "ready", viewer, selected: null }, [messageLink]);
  try {
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().retryable).toBe(true),
    );
    t.arrive("buzz://unsupported");
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(2));
    await settle();
    t.become(ready);
    expect(t.log).toEqual(["fail:unavailable", "rejected", inboxOpen]);
    expect(t.host.navigation.snapshot().entry.target).toEqual(inbox);
  } finally {
    t.stop();
  }
});
it("a malformed warm link retires an earlier link's recovery and restores the page under it", async () => {
  const t = harness(ready);
  try {
    await settle();
    await t.host.navigation.open({ version: 1, kind: "settings" });
    const before = t.host.navigation.snapshot();
    t.become({ selected: null });
    t.arrive(messageLink);
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().retryable).toBe(true),
    );
    t.arrive("buzz://");
    await vi.waitFor(() => expect(t.host.rejected).toHaveBeenCalledTimes(1));
    expect(t.host.navigation.snapshot()).toMatchObject({
      entry: { id: before.entry.id },
      status: "opened",
      canGoForward: false,
    });
    expect(t.host.navigation.snapshot().ingress).toBeUndefined();
    expect(t.host.navigation.snapshot().retryable).toBeUndefined();
    // Selecting a community later revives neither link.
    t.become(ready);
    await settle();
    expect(t.log.filter((entry) => entry.startsWith("open:"))).toEqual([
      `open:${JSON.stringify({ version: 1, kind: "settings" })}`,
      `open:${JSON.stringify(before.entry.target)}`,
    ]);
  } finally {
    t.stop();
  }
});
it("a newer in-flight arrival wins when readiness changes during the drain", async () => {
  const t = harness(loading, [messageLink]);
  let release!: (urls: string[]) => void;
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
    t.take.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    t.arrive("buzz://channel/newer");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      t.become(ready);
      expect(t.host.navigation.open).not.toHaveBeenCalled();
    } finally {
      release(["buzz://channel/newer"]);
    }
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().entry.target).toMatchObject({
        channelId: "newer",
      }),
    );
    expect(t.host.navigation.open).toHaveBeenCalledTimes(1);
  } finally {
    t.stop();
  }
});
it("same-visit normalization does not discard a shell read", async () => {
  const t = harness(ready);
  let release!: (urls: string[]) => void;
  try {
    await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
    t.take.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    t.arrive(messageLink);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    try {
      expect(
        t.controller.resolve(t.host.navigation.snapshot().attempt, {
          version: 1,
          kind: "settings",
        }),
      ).toBe(true);
    } finally {
      release([messageLink]);
    }
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().entry.target).toMatchObject({
        messageId: message,
      }),
    );
  } finally {
    t.stop();
  }
});
it("ignores non-string shell entries and keeps going", async () => {
  const t = harness(ready);
  await settle();
  t.arrive(42, null, "buzz://channel/general");
  await settle();
  expect(t.log).toEqual([channelOpen]);
  t.stop();
});
it("reports a failing shell read without throwing and can drain on the next ping", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const t = harness(ready);
  await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
  t.take.mockRejectedValueOnce(new Error("no shell"));
  t.arrive("buzz://channel/general");
  await settle();
  expect(error).toHaveBeenCalledWith(
    "Could not read pending deep links",
    expect.any(Error),
  );
  expect(t.log).toEqual([]);
  t.arrive();
  await vi.waitFor(() => expect(t.log).toEqual([channelOpen]));
  t.stop();
});
it.each(["navigation", "viewer", "selected"] as const)(
  "discards a shell read completed after newer %s intent",
  async (change) => {
    const t = harness(ready);
    let release!: (urls: string[]) => void;
    try {
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
      t.take.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      t.arrive(messageLink);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      try {
        if (change === "navigation")
          await t.host.navigation.open({ version: 1, kind: "home" });
        else
          t.become({
            [change]: change === "viewer" ? "f".repeat(64) : elsewhere,
          });
      } finally {
        release([messageLink]);
      }
      // A subsequent empty drain is a completion barrier for the held read.
      t.take.mockResolvedValueOnce([]);
      t.arrive();
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(3));
      expect(t.host.navigation.snapshot().entry.target).toEqual({
        version: 1,
        kind: "home",
      });
      expect(t.host.navigation.open).toHaveBeenCalledTimes(
        change === "navigation" ? 1 : 0,
      );
    } finally {
      t.stop();
    }
  },
);
it("latches the first available account and community before retry", async () => {
  const t = harness({ status: "unavailable", selected: null }, [messageLink]);
  try {
    await vi.waitFor(() =>
      expect(t.host.navigation.snapshot().retryable).toBe(true),
    );
    t.become(ready);
    t.become({ viewer: "f".repeat(64), selected: elsewhere });
    await expect(t.host.navigation.retry()).resolves.toEqual({
      status: "failed",
      reason: "denied",
    });
    expect(t.host.navigation.open).not.toHaveBeenCalled();
  } finally {
    t.stop();
  }
});
it("still drains once when the shell cannot deliver updates, without aborting startup", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const controller = createNavigationController(createMemoryHistory());
  const host = {
    ...controller,
    fail: vi.fn(),
    rejected: vi.fn(),
    inbox: inboxOn,
    accepted: vi.fn(),
  };
  const stop = bindDeepLinks(
    host,
    { snapshot: () => ready, subscribe: () => () => {} },
    {
      take: async () => ["buzz://join?relay=example"],
      watch() {
        throw new Error("no channel");
      },
    },
  );
  await settle();
  expect(error).toHaveBeenCalledWith(
    "Deep link updates are unavailable",
    expect.any(Error),
  );
  expect(host.rejected).toHaveBeenCalledTimes(1);
  stop();
  controller.dispose();
});
it("stops draining and reacting after disposal", async () => {
  const t = harness(loading, ["buzz://channel/general"]);
  await settle();
  t.stop();
  expect(t.watchers.size).toBe(0);
  t.become({ status: "ready", viewer, selected: origin });
  t.arrive("buzz://channel/general");
  await settle();
  expect(t.take).toHaveBeenCalledTimes(1);
  expect(t.log).toEqual([]);
});
it("is a no-op in the browser build, where no shell exists", async () => {
  expect(createDeepLinkShell()).toBeUndefined();
  const host = createNavigationController(createMemoryHistory());
  const subscribe = vi.fn(() => () => {});
  const stop = bindDeepLinks(
    { ...host, rejected: vi.fn(), inbox: inboxOn, accepted: vi.fn() },
    { snapshot: () => ready, subscribe },
  );
  await settle();
  expect(subscribe).not.toHaveBeenCalled();
  expect(invoked.fn).not.toHaveBeenCalled();
  stop();
  host.dispose();
});
it("bridges the Tauri shell with raw strings only and detaches its ping channel on stop", async () => {
  native.value = true;
  let channel: { onmessage: (response: unknown) => void } | undefined;
  invoked.fn.mockImplementation(async (command, args) => {
    // The bridge does not interpret what it carries; the scheme is irrelevant here.
    if (command === "deep_link_take")
      return ["buzz://channel/general", 7, null];
    if (command === "deep_link_watch") {
      channel = (args as { onEvent: typeof channel }).onEvent;
      return undefined;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const shell = createDeepLinkShell();
  expect(shell).toBeDefined();
  await expect(shell?.take()).resolves.toEqual(["buzz://channel/general"]);
  const listener = vi.fn();
  const stop = shell?.watch(listener) ?? (() => {});
  await settle();
  expect(invoked.fn).toHaveBeenCalledWith("deep_link_watch", {
    onEvent: channel,
  });
  expect(listener).toHaveBeenCalledTimes(1); // registration closes the startup gap
  channel?.onmessage({ pending: 1 });
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  channel?.onmessage({ pending: 2 });
  expect(listener).toHaveBeenCalledTimes(2);
});

it("drains URLs arriving between startup take and deferred native watch registration", async () => {
  native.value = true;
  let registered!: () => void;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  const queue: string[] = [];
  const take = vi.fn(() => queue.splice(0));
  invoked.fn.mockImplementation(async (command) => {
    if (command === "deep_link_take") return take();
    if (command === "deep_link_watch") return registration;
    throw new Error(`Unexpected native command: ${command}`);
  });
  const controller = createNavigationController(createMemoryHistory());
  const host = {
    ...controller,
    fail: vi.fn(),
    rejected: vi.fn(),
    inbox: inboxOn,
    accepted: vi.fn(),
  };
  const stop = bindDeepLinks(host, {
    snapshot: () => ready,
    subscribe: () => () => {},
  });
  try {
    await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(1));
    // Wait for the empty initial IPC response, not just its invocation.
    await invoked.fn.mock.results.find(
      (_, index) => invoked.fn.mock.calls[index]?.[0] === "deep_link_take",
    )?.value;
    // No native watcher exists yet, so this arrival cannot ping the webview.
    queue.push("buzz://join?relay=example");
    expect(host.rejected).not.toHaveBeenCalled();
    registered();
    await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(2));
    expect(host.rejected).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
  } finally {
    registered();
    stop();
    controller.dispose();
  }
});
it("does not revive a disposed bridge when native registration finishes", async () => {
  native.value = true;
  let registered!: () => void;
  const registration = new Promise<void>((resolve) => {
    registered = resolve;
  });
  invoked.fn.mockImplementation(async () => registration);
  const shell = createDeepLinkShell();
  const listener = vi.fn();
  const stop = shell?.watch(listener);
  expect(invoked.fn).toHaveBeenCalledWith(
    "deep_link_watch",
    expect.any(Object),
  );
  stop?.();
  registered();
  await invoked.fn.mock.results[0]?.value;
  expect(listener).not.toHaveBeenCalled();
});

const localPluginLink = "buzz://plugin-install?repository=org%2Frepo";
it.each(["viewer", "selected"] as const)(
  "keeps a plugin link across a %s change while loading",
  async (key) => {
    const t = harness({ ...ready, status: "loading" }, [localPluginLink]);
    try {
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
      t.become({
        ...ready,
        [key]: key === "viewer" ? "f".repeat(64) : elsewhere,
      });
      await vi.waitFor(() =>
        expect(t.host.navigation.open).toHaveBeenCalledTimes(1),
      );
      expect(t.host.fail).not.toHaveBeenCalled();
      expect(t.host.navigation.snapshot().entry.target).toMatchObject({
        kind: "settings",
        section: "plugins",
      });
    } finally {
      t.stop();
    }
  },
);
it.each(["viewer", "selected"] as const)(
  "keeps a pending plugin shell read across a %s change",
  async (key) => {
    const t = harness(ready);
    let release!: (urls: string[]) => void;
    try {
      await vi.waitFor(() => expect(t.take).toHaveBeenCalledTimes(1));
      t.take.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      t.arrive(localPluginLink);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      t.become({ [key]: key === "viewer" ? "f".repeat(64) : elsewhere });
      release([localPluginLink]);
      await vi.waitFor(() =>
        expect(t.host.navigation.open).toHaveBeenCalledTimes(1),
      );
      expect(t.host.fail).not.toHaveBeenCalled();
    } finally {
      release?.([]);
      t.stop();
    }
  },
);

it("binds a plugin page link to the selected community and viewer", () => {
  const scope = { viewer, communityOrigin: origin };
  expect(
    deepLinkStep(
      "buzz://plugin?id=com.example.catalog&page=detail&route.slug=a&foo=b",
      client,
    ),
  ).toEqual({
    open: {
      version: 1,
      kind: "plugin",
      pluginId: "com.example.catalog",
      pageId: "detail",
      params: { slug: "a" },
      scope,
    },
  });
  expect(deepLinkStep("buzz://plugin?id=com.example.catalog", client)).toEqual({
    open: {
      version: 1,
      kind: "plugin",
      pluginId: "com.example.catalog",
      scope,
    },
  });
  expect(
    deepLinkStep("buzz://plugin?id=com.example.catalog", {
      viewer,
      selected: null,
    }),
  ).toEqual({ fail: "unavailable" });
});
it.each([
  "buzz://plugin",
  "buzz://plugin?id=Not.Valid",
  "buzz://plugin?id=a&id=b",
  "buzz://plugin?id=a&page=b&page=c",
  "buzz://plugin?id=a&route.k=1&route.k=2",
  "buzz://plugin?id=a&page=",
])("fails a malformed plugin link as invalid-target: %s", (url) => {
  expect(deepLinkStep(url, client)).toEqual({ fail: "invalid-target" });
});
it("opens a warm plugin link through the navigation host", async () => {
  const t = harness(ready);
  try {
    await settle();
    t.arrive("buzz://plugin?id=com.example.catalog&route.slug=a");
    await vi.waitFor(() =>
      expect(t.log).toEqual([
        `open:${JSON.stringify({
          version: 1,
          kind: "plugin",
          pluginId: "com.example.catalog",
          params: { slug: "a" },
          scope: { viewer, communityOrigin: origin },
        })}`,
      ]),
    );
  } finally {
    t.stop();
  }
});
