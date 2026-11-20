import { expect, it } from "vitest";
import {
  managedBy,
  managedLabel,
  offeredManaged,
  pendingManaged,
} from "./managed";
import type { ManagedEntry, ManagedPlugins } from "./types";

const entry = (id: string, state: ManagedEntry["state"]): ManagedEntry => ({
  id,
  repository: "https://example.com/plugins",
  reference: "v1",
  commit: "0".repeat(40),
  path: ".",
  state,
});
const policy = (...plugins: ManagedEntry[]): ManagedPlugins => ({
  status: "ready",
  path: "/managed-plugins.json",
  source: "Example Org",
  plugins,
  problems: [],
});

it("counts only recommendations that still need the user", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(pendingManaged(managed).map(({ id }) => id)).toEqual([
    "a.missing",
    "b.outdated",
  ]);
  expect(pendingManaged(undefined)).toEqual([]);
  expect(
    pendingManaged({ status: "invalid", path: "/p", reason: "Bad" }),
  ).toEqual([]);
});

it("attributes installed plugins to their managing source", () => {
  const managed = policy(
    entry("a.missing", "missing"),
    entry("b.outdated", "outdated"),
    entry("c.current", "current"),
    entry("d.other", "other"),
  );
  expect(managedBy(managed, "c.current")?.source).toBe("Example Org");
  expect(managedBy(managed, "b.outdated")?.source).toBe("Example Org");
  for (const id of ["a.missing", "d.other", "unlisted"])
    expect(managedBy(managed, id)).toBeUndefined();
  expect(managedBy(undefined, "c.current")).toBeUndefined();
});

it("offers manual entries only as updates to an installed copy", () => {
  const manual = (state: ManagedEntry["state"]): ManagedEntry => ({
    ...entry(`manual.${state}`, state),
    install: "manual",
  });
  const managed = policy(
    manual("missing"),
    manual("outdated"),
    manual("other"),
    { ...entry("auto.missing", "missing"), install: "automatic" },
  );
  expect(
    managed.status === "ready" &&
      managed.plugins.filter(offeredManaged).map(({ id }) => id),
  ).toEqual(["manual.outdated", "auto.missing"]);
  expect(pendingManaged(managed).map(({ id }) => id)).toEqual([
    "manual.outdated",
    "auto.missing",
  ]);
});

it("labels automatically updated plugins with their source", () => {
  const managed = policy(
    { ...entry("a.auto", "current"), update: "automatic" },
    { ...entry("b.review", "current"), update: "review" },
    entry("c.default", "current"),
  );
  expect(managedLabel(managedBy(managed, "a.auto"))).toBe(
    "Example Org · updates automatically",
  );
  expect(managedLabel(managedBy(managed, "b.review"))).toBe("Example Org");
  expect(managedLabel(managedBy(managed, "c.default"))).toBe("Example Org");
  expect(managedLabel(undefined)).toBeUndefined();
});
