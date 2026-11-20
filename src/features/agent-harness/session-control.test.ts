import { expect, it, vi } from "vitest";
import { SessionControls } from "./session-control";

it("preserves ordered handoffs after a failed admission", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
      throw new Error("admission failed");
    },
    true,
  );
  const failed = expect(first.done).rejects.toThrow("admission failed");
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  expect(controls.active("shared")).toBe(true);
  expect(following).not.toHaveBeenCalled();
  release();
  await failed;
  await second.done;
  expect(following).toHaveBeenCalledOnce();
  expect(controls.active("shared")).toBe(false);
});

it("keeps ordinary steering handoffs concurrent", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver("thread", async () => {
    await gate;
  });
  const following = vi.fn(async () => {});
  const second = controls.deliver("thread", following);
  try {
    await second.done;
    expect(following).toHaveBeenCalledOnce();
    expect(controls.active("thread")).toBe(true);
  } finally {
    release();
    await first.done;
  }
  expect(controls.active("thread")).toBe(false);
});

it("marks work behind an ordered predecessor as deferred", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
    },
    true,
  );
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  try {
    expect(second.deferred).toBe(true);
  } finally {
    release();
    await Promise.all([first.done, second.done]);
  }
});

it("cancels ordered callbacks before releasing their predecessor", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
    },
    true,
  );
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  const settled = second.done.catch(() => undefined);
  controls.interrupt("shared");
  release();
  await Promise.allSettled([first.done, settled]);
  expect(following).not.toHaveBeenCalled();
  await controls.deliver("shared", following, true).done;
  expect(following).toHaveBeenCalledOnce();
});

it("keeps deferred admission alive past its handover deadline", async () => {
  const controls = new SessionControls(() => {});
  const deadline = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.wake(
    "shared",
    new AbortController().signal,
    async () => {
      await gate;
      return { ok: true };
    },
  );
  const workingUntil = vi.fn();
  const admitted = vi.fn(
    async (delivery: { signal: AbortSignal }, deferred: boolean) => {
      expect(delivery.signal.aborted).toBe(false);
      expect(deferred).toBe(true);
    },
  );
  await controls.admit(
    "shared",
    {
      signal: deadline.signal,
      workingUntil,
    } as unknown as import("../agents/service").Delivery,
    admitted,
  );
  expect(workingUntil).toHaveBeenCalledOnce();
  deadline.abort(new Error("handover expired"));
  release();
  await first;
  await workingUntil.mock.calls[0]?.[0];
  expect(admitted).toHaveBeenCalledOnce();
});

it("replays Stop when the admitted runtime registers its handler late", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  let entered!: () => void;
  let stop!: () => Promise<void>;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  const run = controls.admit(
    "shared",
    {
      signal: new AbortController().signal,
      workingUntil() {},
      interruptible: (cancel: () => Promise<void>) => {
        stop = cancel;
      },
    } as unknown as import("../agents/service").Delivery,
    async (delivery) => {
      entered();
      await gate;
      delivery.interruptible?.(async () => {
        cancelled = true;
      });
      expect(cancelled).toBe(true);
    },
  );
  try {
    await preparing;
    await stop();
    release();
    await run;
    expect(cancelled).toBe(true);
  } finally {
    release();
    await run;
  }
});

it("reports a queued wake interrupted before admission as unfinished", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
    },
    true,
  );
  const run = vi.fn(async () => ({ ok: true }));
  const queued = controls.wake("shared", new AbortController().signal, run);
  controls.interrupt("shared");
  release();
  await first.done;
  await expect(queued).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("interrupted"),
  });
  expect(run).not.toHaveBeenCalled();
  await expect(
    controls.wake("shared", new AbortController().signal, run),
  ).resolves.toEqual({ ok: true });
});

it.each(["queued", "preparing"])(
  "retains an unsuccessful result for addressed work interrupted while %s",
  async (boundary) => {
    const controls = new SessionControls(() => {});
    let release!: () => void;
    let mark!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const prior =
      boundary === "queued"
        ? controls.deliver(
            "shared",
            async () => {
              await gate;
            },
            true,
          )
        : undefined;
    const workingUntil = vi.fn();
    const run = vi.fn(async () => {
      mark();
      if (boundary === "preparing") await gate;
    });
    const admitted = controls.admit(
      "shared",
      {
        signal: new AbortController().signal,
        workingUntil,
      } as unknown as import("../agents/service").Delivery,
      run,
    );
    if (boundary === "queued") await admitted;
    else await entered;
    controls.interrupt("shared");
    release();
    await prior?.done;
    await admitted;
    expect(workingUntil).toHaveBeenCalledOnce();
    await expect(workingUntil.mock.calls[0]?.[0]).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("interrupted"),
    });
    if (boundary === "queued") expect(run).not.toHaveBeenCalled();
  },
);

it("preserves ordered admissions when only compaction is interrupted", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let compactSignal: AbortSignal | undefined;
  const compacted = controls
    .run("shared", "compact", async (signal) => {
      compactSignal = signal;
      await gate;
      signal.throwIfAborted();
    })
    .catch((error) => error);
  const first = vi.fn(async () => {});
  const second = vi.fn(async () => {});
  const a = controls.deliver("shared", first, true);
  const b = controls.deliver("shared", second, true);
  try {
    await Promise.resolve();
    expect(controls.interrupt("shared")).toBe(true);
    expect(compactSignal?.aborted).toBe(true);
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
  } finally {
    release();
    await compacted;
    await Promise.all([a.done, b.done]);
  }
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(
    second.mock.invocationCallOrder[0] ?? 0,
  );
});

it("disposal cancels queued admissions even when compaction owns the session", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const compacted = controls.run("shared", "compact", async () => gate);
  const run = vi.fn(async () => {});
  const queued = controls.deliver("shared", run, true);
  controls.dispose();
  release();
  await compacted;
  await queued.done;
  expect(run).not.toHaveBeenCalled();
});
