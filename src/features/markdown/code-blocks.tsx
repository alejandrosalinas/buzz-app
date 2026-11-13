import {
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ExtraProps } from "react-markdown";
import { labelText } from "../messages/label-text";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import { resolveMatch } from "../../plugins/contributions";
import type {
  CodeBlockRenderer,
  ContributionReader,
} from "../conversation/contracts";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import styles from "./Markdown.module.css";

/** The frame and action classes a host gives its code blocks; messages pass
 * their own, which compose these. */
export type CodeClasses = Readonly<{
  frame: string | undefined;
  actions: string | undefined;
}>;
const defaultClasses: CodeClasses = {
  frame: styles.codeFrame,
  actions: styles.codeActions,
};

/** WebKit adds an `overflow-x: auto` scrollbar after flex and grid ancestors
 * have taken their heights, then lays out only the table again. A scrollbar
 * that takes space then overlaps the next row, or leaves a gap when removed.
 * CSS chooses the scrollbar from measured overflow so it is laid out with
 * the ancestors. Observe content too: edits can change scrollWidth without
 * resizing a table at its width cap. Measure on mount because the resize
 * observer's first report arrives after the row's. */
export function observeTableOverflow(table: HTMLTableElement | null) {
  if (!table || typeof ResizeObserver === "undefined") return;
  const update = () => {
    const overflow = String(table.scrollWidth > table.clientWidth);
    if (table.dataset.overflow !== overflow) table.dataset.overflow = overflow;
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(table);
  const contentObserver = new MutationObserver(update);
  contentObserver.observe(table, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return () => {
    observer.disconnect();
    contentObserver.disconnect();
  };
}

/** The fence's info-string language, as remark records it on the inner `code`. */
export function codeLanguage(pre: ExtraProps["node"]) {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return undefined;
  const classes = code.properties.className;
  return Array.isArray(classes)
    ? classes
        .map(String)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length)
    : undefined;
}

/** A fenced block's `pre`: the plain code with an optional copy action, or,
 * when a registry is given and the fence names a language, a plugin's
 * presentation with the plain code as its fallback. */
export function CodeFence({
  node,
  children,
  copy,
  registry,
  classes = defaultClasses,
  ...props
}: ComponentProps<"pre"> &
  ExtraProps & {
    copy: boolean | undefined;
    registry: ContributionReader<CodeBlockRenderer> | undefined;
    classes?: CodeClasses | undefined;
  }) {
  const code = labelText(children).replace(/\n$/, "");
  const plain = (
    <pre {...props}>
      {children}
      {copy && <CodeActions code={code} className={classes.actions} />}
    </pre>
  );
  const language = codeLanguage(node);
  return language && registry ? (
    <CodeBlock
      registry={registry}
      language={language}
      code={code}
      fallback={plain}
      classes={classes}
    />
  ) : (
    plain
  );
}

/** A plugin presents the block and may add an action; the host keeps the frame,
 * action placement and copy, and restores the plain code when the plugin fails
 * or is removed. */
export function CodeBlock({
  registry,
  language,
  code,
  fallback,
  classes = defaultClasses,
}: {
  registry: ContributionReader<CodeBlockRenderer>;
  language: string;
  code: string;
  fallback: ReactNode;
  classes?: CodeClasses | undefined;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const renderer = resolveMatch(renderers, language);
  if (!renderer) return fallback;
  const { component: Renderer, action: Action } = renderer;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${language}:${code}`}
      fallback={fallback}
    >
      {/* Selection copy reads the source here (selection-copy.ts). */}
      <div
        className={classes.frame}
        data-copy-code={code}
        data-copy-language={language}
      >
        <Renderer code={code} language={language} />
        <CodeActions code={code} className={classes.actions}>
          {Action && <Action code={code} language={language} />}
        </CodeActions>
      </div>
    </ContributionBoundary>
  );
}

export function CodeActions({
  code,
  children,
  className = defaultClasses.actions,
}: {
  code: string;
  children?: ReactNode;
  className?: string | undefined;
}) {
  const notify = useToastNotification();
  const [copying, setCopying] = useState(false);
  return (
    <span className={className}>
      {children}
      <IconButton
        hint="familiar"
        aria-label="Copy code block"
        title="Copy code block"
        disabled={copying}
        focusableWhenDisabled
        icon={<CopyIcon />}
        onClick={() => {
          setCopying(true);
          void Promise.resolve()
            .then(() => writeClipboardText(code))
            .then(
              () => notify("Copied code to clipboard", "success"),
              () => notify("Failed to copy code", "error"),
            )
            .finally(() => setCopying(false));
        }}
      />
    </span>
  );
}
