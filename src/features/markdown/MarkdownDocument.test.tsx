// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import remarkGfm from "remark-gfm";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { Contribution } from "../../plugins/contributions";
import type { CodeBlockRenderer } from "../conversation/contracts";
import { DOCUMENT_PROFILE, DOCUMENT_RENDER_CELLS } from "./document-profile";
import { guardDocument, parseForGuard } from "./guard";
import { MarkdownDocument, sharedComponents } from "./MarkdownDocument";
import styles from "./Markdown.module.css";

afterEach(cleanup);

const diagram: Contribution<CodeBlockRenderer> = {
  id: "diagram",
  key: "test/diagram",
  pluginId: "test",
  revision: "1",
  title: "Diagram",
  matches: (language) => language === "mermaid",
  component: ({ code }) => <figure>{code}</figure>,
};
const renderers = [diagram];
const codeBlocks = { snapshot: () => renderers, subscribe: () => () => {} };

it("styles every element as a document and offers copy and plugin blocks", () => {
  const { container } = render(
    <MarkdownDocument
      content={"# Title\n\n- item\n\n```\nplain\n```\n\n```mermaid\ngraph\n```"}
      profile={DOCUMENT_PROFILE}
      components={sharedComponents}
      capabilities={{ codeBlocks, copy: true, openLink: () => false }}
      scale="document"
      className="host"
    />,
    { wrapper: ToastProvider },
  );
  const root = container.firstElementChild;
  expect(root).toHaveClass(
    String(styles.document),
    String(styles.documentScale),
    "host",
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title");
  expect(screen.getByRole("listitem")).toHaveTextContent("item");
  expect(screen.getByRole("figure")).toHaveTextContent("graph");
  expect(
    screen.getAllByRole("button", { name: "Copy code block" }),
  ).toHaveLength(2);
});

it("leaves code plain without copy or a registry", () => {
  render(
    <MarkdownDocument
      content={"```mermaid\ngraph\n```"}
      profile={DOCUMENT_PROFILE}
      components={sharedComponents}
      scale="inherit"
    />,
  );
  expect(screen.queryByRole("figure")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("graph")).toBeInTheDocument();
});

it("keeps link elements mounted when the per-instance URL policy changes", () => {
  const draw = (base: string) => (
    <MarkdownDocument
      content="[doc](page)"
      profile={DOCUMENT_PROFILE}
      urlTransform={(url) => new URL(url, base).href}
      components={sharedComponents}
      scale="document"
    />
  );
  const view = render(draw("https://a.example/"));
  const link = screen.getByRole("link", { name: "doc" });
  expect(link).toHaveAttribute("href", "https://a.example/page");
  view.rerender(draw("https://b.example/"));
  expect(screen.getByRole("link", { name: "doc" })).toBe(link);
  expect(link).toHaveAttribute("href", "https://b.example/page");
});

it("routes links through the host when it opens them", () => {
  const openLink = vi.fn(() => true);
  render(
    <MarkdownDocument
      content="[site](https://example.com)"
      profile={DOCUMENT_PROFILE}
      components={sharedComponents}
      capabilities={{ openLink }}
      scale="document"
    />,
  );
  screen.getByRole("link", { name: "site" }).click();
  expect(openLink).toHaveBeenCalledWith("https://example.com/");
});

it("guards size, depth and expanded table cells with the profile's syntax", () => {
  const limits = { chars: 1_000_000, cells: DOCUMENT_RENDER_CELLS };
  expect(guardDocument("# fine", DOCUMENT_PROFILE, limits)).toBe(true);
  expect(guardDocument("x".repeat(11), DOCUMENT_PROFILE, { chars: 10 })).toBe(
    false,
  );
  expect(guardDocument(">".repeat(5_000), DOCUMENT_PROFILE, limits)).toBe(
    false,
  );
  const header = `|${" a |".repeat(200)}\n|${" - |".repeat(200)}\n`;
  const sparse = header + "| x |\n".repeat(60);
  expect(guardDocument(sparse, DOCUMENT_PROFILE, limits)).toBe(false);
  expect(guardDocument(sparse, DOCUMENT_PROFILE, { chars: 1e6 })).toBe(true);
  // Syntax comes from the profile: without GFM there is no table to count.
  expect(
    parseForGuard(sparse, { ...DOCUMENT_PROFILE, syntax: [] }).children.some(
      (node) => node.type === "table",
    ),
  ).toBe(false);
  expect(
    parseForGuard(sparse, {
      ...DOCUMENT_PROFILE,
      syntax: [remarkGfm],
    }).children.some((node) => node.type === "table"),
  ).toBe(true);
});
