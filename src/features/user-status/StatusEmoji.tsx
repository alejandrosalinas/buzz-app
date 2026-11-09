import {
  cloneElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactElement,
} from "react";
import type { RelaySession } from "../relay/session";
import { useReactionName } from "../messages/use-reaction-name";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Status.module.css";

/** An emoji's `:name:`. A custom code names itself; Unicode names load with the
 * reaction table, once, when a named emoji mounts. Free text has no name. */
export function useEmojiName(value: string) {
  const code = /^:[^:\s]+:$/.test(value);
  const name = useReactionName(!!value && !code)?.(value);
  if (code) return value;
  return name === value ? undefined : name;
}

export function StatusEmoji({
  value,
  url,
  session,
  decorative = false,
  fallback,
  hint = false,
}: {
  value: string;
  /** The status event's own image URL; the catalog is the fallback. */
  url?: string | undefined;
  session: RelaySession;
  decorative?: boolean;
  /** Icon-sized slots show this glyph for an empty or unresolved value. */
  fallback?: string;
  /** Name the emoji on hover where the full status is already displayed. */
  hint?: boolean;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const code = /^:([^:\s]+):$/.exec(value)?.[1];
  const [failed, setFailed] = useState<readonly string[]>([]);
  const usable = (original: string | undefined) => {
    const source = original ? session.media(original) : undefined;
    return source && !failed.includes(source) ? source : undefined;
  };
  // An unloadable event URL falls back to the catalog, like a two-value status.
  const own = usable(url);
  useEffect(() => {
    if (code && !own) void session.emoji.ensure();
  }, [code, own, session]);
  const custom = code
    ? catalog.entries.find(
        (entry) => entry.shortcode.toLowerCase() === code.toLowerCase(),
      )
    : undefined;
  const source = own ?? usable(custom?.url);
  // Unhinted slots, such as every message byline, never load the name table.
  const name = useEmojiName(hint ? value : "");
  // Over the emoji, a name replaces an enclosing native title, such as the
  // ticker's; without one, that title still shows. Base UI keeps hover wiring
  // on the trigger element it first registered, so swapping between an image
  // and a glyph mounts a fresh hint.
  const named = (element: ReactElement<HTMLAttributes<HTMLElement>>) =>
    hint ? (
      <Tooltip
        key={source ? "image" : "glyph"}
        content={name}
        {...(name ? {} : { open: false })}
        disableHoverablePopup
      >
        {name ? cloneElement(element, { title: "" }) : element}
      </Tooltip>
    ) : (
      element
    );
  const glyph = (text: string) => (
    <span
      className={styles.emojiFallback}
      aria-hidden={decorative || undefined}
    >
      {text}
    </span>
  );
  if (source)
    return named(
      <img
        className={styles.emoji}
        src={source}
        alt={decorative ? "" : value}
        aria-hidden={decorative || undefined}
        width={20}
        height={20}
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setFailed((list) => [...list, source])}
      />,
    );
  if (!code)
    return value ? named(glyph(value)) : fallback ? glyph(fallback) : null;
  // Reserve the image's space until the catalog settles instead of flashing text.
  if (catalog.status === "idle" || catalog.status === "loading")
    return (
      <span
        className={styles.emoji}
        data-pending
        role="img"
        aria-label={value}
        aria-hidden={decorative || undefined}
      />
    );
  if (fallback) return glyph(fallback);
  return (
    <span className={styles.text} aria-hidden={decorative || undefined}>
      {value}
    </span>
  );
}
