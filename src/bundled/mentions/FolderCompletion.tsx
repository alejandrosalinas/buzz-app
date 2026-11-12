import { invoke } from "@tauri-apps/api/core";
import { useLayoutEffect } from "react";
import {
  repositoriesFolder,
  repositoryFolders,
  type RepositoryFolder,
} from "../../features/communities/repositories";
import type { HostCompletionResult } from "../../features/conversation/completion";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import { useHeldListing } from "./held-listing";

/** `!` after a boundary, as `@` mentions are matched, once a query character
 * follows it. A bare `!` or one followed by a space is prose, and `![` starts
 * Markdown image syntax. */
export function folderQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])!([^![\s][^![\n\r\t]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

function preference(scope: string) {
  try {
    return repositoriesFolder(scope);
  } catch {
    // The listing reports why the folder cannot be read.
    return "";
  }
}

/** `!` on desktop offers the immediate folders of the community's
 * repositories folder as folder chips. */
export function FolderCompletion({
  scope,
  channelId,
  threadRootId,
  query,
  publish,
}: Pick<
  ComposerCompletionProps,
  "scope" | "channelId" | "threadRootId" | "query" | "publish"
>) {
  // The host remounts this provider on every keystroke. One `!` token in one
  // composer, under one preference, is the lifetime that lists the folders once.
  const folders = useHeldListing(
    JSON.stringify([
      "folders",
      scope,
      channelId,
      threadRootId,
      query.start,
      preference(scope),
    ]),
    (signal) =>
      repositoryFolders(scope, signal, (path) =>
        invoke<readonly RepositoryFolder[]>("repositories_folder_list", {
          path,
        }),
      ),
  );
  useLayoutEffect(() => {
    if (!folders) return;
    const needle = query.query.trim().toLowerCase();
    const items = folders.rows
      .filter((folder) => folder.name.toLowerCase().includes(needle))
      .map((folder) => ({
        id: `folder:${folder.path}`,
        label: folder.name,
        detail: `Local folder · ${folder.displayPath}`,
        edit: {
          token: {
            kind: "folder" as const,
            id: folder.path,
            label: folder.name,
          },
        },
      }));
    // A query that names no folder is prose, not a search.
    if (!items.length && !folders.error) return;
    const result: HostCompletionResult = folders.error
      ? { items, status: folders.error, retry: folders.retry }
      : { items };
    // The host accepts a chip edit only from a bundled provider.
    const withdraw = publish(result as unknown as CompletionResult);
    return () => {
      if (withdraw) withdraw();
    };
  }, [folders, query.query, publish]);
  return null;
}
