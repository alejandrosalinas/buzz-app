// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ForwardChildRegistered } from "../../features/host/forward";
import { forwardChildren } from "./forward-children";
import { flush } from "./goose-testing";

const announced = (call: string, toolName = "delegate", title = toolName) => ({
  sessionUpdate: "tool_call",
  toolCallId: call,
  title,
  _meta: { goose: { toolCall: { toolName } } },
});
const completed = (call: string, child: unknown = "20261104_2") => ({
  sessionUpdate: "tool_call_update",
  toolCallId: call,
  status: "completed",
  _meta: { goose: { subagentSessionId: child } },
});

function tracked(
  outcome: () => Promise<ForwardChildRegistered> = async () => ({
    type: "registered",
  }),
) {
  const register = vi.fn((_call: string, _child: string) => outcome());
  const failed = vi.fn();
  const { observe, settled } = forwardChildren({ register, failed });
  return { observe, settled, register, failed };
}

describe("forwardChildren", () => {
  it("registers a live delegate's child, and its resume under a new call", async () => {
    const { observe, settled, register, failed } = tracked();
    observe(announced("call-1"), true);
    observe({ ...completed("call-1"), status: "in_progress" }, true);
    observe(completed("call-1"), true);
    // Titled by its source, as goose titles a delegate that names one.
    observe(announced("call-2", "delegate", "delegate · reviewer"), true);
    observe(completed("call-2"), true);
    await flush();
    expect(register.mock.calls).toEqual([
      ["call-1", "20261104_2"],
      ["call-2", "20261104_2"],
    ]);
    expect(failed).not.toHaveBeenCalled();
    expect(await settled()).toBeUndefined();
  });

  it("ignores replay, other tools and calls it never saw announced", async () => {
    const { observe, register } = tracked();
    // A replay arrives outside any prompt, announcement included.
    observe(announced("call-1"), false);
    observe(completed("call-1"), false);
    observe(completed("call-1"), true);
    observe(announced("call-2", "shell"), true);
    observe(completed("call-2"), true);
    // Another tool titled as a delegate is not one.
    observe(announced("call-4", "shell", "delegate"), true);
    observe(completed("call-4"), true);
    observe({ ...announced("call-5"), _meta: undefined }, true);
    observe(completed("call-5"), true);
    observe(announced("call-3"), true);
    observe(completed("call-3", 7), true);
    observe({ ...completed("call-3"), _meta: undefined }, true);
    await flush();
    expect(register).not.toHaveBeenCalled();
  });

  it("shows each refusal, and stops registering once revoked", async () => {
    const outcomes: ForwardChildRegistered[] = [
      { type: "refused", reason: "child_cap" },
      { type: "refused", reason: "generation_revoked" },
    ];
    const { observe, settled, register, failed } = tracked(
      async () => outcomes.shift() ?? { type: "registered" },
    );
    for (const call of ["call-1", "call-2", "call-3"]) {
      observe(announced(call), true);
      observe(completed(call), true);
      await flush();
    }
    expect(register).toHaveBeenCalledTimes(2);
    expect(failed.mock.calls).toEqual([["child_cap"], ["generation_revoked"]]);
    // The turn fails for the first.
    expect(await settled()).toBe("child_cap");
  });

  it("surfaces a rejected registration, leaving no promise unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { observe, failed } = tracked(() =>
        Promise.reject("The generation's session is not associated"),
      );
      observe(announced("call-1"), true);
      observe(completed("call-1"), true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        "The generation's session is not associated",
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

it("surfaces a registration that throws instead of returning a promise", () => {
  const failed = vi.fn();
  const { observe } = forwardChildren({
    register: () => {
      throw new Error("ipc unavailable");
    },
    failed,
  });
  observe(announced("call-1"), true);
  expect(() => observe(completed("call-1"), true)).not.toThrow();
  expect(failed).toHaveBeenCalledExactlyOnceWith("Error: ipc unavailable");
});

describe("a failure reporter that throws", () => {
  const throwing = () =>
    vi.fn((_reason: string) => {
      throw new Error("turn already ended");
    });

  it("is called once on a synchronous failure, and stops registration", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = throwing();
      const register = vi.fn((_call: string, _child: string) => {
        throw new Error("ipc unavailable");
      });
      const { observe, settled } = forwardChildren({ register, failed });
      observe(announced("call-1"), true);
      expect(() => observe(completed("call-1"), true)).not.toThrow();
      observe(announced("call-2"), true);
      observe(completed("call-2"), true);
      expect(failed).toHaveBeenCalledExactlyOnceWith("Error: ipc unavailable");
      expect(await settled()).toBe("Error: ipc unavailable");
      expect(register).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it.each([
    [
      "a refusal",
      async () => ({ type: "refused", reason: "child_cap" }) as const,
      "child_cap",
    ],
    ["a rejection", () => Promise.reject("not associated"), "not associated"],
  ] as const)(
    "is called once on %s, leaving no promise unhandled",
    async (_, outcome, reason) => {
      const unhandled = vi.fn();
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      process.on("unhandledRejection", unhandled);
      try {
        const failed = throwing();
        const register = vi.fn((_call: string, _child: string) => outcome());
        const { observe, settled } = forwardChildren({ register, failed });
        observe(announced("call-1"), true);
        observe(completed("call-1"), true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        observe(announced("call-2"), true);
        observe(completed("call-2"), true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(failed).toHaveBeenCalledExactlyOnceWith(reason);
        expect(await settled()).toBe(reason);
        expect(register).toHaveBeenCalledOnce();
        expect(logged).toHaveBeenCalledOnce();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
        logged.mockRestore();
      }
    },
  );
});

it("keeps a failure for the turn when the only child's report throws", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { observe, settled } = forwardChildren({
      register: async () => ({
        type: "refused",
        reason: "child_call_conflict",
      }),
      failed: () => {
        throw new Error("turn already ended");
      },
    });
    observe(announced("call-1"), true);
    observe(completed("call-1"), true);
    await flush();
    // No later child request exists to be refused: only this signal remains.
    expect(await settled()).toBe("child_call_conflict");
  } finally {
    logged.mockRestore();
  }
});

it("fails the turn for a registration still unanswered when its prompt ends", async () => {
  let answer!: (registered: ForwardChildRegistered) => void;
  const { observe, settled, failed } = tracked(
    () => new Promise((resolve) => (answer = resolve)),
  );
  observe(announced("call-1"), true);
  observe(completed("call-1"), true);
  // The prompt has ended; the registration has not been answered.
  let outcome: string | undefined | null = null;
  const checking = settled().then((failure) => (outcome = failure));
  await flush();
  expect(outcome).toBeNull();
  answer({ type: "refused", reason: "generation_ended" });
  await checking;
  expect(outcome).toBe("generation_ended");
  expect(failed).toHaveBeenCalledExactlyOnceWith("generation_ended");
});

it("fails the turn for a held registration that rejects into a throwing notifier", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let reject!: (error: unknown) => void;
    const failed = vi.fn(() => {
      throw new Error("turn already ended");
    });
    const { observe, settled } = forwardChildren({
      register: () => new Promise((_, rejected) => (reject = rejected)),
      failed,
    });
    observe(announced("call-1"), true);
    observe(completed("call-1"), true);
    // The prompt settles while the IPC answer is held: success stays blocked.
    let checked = false;
    const checking = settled().then((failure) => {
      checked = true;
      return failure;
    });
    await flush();
    expect(checked).toBe(false);
    // No later child follows.
    reject("ipc closed");
    await expect(checking).resolves.toBe("ipc closed");
    expect(failed).toHaveBeenCalledOnce();
  } finally {
    logged.mockRestore();
  }
});
