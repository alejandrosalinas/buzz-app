import { createPortal } from "react-dom";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import {
  CloudUploadIcon,
  PencilSimpleIcon,
  PlusIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./AvatarEditor.module.css";
import emojiStyles from "../../bundled/emoji/Emoji.module.css";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { InputGroup } from "../../shared/design-system/ui/InputGroup";
import { ScrollEdgeMaterial } from "../../shared/design-system/ui/ScrollEdgeMaterial";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  avatarPictureError,
  profilePictureError,
  emojiAvatar,
  emojiAvatarScale,
  paintEmojiAvatar,
  uploadAvatar,
} from "./avatar-upload";
import { useAvatarPreview } from "./use-avatar-preview";
import { AvatarCustomColor } from "./AvatarCustomColor";
import type { EmojiSearchSelection } from "../../bundled/emoji/emoji-mart";

type Props = {
  triggerStyle?: "dotted-squircle";
  emptyStyle?: "dotted-circle" | undefined;
  inlinePicker?: boolean;
  triggerLabel?: string;
  actionTarget?: HTMLElement | null | undefined;
  value: string;
  name: string;
  community?: string | undefined;
  shape?: "circle" | "squircle";
  /** A person's own profile, which keeps an emoji avatar saved by Buzz mobile. */
  personal?: boolean;
  size?: "compact" | "default";
  /** Reuse the active session's already-authorized cached thumbnail in compact previews. */
  thumbnailMedia?: (url: string, size: "small") => string | undefined;
  disabled?: boolean;
  onChange(value: string): void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
};

type DraftPreview = {
  picture: string;
  emoji?: string;
  color?: string;
  scale?: number;
  offset?: number;
  pulse?: number;
  move?: (update: (offset: number) => number) => void;
};

const colors = [
  "#FFFFFF",
  "#FFF4CC",
  "#FFE75C",
  "#FFB84D",
  "#FF8652",
  "#F6534F",
  "#FF6B9A",
  "#FB60C4",
  "#D66BFF",
  "#B141FF",
  "#7C5CFF",
  "#476CFF",
  "#3399FF",
  "#63C6F2",
  "#41EBC1",
  "#2ED3A2",
  "#73EF75",
  "#9FE870",
  "#C7D36F",
  "#CCCCCC",
  "#8A8F98",
  "#4B5563",
  "#000000",
];

/** Not the popup, nor the emoji preview it moves from outside the popup. */
const outsideEditor = (popup: HTMLElement | null, target: EventTarget | null) =>
  target instanceof Element &&
  !popup?.contains(target) &&
  !target.closest("[data-emoji-position]");

/** One draft editor for humans and agents; the enclosing form owns profile Save. */
export function AvatarEditor(props: Props) {
  const setupAnchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(!!props.inlinePicker);
  const [draftPreview, setDraftPreview] = useState<DraftPreview | null>(null);
  const [sizeTarget, setSizeTarget] = useState<HTMLElement | null>(null);
  // Compact profile previews reuse the header's cached thumbnail; full-size
  // editors still request original artwork (see avatar-source.grit).
  const preview = useAvatarPreview(
    draftPreview?.picture ?? props.value,
    props.community,
    props.size === "compact" ? "small" : undefined,
    props.size === "compact" ? props.thumbnailMedia : undefined,
  );
  const pictureError = (
    props.personal ? profilePictureError : avatarPictureError
  )(props.value);
  const errorId = useId();
  // The empty and filled triggers swap as the draft preview changes. One id
  // lets Base UI follow the mounted one, for Tab and return focus.
  const triggerId = useId();
  const popupElement = useRef<HTMLDivElement>(null);
  // What the preview shows and Done could apply (an emoji needs a community).
  const unsaved =
    !!draftPreview &&
    (draftPreview.emoji
      ? !!props.community
      : draftPreview.picture !== props.value);
  const callback = useRef(props.onBusyChange);
  callback.current = props.onBusyChange;
  useEffect(() => {
    callback.current?.(open);
    return () => callback.current?.(false);
  }, [open]);
  // Only Done applies a draft, so a press elsewhere keeps the popup open
  // (see onOpenChange) and its focus: once Base UI sees focus leave, it skips
  // returning focus on the next close, even when that dismissal was cancelled,
  // and Escape from outside would also dismiss an enclosing dialog. A press
  // focuses on mousedown, and a label also focuses its control on click.
  useEffect(() => {
    if (!open || !unsaved || props.inlinePicker) return;
    const keepFocus = (event: MouseEvent) => {
      if (
        outsideEditor(popupElement.current, event.target) &&
        (event.type === "mousedown" ||
          (event.target as Element).closest("label"))
      )
        event.preventDefault();
    };
    document.addEventListener("mousedown", keepFocus, true);
    document.addEventListener("click", keepFocus, true);
    return () => {
      document.removeEventListener("mousedown", keepFocus, true);
      document.removeEventListener("click", keepFocus, true);
    };
  }, [open, unsaved, props.inlinePicker]);
  const draft = open && (
    <AvatarDraft
      key={props.community ?? "local"}
      {...props}
      onPreview={setDraftPreview}
      sizeTarget={sizeTarget}
      done={(value) => {
        props.onChange(value);
        setOpen(false);
      }}
    />
  );
  return (
    <div
      className={props.inlinePicker ? styles.inlineEditor : undefined}
      data-editing={open || undefined}
      ref={setupAnchor}
    >
      <Popover.Root
        open={open}
        onOpenChange={(next, details) => {
          // An inline picker stays open, so Escape belongs to its dialog.
          if (props.inlinePicker && details.reason === "escape-key")
            details.allowPropagation();
          // Pressing or focusing the emoji preview moves the emoji, so it
          // never dismisses. An unsaved draft survives a press elsewhere.
          // Escape still discards it, and so does tabbing out onto a guard.
          const { event } = details;
          const target =
            event instanceof FocusEvent ? event.relatedTarget : event.target;
          if (
            (details.reason === "outside-press" ||
              details.reason === "focus-out") &&
            target instanceof Element &&
            (target.closest("[data-emoji-position]") ||
              (unsaved &&
                outsideEditor(popupElement.current, target) &&
                !target.closest("[data-base-ui-focus-guard]")))
          )
            return details.cancel();
          if (!props.inlinePicker || next) setOpen(next);
        }}
      >
        {props.emptyStyle === "dotted-circle" &&
        !props.value &&
        !draftPreview?.picture &&
        !draftPreview?.emoji ? (
          <div className={styles.avatarFrame}>
            <Popover.Trigger
              id={triggerId}
              render={
                <button
                  type="button"
                  className={`${styles.dottedTrigger} ${styles.emptyCircle}`}
                  aria-label="Add avatar"
                  disabled={props.disabled}
                />
              }
            >
              <svg
                className={styles.dottedOutline}
                viewBox="0 0 220 220"
                aria-hidden="true"
              >
                <circle
                  cx="110"
                  cy="110"
                  r="108"
                  pathLength="288"
                  strokeWidth="3"
                  strokeDasharray="4 5"
                />
              </svg>
              <PlusIcon size={40} aria-hidden="true" />
            </Popover.Trigger>
          </div>
        ) : props.triggerStyle === "dotted-squircle" ? (
          <div className={styles.dottedFrame}>
            <Popover.Trigger
              id={triggerId}
              render={
                <button
                  type="button"
                  className={styles.dottedTrigger}
                  aria-label="Edit avatar"
                  disabled={props.disabled}
                />
              }
            >
              <svg
                className={styles.dottedOutline}
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <path d="M 50 1 C 92.14 1 99 7.86 99 50 C 99 92.14 92.14 99 50 99 C 7.86 99 1 92.14 1 50 C 1 7.86 7.86 1 50 1 Z" />
              </svg>
              {draftPreview?.emoji ? null : preview ? (
                <img
                  src={preview}
                  alt="Avatar preview"
                  data-avatar-shape="squircle"
                />
              ) : (
                <PlusIcon size={28} aria-hidden="true" />
              )}
            </Popover.Trigger>
            {/* A sibling, not trigger content, so it stays its own control. */}
            {draftPreview?.emoji && (
              <EmojiPreview
                preview={draftPreview}
                emoji={draftPreview.emoji}
                shape="squircle"
              />
            )}
            {props.inlinePicker && <div ref={setSizeTarget} />}
          </div>
        ) : props.triggerLabel ? (
          <Popover.Trigger
            id={triggerId}
            render={
              <Button size="compact" disabled={props.disabled}>
                {props.triggerLabel}
              </Button>
            }
          />
        ) : (
          <div
            className={styles.avatarFrame}
            data-shape={props.shape ?? "circle"}
            data-size={props.size}
          >
            {draftPreview?.emoji ? (
              <EmojiPreview
                preview={draftPreview}
                emoji={draftPreview.emoji}
                shape={props.shape ?? "circle"}
                cutout
              />
            ) : (
              <div
                className={styles.avatarArtwork}
                data-shape={props.shape ?? "circle"}
              >
                <Avatar
                  src={preview}
                  alt={open ? "Avatar preview" : "Avatar"}
                  fallback={props.name}
                  size="fill"
                  loading="eager"
                  shape={props.shape ?? "circle"}
                />
              </div>
            )}
            <div className={styles.editBadge}>
              <Popover.Trigger
                id={triggerId}
                render={
                  <IconButton
                    variant="solid"
                    size="md"
                    shape="round"
                    style={{
                      width: "100%",
                      height: "100%",
                      minWidth: 0,
                      minHeight: 0,
                    }}
                    aria-label="Edit avatar"
                    aria-describedby={pictureError ? errorId : undefined}
                    icon={
                      (draftPreview?.picture ?? props.value) ||
                      draftPreview?.emoji ? (
                        <PencilSimpleIcon size={16} />
                      ) : (
                        <PlusIcon size={16} />
                      )
                    }
                    disabled={props.disabled}
                  />
                }
              />
            </div>
          </div>
        )}
        {pictureError && (
          <p id={errorId} role="alert" className="text-body-sm text-danger">
            {pictureError}
          </p>
        )}
        {props.inlinePicker ? (
          draft
        ) : (
          <Popover.Portal>
            <Popover.Positioner
              anchor={
                props.emptyStyle === "dotted-circle" ? setupAnchor : undefined
              }
              side="bottom"
              align="center"
              sideOffset={8}
              collisionPadding={12}
              collisionAvoidance={{
                side: props.emptyStyle === "dotted-circle" ? "none" : "shift",
                align: "shift",
                fallbackAxisSide: "none",
              }}
              style={{ zIndex: "var(--layer-popover)" }}
            >
              <Popover.Popup
                ref={popupElement}
                data-buzz-ui=""
                className={`popover-surface ${styles.popup}`}
              >
                <Popover.Title className="sr-only">Edit avatar</Popover.Title>
                {draft}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

/** Drag or use the arrow keys to move the emoji up or down; it stays
 * horizontally centered. Masks apply only to the artwork inside, so the
 * focus ring stays visible. */
function EmojiPreview({
  preview: { color, scale, offset = 0, pulse, move },
  emoji,
  shape,
  cutout = false,
}: {
  preview: DraftPreview;
  emoji: string;
  shape: string;
  /** Leave room for the edit badge, as the profile avatar does. */
  cutout?: boolean;
}) {
  const artwork = (
    <div
      data-avatar-shape={shape}
      className={styles.emojiPreviewArtwork}
      style={{ backgroundColor: color }}
    >
      <EmojiArtwork
        key={`${emoji}-${pulse}`}
        emoji={emoji}
        scale={scale}
        offset={offset}
        animate={!!pulse}
      />
    </div>
  );
  const drag = useRef<{ y: number; offset: number } | null>(null);
  // Update from the latest offset: key repeats can outpace the preview.
  const nudge = (to: (current: number) => number) =>
    move?.(
      (current) =>
        Math.round(Math.min(0.2, Math.max(-0.2, to(current))) * 100) / 100,
    );
  return (
    <div
      role="slider"
      tabIndex={move ? 0 : -1}
      aria-label="Emoji position"
      aria-orientation="vertical"
      aria-disabled={!move || undefined}
      // Up is positive, matching the arrow keys.
      aria-valuemin={-20}
      aria-valuemax={20}
      aria-valuenow={Math.round(-offset * 100)}
      aria-valuetext={
        offset
          ? `${Math.round(Math.abs(offset) * 100)}% ${offset > 0 ? "down" : "up"}`
          : "Centered"
      }
      data-emoji-position=""
      className={styles.emojiPreview}
      onPointerDown={(event) => {
        if (!move) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, offset };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const to =
          drag.current.offset +
          (event.clientY - drag.current.y) / event.currentTarget.clientHeight;
        nudge(() => to);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowUp"
            ? -0.02
            : event.key === "ArrowDown"
              ? 0.02
              : 0;
        if (!move || (!step && event.key !== "Home")) return;
        event.preventDefault();
        nudge((current) => (step ? current + step : 0));
      }}
    >
      {cutout ? (
        <div className={styles.avatarArtwork} data-shape={shape}>
          {artwork}
        </div>
      ) : (
        artwork
      )}
    </div>
  );
}

export function EmojiArtwork({
  emoji,
  scale,
  offset,
  animate,
}: {
  emoji: string;
  scale?: number | undefined;
  offset?: number | undefined;
  animate: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (canvas.current)
      paintEmojiAvatar(canvas.current, emoji, undefined, scale, offset);
  }, [emoji, scale, offset]);
  return (
    <canvas
      ref={canvas}
      width={512}
      height={512}
      data-animate={animate || undefined}
      className={styles.emojiArtwork}
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

function AvatarDraft({
  actionTarget,
  inlinePicker,
  value,
  community,
  personal,
  onPreview,
  sizeTarget,
  disabled = false,
  done,
}: Props & {
  done(value: string): void;
  onPreview(value: DraftPreview | null): void;
  sizeTarget: HTMLElement | null;
}) {
  const [customColorOpen, setCustomColorOpen] = useState(false);
  const customColorTrigger = useRef<HTMLButtonElement>(null);
  const wasCustomColorOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasCustomColorOpen.current && !customColorOpen)
      customColorTrigger.current?.focus({ preventScroll: true });
    wasCustomColorOpen.current = customColorOpen;
  }, [customColorOpen]);
  const panels = useRef<HTMLFieldSetElement>(null);
  const [panelHeight, setPanelHeight] = useState<number>();
  useLayoutEffect(() => {
    const element = panels.current;
    if (!element) return;
    // The popover scales on entry; measure layout rather than transformed size.
    const measure = () => setPanelHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Focus scrolling stops above the sticky footer, however its actions wrap.
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const popup = footer?.closest<HTMLElement>(`.${styles.popup}`);
    if (!footer || !popup) return;
    const measure = () => {
      popup.style.scrollPaddingBlockEnd = `${footer.offsetHeight}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      popup.style.removeProperty("scroll-padding-block-end");
    };
  }, [footer]);
  const [picture, setPicture] = useState(value);
  const [mode, setMode] = useState<"image" | "emoji" | "background">("image");
  const [emoji, setEmoji] = useState("😀");
  const [color, setColor] = useState("#FFF4CC");
  // The slider is relative to the default size, so 100% never crops a circle.
  const [zoom, setZoom] = useState(1);
  const scale = emojiAvatarScale * zoom;
  // A share of the image height that the preview drags; positive is down.
  const [offset, setOffset] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const droppable = !disabled && !busy && !!community;
  useEffect(() => {
    onPreview({
      picture,
      ...(mode !== "image"
        ? {
            emoji,
            color,
            scale,
            offset,
            pulse,
            ...(disabled || busy ? {} : { move: setOffset }),
          }
        : {}),
    });
  }, [
    picture,
    mode,
    emoji,
    color,
    scale,
    offset,
    pulse,
    disabled,
    busy,
    onPreview,
  ]);
  useEffect(() => () => onPreview(null), [onPreview]);
  const input = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  async function upload(makeFile: () => Promise<File>, apply = false) {
    if (disabled || pending.current || !community) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      const file = await makeFile();
      request.signal.throwIfAborted();
      const url = await uploadAvatar(file, community, request.signal);
      if (!request.signal.aborted) {
        if (apply) done(url);
        else setPicture(url);
      }
    } catch (reason) {
      if (!request.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Image upload failed. Try again.",
        );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const pictureError = (personal ? profilePictureError : avatarPictureError)(
    picture,
  );
  // Validate late: show the URL error after blur or an attempt to apply it,
  // then keep it current so it clears as soon as the URL is fixed.
  // An invalid saved URL is not a new attempt, so it shows at once.
  const [checkPicture, setCheckPicture] = useState(() => !!pictureError);
  const applyPicture = () => {
    if (!pictureError) return done(picture);
    setCheckPicture(true);
    urlInput.current?.focus();
  };
  const doneButton = (
    <Button
      variant="prominent"
      disabled={
        disabled || busy || (mode !== "image" && (!community || !emoji.trim()))
      }
      onClick={() => {
        if (mode !== "image")
          void upload(() => emojiAvatar(emoji, color, scale, offset), true);
        else applyPicture();
      }}
    >
      Done
    </Button>
  );

  const sizeSlider = (
    <label className={styles.emojiScale}>
      <span className="text-label-sm">Emoji size</span>
      <input
        type="range"
        min={1}
        max={2}
        step={0.05}
        value={zoom}
        aria-valuetext={`${Math.round(zoom * 100)}%`}
        disabled={disabled || busy}
        onChange={(event) => setZoom(Number(event.target.value))}
      />
    </label>
  );

  const renderPanel = (tab: string) =>
    tab === "image" ? (
      <div
        className={styles.imagePanel}
        data-surface={inlinePicker ? "panel" : undefined}
      >
        <button
          type="button"
          className={styles.dropzone}
          disabled={disabled || busy || !community}
          onClick={() => input.current?.click()}
        >
          <CloudUploadIcon size={24} aria-hidden="true" />
          <span>
            {busy
              ? "Uploading…"
              : dragging
                ? "Drop image here"
                : "Drop or browse"}
          </span>
        </button>
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload an image"
          accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif"
          disabled={disabled || busy || !community}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(async () => file);
          }}
        />
        <Field
          label="Picture URL (optional)"
          labelVisibility="hidden"
          error={checkPicture ? pictureError : undefined}
        >
          <InputGroup
            surface={inlinePicker ? "panel" : "inset"}
            leading={<LinkIcon size={18} aria-hidden="true" />}
          >
            <Input
              ref={urlInput}
              type="url"
              placeholder="Paste an image URL"
              maxLength={2048}
              disabled={disabled || busy}
              value={picture}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!disabled && !busy) applyPicture();
                }
              }}
              onBlur={() => setCheckPicture(true)}
              onChange={(event) => {
                setPicture(event.target.value);
                setError("");
              }}
            />
          </InputGroup>
        </Field>
      </div>
    ) : tab === "emoji" ? (
      <div className={styles.emojiPanel}>
        <AvatarEmojiPicker
          disabled={disabled || busy}
          onSelect={(value, animate) => {
            setEmoji(value);
            setPulse((current) => (animate ? current + 1 : 0));
          }}
        />
        {!sizeTarget && sizeSlider}
      </div>
    ) : (
      <div className={styles.backgroundPanel}>
        {customColorOpen ? (
          <AvatarCustomColor
            color={color}
            disabled={disabled || busy}
            onChange={setColor}
            onClose={() => setCustomColorOpen(false)}
          />
        ) : (
          <fieldset className={styles.swatches} aria-label="Avatar background">
            {colors.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={styles.swatch}
                aria-label={`Use ${swatch} background`}
                aria-pressed={color.toUpperCase() === swatch}
                disabled={disabled || busy}
                style={{ backgroundColor: swatch }}
                onClick={() => setColor(swatch)}
              />
            ))}
            <button
              ref={customColorTrigger}
              type="button"
              className={styles.customColor}
              aria-label="Custom background color"
              aria-pressed={!colors.includes(color.toUpperCase())}
              disabled={disabled || busy}
              onClick={() => setCustomColorOpen(true)}
            />
          </fieldset>
        )}
      </div>
    );
  return (
    <div className={styles.panelViewport} style={{ height: panelHeight }}>
      {/* An inline editor shows the size under its preview, on every tab. */}
      {sizeTarget && mode !== "image" && createPortal(sizeSlider, sizeTarget)}
      <fieldset
        ref={panels}
        aria-label="Avatar picker"
        className={styles.picker}
        data-dragging={dragging || undefined}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files") || !droppable) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
          setMode("image");
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = droppable ? "copy" : "none";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file && droppable) {
            setMode("image");
            void upload(async () => file);
          }
        }}
      >
        <Tabs
          value={mode}
          label="Avatar source"
          variant="panel"
          items={[
            { value: "image", label: "Image" },
            { value: "emoji", label: "Emoji" },
            { value: "background", label: "Background" },
          ]}
          onValueChange={(next) => {
            if (!busy && !disabled) {
              setMode(next);
              setCustomColorOpen(false);
              setError("");
            }
          }}
          renderPanel={renderPanel}
        />
        {busy && (
          <p role="status" className="text-body-sm">
            Uploading avatar…
          </p>
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger">
            {error}
          </p>
        )}
        {!community && (
          <p className="text-body-sm text-subtle">
            Select a community to upload an image or emoji. Your local default
            can use a public HTTPS image URL.
          </p>
        )}
        {!(mode === "background" && customColorOpen) && (
          <div ref={setFooter} className={styles.footer}>
            {/* A short popup scrolls beneath its actions; inline, they sit in flow. */}
            {!inlinePicker && <ScrollEdgeMaterial edge="bottom" />}
            <div className={styles.footerActions}>
              {!inlinePicker && (
                <Button
                  variant="destructive"
                  disabled={(!value && !picture) || disabled || busy}
                  onClick={() => done("")}
                >
                  Remove avatar
                </Button>
              )}
              {actionTarget
                ? createPortal(doneButton, actionTarget)
                : doneButton}
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}

const rootScale = () =>
  (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    16) / 16;

export function AvatarEmojiPicker({
  onSelect,
  disabled,
}: {
  onSelect(value: string, animate: boolean): void;
  disabled: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const callback = useRef<(value: string) => void>(() => {});
  callback.current = (value) => {
    if (disabled) return;
    const fromPointer = pointer.current;
    pointer.current = false;
    const animate =
      fromPointer &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    onSelect(value, animate);
  };
  const [error, setError] = useState(false);
  const [{ scale, perLine }, setLayout] = useState({
    scale: rootScale(),
    perLine: 0,
  });
  const search = useRef("");
  const focusPicker = useRef(true);
  const searchSelection = useRef<EmojiSearchSelection | undefined>(undefined);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => {
      const scale = rootScale();
      // Up to six 48px slots, leaving room for a non-overlay scrollbar.
      const perLine = Math.max(
        1,
        Math.min(
          6,
          Math.floor((element.clientWidth - 20 * scale) / (48 * scale)),
        ),
      );
      setLayout((current) =>
        current.scale === scale && current.perLine === perLine
          ? current
          : { scale, perLine },
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const appearance = new MutationObserver(resize);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      observer.disconnect();
      appearance.disconnect();
    };
  }, []);
  useEffect(() => {
    const element = host.current;
    if (!element || !perLine) return;
    let retired = false;
    let dispose: (() => void) | undefined;
    void import("../../bundled/emoji/emoji-mart")
      .then(({ mountEmojiMart }) => {
        if (retired) return;
        dispose = mountEmojiMart({
          host: element,
          scope: "avatar",
          autoFocus: focusPicker.current,
          perLine,
          emojiSize: 36 * scale,
          emojiButtonSize: 48 * scale,
          search: search.current,
          searchSelection,
          searchChange(value) {
            search.current = value;
          },
          entries: [],
          media: () => undefined,
          select: (value) => callback.current(value),
          close() {},
        });
      })
      .catch(() => {
        if (!retired) setError(true);
      });
    return () => {
      retired = true;
      // Shadow focus is retargeted to the picker host. Geometry changes must
      // not reclaim focus from the background controls.
      if (dispose)
        focusPicker.current = element.contains(
          element.ownerDocument.activeElement,
        );
      dispose?.();
    };
  }, [scale, perLine]);
  if (error)
    return (
      <p role="alert" className={emojiStyles.emojiStatus}>
        Could not load the emoji picker. Reopen it to retry.
      </p>
    );
  return (
    <div
      onPointerDownCapture={() => {
        pointer.current = true;
      }}
      onKeyDownCapture={() => {
        pointer.current = false;
      }}
      inert={disabled}
      className={emojiStyles.emojiMart}
    >
      <div ref={host} tabIndex={-1} />
    </div>
  );
}
