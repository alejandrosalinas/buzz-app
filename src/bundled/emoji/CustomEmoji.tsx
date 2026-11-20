import { useReadyImage } from "../../shared/design-system/useReadyImage";
import type { CustomEmoji as Emoji } from "../../features/relay/emoji";
import styles from "./Emoji.module.css";

/** Event URLs never bypass the captured community's media policy. */
export function CustomEmoji({
  emoji,
  media,
}: {
  emoji: Emoji;
  media(url: string): string | undefined;
}) {
  const src = media(emoji.url);
  const literal = `:${emoji.shortcode}:`;
  return src ? <EmojiImage key={src} src={src} literal={literal} /> : literal;
}

function EmojiImage({ src, literal }: { src: string; literal: string }) {
  const { status, failing, image } = useReadyImage(src);
  // A source that failed keeps its text until a retry loads; the hidden retry
  // loads eagerly and copies nothing, so the text is copied once.
  const placeholder = failing && status !== "loaded";
  if (status === "failed") return literal;
  return (
    <>
      {placeholder && literal}
      <img
        {...image}
        className={styles.customEmoji}
        data-copy-emoji={placeholder ? undefined : literal}
        draggable={false}
        alt={placeholder ? "" : literal}
        title={placeholder ? undefined : literal}
        width={22}
        height={22}
        loading={placeholder ? "eager" : image.loading}
        hidden={placeholder}
      />
    </>
  );
}
