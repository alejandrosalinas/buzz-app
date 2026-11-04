// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { flush, keypair, scriptedTransport, signed } from "../relay/testing";
import type { UserStatus } from "../relay/user-status";
import { StatusDisplay } from "./StatusDisplay";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const beeUrl = "https://emoji.test/bee.png";
const catalogUrl = "https://emoji.test/bee-catalog.png";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
function harness(status: UserStatus) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession(wire.transport, {
    outboxStorage: { load: () => [], save() {} },
  });
  owners.push(owner);
  const { session } = owner;
  const view = (status: UserStatus) => (
    <>
      <section aria-label="Full">
        <StatusDisplay status={status} session={session} />
      </section>
      <section aria-label="Compact">
        <StatusDisplay compact status={status} session={session} />
      </section>
    </>
  );
  const { rerender } = render(view(status));
  const catalogRead = () =>
    wire.pending.find((entry) => entry.filters[0]?.kinds?.includes(30030));
  return {
    update: (next: UserStatus) => rerender(view(next)),
    full: within(screen.getByRole("region", { name: "Full" })),
    compact: screen.getByRole("img", { name: `${status.emoji} Buzzin'` }),
    catalogRead,
    async respondCatalog(tags: string[][]) {
      const read = catalogRead();
      if (!read) throw new Error("No catalog read");
      await act(async () => {
        read.respond([
          signed(other, {
            kind: 30030,
            content: "",
            tags: [["d", "buzz:custom-emoji"], ...tags],
          }),
        ]);
        await flush();
      });
    },
  };
}
const status = (emoji: string, emojiUrl?: string): UserStatus => ({
  userId: other.pubkey,
  text: "Buzzin'",
  emoji,
  ...(emojiUrl ? { emojiUrl } : {}),
  updatedAt: 1,
});
async function tooltip(trigger: HTMLElement) {
  act(() => trigger.focus());
  return screen.findByRole("tooltip");
}
/** A full status's emoji is not focusable; its name hint opens on hover alone. */
async function hint(emoji: HTMLElement) {
  fireEvent.mouseEnter(emoji);
  fireEvent.mouseMove(emoji);
  const tip = await screen.findByRole("tooltip");
  fireEvent.mouseLeave(emoji);
  return tip;
}

it("renders a status's own image in every mode without reading the catalog", async () => {
  const h = harness(status(":bee:", beeUrl));
  expect(h.full.getByRole("img", { name: ":bee:" })).toHaveAttribute(
    "src",
    beeUrl,
  );
  const decorative = h.compact.querySelector("img");
  expect(decorative).toHaveAttribute("src", beeUrl);
  expect(decorative).toHaveAttribute("alt", "");
  expect(
    await hint(h.full.getByRole("img", { name: ":bee:" })),
  ).toHaveTextContent(/^:bee:$/);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  const tip = await tooltip(h.compact);
  expect(tip.querySelector("img")).toHaveAttribute("src", beeUrl);
  expect(tip).toHaveTextContent(/^Buzzin'$/);
  expect(h.catalogRead()).toBeUndefined();
  // A failed image falls back to the catalog, then degrades like an unresolved code.
  if (decorative) fireEvent.error(decorative);
  expect(h.compact).toHaveTextContent(/^$/);
  await h.respondCatalog([["emoji", "bee", catalogUrl]]);
  const fallback = h.compact.querySelector("img");
  expect(fallback).toHaveAttribute("src", catalogUrl);
  if (fallback) fireEvent.error(fallback);
  expect(h.compact).toHaveTextContent(/^💬$/);
});

it("names a Unicode status emoji on hover, as reactions do", async () => {
  const h = harness(status("🏠"));
  expect(await hint(h.full.getByText("🏠"))).toHaveTextContent(/^:house:$/);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  // The compact slot's hint already shows the whole status, so it stays as is.
  expect(await tooltip(h.compact)).toHaveTextContent(/^🏠Buzzin'$/);
  expect(h.compact).toHaveAccessibleName("🏠 Buzzin'");
  // A status that changes between a glyph and an image keeps its hint.
  act(() => h.compact.blur());
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  h.update(status(":bee:", beeUrl));
  expect(
    await hint(h.full.getByRole("img", { name: ":bee:" })),
  ).toHaveTextContent(/^:bee:$/);
});

it("gives free text in the emoji slot no name", async () => {
  const h = harness(status("🐝 working from the office"));
  // Completion barrier: the hint's name table has loaded.
  await act(() => import("../messages/reaction-name"));
  const glyph = h.full.getByText("🐝 working from the office");
  vi.useFakeTimers();
  try {
    fireEvent.mouseEnter(glyph);
    fireEvent.mouseMove(glyph);
    // Past the hint's rest delay, hover has still opened nothing.
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("tooltip")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
  expect(await tooltip(h.compact)).toHaveTextContent(
    /^🐝 working from the officeBuzzin'$/,
  );
});

it("resolves from the catalog when a status's own URL is not loadable", async () => {
  const h = harness(status(":bee:", "http://emoji.test/bee.png"));
  expect(h.compact).toHaveTextContent(/^$/);
  await h.respondCatalog([["emoji", "bee", catalogUrl]]);
  expect(h.full.getByRole("img", { name: ":bee:" })).toHaveAttribute(
    "src",
    catalogUrl,
  );
  expect(h.compact.querySelector("img")).toHaveAttribute("src", catalogUrl);
});

it("resolves a two-value status from the community catalog", async () => {
  const h = harness(status(":bee:"));
  await h.respondCatalog([["emoji", "bee", beeUrl]]);
  expect(h.full.getByRole("img", { name: ":bee:" })).toHaveAttribute(
    "src",
    beeUrl,
  );
  expect(h.compact.querySelector("img")).toHaveAttribute("src", beeUrl);
});

it("reserves an unresolved code's space while loading, then shows 💬 when compact and text elsewhere", async () => {
  const h = harness(status(":wasp:"));
  expect(h.catalogRead()).toBeDefined();
  expect(h.compact).toHaveTextContent(/^$/);
  expect(h.full.getByRole("img", { name: ":wasp:" })).toHaveTextContent(/^$/);
  await h.respondCatalog([["emoji", "bee", beeUrl]]);
  expect(h.compact).toHaveTextContent(/^💬$/);
  expect(h.compact).toHaveAccessibleName(":wasp: Buzzin'");
  expect(h.full.queryByRole("img")).toBeNull();
  expect(h.full.getByText(":wasp:")).toBeVisible();
  expect(h.full.getByText("Buzzin'")).toBeVisible();
  const tip = await tooltip(h.compact);
  expect(within(tip).getByText(":wasp:")).toBeVisible();
  expect(within(tip).queryByText("💬")).toBeNull();
});
