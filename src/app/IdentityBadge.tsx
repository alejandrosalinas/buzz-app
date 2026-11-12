import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import { abbreviatedPublicKey } from "../shared/identity/public-key";
import { Avatar } from "../shared/design-system/ui/Avatar";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { Panel } from "../shared/design-system/ui/Panel";
import {
  CaretLeftIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DotsThreeIcon,
} from "../shared/design-system/icons";
import styles from "./IdentityBadge.module.css";
import { IdentityReflection } from "./IdentityReflection";
import { useIdentityTilt } from "./useIdentityTilt";

const barcodeBars =
  "M10 0h2v24h-2zM13 0h1v24h-1zM16 0h1v24h-1zM21 0h1v24h-1zM25 0h1v24h-1zM27 0h2v24h-2zM32 0h2v24h-2zM35 0h3v24h-3zM39 0h3v24h-3zM43 0h3v24h-3zM47 0h2v24h-2zM52 0h1v24h-1zM54 0h3v24h-3zM58 0h2v24h-2zM63 0h1v24h-1zM65 0h1v24h-1zM69 0h1v24h-1zM71 0h2v24h-2zM76 0h2v24h-2zM79 0h3v24h-3zM83 0h3v24h-3zM87 0h3v24h-3zM91 0h2v24h-2zM96 0h1v24h-1zM98 0h3v24h-3zM102 0h2v24h-2zM107 0h1v24h-1zM109 0h2v24h-2zM112 0h3v24h-3zM116 0h1v24h-1zM120 0h2v24h-2zM125 0h3v24h-3zM129 0h1v24h-1zM131 0h2v24h-2z";

/** Public identity artwork. Secret-key access stays with the existing key owner. */
export function IdentityBadge({
  viewer,
  name,
  picture,
  photoContext,
  backup,
  backupAccount = "your Builderlab account",
  onCopy,
  children,
}: {
  viewer: string;
  name: string;
  picture?: string | undefined;
  photoContext?: string | undefined;
  backup?: "pending" | "confirmed" | "attention" | "running" | undefined;
  /** Where the backup is, e.g. "your Builderlab account". */
  backupAccount?: string | undefined;
  onCopy(): void;
  children(
    active: boolean,
    action: RefObject<HTMLButtonElement | null>,
  ): ReactNode;
}) {
  const [back, setBack] = useState(false);
  const [loaded, setLoaded] = useState<string>();
  const faceId = useId();
  const action = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = details.current;
    if (!element) return;
    const measure = () =>
      setOverflowing(element.scrollHeight > element.clientHeight);
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    // Content can grow without changing the bounded scrollport's own size.
    for (const box of [element, ...element.children]) observer?.observe(box);
    return () => observer?.disconnect();
  });
  const tilt = useIdentityTilt();
  const { x: pointerX, y: pointerY, reducedMotion } = tilt;
  return (
    <Panel aria-label="Your Buzz ID">
      <div className={styles.badge}>
        <div className={styles.actions}>
          <Tooltip content={back ? "Back" : "More options"}>
            <IconButton
              ref={action}
              variant={back ? "ghost" : "subtle"}
              size="sm"
              aria-label={back ? "Back" : "More options"}
              aria-controls={faceId}
              aria-pressed={back}
              icon={
                back ? (
                  <CaretLeftIcon size={16} aria-hidden="true" />
                ) : (
                  <DotsThreeIcon size={16} aria-hidden="true" />
                )
              }
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true });
                setBack(!back);
              }}
            />
          </Tooltip>
        </div>
        <div
          id={faceId}
          className={styles.stage}
          onPointerMove={tilt.onPointerMove}
          onPointerLeave={tilt.onPointerLeave}
        >
          <motion.div className={styles.tilt} style={tilt.style}>
            <div className={styles.card} data-back={back || undefined}>
              <div
                className={`${styles.face} ${styles.front}`}
                inert={back}
                aria-hidden={back}
              >
                <div className={styles.slot} aria-hidden="true" />
                <div className={styles.photoArea}>
                  <div className={styles.artwork} aria-hidden="true">
                    {(!picture || loaded !== picture) && (
                      <span className={styles.monogram}>
                        {name.trim().slice(0, 1).toUpperCase() || "?"}
                      </span>
                    )}
                    {picture && (
                      <img
                        className={styles.portrait}
                        src={picture}
                        alt=""
                        data-loaded={loaded === picture || undefined}
                        onLoad={() => setLoaded(picture)}
                        onError={() => setLoaded(undefined)}
                      />
                    )}
                    <div className={styles.tint} />
                    <IdentityReflection
                      x={pointerX}
                      y={pointerY}
                      active={!back && !reducedMotion}
                    />
                  </div>
                  <div className={styles.topline}>
                    <Tooltip
                      content={
                        photoContext
                          ? `Photo from ${photoContext}`
                          : "Your ID is shared across communities."
                      }
                    >
                      <span
                        role="img"
                        className={styles.photoHint}
                        aria-label={
                          photoContext
                            ? `Photo from ${photoContext}`
                            : "Buzz identity photo"
                        }
                      >
                        <Avatar
                          src={picture}
                          alt=""
                          fallback={name}
                          size="large"
                        />
                      </span>
                    </Tooltip>
                    <strong className="dark text-heading font-bold text-standard break-normal">
                      Buzz ID
                    </strong>
                  </div>
                  {backup && (
                    <div className={styles.backupCaption}>
                      {backup === "confirmed" ? (
                        <Tooltip
                          content={`Your private key is saved on this device and backed up with ${backupAccount}.`}
                        >
                          <span
                            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users focus this informational pill to read its destination tooltip.
                            tabIndex={0}
                            className={`${styles.backupPill} text-label-sm`}
                          >
                            <CheckIcon size={14} aria-hidden="true" />
                            Backed up
                          </span>
                        </Tooltip>
                      ) : backup === "attention" ? (
                        <span className={styles.backupPill}>
                          <Button
                            size="inline"
                            variant="link"
                            aria-controls={faceId}
                            onClick={() => {
                              action.current?.focus({ preventScroll: true });
                              setBack(true);
                            }}
                          >
                            Check backup
                          </Button>
                        </span>
                      ) : backup === "running" ? (
                        <span
                          role="status"
                          aria-label="Backing up your key"
                          className={styles.backupPill}
                        >
                          <CircleNotchIcon
                            size={14}
                            className="animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
                <div className={styles.identity}>
                  <span
                    className={`${styles.keyLabel} text-caption text-subtle`}
                  >
                    PUBLIC KEY
                  </span>
                  {/* Code 128-B: fixed public word BUZZBUZZ, checksum 51; no key data. */}
                  <div className={`dark ${styles.barcodeSticker}`}>
                    <span className={styles.barcodeFilm}>
                      <svg
                        viewBox="5 -4 133 32"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path fill="var(--surface-panel)" d={barcodeBars} />
                      </svg>
                      <IdentityReflection
                        x={pointerX}
                        y={pointerY}
                        active={!back && !reducedMotion}
                        surface="paper"
                      />
                    </span>
                  </div>
                  <div className={styles.publicId}>
                    <code className="text-mono-lg">
                      {abbreviatedPublicKey(viewer)}
                    </code>
                    <span className={styles.copyAction}>
                      <Tooltip
                        content="Copy your full public Buzz ID"
                        hint="familiar"
                      >
                        <IconButton
                          aria-label="Copy Buzz ID"
                          size="xs"
                          icon={<CopyIcon aria-hidden="true" />}
                          onClick={onCopy}
                        />
                      </Tooltip>
                    </span>
                  </div>
                </div>
              </div>
              <div
                className={`${styles.face} ${styles.back}`}
                inert={!back}
                aria-hidden={!back}
              >
                <div className={styles.slot} aria-hidden="true" />
                <div className={`dark ${styles.stripe}`} aria-hidden="true">
                  <IdentityReflection
                    x={pointerX}
                    y={pointerY}
                    active={back && !reducedMotion}
                    surface="magnetic"
                  />
                </div>
                {/* Keyboard scrolling remains available when the details overflow. */}
                <section
                  ref={details}
                  className={styles.details}
                  aria-label={overflowing ? "Identity details" : undefined}
                  tabIndex={overflowing ? 0 : undefined}
                >
                  {children(back, action)}
                </section>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </Panel>
  );
}
