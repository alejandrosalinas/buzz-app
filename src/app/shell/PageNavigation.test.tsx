// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { ACTIVITY_PAGE, ActivityEmojiContext } from "./activity-context";
import { PageNavigation } from "./PageNavigation";

afterEach(cleanup);

const activity: RegisteredPage = {
  key: ACTIVITY_PAGE,
  pluginId: "buzz.inbox",
  id: "inbox",
  title: "Activity",
  revision: "bundled",
  primary: true,
  component: () => null,
};

it("swaps the sidebar Activity row's bell for the latest reaction emoji", () => {
  const row = (emoji?: { content: string; active: boolean }) => (
    <ActivityEmojiContext value={emoji}>
      <PageNavigation
        pages={[activity]}
        selected="buzz.channels/channels"
        onSelect={() => {}}
      />
    </ActivityEmojiContext>
  );
  const view = render(row());
  const button = screen.getByRole("button", { name: "Activity" });
  expect(button.querySelector("svg")).toBeInTheDocument();
  expect(button.querySelector("[data-active]")).toBeNull();

  view.rerender(row({ content: "🎉", active: true }));
  // The emoji is decoration; the row keeps its name.
  expect(screen.getByRole("button", { name: "Activity" })).toBe(button);
  expect(button.querySelector("[data-active]")).toHaveTextContent("🎉");
});
