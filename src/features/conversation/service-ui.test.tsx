// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";

const dispose: (() => Promise<unknown>)[] = [];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  cleanup();
  for (const release of dispose.splice(0)) await release();
  if (originalScrollIntoView)
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("renders controlled native reply grouping through a retained reader's UI", async () => {
  const host = new Context();
  const runtime = new PluginRuntime(host, async () => ({ apply() {} }));
  const conversation = new ConversationService(host);
  dispose.push(async () => {
    await runtime.dispose();
    await host.fiber.dispose();
  });

  function RetainedReader({ replies }: { replies: readonly string[] }) {
    const [open, setOpen] = useState(false);
    const h = createElement;

    return h(
      "section",
      { "aria-label": "Retained messages" },
      h(conversation.ui.ReplyBranch, {
        message: h("div", { "data-message-id": "root" }, "Root message"),
        layout: "thread",
        summary: h(conversation.ui.ReplySummary, {
          count: replies.length,
          participants: [],
          resolveName: (_id, fallback) => fallback,
          media: () => undefined,
        }),
        label: replies.length
          ? `View ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
          : "View thread",
        collapseLabel: "Collapse replies",
        hasReplies: replies.length > 0,
        open,
        depth: 0,
        onExpand: () => setOpen(true),
        onCollapse: () => setOpen(false),
        children: replies.map((id) =>
          h("div", { key: id, "data-message-id": id }, id),
        ),
      }),
    );
  }

  const user = userEvent.setup();
  const reader = (replies: readonly string[]) =>
    createElement(StrictMode, null, createElement(RetainedReader, { replies }));
  const view = render(reader([]));

  view.rerender(reader(["reply-one"]));
  const summary = screen.getByRole("button", { name: "View 1 reply" });
  expect(screen.getByText("1 reply")).toBeInTheDocument();

  await user.click(summary);
  expect(await screen.findByText("reply-one")).toHaveFocus();

  const collapse = screen.getByRole("button", { name: "Collapse replies" });
  await user.click(collapse);
  const collapsedSummary = screen.getByRole("button", {
    name: "View 1 reply",
  });
  await waitFor(() => expect(collapsedSummary).toHaveFocus());

  await user.click(collapsedSummary);
  expect(await screen.findByText("reply-one")).toHaveFocus();
  const collapseAgain = screen.getByRole("button", {
    name: "Collapse replies",
  });
  collapseAgain.focus();
  view.rerender(reader([]));

  await waitFor(() => expect(screen.getByText("Root message")).toHaveFocus());
  expect(
    screen.queryByRole("button", { name: /View .* replies?/ }),
  ).not.toBeInTheDocument();
});
