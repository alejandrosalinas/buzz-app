import { readView, writeView } from "../../shared/view-state";

// Kept on this device for the account and community (the usage scope).
const KEY = "search-recent";
const LIMIT = 6;

/** The searches last run here, newest first. */
export function readRecentSearches(scope: string): string[] {
  const saved = readView<unknown>(scope, KEY, []);
  return Array.isArray(saved)
    ? saved.filter((item): item is string => typeof item === "string")
    : [];
}

/** Remembers `query` as the newest search, once. */
export function recordRecentSearch(scope: string, query: string) {
  const text = query.replace(/\s+/g, " ").trim();
  if (text.length < 2) return;
  const rest = readRecentSearches(scope).filter(
    (item) => item.toLowerCase() !== text.toLowerCase(),
  );
  writeView(scope, KEY, [text, ...rest].slice(0, LIMIT));
}
