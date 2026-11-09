import { expect, it, vi } from "vitest";
import { createPcmSender } from "./sender";

it("retires a failed sender even if its owner does not abort immediately", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi.fn(async () => {
    await gate;
    throw new Error("offline");
  });
  const failed = vi.fn();
  const sender = createPcmSender(send, new AbortController().signal, failed);
  const draining = sender.send([1]);
  await sender.send([2]);
  release();
  await draining;
  await sender.send([3]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "offline" }),
  );
});

it("ignores a late failure after abort and never sends waiting frames", async () => {
  let reject!: (error: Error) => void;
  const send = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const failed = vi.fn();
  const abort = new AbortController();
  const sender = createPcmSender(send, abort.signal, failed);
  const draining = sender.send([1]);
  await sender.send([2]);
  abort.abort();
  reject(new Error("late failure"));
  await draining;
  await sender.send([3]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});

it("does not send on an already aborted call", async () => {
  const send = vi.fn(async () => {});
  const failed = vi.fn();
  const sender = createPcmSender(send, AbortSignal.abort(), failed);
  await sender.send([1]);
  expect(send).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});
