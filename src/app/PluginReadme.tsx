import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, useReducedMotion } from "motion/react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../shared/design-system/ui/Button";
import { safeLinkUrl } from "../features/relay/message-content";
import {
  MarkdownDocument,
  sharedComponents,
} from "../features/markdown/MarkdownDocument";
import type { MarkdownProfile } from "../features/markdown/profiles";
import styles from "./PluginReadme.module.css";

// Relative and in-page links have nowhere to go outside the repository.
const PROFILE: MarkdownProfile = {
  syntax: [remarkGfm],
  transforms: [],
  html: "omit",
  urlTransform: (url) => safeLinkUrl(url) ?? null,
};
const CAPABILITIES = { copy: true };
// The pane already titles the plugin (h2); README sections nest beneath it.
const MARKDOWN: Components = {
  ...sharedComponents,
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
};

export function PluginReadme({ text }: { text: string }) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  // Null means no disclosure action yet: apply measurements without animation.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [size, setSize] = useState({ height: 0, limit: 320 });
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () =>
      setSize({
        height: element.scrollHeight,
        limit:
          20 *
          (Number.parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          ) || 16),
      });
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const overflow = size.height > size.limit;
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  return (
    <div className={styles.disclosure}>
      <motion.div
        id={id}
        className={styles.clip}
        data-collapsed={(overflow && !expanded) || undefined}
        initial={false}
        style={expanded === null ? { maxHeight: "20rem" } : {}}
        animate={{ height: overflow && !expanded ? size.limit : "auto" }}
        transition={{
          duration: instant || expanded === null ? 0 : 0.2,
          ease: [0.2, 0.8, 0.2, 1],
        }}
        onFocusCapture={() => {
          if (overflow) setExpanded(true);
        }}
      >
        <div ref={content}>
          <MarkdownDocument
            content={text.replace(/^# .*\n+/, "")}
            profile={PROFILE}
            components={MARKDOWN}
            capabilities={CAPABILITIES}
            scale="inherit"
            className={styles.readme}
          />
        </div>
      </motion.div>
      {overflow && (
        <div className={styles.more} data-collapsed={!expanded || undefined}>
          <Button
            variant="subtle"
            size="sm"
            aria-expanded={!!expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "View less" : "View more"}
          </Button>
        </div>
      )}
    </div>
  );
}
