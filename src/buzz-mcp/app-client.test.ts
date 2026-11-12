import { expect, it, vi } from "vitest";
import type { AgentHandle } from "../features/agents/service";
import type { AgentProtection } from "../features/agent-protection/service";
import { appClient, readFile } from "./app-client";
import type { Host } from "../features/host/service";
import { pngChunks } from "../features/messages/image-metadata";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "uses the declared contained reader only when protected: %s",
  async (protectedRead) => {
    const protection = {
      readOnlyPaths: ["/controls"],
      hiddenPaths: ["/private"],
    };
    const path = 'report; $(do-not-execute) "quoted".txt';
    const spawn = vi.fn<NonNullable<Host["spawn"]>>(async (_id, options) => {
      options?.onStdout?.(btoa("captured bytes"));
      return {
        write: vi.fn(),
        end: vi.fn(),
        kill: vi.fn(),
        exited: Promise.resolve(0),
      };
    });
    const pending = readFile(
      spawn,
      "/workspace",
      path,
      undefined,
      protectedRead ? protection : undefined,
    );
    protection.hiddenPaths.push("/changed");
    expect(new TextDecoder().decode(await pending)).toBe("captured bytes");
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      protectedRead ? "read-protected" : "read",
      expect.objectContaining({
        cwd: "/workspace",
        args: [path],
        ...(protectedRead
          ? {
              protection: {
                readOnlyPaths: ["/controls"],
                hiddenPaths: ["/private"],
              },
            }
          : {}),
      }),
    );
    if (!protectedRead)
      expect(spawn.mock.calls[0]?.[1]).not.toHaveProperty("protection");
  },
);

it("does not fall back to an ordinary reader when containment denies a file", async () => {
  const spawn = vi.fn<NonNullable<Host["spawn"]>>(async (_id, options) => {
    options?.onStderr?.("Operation not permitted");
    return {
      write: vi.fn(),
      end: vi.fn(),
      kill: vi.fn(),
      exited: Promise.resolve(1),
    };
  });
  await expect(
    readFile(spawn, "/workspace", "/private/approval", undefined, {
      readOnlyPaths: [],
      hiddenPaths: ["/private"],
    }),
  ).rejects.toThrow("Operation not permitted");
  expect(spawn).toHaveBeenCalledOnce();
  expect(spawn.mock.calls[0]?.[0]).toBe("read-protected");
});

it("withholds file bytes when the protected handle retires during a read", async () => {
  const started = gate<void>();
  const bytes = gate<Uint8Array>();
  let live = true;
  const assertAvailable = vi.fn(() => {
    if (!live) throw new Error("retired");
  });
  const client = appClient(
    {
      pubkey: "agent",
      protection: { assertAvailable },
    } as unknown as AgentHandle,
    {
      read: async () => {
        started.resolve(undefined);
        return bytes.promise;
      },
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const result = client.read("file");
  try {
    await started.promise;
    live = false;
    bytes.resolve(new TextEncoder().encode("must not escape"));
    await expect(result).rejects.toThrow("retired");
  } finally {
    bytes.resolve(new Uint8Array());
    await result.catch(() => undefined);
  }
});

it("binds shared-tool review to native conversation context and refuses missing context", async () => {
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const agent = {
    pubkey: "agent",
    protection: { check },
  } as unknown as AgentHandle;
  const options = {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  };
  const action = {
    kind: "tool" as const,
    session: "native-session",
    content: { command: "write", conversation: "untrusted replacement" },
  };
  await expect(appClient(agent, options).protect?.(action)).rejects.toThrow(
    "no native conversation context",
  );
  expect(check).not.toHaveBeenCalled();
  const conversation = [{ role: "user", text: "Only read" }];
  await appClient(agent, {
    ...options,
    protectionContext: async () => conversation,
  }).protect?.(action);
  expect(check.mock.calls[0]?.[0]).toEqual({
    ...action,
    content: { command: "write", conversation },
  });
});

it("carries connection authorities independently of query event authors", async () => {
  const query = vi.fn(async () => []);
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
      relayAuthor: "trusted-relay",
      signingAuthority: "trusted-workflows",
    },
  );
  expect(client.relayAuthor).toBe("trusted-relay");
  expect(client.signingAuthority).toBe("trusted-workflows");
  await client.query([{ kinds: [39000] }]);
  expect(query).toHaveBeenCalledWith([{ kinds: [39000] }]);
});

it("reads effective edit state as the agent and withholds it after the turn retires", async () => {
  const result = gate<Awaited<ReturnType<AgentHandle["effectiveEdit"]>>>();
  const effectiveEdit = vi.fn(() => result.promise);
  let live = true;
  const client = appClient({ effectiveEdit } as unknown as AgentHandle, {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
    check: () => {
      if (!live) throw new Error("retired");
    },
  });
  const pending = client.effectiveEdit?.("target", "private");
  expect(effectiveEdit).toHaveBeenCalledWith("target", "private");
  live = false;
  result.resolve({ id: "head" } as Awaited<
    ReturnType<AgentHandle["effectiveEdit"]>
  >);
  await expect(pending).rejects.toThrow("retired");
  await expect(client.effectiveEdit?.("target", "private")).rejects.toThrow(
    "retired",
  );
  expect(effectiveEdit).toHaveBeenCalledOnce();
});

it("does not invent authority when a host has none", () => {
  const client = appClient({ pubkey: "agent" } as AgentHandle, {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
  });
  expect(client.relayAuthor).toBeUndefined();
  expect(client.signingAuthority).toBeUndefined();
});

it("withholds a query result when the owning turn ends during the read", async () => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const query = vi.fn(async () => {
    await pending;
    return [];
  });
  const client = appClient(
    { pubkey: "agent", query } as unknown as AgentHandle,
    {
      read: vi.fn(),
      signal: controller.signal,
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const result = client.query([{ kinds: [9] }]);
  expect(query).toHaveBeenCalledOnce();
  controller.abort(new Error("Owning turn ended"));
  release();
  await expect(result).rejects.toThrow("Owning turn ended");
});

it("refuses creation after the calling turn ends and surfaces native failures", async () => {
  const createAgent = vi.fn(async () => {
    throw new Error("Native creation failed");
  });
  const controller = new AbortController();
  const client = appClient({ createAgent } as unknown as AgentHandle, {
    read: vi.fn(),
    signal: controller.signal,
    memories: async () => ({ entries: [], partial: false }),
  });
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Native creation failed");
  controller.abort(new Error("Turn ended"));
  await expect(
    client.createAgent?.({ type: "codex/codex", name: "Child" }),
  ).rejects.toThrow("Turn ended");
  expect(createAgent).toHaveBeenCalledOnce();
});

/** A PNG carrying a location in a text chunk. */
function metadataPng() {
  const chunk = (kind: string, payload: number[] | string = []) => {
    const data =
      typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    return [
      ...[0, 0, 0, data.length],
      ...new TextEncoder().encode(kind),
      ...data,
      ...[0, 0, 0, 0],
    ];
  };
  return new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk("IHDR", Array(13).fill(0)),
    ...chunk("tEXt", "GPS\u000051.5,-0.12"),
    ...chunk("IDAT", [1, 2]),
    ...chunk("IEND"),
  ]);
}

it("strips a proposed picture's metadata before uploading it as the agent", async () => {
  const png = metadataPng();
  const upload = vi.fn(async (_data: string, type: string) => ({
    url: "https://relay/media/x.png",
    sha256: "ab",
    size: 1,
    type,
  }));
  const client = appClient(
    { pubkey: "agent", upload } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  await expect(client.uploadPicture?.(png, "image/png")).resolves.toMatchObject(
    {
      url: "https://relay/media/x.png",
    },
  );
  const [data, type] = upload.mock.calls[0] ?? [];
  expect(type).toBe("image/png");
  const sent = Uint8Array.from(atob(data ?? ""), (c) => c.charCodeAt(0));
  expect(pngChunks(sent).map((c) => c.kind)).toEqual(["IHDR", "IDAT", "IEND"]);
});

/** A 1x1 two-colour GIF, with `extra` blocks before its image. */
function gif(...extra: number[]) {
  return new Uint8Array([
    ...new TextEncoder().encode("GIF89a"),
    ...[1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255],
    ...extra,
    ...[0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b],
  ]);
}

it("strips an attached image's metadata and sends other files as they are", async () => {
  const upload = vi.fn(async (_data: string, type: string) => ({
    url: "https://relay/media/x",
    sha256: "ab",
    size: 1,
    type,
  }));
  const client = appClient(
    { pubkey: "agent", upload } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const text = new TextEncoder().encode("GPS 51.5,-0.12");
  // A comment extension carrying a location.
  await client.upload(gif(0x21, 0xfe, 3, 0x47, 0x50, 0x53, 0), "image/gif");
  await client.upload(text, "text/plain");
  const sent = upload.mock.calls.map(([data, type]) => [
    Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    type,
  ]);
  expect(sent).toEqual([
    [gif(), "image/gif"],
    [text, "text/plain"],
  ]);
});

it.each(["signal", "check"])(
  "uploads no attached image when the turn ends during its preparation (%s)",
  async (retire) => {
    const upload = vi.fn();
    const controller = new AbortController();
    let retired = false;
    const client = appClient(
      { pubkey: "agent", upload } as unknown as AgentHandle,
      {
        read: vi.fn(),
        signal: controller.signal,
        check: () => {
          if (retired) throw new Error("Turn ended");
        },
        memories: async () => ({ entries: [], partial: false }),
      },
    );
    // The second read is the prepared image's, after its last check.
    const read = File.prototype.arrayBuffer;
    let reads = 0;
    const spy = vi
      .spyOn(File.prototype, "arrayBuffer")
      .mockImplementation(async function (this: File) {
        if (++reads === 2) {
          if (retire === "signal") controller.abort(new Error("Turn ended"));
          else retired = true;
        }
        return read.call(this);
      });
    try {
      await expect(client.upload(gif(), "image/gif")).rejects.toThrow(
        "Turn ended",
      );
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBe(2);
    expect(upload).not.toHaveBeenCalled();
  },
);

it("refuses a proposed picture its preparation does not recognize", async () => {
  const upload = vi.fn();
  const client = appClient(
    { pubkey: "agent", upload } as unknown as AgentHandle,
    {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  await expect(
    client.uploadPicture?.(
      new TextEncoder().encode("GIF8x metadata"),
      "image/gif",
    ),
  ).rejects.toThrow("PNG, JPEG, GIF or WebP");
  expect(upload).not.toHaveBeenCalled();
});

it("proposes no picture for a turn stopped during its upload", async () => {
  let release = () => {};
  const upload = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ url: "https://relay/media/x.png", sha256: "ab", size: 1 });
      }),
  );
  const controller = new AbortController();
  const client = appClient(
    { pubkey: "agent", upload } as unknown as AgentHandle,
    {
      read: vi.fn(),
      signal: controller.signal,
      memories: async () => ({ entries: [], partial: false }),
    },
  );
  const picture = client.uploadPicture?.(metadataPng(), "image/png");
  await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
  controller.abort(new Error("Turn ended"));
  release();
  await expect(picture).rejects.toThrow("Turn ended");
});

it("refuses plugin calls after the calling turn ends", async () => {
  const plugins = {
    list: vi.fn(async () => ({ plugins: [] })),
    discover: vi.fn(),
    disable: vi.fn(),
    request: vi.fn(),
    status: vi.fn(),
  };
  const controller = new AbortController();
  const client = appClient({ plugins } as unknown as AgentHandle, {
    read: vi.fn(),
    signal: controller.signal,
    memories: async () => ({ entries: [], partial: false }),
  });
  expect(await client.plugins?.list()).toEqual({ plugins: [] });
  controller.abort(new Error("Turn ended"));
  await expect(async () => client.plugins?.list()).rejects.toThrow(
    "Turn ended",
  );
  expect(() => client.plugins?.status("r")).toThrow("Turn ended");
  expect(plugins.list).toHaveBeenCalledOnce();
  expect(
    appClient({} as AgentHandle, {
      read: vi.fn(),
      memories: async () => ({ entries: [], partial: false }),
    }).plugins,
  ).toBeUndefined();
});

it("offers the handle's settings, checking the turn before each call", () => {
  const settings = {
    list: vi.fn(() => []),
    get: vi.fn(),
    set: vi.fn(() => ({ key: "example.mood" }) as never),
  };
  const agent = { pubkey: "agent", settings } as unknown as AgentHandle;
  const memories = async () => ({ entries: [], partial: false });
  expect(
    appClient({ pubkey: "agent" } as unknown as AgentHandle, {
      read: vi.fn(),
      memories,
    }).settings,
  ).toBeUndefined();
  let ended = false;
  const controller = new AbortController();
  const client = appClient(agent, {
    read: vi.fn(),
    memories,
    signal: controller.signal,
    check: () => {
      if (ended) throw new Error("The turn has ended");
    },
  });
  client.settings?.set("example.mood", "busy");
  expect(settings.set).toHaveBeenCalledExactlyOnceWith("example.mood", "busy");
  ended = true;
  expect(() => client.settings?.set("example.mood", "calm")).toThrow("ended");
  expect(() => client.settings?.list()).toThrow("ended");
  ended = false;
  controller.abort(new Error("Turn stopped"));
  expect(() => client.settings?.get("example.mood")).toThrow("Turn stopped");
  expect(settings.set).toHaveBeenCalledOnce();
  expect(settings.list).not.toHaveBeenCalled();
  expect(settings.get).not.toHaveBeenCalled();
});

it("forwards workspace discovery and one-use filing only while the app client is live", async () => {
  let live = true;
  const file = vi.fn(async () => {});
  const list = vi.fn(async () => [{ id: "work", name: "Work" }]);
  const prepare = vi.fn(async () => file);
  const client = appClient(
    { soloWorkspaces: { list, prepare } } as unknown as AgentHandle,
    {
      read: async () => new Uint8Array(),
      memories: async () => ({ entries: [], partial: false }),
      check: () => {
        if (!live) throw new Error("retired");
      },
    },
  );
  expect(await client.soloWorkspaces?.list()).toEqual([
    { id: "work", name: "Work" },
  ]);
  const place = await client.soloWorkspaces?.prepare("work", ["owner"], "chat");
  expect(prepare).toHaveBeenCalledExactlyOnceWith(
    "work",
    ["owner"],
    "chat",
    undefined,
  );
  live = false;
  await expect(place?.("chat")).rejects.toThrow("retired");
  expect(file).not.toHaveBeenCalled();
  await expect(client.soloWorkspaces?.list()).rejects.toThrow("retired");
});

it("rejects app retirement after a completed placement without undoing it", async () => {
  const started = gate<void>(),
    release = gate<void>();
  let live = true,
    durable = false;
  const file = vi.fn(async () => {
    durable = true;
    started.resolve();
    await release.promise;
    return { status: "filed" as const };
  });
  const client = appClient(
    {
      soloWorkspaces: { list: async () => [], prepare: async () => file },
    } as unknown as AgentHandle,
    {
      read: async () => new Uint8Array(),
      memories: async () => ({ entries: [], partial: false }),
      check: () => {
        if (!live) throw new Error("retired");
      },
    },
  );
  const place = await client.soloWorkspaces?.prepare("work", ["owner"], "chat");
  const pending = place?.("chat");
  const refused = expect(pending).rejects.toThrow("retired");
  try {
    await started.promise;
    expect(durable).toBe(true);
    live = false;
  } finally {
    release.resolve();
  }
  await refused;
  expect(file).toHaveBeenCalledExactlyOnceWith("chat");
  expect(durable).toBe(true);
});

it("does not expose workspace capability on unsupported handles", () => {
  expect(
    appClient({} as AgentHandle, {
      read: async () => new Uint8Array(),
      memories: async () => ({ entries: [], partial: false }),
    }).soloWorkspaces,
  ).toBeUndefined();
});

it("never passes on an owner-read capability, even from a handle that carries one", () => {
  const read = vi.fn();
  const stale = Object.fromEntries(
    [
      "channels",
      "channel",
      "members",
      "messages",
      "canvas",
      "canvasHistory",
      "held",
    ].map((name) => [name, read]),
  );
  const client = appClient(
    { pubkey: "agent", ownerAccess: stale } as unknown as AgentHandle,
    { read: vi.fn(), memories: async () => ({ entries: [], partial: false }) },
  );
  expect("ownerAccess" in client).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it("retains native context through the check and releases it on denial", async () => {
  const release = vi.fn();
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const check = vi.fn(async () => {
    await hold;
    throw new Error("denied");
  });
  const agent = {
    pubkey: "agent",
    protection: { check },
  } as unknown as AgentHandle;
  const client = appClient(agent, {
    read: vi.fn(),
    memories: async () => ({ entries: [], partial: false }),
    captureProtectionContext: async () => ({ value: "snapshot", release }),
  });
  const result = client.protect?.({
    kind: "tool",
    session: "s",
    content: { command: "write" },
  });
  await vi.waitFor(() => expect(check).toHaveBeenCalled());
  expect(release).not.toHaveBeenCalled();
  finish();
  await expect(result).rejects.toThrow("denied");
  expect(release).toHaveBeenCalledOnce();
});
