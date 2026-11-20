// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageLink } from "../../features/conversation/MessageLink";
import type { LinkRenderer } from "../../features/conversation/contracts";
import type { Contribution } from "../../plugins/contributions";
import { apply } from "./index";

afterEach(cleanup);

const renderers: Contribution<LinkRenderer>[] = [];
apply({
  conversation: {
    registerLink: (value: LinkRenderer) =>
      renderers.push({
        ...value,
        key: `buzz.links/${value.id}`,
        pluginId: "buzz.links",
        revision: "test",
      }),
  },
} as never);
const markdown: Contribution<LinkRenderer> = {
  id: "markdown",
  key: "md-reader/markdown",
  pluginId: "md-reader",
  revision: "test",
  title: "Markdown",
  matches: (url) =>
    url.startsWith("https://") &&
    url.includes("github") &&
    /\.md(?:[?#]|$)/i.test(url),
  order: -10,
  component: () => <>Generic document</>,
};
const entries = [markdown, ...renderers];
const registry = { snapshot: () => entries, subscribe: () => () => {} };

it.each([
  "https://github.com/example-org/example-repo/blob/main/skills/pr-ship/SKILL.md",
  "https://www.github.com/example-org/example-repo/raw/main/skills/pr-ship/SKILL.md?raw=1#usage",
  "https://raw.githubusercontent.com/example-org/example-repo/refs/heads/main/skills/pr-ship/SKILL.md",
  "https://github.com/example-org/example-repo/blob/refs/tags/v1/pr-ship/SKILL.md",
])(
  "names a skill ahead of generic Markdown and keeps navigation: %s",
  (url) => {
    const open = vi.fn(() => true);
    render(
      <MessageLink
        url={url}
        label="SKILL.md"
        registry={registry}
        onOpenLink={open}
      >
        <code>SKILL.md</code>
      </MessageLink>,
    );
    const link = screen.getByRole("link", {
      name: "Skill: pr-ship · example-org/example-repo",
    });
    expect(link).toHaveAttribute("data-link-label", "SKILL.md");
    expect(link.textContent).toBe("Skill: pr-ship · example-org/example-repo");
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(open).toHaveBeenCalledExactlyOnceWith(url);
    expect(click.defaultPrevented).toBe(true);
    const modified = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    link.dispatchEvent(modified);
    expect(open).toHaveBeenCalledTimes(1);
    expect(modified.defaultPrevented).toBe(false);
  },
);

it("preserves formatted section labels and their distinct destinations", () => {
  const url =
    "https://github.com/example-org/example-repo/blob/main/pr-ship/SKILL.md";
  render(
    <>
      <MessageLink url={url} registry={registry} onOpenLink={() => true} />
      <MessageLink
        url={`${url}#install`}
        label="Install"
        registry={registry}
        onOpenLink={() => true}
      >
        <strong>Install</strong>
      </MessageLink>
      <MessageLink
        url={`${url}#rollback`}
        label="Rollback"
        registry={registry}
        onOpenLink={() => true}
      >
        <em>Rollback</em>
      </MessageLink>
    </>,
  );
  const install = screen.getByRole("link", { name: "Install" });
  expect(install.querySelector("strong")).toHaveTextContent("Install");
  expect(install).toHaveAttribute("href", `${url}#install`);
  const rollback = screen.getByRole("link", { name: "Rollback" });
  expect(rollback.querySelector("em")).toHaveTextContent("Rollback");
  expect(rollback).toHaveAttribute("href", `${url}#rollback`);
  const bare = screen.getByRole("link", {
    name: "Skill: pr-ship · example-org/example-repo",
  });
  expect(bare).toHaveAttribute("href", url);
});

it.each([
  "https://github.com/example-org/example-repo/blob/main/pr-ship/README.md",
  "https://github.com/example-org/example-repo/blob/main/SKILL.md",
  "https://github.com/example-org/example-repo/tree/main/pr-ship/SKILL.md",
  "https://github.com.example.com/example-org/example-repo/blob/main/pr-ship/SKILL.md",
  "https://github.com/example-org/example-repo/blob/main/pr%2Fship/SKILL.md",
  "https://github.com/example-org/example-repo/blob/main/%ZZ/SKILL.md",
])("preserves generic document presentation: %s", (url) => {
  render(<MessageLink url={url} registry={registry} onOpenLink={() => true} />);
  expect(
    screen.getByRole("link", { name: "Generic document" }),
  ).toHaveAttribute("href", url);
});

it("keeps local skill links on the host fallback", () => {
  const url = "/Users/example/skills/pr-ship/SKILL.md";
  render(
    <MessageLink
      url={url}
      label="Local skill"
      registry={registry}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByRole("link", { name: "Local skill" })).toHaveAttribute(
    "href",
    url,
  );
});

it("retires the skill name when its renderer is removed", () => {
  const url =
    "https://github.com/example-org/example-repo/blob/main/pr-ship/SKILL.md";
  const { rerender } = render(
    <MessageLink
      url={url}
      label="SKILL.md"
      registry={registry}
      onOpenLink={() => true}
    />,
  );
  expect(
    screen.getByRole("link", {
      name: "Skill: pr-ship · example-org/example-repo",
    }),
  ).toHaveAttribute("data-link-label", "SKILL.md");
  rerender(
    <MessageLink
      url={url}
      label="SKILL.md"
      registry={undefined}
      onOpenLink={() => true}
    />,
  );
  expect(screen.getByRole("link", { name: "SKILL.md" })).toHaveTextContent(
    "SKILL.md",
  );
});
