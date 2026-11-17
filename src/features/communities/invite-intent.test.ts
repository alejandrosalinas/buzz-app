import { expect, it, vi } from "vitest";
import {
  createInviteIntent,
  joinOpening,
  offeredCommunity,
} from "./invite-intent";

it("keeps a join visit's code and connects once", () => {
  const intents = createInviteIntent();
  const listener = vi.fn();
  const stop = intents.subscribe(listener);
  intents.set("a", { viewer: "alice", code: "x", connect: true });
  intents.set("b", { viewer: "alice", code: "y", connect: false });
  intents.consume("a");
  expect(intents.get("a")).toEqual({
    viewer: "alice",
    code: "x",
    connect: false,
  });
  // Consuming again, or a visit that never connects, changes nothing.
  intents.consume("a");
  intents.consume("b");
  expect(listener).toHaveBeenCalledTimes(3);
  intents.delete((visit) => visit === "a");
  expect(intents.get("a")).toBeUndefined();
  expect(intents.get("b")?.code).toBe("y");
  stop();
});

it("keeps each opening's edited form until that opening is deleted", () => {
  const intents = createInviteIntent();
  const listener = vi.fn();
  intents.subscribe(listener);
  intents.set("a", {
    viewer: "alice",
    community: "https://b.example",
    code: "B",
    connect: false,
  });
  intents.set("b", { viewer: "bob", code: "z", connect: false });
  listener.mockClear();
  const form = { address: "https://c.example", code: "" };
  intents.edit("a", { viewer: "alice", code: "", connect: false }, form);
  // A keystroke is not a presentation change.
  expect(listener).not.toHaveBeenCalled();
  expect(intents.get("a")).toMatchObject({ code: "B", form });
  // An opening restored without state (after reload) starts from its base.
  intents.edit("r", { viewer: "alice", code: "", connect: false }, form);
  expect(intents.get("r")).toEqual({
    viewer: "alice",
    code: "",
    connect: false,
    form,
  });
  intents.delete((_visit, state) => state.viewer !== "alice");
  expect(intents.get("b")).toBeUndefined();
  intents.delete((visit) => visit === "a");
  expect(intents.get("a")).toBeUndefined();
});

it("an opening shows and offers its edited form, never its original code beside another address", () => {
  const opened = {
    viewer: "alice",
    community: "https://b.example",
    code: "B-SECRET",
    connect: false,
  };
  expect(joinOpening(opened)).toEqual({
    community: "https://b.example",
    code: "B-SECRET",
  });
  expect(offeredCommunity(opened)).toBe("https://b.example");
  const edited = { ...opened, form: { address: "wss://C.example/", code: "" } };
  expect(joinOpening(edited)).toEqual({
    community: "wss://C.example/",
    code: "",
  });
  expect(offeredCommunity(edited)).toBe("https://c.example");
  // No state (reload): the target's address alone; an emptied form still shows.
  expect(joinOpening(undefined, "https://b.example")).toEqual({
    community: "https://b.example",
    code: "",
  });
  expect(joinOpening(undefined)).toBeUndefined();
  expect(joinOpening({ ...opened, form: { address: "", code: "" } })).toEqual({
    community: "",
    code: "",
  });
  expect(
    offeredCommunity({ ...opened, form: { address: "not a url", code: "" } }),
  ).toBeUndefined();
  // The dialog also takes a bare host or an invite link as its address.
  expect(
    offeredCommunity({ ...opened, form: { address: "c.example", code: "" } }),
  ).toBe("https://c.example");
  expect(
    offeredCommunity({
      ...opened,
      form: { address: "https://c.example/invite/C-CODE", code: "C-CODE" },
    }),
  ).toBe("https://c.example");
});
