import {
  type ComponentProps,
  createContext,
  type ReactElement,
  useContext,
  useState,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import { DOCUMENT_PROFILE } from "../../features/markdown/document-profile";
import {
  MarkdownDocument,
  SharedLink,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import markdownStyles from "../../features/markdown/Markdown.module.css";
import type { MarkdownProfile } from "../../features/markdown/profiles";
import type { RelaySession } from "../../features/relay/session";
import styles from "./FileViewer.module.css";

export type MediaSource = (url: string) => string | undefined;

type PartActions = Readonly<{
  media: MediaSource | undefined;
  onAnchor(id: string): void;
}>;

const PartContext = createContext<PartActions>({
  media: undefined,
  onAnchor: () => {},
});

function fragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

function PartLink(props: ComponentProps<"a"> & ExtraProps) {
  const { onAnchor } = useContext(PartContext);
  const { node: _node, href, onClick: _onClick, ...rest } = props;
  if (!href?.startsWith("#")) return <SharedLink {...props} />;
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onAnchor(fragment(href));
      }}
    />
  );
}

/** Community media draws; anything else, such as a remote image that could
 * act as a tracking beacon, stays as its alt text. */
function PartImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  const { media } = useContext(PartContext);
  const source = typeof src === "string" ? media?.(src) : undefined;
  const [failed, setFailed] = useState(false);
  if (!source || failed)
    return alt ? <span className={markdownStyles.imageAlt}>{alt}</span> : null;
  return (
    <img
      className={styles.picture}
      src={source}
      alt={alt ?? ""}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

const components: Components = {
  ...sharedComponents,
  a: PartLink,
  img: PartImage,
};

/** One part of a Markdown file, with the Canvas and Notes trust rules plus the
 * viewer's own: part-aware transforms, community images and `#` links that
 * move within the file. */
export function PartMarkdown({
  content,
  transforms,
  rehype,
  openLink,
  session,
  media,
  onAnchor,
}: {
  content: string;
  transforms: MarkdownProfile["transforms"];
  rehype: NonNullable<MarkdownProfile["rehype"]>;
  openLink(url: string): boolean;
  session: RelaySession | undefined;
  media: MediaSource | undefined;
  onAnchor(id: string): void;
}): ReactElement {
  const profile: MarkdownProfile = {
    ...DOCUMENT_PROFILE,
    transforms,
    rehype,
  };
  return (
    <PartContext value={{ media, onAnchor }}>
      <MarkdownDocument
        content={content}
        profile={profile}
        urlTransform={(url, key, node) =>
          url.startsWith("#")
            ? url
            : (DOCUMENT_PROFILE.urlTransform?.(url, key, node) ?? null)
        }
        components={components}
        capabilities={{ openLink, session, copy: true }}
        scale="document"
      />
    </PartContext>
  );
}
