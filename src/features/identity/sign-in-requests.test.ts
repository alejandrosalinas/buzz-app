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

  first.requestSignInAfterRestart(Date.now() - 10 * 60_000);
  expect((await launch()).takeSignInRequest()).toBe(false);

  first.requestSignInAfterRestart();
  withdraw();
  expect((await launch()).takeSignInRequest()).toBe(false);
});
