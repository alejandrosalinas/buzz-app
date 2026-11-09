import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserService } from "./service";
import type { BrowserPlatform } from "./platform";

const contexts: Context[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

function platform(available: boolean): BrowserPlatform {
  return {
    available,
    attach: vi.fn(),
    setBounds: vi.fn(),
    setMediaSuspended: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn(),
    detach: vi.fn(),
    openExternal: vi.fn(),
  };
}

it("exposes availability and a host View", () => {
  const context = new Context();
  contexts.push(context);
  new BrowserService(context, platform(true));
  expect(context.browser.available).toBe(true);
  expect(typeof context.browser.View).toBe("function");
});
