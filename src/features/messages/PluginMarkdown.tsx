import { useMemo } from "react";
import {
  DOCUMENT_PROFILE,
  fitsDocumentRenderBudget,
} from "../markdown/document-profile";
import {
  MarkdownDocument,
  MarkdownSource,
  sharedComponents,
} from "../markdown/MarkdownDocument";
import { buzzLinkTarget } from "../navigation/buzz-links";
import type { Navigation } from "../navigation/controller";
import type { RelaySession } from "../relay/session";
import { splitPartition } from "../relay/partition";

/** Host document rendering with optional local link handling before host navigation. */
export type MarkdownProps = {
  content: string;
  session?: RelaySession | undefined;
  /** Heading roles: message by default, document for a page's hierarchy. */
  scale?: "message" | "document" | undefined;
  /** True handles the link locally; false falls through to the host. */
  openLink?: ((url: string) => boolean) | undefined;
};

/** Installed documents use the host's parsing bounds, URL rules and rich links. */
export function PluginMarkdown({
  content,
  session,
  scale = "message",
  openLink,
  navigation,
}: MarkdownProps & { navigation?: Navigation | undefined }) {
  const plain = useMemo(() => !fitsDocumentRenderBudget(content), [content]);
  return plain ? (
    <MarkdownSource content={content} />
  ) : (
    <MarkdownDocument
      content={content}
      profile={DOCUMENT_PROFILE}
      components={sharedComponents}
      scale={scale}
      capabilities={{
        session,
        openLink: (url) => {
          if (openLink?.(url)) return true;
          const scope = session?.viewer
            ? splitPartition(session.scope)
            : undefined;
          if (!scope?.viewer || !navigation) return false;
          const target = buzzLinkTarget(url, scope);
          if (!target) return false;
          void navigation.open(target);
          return true;
        },
      }}
    />
  );
}
