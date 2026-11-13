import { createContext, useContext, type ReactNode } from "react";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { DOCUMENT_RENDER_CELLS } from "../../features/markdown/document-profile";
import { guardDocument } from "../../features/markdown/guard";
import {
  MarkdownDocument,
  MarkdownSource,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import type { MarkdownProfile } from "../../features/markdown/profiles";
import { profileKey } from "../../features/profiles/target";
import { MAX_MARKDOWN_LENGTH } from "../../features/relay/message-content";

/** Opens a link where the tab is shown; see AgentAddedTab. */
export const OpenLink = createContext<
  | {
      open(target: string): boolean;
      canOpen(target: string): boolean;
    }
  | undefined
>(undefined);

/** A person written as `[Name](nostr:npub…)` shows as their name and, where
 * the host can, opens their profile. */
function Link({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode;
}) {
  const links = useContext(OpenLink);
  if (!href) return <span>{children}</span>;
  if (profileKey(href))
    return links?.canOpen(href) ? (
      <button
        type="button"
        className="attention-link"
        onClick={() => links.open(href)}
      >
        {children}
      </button>
    ) : (
      <span>{children}</span>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

// Instructions sit in a dense list: headings keep label roles (compact scale).
const PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [],
  html: "literal",
  urlTransform: (url) =>
    /^(https?:|mailto:|buzz:|nostr:|#)/i.test(url) ? url : "",
};
const components: Components = {
  ...sharedComponents,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
};

const CLASS = "attention-markdown text-body-sm text-secondary";

export function InstructionsMarkdown({ text }: { text: string }) {
  if (
    !guardDocument(text, PROFILE, {
      chars: MAX_MARKDOWN_LENGTH,
      cells: DOCUMENT_RENDER_CELLS,
    })
  )
    return <MarkdownSource content={text} className={CLASS} />;
  return (
    <MarkdownDocument
      content={text}
      profile={PROFILE}
      components={components}
      scale="compact"
      className={CLASS}
    />
  );
}
