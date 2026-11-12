// The agent card about to be exported, as drawn: it tilts toward the pointer
// and the portrait-colored foil catches the light along its border.
import {
  type CSSProperties,
  type PointerEvent,
  useState,
  useRef,
  useEffect,
  useCallback,
} from "react";
import {
  CARD_PICTURE,
  CARD_HEIGHT,
  CARD_BORDER,
  CARD_RADIUS,
  CARD_WIDTH,
} from "../../features/agents/share-card";
import { fallbackAgentCardColor } from "../../features/agents/agent-card-color";
import styles from "./AgentCardPreview.module.css";

/** The drawn card's proportions and corner, which the preview clips to. */
const geometry = {
  "--portrait-left": `${(CARD_PICTURE.x / CARD_WIDTH) * 100}%`,
  "--portrait-top": `${(CARD_PICTURE.y / CARD_HEIGHT) * 100}%`,
  "--portrait-width": `${(CARD_PICTURE.size / CARD_WIDTH) * 100}%`,
  "--portrait-radius": `${(CARD_PICTURE.radius / CARD_PICTURE.size) * 100}%`,
  "--card-aspect": `${CARD_WIDTH} / ${CARD_HEIGHT}`,
  "--card-tall": CARD_HEIGHT / CARD_WIDTH,
  "--card-radius": `${(CARD_RADIUS / CARD_WIDTH) * 100}% / ${(CARD_RADIUS / CARD_HEIGHT) * 100}%`,
  "--card-border": `${(CARD_BORDER / CARD_WIDTH) * 100}%`,
} as CSSProperties;

const updatePointer = (
  element: HTMLDivElement,
  clientX: number,
  clientY: number,
) => {
  const reveal = element.closest('[data-entered="true"]');
  if (!reveal || !element.isConnected) return;
  const box = reveal.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const style = element.querySelector<HTMLElement>(`.${styles.card}`)?.style;
  if (!style) return;
  style.setProperty(
    "--card-x",
    String(Math.max(0, Math.min(1, (clientX - box.left) / box.width))),
  );
  style.setProperty(
    "--card-y",
    String(Math.max(0, Math.min(1, (clientY - box.top) / box.height))),
  );
};

const rest = (event: PointerEvent<HTMLDivElement>) => {
  const style = event.currentTarget.querySelector<HTMLElement>(
    `.${styles.card}`,
  )?.style;
  style?.removeProperty("--card-x");
  style?.removeProperty("--card-y");
};

/** Without `src`, the card's place is held while it is drawn. */
export function AgentCardPreview({
  src,
  alt,
  accentColor,
  portrait,
}: {
  src?: string | undefined;
  portrait?: string | undefined;
  alt: string;
  accentColor?: string | undefined;
}) {
  const frame = useRef<number | undefined>(undefined);
  const pending = useRef<
    { element: HTMLDivElement; x: number; y: number } | undefined
  >(undefined);
  const cancelPointer = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    pending.current = undefined;
  }, []);
  useEffect(() => cancelPointer, [cancelPointer]);
  const lean = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    pending.current = {
      element: event.currentTarget,
      x: event.clientX,
      y: event.clientY,
    };
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const point = pending.current;
      pending.current = undefined;
      if (point) updatePointer(point.element, point.x, point.y);
    });
  };
  const [portraitLoaded, setPortraitLoaded] = useState<string>();
  const [loaded, setLoaded] = useState<{
    src: string;
    animate: boolean;
    entered: boolean;
  }>();
  const ready = loaded?.src === src;
  return (
    <div
      className={styles.stage}
      style={
        {
          ...geometry,
          "--card-accent": accentColor ?? fallbackAgentCardColor(alt),
        } as CSSProperties
      }
    >
      {src ? (
        <div
          key={src}
          className={styles.reveal}
          onPointerMove={lean}
          onPointerLeave={(event) => {
            cancelPointer();
            rest(event);
          }}
          data-ready={ready}
          data-animate={ready && loaded?.animate}
          data-entered={ready && loaded?.entered}
        >
          <span className={styles.burst} aria-hidden="true">
            <span />
            <span />
            <span
              onAnimationEnd={() =>
                setLoaded((current) =>
                  current?.src === src
                    ? { ...current, entered: true }
                    : current,
                )
              }
            />
          </span>
          <div className={styles.turn}>
            <div className={styles.card}>
              <img
                className={styles.image}
                src={src}
                alt={alt}
                draggable={false}
                onLoad={() => {
                  const animate = !document.documentElement.hasAttribute(
                    "data-keyboard-navigation",
                  );
                  setLoaded({
                    src,
                    animate,
                    entered: !animate,
                  });
                }}
                onError={() =>
                  setLoaded({ src, animate: false, entered: true })
                }
              />
              {portrait && (
                <span
                  className={styles.portrait}
                  data-loaded={portraitLoaded === portrait}
                  aria-hidden="true"
                >
                  <img
                    src={portrait}
                    alt=""
                    draggable={false}
                    onLoad={() => setPortraitLoaded(portrait)}
                    onError={() => setPortraitLoaded(undefined)}
                  />
                </span>
              )}
              <span className={styles.sheen} aria-hidden="true" />
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.placeholder} />
      )}
    </div>
  );
}
