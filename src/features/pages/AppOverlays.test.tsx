// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { bundledOwner } from "../../plugins/provenance";
import { AppOverlays } from "./AppOverlays";
import { PagesService } from "./service";

it("shows bundled plugins' overlays over the app, and only theirs", () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const pages = new PagesService(ctx);
  const installed = ctx.extend({
    pluginOwner: Object.freeze({ id: "someone.else", revision: "1" }),
  }).pages;
  expect(() =>
    installed.registerOverlay({ id: "notice", component: () => null }),
  ).toThrow(/bundled plugins/);
  const bundled = ctx.extend({
    pluginOwner: bundledOwner(
      Object.freeze({ id: "org.example", revision: "bundled" }),
    ),
  }).pages;
  expect(() =>
    bundled.registerOverlay({ id: "Bad Id", component: () => null }),
  ).toThrow(/needs an id/);
  // Registering only goes through that check.
  expect(installed.overlays).not.toHaveProperty("register");
  render(<AppOverlays pages={pages} />);
  act(() =>
    bundled.registerOverlay({ id: "notice", component: () => <p>Hello</p> }),
  );
  expect(screen.getByText("Hello")).toBeTruthy();
});
