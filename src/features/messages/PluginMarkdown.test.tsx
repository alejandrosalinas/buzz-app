// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "../conversation/service";
import {
  MAX_MARKDOWN_DEPTH,
  MAX_MARKDOWN_LENGTH,
} from "../relay/message-content";
import type { RelaySession } from "../relay/session";

afterEach(cleanup);
function fixture() {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => ({ apply() {} }));
  const { Markdown } = new ConversationService(root).ui;
  return { root, runtime, Markdown };
}

it.each([
  `buzz://repo?owner=${"b".repeat(64)}&d=example`,
  "buzz://agent/new?card=example",
  "buzz://project",
])(
  "reports unavailable for viewerless internal navigation: %s",
  async (url) => {
    const { root, runtime, Markdown } = fixture();
    const open = vi.fn(async () => ({ status: "opened" as const }));
    root.provide("navigation", {
      open,
    } as unknown as import("../navigation/controller").Navigation);
    const session = {
      viewer: undefined,
      scope: "undefined:undefined",
    } as unknown as RelaySession;
    try {
      render(<Markdown session={session} content={`[Open](${url})`} />);
      await userEvent.click(screen.getByRole("link", { name: "Open" }));
      expect(
        await screen.findByText("This Buzz link couldn’t be opened here."),
      ).toBeVisible();
      expect(open).not.toHaveBeenCalled();
    } finally {
      cleanup();
      await runtime.dispose();
      await root.fiber.dispose();
    }
  },
);

it("injected Markdown preserves safe URLs, formatted Buzz links and image-as-text policy", async () => {
  const { root, runtime, Markdown } = fixture();
  const openLink = vi.fn(() => true);
  const session = {
    unread: undefined,
    channels: {
      list: () => ({ status: "ready", channels: [] }),
      describe: () => ({ state: "found", name: "Release", joined: true }),
      refer: () => () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  try {
    const { container } = render(
      <Markdown
        session={session}
        openLink={openLink}
        content={
          "**Safe**\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert%281%29)\n\n[Credentials](https://user:pass@example.com)\n\n[Relative](/settings)\n\n[Email](mailto:a@example.com)\n\n![Tracking image](https://tracker.example/p.gif)\n\n[Good](https://example.com)\n\n<buzz://channel/release>\n\n[the **release** room](buzz://channel/release)"
        }
      />,
    );
    expect(container.querySelector("strong")).toHaveTextContent("Safe");
    expect(container.querySelector("script, img")).toBeNull();
    expect(document.querySelector('link[as="image"]')).toBeNull();
    expect(screen.getByText("Tracking image")).toBeVisible();
    for (const name of ["Unsafe", "Credentials", "Relative", "Email"])
      expect(screen.getByText(name).closest("a")).toBeNull();
    expect(screen.getByRole("link", { name: "Good" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    const raw = screen.getByRole("link", { name: "#Release" });
    const formatted = screen.getByRole("link", { name: "the release room" });
    expect(formatted.querySelector("strong")).toHaveTextContent("release");
    await userEvent.click(raw);
    await userEvent.click(formatted);
    expect(openLink.mock.calls).toEqual([
      ["buzz://channel/release"],
      ["buzz://channel/release"],
    ]);
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it.each([
  "x".repeat(MAX_MARKDOWN_LENGTH + 1),
  `${"> ".repeat(MAX_MARKDOWN_DEPTH + 1)}**deep**`,
  `|${" a |".repeat(200)}\n|${" - |".repeat(200)}\n${"| x |\n".repeat(60)}`,
])("falls back to literal text beyond host parsing bounds", async (content) => {
  const { root, runtime, Markdown } = fixture();
  try {
    const { container } = render(
      <Markdown content={content} openLink={() => false} />,
    );
    expect(container.querySelector("pre")?.textContent).toBe(content);
    expect(container.querySelector("strong, blockquote, a, table")).toBeNull();
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("defaults to host Buzz navigation, lets a local override handle links, and recovers without a session", async () => {
  const { root, runtime, Markdown } = fixture();
  const open = vi.fn(async () => ({ status: "opened" as const }));
  root.provide("navigation", {
    open,
  } as unknown as import("../navigation/controller").Navigation);
  const session = {
    unread: undefined,
    viewer: "a".repeat(64),
    scope: `https://community.example:${"a".repeat(64)}`,
    channels: {
      list: () => ({ status: "ready", channels: [] }),
      describe: () => ({ state: "found", name: "Release", joined: true }),
      refer: () => () => {},
      subscribeList: () => () => {},
    },
  } as unknown as RelaySession;
  const content = "[Release](buzz://channel/release)";
  try {
    const view = render(<Markdown session={session} content={content} />);
    await userEvent.click(screen.getByRole("link", { name: "Release" }));
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "conversation",
      channelId: "release",
      scope: {
        viewer: session.viewer,
        communityOrigin: "https://community.example",
      },
    });
    const override = vi.fn(() => true);
    view.rerender(
      <Markdown session={session} content={content} openLink={override} />,
    );
    await userEvent.click(screen.getByRole("link", { name: "Release" }));
    expect(override).toHaveBeenCalledWith("buzz://channel/release");
    expect(open).toHaveBeenCalledTimes(1);
    override.mockReturnValue(false);
    await userEvent.click(screen.getByRole("link", { name: "Release" }));
    expect(open).toHaveBeenCalledTimes(2);
    view.rerender(<Markdown content={content} />);
    await userEvent.click(screen.getByRole("link", { name: "Release" }));
    expect(
      await screen.findByText("This Buzz link couldn’t be opened here."),
    ).toBeVisible();
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("uses shared code and table components without optional code actions", async () => {
  const { root, runtime, Markdown } = fixture();
  try {
    const { container } = render(
      <Markdown
        scale="document"
        content={
          "# Guide\n\n```ts\nconst ready = true;\n```\n\n| Area | State |\n| --- | --- |\n| Docs | Ready |"
        }
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Guide", level: 1 }),
    ).toBeVisible();
    expect(container.querySelector("pre code")).toHaveTextContent(
      "const ready = true;",
    );
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("cell", { name: "Ready" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Copy code block" }),
    ).toBeNull();
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});
