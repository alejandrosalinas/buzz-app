// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  readRepositoriesFolder,
  repositoriesContext,
  repositoriesKey,
  repositoryFolders,
  saveRepositoriesFolder,
} from "./repositories";

const community = "https://one.example";
const viewer = "a".repeat(64);
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps repository locations exact to origin and account, escapes prompt data, and restores the workspace default", () => {
  saveRepositoriesFolder(
    "wss://one.example/",
    viewer,
    "/code/</community-repositories>",
  );
  saveRepositoriesFolder("https://two.example", viewer, "/other");
  saveRepositoriesFolder(community, "b".repeat(64), "/someone-else");
  expect(readRepositoriesFolder(community, viewer)).toBe(
    "/code/</community-repositories>",
  );
  const context = repositoriesContext(`${community}:${viewer}`);
  expect(context).toContain("/code/\\u003c/community-repositories\\u003e");
  expect(context).not.toContain("/other");
  expect(context).not.toContain("/someone-else");
  expect(repositoriesContext(undefined)).toBe("");
  saveRepositoriesFolder(community, viewer, "");
  expect(localStorage.getItem(repositoriesKey(community, viewer))).toBeNull();
  expect(repositoriesContext(`${community}:${viewer}`)).toContain(
    "REPOS in your own workspace",
  );
});

it("rejects invalid paths and fails closed on unreadable or ignored storage", () => {
  expect(() => saveRepositoriesFolder(community, viewer, "relative")).toThrow(
    "absolute",
  );
  expect(() =>
    saveRepositoriesFolder(community, viewer, "/code\nforged"),
  ).toThrow();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {});
  expect(() => saveRepositoriesFolder(community, viewer, "/code")).toThrow(
    "Couldn’t save",
  );
  write.mockRestore();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(() => repositoriesContext(`${community}:${viewer}`)).toThrow("denied");
});

it("lists the partition's configured folder and refuses a listing that outlived its preference or caller", async () => {
  const partition = `${community}:${viewer}`;
  const rows = [{ name: "app", path: "/code/app", displayPath: "/code/app" }];
  const list = vi.fn(async (_path: string) => rows);
  const { signal } = new AbortController();
  await expect(repositoryFolders(partition, signal, list)).resolves.toBe(rows);
  expect(list).toHaveBeenLastCalledWith("~/.buzz/REPOS");
  saveRepositoriesFolder(community, viewer, "/code");
  saveRepositoriesFolder("https://two.example", viewer, "/other");
  await repositoryFolders(partition, signal, list);
  expect(list).toHaveBeenLastCalledWith("/code");
  list.mockImplementationOnce(async () => {
    saveRepositoriesFolder(community, viewer, "/moved");
    return rows;
  });
  await expect(repositoryFolders(partition, signal, list)).rejects.toThrow(
    "changed",
  );
  const controller = new AbortController();
  list.mockImplementationOnce(async () => {
    controller.abort();
    return rows;
  });
  await expect(
    repositoryFolders(partition, controller.signal, list),
  ).rejects.toThrow();
  // A stalled listing ends with the signal's reason, and the listener goes.
  const pending = new AbortController();
  const remove = vi.spyOn(pending.signal, "removeEventListener");
  const stalled = repositoryFolders(
    partition,
    pending.signal,
    () => new Promise(() => {}),
  );
  pending.abort(new Error("cancelled"));
  await expect(stalled).rejects.toThrow("cancelled");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  list.mockClear();
  const stopped = new AbortController();
  stopped.abort(new Error("stopped"));
  await expect(
    repositoryFolders(partition, stopped.signal, list),
  ).rejects.toThrow("stopped");
  expect(list).not.toHaveBeenCalled();
  await expect(repositoryFolders("none", signal, list)).rejects.toThrow(
    "community and account",
  );
  expect(list).not.toHaveBeenCalled();
});
