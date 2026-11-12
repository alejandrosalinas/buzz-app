import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { PhrasingContent, Root, RootContent } from "mdast";
import { MediaAttachment } from "../../features/messages/MediaAttachment";
import { AudioAttachment } from "../../features/messages/AudioAttachment";
import {
  MAX_MARKDOWN_LENGTH,
  MAX_MARKDOWN_DEPTH,
  scanMarkdown,
} from "../../features/relay/message-content";
import {
  attachmentFor,
  attachmentMetadata,
  bodyUrl,
  inertHtml,
  signedUrl,
} from "./attachments";
import styles from "./GitHub.module.css";

function containsImage(node: NonNullable<ExtraProps["node"]>): boolean {
  return (
    node.tagName === "img" ||
    node.children.some(
      (child) => child.type === "element" && containsImage(child),
    )
  );
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : "";
    })
    .join("");
}

// Extract content into Markdown nodes; HTML elements and attributes stay inert.
function htmlContent(html: string): PhrasingContent[] {
  const convert = (node: ChildNode, depth: number): PhrasingContent[] => {
    if (node.nodeType === Node.TEXT_NODE)
      return [{ type: "text", value: node.textContent ?? "" }];
    if (!(node instanceof Element)) return [];
    if (depth > MAX_MARKDOWN_DEPTH)
      return [{ type: "text", value: node.outerHTML }];
    if (node.localName === "img")
      return [
        {
          type: "image",
          url: node.getAttribute("src") ?? "",
          alt: node.getAttribute("alt") ?? "",
        },
      ];

    const children = [...node.childNodes].flatMap((child) =>
      convert(child, depth + 1),
    );
    const destination = node.getAttribute(
      node.localName === "a" ? "href" : "src",
    );
    if (
      destination &&
      ["a", "video", "audio", "source"].includes(node.localName)
    ) {
      const label = [{ type: "text" as const, value: destination }];
      if (
        node.localName === "a" &&
        !children.some((child) => child.type === "link")
      )
        return [
          {
            type: "link",
            url: destination,
            children: children.length ? children : label,
          },
        ];
      return [{ type: "link", url: destination, children: label }, ...children];
    }
    if (["br", "hr"].includes(node.localName)) return [{ type: "break" }];
    // Adjacent table cells need a separator; rows already break below.
    if (["td", "th"].includes(node.localName))
      return [...children, { type: "text", value: " " }];
    if (
      [
        "details",
        "summary",
        "div",
        "p",
        "blockquote",
        "li",
        "tr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].includes(node.localName)
    )
      return [{ type: "break" }, ...children, { type: "break" }];
    return children;
  };
  return [...inertHtml(html).childNodes].flatMap((node) => convert(node, 0));
}

// A lone opening anchor tag yields its destination; anything else does not.
function anchorHref(html: string): string | null {
  if (!/^<a(\s[^<>]*)?>$/i.test(html.trim())) return null;
  return inertHtml(html).querySelector("a")?.getAttribute("href") ?? null;
}

function githubHtml() {
  return (tree: Root) => {
    const visit = (parent: { type: string; children: RootContent[] }) => {
      const block = ["root", "blockquote", "listItem"].includes(parent.type);
      const result: RootContent[] = [];
      for (let index = 0; index < parent.children.length; index++) {
        const node = parent.children[index];
        if (!node) continue;
        if (node.type !== "html") {
          if ("children" in node) visit(node);
          result.push(node);
          continue;
        }
        // micromark splits an inline HTML anchor into opening-tag, label and
        // closing-tag siblings; rejoin the pair so the label stays linked.
        const href = anchorHref(node.value);
        const closing =
          href === null
            ? -1
            : parent.children.findIndex(
                (sibling, at) =>
                  at > index &&
                  sibling.type === "html" &&
                  /^<\/a\s*>$/i.test(sibling.value.trim()),
              );
        let content: PhrasingContent[];
        if (href !== null && closing !== -1) {
          const label = {
            type: "paragraph",
            children: parent.children.slice(index + 1, closing),
          };
          visit(label);
          content = [
            {
              type: "link",
              url: href,
              children: label.children as PhrasingContent[],
            },
          ];
          index = closing;
        } else {
          content = htmlContent(node.value);
        }
        if (block) result.push({ type: "paragraph", children: content });
        else result.push(...content);
      }
      parent.children = result;
    };
    visit(tree);
  };
}

function EmbeddedAttachment({
  source,
  signed,
  children,
  fallback,
  caption,
  onMedia,
}: {
  source: string;
  /** The latest signed link for `source` in the rendered HTML. */
  signed?: string | undefined;
  children(src: string): ReactNode;
  fallback: ReactNode;
  caption: ReactNode;
  /** The signed link `src` loaded, or failed. */
  onMedia?: ((loaded: boolean, src: string) => void) | undefined;
}) {
  const [loaded, setLoaded] = useState(false);
  // Media loads its own link first. When that fails it takes the signed link,
  // and when that fails the next one read; a working link stays, so media
  // does not reload or restart when the body is read again.
  const [shown, setShown] = useState(source);
  const [failed, setFailed] = useState(false);
  if (failed && signed && signed !== shown) {
    setShown(signed);
    setFailed(false);
  }
  const show = (next: boolean) => {
    setLoaded(next);
    setFailed(!next);
    if (shown !== source) onMedia?.(next, shown);
  };
  return (
    <div
      className={styles.attachment}
      onLoadCapture={() => show(true)}
      onLoadedDataCapture={() => show(true)}
      // A video player reloads after a network failure (code 2) on its own,
      // so that keeps its link and only shows the original link until the
      // video loads again. An expired or missing link fails as unsupported
      // (code 4) in Chromium and WebKit, and takes another link. Audio has no
      // quiet reload, so any audio failure does.
      onLoadedMetadataCapture={() => setLoaded(true)}
      onErrorCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLVideoElement && target.error?.code === 2) {
          setLoaded(false);
          return;
        }
        show(false);
      }}
    >
      {/* Media keeps a failure until remounted with a new source. */}
      <Fragment key={shown}>{children(shown)}</Fragment>
      {loaded ? caption : fallback}
    </div>
  );
}

type Media = (
  source: string,
  label: ReactNode,
  image?: boolean,
  description?: string,
) => ReactNode;
const MediaContext = createContext<Media>((source) => source);

// Stable across renders, so a body read again keeps its media elements.
const components: Components = {
  // Players are block elements, including when embedded in prose.
  p: ({ children }) => <div className={styles.paragraph}>{children}</div>,
  a: function MarkdownLink({ href, children, node }) {
    const media = useContext(MediaContext);
    if (!href) return <>{children}</>;
    if (node && containsImage(node))
      return (
        <div>
          {children}
          <a href={href} target="_blank" rel="noreferrer">
            {href}
          </a>
        </div>
      );
    return media(href, children, false, plainText(children) || undefined);
  },
  img: function MarkdownImage({ src, alt }) {
    const media = useContext(MediaContext);
    return typeof src === "string" && src ? media(src, alt, true, alt) : alt;
  },
  table: ({ children }) => (
    <div className={styles.tableScroll}>
      <table>{children}</table>
    </div>
  ),
};

const RETRY_DELAY = 30_000;
const MAX_RETRIES = 3;

/** A private repository's media links need a GitHub sign-in; `bodyHtml` has
 * signed links for them that expire within minutes and change on every read.
 * Media whose own link fails takes its signed link, and when that fails reads
 * GitHub again with `refresh` and takes the link read. Each source reads at
 * once only on its first failure; when a read leaves media failed with no
 * newer link to try, it reads again after 30 seconds, at most three times.
 * So a mount reads at most once per signed source plus three times. */
export const GitHubBody = memo(function GitHubBody({
  body,
  bodyHtml,
  url,
  refresh,
}: {
  body: string;
  bodyHtml?: string | undefined;
  url: string;
  refresh?: (() => Promise<unknown>) | undefined;
}) {
  const bounded = useMemo(
    () => body.length <= MAX_MARKDOWN_LENGTH && !scanMarkdown(body).tooDeep,
    [body],
  );
  const metadata = useMemo(
    () => (bounded ? attachmentMetadata(bodyHtml) : new Map()),
    [bounded, bodyHtml],
  );
  // One read at a time, and at most once per signed source plus three
  // retries per mount: a source that already read at once (`tried`, kept
  // through loads) waits for a retry. `failed` keeps each source's failed
  // signed link until a signed link for it loads.
  const failed = useRef(new Map<string, string>());
  const tried = useRef(new Set<string>());
  const reading = useRef(false);
  const retry = useRef<{
    timer?: ReturnType<typeof setTimeout> | undefined;
    count: number;
    stopped?: boolean;
  }>({ count: 0 });
  // A retry reads with the latest body's links and refresh.
  const latest = useRef({ metadata, refresh });
  useEffect(() => {
    latest.current = { metadata, refresh };
  }, [metadata, refresh]);
  useEffect(() => {
    const state = retry.current;
    state.stopped = false;
    return () => {
      state.stopped = true;
      clearTimeout(state.timer);
      state.timer = undefined;
    };
  }, []);
  if (!bounded) return <div className={styles.plainBody}>{body}</div>;

  // Failed media whose latest signed link is the one that failed.
  const stuck = () =>
    [...failed.current].some(
      ([source, link]) => signedUrl(source, latest.current.metadata) === link,
    );
  const read = () => {
    const current = latest.current.refresh;
    if (!current) return;
    reading.current = true;
    const done = () => {
      reading.current = false;
      later();
    };
    current().then(done, done);
  };
  const later = () => {
    const state = retry.current;
    if (
      state.stopped ||
      state.timer ||
      reading.current ||
      state.count >= MAX_RETRIES ||
      !stuck()
    )
      return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      // A read in flight retries when it settles; links read meanwhile are
      // tried first.
      if (reading.current || !stuck()) return;
      state.count += 1;
      read();
    }, RETRY_DELAY);
  };
  const renew = (source: string, loaded: boolean, link: string) => {
    if (!refresh) return;
    if (loaded) {
      failed.current.delete(source);
      return;
    }
    failed.current.set(source, link);
    if (tried.current.has(source) || reading.current) later();
    else {
      tried.current.add(source);
      read();
    }
  };

  const media: Media = (source, label, image = false, description) => {
    const attachment = attachmentFor(source, metadata, image);
    const signed = signedUrl(source, metadata);
    const link = (
      <a href={source} target="_blank" rel="noreferrer">
        {label || attachment?.name || "Open attachment"}
      </a>
    );
    if (!attachment) return link;
    return (
      <EmbeddedAttachment
        key={source}
        source={source}
        {...(signed && {
          signed,
          onMedia: (loaded: boolean, link: string) =>
            renew(source, loaded, link),
        })}
        fallback={link}
        caption={
          !image && Children.toArray(label).some((part) => part !== source)
            ? label
            : null
        }
      >
        {(src) =>
          attachment.kind === "audio" ? (
            <AudioAttachment attachment={attachment} source={src} />
          ) : (
            <MediaAttachment
              attachment={attachment}
              media={() => src}
              {...(description !== undefined
                ? { imageDescription: description }
                : {})}
              preload="metadata"
            />
          )
        }
      </EmbeddedAttachment>
    );
  };

  return (
    <div className={styles.body}>
      <MediaContext value={media}>
        <Markdown
          remarkPlugins={[remarkGfm, remarkBreaks, githubHtml]}
          urlTransform={(value) => bodyUrl(value, url) ?? ""}
          components={components}
        >
          {body}
        </Markdown>
      </MediaContext>
    </div>
  );
});
