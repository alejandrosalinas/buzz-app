// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HashIcon,
  LockIcon,
  TableIcon,
} from "../../shared/design-system/icons/index";
import styles from "../../shared/InlineReference.module.css";
import { InlineLink, LinkLabel, linkKind } from "./InlineLink";
import { apply } from "./index";
import type { LinkRenderer } from "../../features/conversation/contracts";
import {
  LinkLabelContext,
  LinkContentContext,
  LinkChannelKindContext,
} from "../../features/conversation/LinkLabelContext";

function textOf(markup: string) {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container.textContent;
}

it("claims recognised services and Buzz entities by default and unknown websites as a catch-all", () => {
  let renderer: LinkRenderer | undefined;
  apply({
    conversation: { registerLink: (value: LinkRenderer) => (renderer = value) },
  } as never);
  const order = renderer?.order;
  if (typeof order !== "function")
    throw new Error("expected an order function");
  expect(order("https://github.com/block/buzz")).toBe(0);
  expect(order("https://docs.google.com/document/d/1")).toBe(0);
  expect(order("buzz://channel/general")).toBe(0);
  expect(order("https://example.com/")).toBe(100);
});

it("identifies exact GitHub hosts, ordinary websites, and Buzz entity links", () => {
  expect(linkKind("https://github.com/block/buzz")).toBe("github");
  expect(linkKind("https://github.com.example.com/block/buzz")).toBe("web");
  expect(linkKind("https://example.com/github.com")).toBe("web");
  expect(linkKind(`buzz://repo?owner=${"a".repeat(64)}&d=buzz`)).toBe("buzz");
});

it.each([
  ["buzz://channel/general", "channel", "Channel", "hash"],
  [
    `buzz://message?channel=general&id=${"a".repeat(64)}`,
    "message",
    "Message",
    "message-2",
  ],
  [
    `buzz://message?channel=general&id=${"a".repeat(64)}&thread=${"b".repeat(64)}`,
    "thread",
    "Thread",
    "message-2",
  ],
  [
    "buzz://plugin-install?repository=example-org%2Fexample-plugin&ref=main",
    "plugin",
    "Plugin",
    "layout-grid",
  ],
])(
  "renders semantic Buzz labels and icons for %s",
  (href, kind, label, icon) => {
    const html = renderToStaticMarkup(<InlineLink href={href} />);
    expect(html).toContain(`data-link-kind="${kind}"`);
    expect(html).toContain(`tabler-icon-${icon}`);
    expect(textOf(html)).toBe(label);
    expect(html).toContain('href="buzz://');
  },
);

it("keeps an install link's authored label beside the plugin icon", () => {
  const href =
    "buzz://plugin-install?repository=example-org%2Fexample-plugin&ref=main";
  const markup = renderToStaticMarkup(
    <InlineLink href={href}>Click to install</InlineLink>,
  );
  expect(markup).toContain("tabler-icon-layout-grid");
  expect(textOf(markup)).toBe("Click to install");
});

it("renders private channel links with the design-system lock icon", () => {
  const markup = renderToStaticMarkup(
    <LinkChannelKindContext value="private">
      <InlineLink href="buzz://channel/private">#private</InlineLink>
    </LinkChannelKindContext>,
  );
  // A little apart from the name, where a public channel's hash sits flush.
  expect(markup).toContain(
    renderToStaticMarkup(
      <LockIcon className={`${styles.icon} ${styles.snug}`} />,
    ),
  );
  expect(textOf(markup)).toBe("private");
});

it("uses the Solo bubble and keeps the full authored chat title", () => {
  const markup = renderToStaticMarkup(
    <LinkChannelKindContext value="chat">
      <InlineLink href="buzz://channel/solo">#Design notes</InlineLink>
    </LinkChannelKindContext>,
  );
  expect(markup).toContain('data-link-kind="chat"');
  expect(markup).toContain("tabler-icon-message-circle");
  expect(textOf(markup)).toBe("#Design notes");
});

it("renders public channel links with the hash flush against the name", () => {
  const markup = renderToStaticMarkup(
    <InlineLink href="buzz://channel/public">#public</InlineLink>,
  );
  expect(markup).toContain(
    renderToStaticMarkup(
      <HashIcon className={`${styles.icon} ${styles.flush}`} />,
    ),
  );
  expect(textOf(markup)).toBe("public");
});

it("shows a supplied icon in place of the service's, with the label intact", () => {
  const href = "https://github.com/block/buzz/pull/1234";
  const icon = <TableIcon data-supplied="" className={styles.icon} />;
  const markup = renderToStaticMarkup(
    <LinkLabel href={href} label="Fix the lab" icon={icon} />,
  );
  expect(markup).toContain(renderToStaticMarkup(icon));
  expect(markup).not.toContain("tabler-icon-brand-github");
  expect(textOf(markup)).toBe("Fix the lab");
  // Authored formatting takes the supplied icon too.
  const formatted = renderToStaticMarkup(
    <LinkContentContext value={<em>Fix</em>}>
      <LinkLabel href={href} label="Fix" icon={icon} />
    </LinkContentContext>,
  );
  expect(formatted).toContain(renderToStaticMarkup(icon));
  expect(formatted).toContain("<em>Fix</em>");
});

it.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  "data:text/html,hello",
  "//github.com/block/buzz",
  "buzz://unknown",
  "not a URL",
])("leaves unsupported destinations as plain text: %s", (href) => {
  expect(linkKind(href)).toBeNull();
  expect(
    renderToStaticMarkup(<InlineLink href={href}>Reference</InlineLink>),
  ).toBe("Reference");
});

it("preserves the destination and readable full label", () => {
  const href = "https://github.com/block/buzz/issues/1234";
  const markup = renderToStaticMarkup(
    <InlineLink href={href} target="_blank" rel="noreferrer" />,
  );
  expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain('data-kind="github"');
  expect(markup).toContain('aria-hidden="true"');
  expect(textOf(markup)).toBe(href);
});

it.each([
  ["https://drive.google.com/drive/folders/example", "drive"],
  ["https://docs.google.com/document/d/example/edit", "document"],
  ["https://docs.google.com/spreadsheets/d/example/edit", "spreadsheet"],
  ["https://docs.google.com/presentation/d/example/edit", "presentation"],
  ["https://docs.google.com/forms/d/example/edit", "drive"],
])("recognizes Google Drive file types: %s", (url, kind) => {
  expect(linkKind(url)).toBe(kind);
});

it.each([
  ["https://www.figma.com/design/example", "figma"],
  ["https://www.notion.so/example", "notion"],
  ["https://team.notion.site/example", "notion"],
  ["https://workspace.slack.com/archives/example", "slack"],
  ["https://www.dropbox.com/scl/fi/example", "dropbox"],
  ["https://db.tt/example", "dropbox"],
  ["https://onedrive.live.com/?id=example", "onedrive"],
  ["https://1drv.ms/w/example", "onedrive"],
  ["https://example-my.sharepoint.com/personal/example", "onedrive"],
  ["https://example.sharepoint.com/sites/example", "web"],
  ["https://example-my.sharepoint.com.evil.test/personal/example", "web"],
  ["https://gitlab.com/example/project", "gitlab"],
  ["https://www.youtube.com/watch?v=example", "youtube"],
  ["https://youtu.be/example", "youtube"],
  ["https://www.loom.com/share/example", "loom"],
  ["https://us02web.zoom.us/j/example", "zoom"],
  ["https://zoom.com/j/example", "zoom"],
  ["https://teams.microsoft.com/l/meetup-join/example", "teams"],
  ["https://teams.live.com/meet/example", "teams"],
  ["https://teams.cloud.microsoft/l/meetup-join/example", "teams"],
])("renders the service icon for %s", (href, kind) => {
  expect(linkKind(href)).toBe(kind);
  const markup = renderToStaticMarkup(<InlineLink href={href} />);
  expect(markup).toContain(`data-link-kind="${kind}"`);
  expect(markup).toContain(`href="${href}"`);
});

it.each([45, 46])(
  "caps raw URL labels at 45 characters (source length %i)",
  (length) => {
    const href = "https://figma.com/design/".padEnd(length, "a");
    const markup = renderToStaticMarkup(<InlineLink href={href} />);
    const text = textOf(markup);
    expect(markup).toContain(`href="${href}"`);
    expect(text).toBe(
      length <= 45 ? href : `${href.slice(0, 34)}…${href.slice(-10)}`,
    );
  },
);

it("distinguishes long raw URLs by their final ten characters", () => {
  const prefix = "https://example.test/appsecreporter/dashboard/bundles/";
  const suffixes = ["0123456789", "abcdefghij", "klmnopqrst"];
  const labels = suffixes.map((suffix) => {
    const href = `${prefix}${"a".repeat(48)}${suffix}`;
    const markup = renderToStaticMarkup(<InlineLink href={href} />);
    expect(markup).toContain(`href="${href}"`);
    const text = textOf(markup) ?? "";
    expect(Array.from(text)).toHaveLength(45);
    expect(text).toBe(`https://example.test/appsecreporte…${suffix}`);
    return text;
  });
  expect(new Set(labels).size).toBe(3);
});

it("keeps whole Unicode code points at both ends of a shortened URL", () => {
  const href = `https://example.test/${"a".repeat(12)}😀${"b".repeat(20)}😀123456789`;
  const markup = renderToStaticMarkup(<InlineLink href={href} />);
  expect(textOf(markup)).toBe(
    `https://example.test/${"a".repeat(12)}😀…😀123456789`,
  );
  expect(Array.from(textOf(markup) ?? "")).toHaveLength(45);
});

it("preserves authored labels on long URLs", () => {
  const href = `https://figma.com/design/${"a".repeat(100)}`;
  const label = "View the full design and all of the discussion notes";
  const markup = renderToStaticMarkup(
    <InlineLink href={href}>{label}</InlineLink>,
  );
  expect(textOf(markup)).toBe(label);
  expect(markup).toContain(`href="${href}"`);
});

it("truncates a Unicode URL when Markdown encodes its destination", () => {
  const label =
    "https://www.figma.com/design/example/Builderlab-Café-Branding?node-id=1119-21207";
  const href = new URL(label).href;
  const markup = renderToStaticMarkup(
    <LinkLabelContext value={label}>
      <LinkContentContext value={[label]}>
        <LinkLabel href={href} />
      </LinkContentContext>
    </LinkLabelContext>,
  );
  expect(textOf(markup)).toBe(`${label.slice(0, 34)}…${label.slice(-10)}`);
});

it.each(["figma.com", "teams.microsoft.com"])(
  "does not brand lookalike destinations for %s",
  (host) => {
    expect(linkKind(`https://${host}.example.com/file`)).toBe("web");
    expect(linkKind(`https://fake${host}/file`)).toBe("web");
    expect(linkKind(`https://example.com/${host}`)).toBe("web");
    expect(linkKind(`https://${host}@example.com/file`)).toBe("web");
  },
);
it("does not mistake lookalike hosts or URL paths for Google Drive", () => {
  expect(linkKind("https://drive.google.com.example.com/file")).toBe("web");
  expect(linkKind("https://example.com/drive.google.com")).toBe("web");
});

it.each([false, true])(
  "renders a neutral table glyph for Google Sheets, including rich labels (%s)",
  (rich) => {
    const href = "https://docs.google.com/spreadsheets/d/example/edit";
    const markup = renderToStaticMarkup(
      <LinkContentContext
        value={rich ? <strong>the tracker</strong> : undefined}
      >
        <InlineLink href={href}>the tracker</InlineLink>
      </LinkContentContext>,
    );
    expect(markup).toContain(
      renderToStaticMarkup(<TableIcon className={styles.icon} />),
    );
    expect(markup).toContain(`href="${href}"`);
    expect(textOf(markup)).toBe("the tracker");
  },
);

it("keeps the icon with the whole first character of a label", () => {
  const markup = renderToStaticMarkup(
    <LinkLabelContext value="👩🏽‍💻-builders">
      <LinkLabel href="buzz://channel/builders" />
    </LinkLabelContext>,
  );
  const container = document.createElement("div");
  container.innerHTML = markup;
  expect(container.querySelector(`.${styles.lead}`)?.textContent).toBe(
    "👩🏽‍💻",
  );
  expect(container.textContent).toBe("👩🏽‍💻-builders");
});
