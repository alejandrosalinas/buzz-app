import { createContext, useContext, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { profileKey } from "../../features/profiles/target";

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

const components: Components = {
  h1: ({ children }) => <h1 className="text-label text-primary">{children}</h1>,
  h2: ({ children }) => (
    <h2 className="text-label-sm text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-label-sm text-primary">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-label-sm text-primary">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-label-sm text-primary">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-label-sm text-primary">{children}</h6>
  ),
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ alt }) => alt ?? "",
};

export function InstructionsMarkdown({ text }: { text: string }) {
  return (
    <div className="attention-markdown text-body-sm text-secondary">
      <Markdown
        components={components}
        urlTransform={(url) =>
          /^(https?:|mailto:|buzz:|nostr:|#)/i.test(url) ? url : ""
        }
      >
        {text}
      </Markdown>
    </div>
  );
}
