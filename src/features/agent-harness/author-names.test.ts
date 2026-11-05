import { afterEach, expect, it, vi } from "vitest";
import type { EventData } from "../relay/events";
import type { VerifiedProfile } from "../relay/verified-profile";
import { profileNames } from "../agents/reads";
import { AUTHOR_NAMES_TIMEOUT_MS, readAuthorNames } from "./author-names";

afterEach(() => {
  vi.useRealTimers();
});

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const relay = "c".repeat(64);
const message = (pubkey: string, tags: string[][] = []) =>
  ({ pubkey, tags }) as unknown as EventData;

const verified = {
  displayName: "Alice S",
  username: "asmith",
} as VerifiedProfile;

it("gives a verified username and display name, and no self-declared username", () => {
  expect(profileNames({ name: "Alice S", verified }, alice)).toEqual({
    username: "asmith",
    display_name: "Alice S",
  });
  // A profile's own handle is no verified username.
  expect(profileNames({ name: " Bob ", username: "bob" }, bob)).toEqual({
    display_name: "Bob",
  });
  // A key fragment, an empty name or one no person could have is no name.
  expect(
    profileNames({ name: "npub1abc", nameIsFallback: true }, bob),
  ).toBeUndefined();
  expect(profileNames({ name: " " }, bob)).toBeUndefined();
  expect(profileNames({ name: "x".repeat(65) }, bob)).toBeUndefined();
  expect(profileNames({ name: "Bob\u200b" }, bob)).toBeUndefined();
  expect(profileNames(undefined, bob)).toBeUndefined();
});

it("keeps a verified display name the directory qualified, but no self-declared one", () => {
  // Someone else shares her verified display name or username: she is still
  // addressed by her own display name, and tagged by her username.
  expect(
    profileNames({ name: `Alice S (${alice.slice(0, 10)})`, verified }, alice),
  ).toEqual({ username: "asmith", display_name: "Alice S" });
  // A self-declared name that imitates a verified one.
  expect(
    profileNames({ name: `Alice S (${bob.slice(0, 10)})` }, bob),
  ).toBeUndefined();
});

it("reads each author's profile once before naming them", async () => {
  const profiles = vi.fn(async () => {});
  const authorNames = vi.fn((pubkey: string) =>
    pubkey === alice ? { display_name: "Alice" } : undefined,
  );
  const name = await readAuthorNames({ profiles, authorNames }, [
    message(alice),
    message(bob),
    message(alice),
  ]);
  expect(profiles).toHaveBeenCalledExactlyOnceWith([alice, bob]);
  expect(name(alice)).toEqual({ display_name: "Alice" });
  expect(name(bob)).toBeUndefined();
});

it("reads the profile of the person a relay-signed message is for", async () => {
  const profiles = vi.fn(async () => {});
  await readAuthorNames(
    { profiles, authorNames: () => undefined },
    [message(relay, [["actor", alice]]), message(bob, [["actor", alice]])],
    relay,
  );
  // Only the signing authority's own messages are someone else's.
  expect(profiles).toHaveBeenCalledExactlyOnceWith([alice, bob]);
});

it("starts the turn without names when profiles are slow or fail", async () => {
  vi.useFakeTimers();
  const authorNames = () => ({ display_name: "Alice" });
  const slow = readAuthorNames(
    { profiles: () => new Promise(() => {}), authorNames },
    [message(alice)],
  );
  await vi.advanceTimersByTimeAsync(AUTHOR_NAMES_TIMEOUT_MS);
  expect((await slow)(alice)).toEqual({ display_name: "Alice" });
  const failed = await readAuthorNames(
    { profiles: () => Promise.reject(new Error("offline")), authorNames },
    [message(alice)],
  );
  expect(failed(alice)).toEqual({ display_name: "Alice" });
  expect((await readAuthorNames(undefined, [message(alice)]))(alice)).toBe(
    undefined,
  );
});
