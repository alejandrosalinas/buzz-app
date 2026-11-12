// @vitest-environment jsdom
import { isTauri } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const context = (spawn?: () => Promise<never>) => ({
  host: { spawn },
  effect: vi.fn(),
  relay: { snapshot: vi.fn(), subscribe: vi.fn() },
  conversation: { registerAccessory: vi.fn() },
  panels: { register: vi.fn() },
});
const run = (ctx: ReturnType<typeof context>) =>
  apply(ctx as unknown as Parameters<typeof apply>[0]);

it("does nothing in the browser", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const spawn = vi.fn();
  const ctx = context(spawn as never);
  run(ctx);
  expect(ctx.effect).not.toHaveBeenCalled();
  expect(ctx.conversation.registerAccessory).not.toHaveBeenCalled();
  expect(ctx.panels.register).not.toHaveBeenCalled();
  expect(ctx.relay.subscribe).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("does nothing on a desktop without process support", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const ctx = context(undefined);
  run(ctx);
  expect(ctx.conversation.registerAccessory).not.toHaveBeenCalled();
});

it("adds the card and its panel on desktop", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const ctx = context(vi.fn() as never);
  run(ctx);
  expect(ctx.conversation.registerAccessory).toHaveBeenCalledWith(
    expect.objectContaining({ placement: "message" }),
  );
  const panel = ctx.panels.register.mock.calls[0]?.[0];
  expect(
    panel.matches(
      "https://changeset.buzz.changesets.invalid/?turn=a1&checkout=0",
    ),
  ).toBe(true);
  expect(panel.matches("https://example.com/")).toBe(false);
  expect(ctx.effect).toHaveBeenCalledOnce();
});
