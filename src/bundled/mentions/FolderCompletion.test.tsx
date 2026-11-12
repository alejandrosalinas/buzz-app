// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { saveRepositoriesFolder } from "../../features/communities/repositories";
import type { CompletionResult } from "../../features/conversation/contracts";
import { FolderCompletion, folderQuery } from "./FolderCompletion";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("matches `!` only at a word start before a query character, never in image syntax or mid-word", () => {
  for (const text of ["!n", "use !no", "(!no", "[!no", "{!no", "\n!no"])
    expect(folderQuery(text, text.length)).toEqual({
      start: text.lastIndexOf("!"),
      end: text.length,
      query: text.slice(text.lastIndexOf("!") + 1),
    });
  expect(folderQuery("use !my notes", 13)?.query).toBe("my notes");
  // An image earlier in the text does not stop a later folder query.
  expect(folderQuery("![a](b.png) !no", 15)).toEqual({
    start: 12,
    end: 15,
    query: "no",
  });
  for (const text of [
    // A bare `!`, or one followed by a space, is prose.
    "!",
    "use !",
    "Merci !",
    "Merci ! more",
    "! n",
    "!\tn",
    "hi!",
    "wow!!",
    "!!",
    "say hi! no",
    "![",
    "![alt",
    "![alt](https://example.org/a.png)",
    "see ![alt](a.png) more",
  ])
    expect(folderQuery(text, text.length)).toBeNull();
  expect(folderQuery("!no", 9)).toBeNull();
  // The bounded look-back starting at a `!` inside a word is no boundary.
  const word = `${"x".repeat(10)}!${"n".repeat(159)}`;
  expect(folderQuery(word, word.length)).toBeNull();
});

const folderViewer = "a".repeat(64);
/** One `!` query at position 0 in `channelId`'s composer. `remount` swaps in a
 * new provider in one commit, as the host does per keystroke; `close` ends
 * the query. */
function showFolders(channelId: string, query: string) {
  let publish = vi.fn();
  let mounts = 0;
  const element = (text: string) => (
    <FolderCompletion
      key={mounts++}
      scope={`https://one.example:${folderViewer}`}
      channelId={channelId}
      publish={publish}
      query={{ start: 0, end: text.length + 1, query: text }}
    />
  );
  const view = render(element(query));
  const last = () => publish.mock.lastCall?.[0] as CompletionResult | undefined;
  return {
    view,
    last,
    publishes: () =>
      publish.mock.calls.map(
        ([result]) => result as CompletionResult | undefined,
      ),
    items: () => last()?.items ?? [],
    /** Closing is its own input event; the next one starts after it ends. */
    async close() {
      view.unmount();
      await act(async () => {});
    },
    remount(text: string) {
      publish = vi.fn();
      view.rerender(element(text));
    },
  };
}

it("offers the repositories folder's folders as chips, listed once per query; a browser build never lists it", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const rows = [
    { name: "notes", path: "/code/notes", displayPath: "~/code/notes" },
    { name: "site", path: "/code/site", displayPath: "~/code/site" },
  ];
  vi.mocked(invoke).mockReset().mockResolvedValue(rows);
  const first = showFolders("one", "no");
  await waitFor(() =>
    expect(first.items()).toEqual([
      {
        id: "folder:/code/notes",
        label: "notes",
        detail: "Local folder · ~/code/notes",
        edit: {
          token: { kind: "folder", id: "/code/notes", label: "notes" },
        },
      },
    ]),
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith("repositories_folder_list", {
    path: "~/.buzz/REPOS",
  });
  // The host remounts the provider per keystroke; the query keeps its listing.
  first.remount("not");
  await waitFor(() =>
    expect(first.items().map((item) => item.id)).toEqual([
      "folder:/code/notes",
    ]),
  );
  expect(invoke).toHaveBeenCalledOnce();
  // A query that names no folder is prose: nothing is offered.
  first.remount("note to self");
  await act(async () => {});
  expect(first.last()).toBeUndefined();
  first.view.unmount();

  vi.mocked(invoke).mockRejectedValueOnce(
    new Error("The configured repositories folder is unavailable."),
  );
  const failed = showFolders("two", "n");
  await waitFor(() =>
    expect(failed.last()?.status).toBe(
      "The configured repositories folder is unavailable.",
    ),
  );
  expect(failed.items()).toEqual([]);
  failed.view.unmount();

  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(false);
  const ordinary = showFolders("three", "n");
  await act(async () => {});
  expect(ordinary.last()).toBeUndefined();
  ordinary.view.unmount();
  expect(invoke).not.toHaveBeenCalled();
});

it("a `!` query reopened at the same position, after a preference change, or retried after a failed read lists the folders again; a closed query's late listing never publishes", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const row = (name: string, root: string) => ({
    name,
    path: `${root}/${name}`,
    displayPath: `${root}/${name}`,
  });
  const listings: {
    path: string;
    resolve(rows: unknown): void;
    reject(error: Error): void;
  }[] = [];
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(
      (_command, args) =>
        new Promise((resolve, reject) =>
          listings.push({
            path: (args as { path: string }).path,
            resolve,
            reject,
          }),
        ),
    );
  const folders = (shown: ReturnType<typeof showFolders>) =>
    shown.items().map((item) => item.label);
  saveRepositoriesFolder("https://one.example", folderViewer, "/code/old");
  const open = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(1));
  listings[0]?.resolve([row("old", "/code/old")]);
  await waitFor(() => expect(folders(open)).toEqual(["old"]));
  await open.close();

  // Reopened at the same position with the same preference: a fresh read.
  const again = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(2));
  expect(listings[1]?.path).toBe("/code/old");
  listings[1]?.resolve([row("again", "/code/old")]);
  await waitFor(() => expect(folders(again)).toEqual(["again"]));
  await again.close();

  // A changed preference lists the new folder.
  saveRepositoriesFolder("https://one.example", folderViewer, "/code/new");
  const changed = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(3));
  expect(listings[2]?.path).toBe("/code/new");
  listings[2]?.resolve([row("new", "/code/new")]);
  await waitFor(() => expect(folders(changed)).toEqual(["new"]));
  // So does one changed while the query is open, at its next keystroke.
  saveRepositoriesFolder("https://one.example", folderViewer, "/code/newer");
  changed.remount("n");
  await waitFor(() => expect(listings).toHaveLength(4));
  expect(listings[3]?.path).toBe("/code/newer");
  listings[3]?.resolve([row("newer", "/code/newer")]);
  await waitFor(() => expect(folders(changed)).toEqual(["newer"]));
  await changed.close();

  // A failed read stays for the open query's keystrokes; Retry reads again.
  const failing = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(5));
  listings[4]?.reject(new Error("Folder unavailable"));
  await waitFor(() =>
    expect(failing.last()?.status).toBe("Folder unavailable"),
  );
  failing.remount("n");
  await waitFor(() =>
    expect(failing.last()?.status).toBe("Folder unavailable"),
  );
  expect(listings).toHaveLength(5);
  act(() => failing.last()?.retry?.());
  await waitFor(() => expect(listings).toHaveLength(6));
  listings[5]?.resolve([row("newer", "/code/newer")]);
  await waitFor(() => expect(folders(failing)).toEqual(["newer"]));
  await failing.close();

  // A query closed while its read is pending never shows that read.
  const closed = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(7));
  await closed.close();
  const reopened = showFolders("reopen", "");
  await waitFor(() => expect(listings).toHaveLength(8));
  listings[6]?.resolve([row("late", "/code/newer")]);
  listings[7]?.resolve([row("current", "/code/newer")]);
  // The later read settles after the earlier one.
  await waitFor(() => expect(folders(reopened)).toEqual(["current"]));
  expect(
    [...closed.publishes(), ...reopened.publishes()].some((result) =>
      result?.items.some((item) => item.label === "late"),
    ),
  ).toBe(false);
  reopened.view.unmount();
});
