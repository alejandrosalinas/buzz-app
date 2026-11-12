// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  isSignInLink,
  onSignInRequest,
  requestSignIn,
  takeSignInRequest,
} from "./sign-in-requests";

afterEach(() => {
  takeSignInRequest();
});

it("accepts only the bare sign-in link", () => {
  expect(isSignInLink("buzz://sign-in")).toBe(true);
  expect(isSignInLink("buzz://sign-in/")).toBe(true);
  expect(isSignInLink("BUZZ://SIGN-IN")).toBe(true);
  expect(isSignInLink("buzz://sign-in?next=x")).toBe(false);
  expect(isSignInLink("buzz://sign-in/extra")).toBe(false);
  expect(isSignInLink("buzz://sign-in#x")).toBe(false);
  expect(isSignInLink("https://sign-in")).toBe(false);
});

it("notifies listeners and is consumed once", () => {
  const listener = vi.fn();
  const stop = onSignInRequest(listener);
  requestSignIn();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(takeSignInRequest()).toBe(true);
  expect(takeSignInRequest()).toBe(false);
  stop();
  requestSignIn();
  expect(listener).toHaveBeenCalledTimes(1);
});

it("expires a request nobody took", () => {
  requestSignIn(0);
  expect(takeSignInRequest(2 * 60_000 + 1)).toBe(false);
});

it("a restart's note becomes one request at the next launch, unless it went stale", async () => {
  const launch = async () => {
    vi.resetModules();
    return import("./sign-in-requests");
  };
  const first = await launch();
  const withdraw = first.requestSignInAfterRestart();
  const next = await launch();
  expect(next.takeSignInRequest()).toBe(true);
  expect(next.takeSignInRequest()).toBe(false);
  expect((await launch()).takeSignInRequest()).toBe(false);

  first.requestSignInAfterRestart(undefined, Date.now() - 10 * 60_000);
  expect((await launch()).takeSignInRequest()).toBe(false);

  first.requestSignInAfterRestart();
  withdraw();
  expect((await launch()).takeSignInRequest()).toBe(false);
});

it("a restart's note names the linked key its sign-in expects, once, and only while the note is fresh", async () => {
  const launch = async () => {
    vi.resetModules();
    return import("./sign-in-requests");
  };
  const first = await launch();
  first.requestSignInAfterRestart("aa");
  const next = await launch();
  expect(next.takeSignInRequest()).toBe(true);
  expect(next.takeExpectedKey()).toBe("aa");
  expect(next.takeExpectedKey()).toBeUndefined();

  // A stale note expects nothing, and neither does a later Open Buzz.
  first.requestSignInAfterRestart("aa", Date.now() - 10 * 60_000);
  const stale = await launch();
  stale.requestSignIn();
  expect(stale.takeSignInRequest()).toBe(true);
  expect(stale.takeExpectedKey()).toBeUndefined();

  // A withdrawn note leaves no key behind.
  const withdraw = first.requestSignInAfterRestart("aa");
  withdraw();
  first.requestSignInAfterRestart();
  const plain = await launch();
  expect(plain.takeSignInRequest()).toBe(true);
  expect(plain.takeExpectedKey()).toBeUndefined();
});

it("a restart's note is saved with its key or not at all, even when storage refuses a write", async () => {
  const launch = async () => {
    vi.resetModules();
    return import("./sign-in-requests");
  };
  const first = await launch();
  // Storage takes one write, then refuses: a note armed without its key
  // would let the sign-in after Replace into another account.
  const write = Storage.prototype.setItem;
  let writes = 0;
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (writes++ > 0) throw new DOMException("full", "QuotaExceededError");
      write.call(this, key, value);
    });
  try {
    first.requestSignInAfterRestart("aa");
  } finally {
    setItem.mockRestore();
  }
  const next = await launch();
  expect(next.takeSignInRequest()).toBe(true);
  expect(next.takeExpectedKey()).toBe("aa");

  // Storage that refuses every write saves no note.
  const refuse = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  try {
    first.requestSignInAfterRestart("aa");
  } finally {
    refuse.mockRestore();
  }
  const refused = await launch();
  expect(refused.takeSignInRequest()).toBe(false);
  expect(refused.takeExpectedKey()).toBeUndefined();
});

it("an earlier build's note, the bare time, still signs in, expecting no key", async () => {
  vi.resetModules();
  localStorage.setItem("buzz.sign-in-after-restart.v1", String(Date.now()));
  const next = await import("./sign-in-requests");
  expect(next.takeSignInRequest()).toBe(true);
  expect(next.takeExpectedKey()).toBeUndefined();
});
