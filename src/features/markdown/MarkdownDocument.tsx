import { createContext, useContext, type ReactElement } from "react";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import type {
  CodeBlockRenderer,
  ContributionReader,
} from "../conversation/contracts";
import { MessageLink } from "../conversation/MessageLink";
import { labelText } from "../messages/label-text";
import type { RelaySession } from "../relay/session";
import { CodeFence, observeTableOverflow } from "./code-blocks";
import type { MarkdownProfile } from "./profiles";
import styles from "./Markdown.module.css";

/** Heading roles: messages', a document's, a compact list's, or the host's. */
export type HeadingScale = "message" | "document" | "compact" | "inherit";

/** Per-render inputs the stable shared components read. */
export type MarkdownCapabilities = Readonly<{
  /** Routes links through `MessageLink`; without it links open externally. */
  openLink?: ((url: string) => boolean) | undefined;
  session?: RelaySession | undefined;
  /** Plugin code-block renderers; without them blocks stay plain. */
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
  /** A copy action on code blocks. */
  copy?: boolean | undefined;
}>;

const CapabilitiesContext = createContext<MarkdownCapabilities>({});

const SCALES: Record<HeadingScale, string | undefined> = {
  message: styles.message,
  document: styles.documentScale,
  compact: styles.compact,
  inherit: undefined,
};

/** Component types stay module-stable, so a re-render never remounts a
 * focused link or a plugin block; what changes per render is read here. */
export const sharedComponents: Components = {
  a: function SharedLink({ href, children }) {
    const { openLink, session } = useContext(CapabilitiesContext);
    if (!href) return children;
    if (!openLink)
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    // A raw autolink shows its destination's name, as in messages.
    const label = labelText(children);
    const raw = label === href;
    return (
      <MessageLink
        url={href}
        label={raw ? undefined : label}
        registry={undefined}
        session={session}
        onOpenLink={openLink}
      >
        {raw ? undefined : children}
      </MessageLink>
    );
  },
  img: ({ alt }) =>
    alt ? <span className={styles.imageAlt}>{alt}</span> : null,
  pre: function SharedCode(props) {
    const { codeBlocks, copy } = useContext(CapabilitiesContext);
    return <CodeFence {...props} copy={copy} registry={codeBlocks} />;
  },
  table: ({ node: _node, ...props }) => (
    <table ref={observeTableOverflow} {...props} />
  ),
};

/** A Markdown document with the shared element styles and components. The
 * screen supplies its profile, its components (module constants that spread
 * `sharedComponents`), and its trust policy. */
export function MarkdownDocument({
  content,
  profile,
  urlTransform,
  components,
  capabilities,
  scale,
  className,
}: {
  content: string;
  profile: MarkdownProfile;
  /** A URL policy bound to the current item; overrides the profile's. */
  urlTransform?: UrlTransform | undefined;
  components: Components;
  capabilities?: MarkdownCapabilities | undefined;
  scale: HeadingScale;
  /** The host's layout and spacing only. */
  className?: string | undefined;
}): ReactElement {
  const transform = urlTransform ?? profile.urlTransform;
  return (
    <div
      className={[styles.document, SCALES[scale], className]
        .filter(Boolean)
        .join(" ")}
    >
      <CapabilitiesContext value={capabilities ?? {}}>
        <Markdown
          remarkPlugins={[...profile.syntax, ...profile.transforms]}
          components={components}
          skipHtml={profile.html === "omit"}
          {...(transform ? { urlTransform: transform } : {})}
        >
          {content}
        </Markdown>
      </CapabilitiesContext>
    </div>
  );
}

/** A document too large or too deep to render, shown as its wrapped source. */
export function MarkdownSource({
  content,
  className,
}: {
  content: string;
  className?: string | undefined;
}): ReactElement {
  return (
    <div className={[styles.document, className].filter(Boolean).join(" ")}>
      <pre className={styles.source}>
        <code>{content}</code>
      </pre>
    </div>
  );
}
