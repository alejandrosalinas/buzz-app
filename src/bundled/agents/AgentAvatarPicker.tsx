import { useMediaCorners } from "../../features/messages/use-media-corners";
import { animatedImage } from "../../features/messages/prepare-attachment";
import { AgentAvatarBackdrop } from "./AgentAvatarBackdrop";
import { EmojiSwap } from "./EmojiSwap";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  avatarMotionAllowed,
  createDockMagnifier,
  swapAvatarArtwork,
} from "./avatar-motion";
import {
  agentAvatars,
  randomAgentAvatar,
} from "../../features/agents/avatar-packs";
import { AvatarEmojiPicker } from "../../features/profiles/AvatarEditor";
import {
  AvatarCropFrame,
  AvatarZoom,
  useAvatarPan,
} from "../../features/profiles/AvatarCrop";
import {
  type AvatarCrop,
  croppedAvatar,
  emojiAvatar,
  emojiAvatarScale,
  avatarCropBox,
  uncropped,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import {
  CircleIcon,
  ImageIcon,
  SmileyIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { PackedAgentAvatar } from "./PackedAgentAvatar";
import styles from "./AgentCreate.module.css";

// Avatar artwork colors: Buzz blue/purple/green/amber plus Tailwind hues.
// These are exported into image pixels, so they stay stable across theme changes.
const backgrounds = [
  "#F43F5E",
  "#EC4899",
  "#D946EF",
  "#8E4EC6",
  "#6366F1",
  "#0090FF",
  "#0EA5E9",
  "#06B6D4",
  "#14B8A6",
  "#30A46C",
  "#22C55E",
  "#84CC16",
  "#F59E0B",
  "#F97316",
  "#EA580C",
  "#EF4444",
  "#FBBF24",
  "#A16207",
  "#334155",
  "#18181B",
  "transparent",
] as const;

export type AvatarSelection =
  | { kind: "gloopie"; picture: string }
  | { kind: "emoji"; emoji: string; color: string; crop?: AvatarCrop }
  | { kind: "image"; picture: string; crop?: AvatarCrop };

type EmojiSelection = Extract<AvatarSelection, { kind: "emoji" }>;

const defaultEmojiColor = backgrounds[0];

// The emoji's center stays inside the frame.
const emojiCenter = (value: number) => Math.min(0.5, Math.max(-0.5, value));

/** Whether this browser can paint the image. */
const decodes = (src: string) =>
  Object.assign(new Image(), { src })
    .decode()
    .then(
      () => true,
      () => false,
    );

export function AgentAvatarPicker({
  name,
  selection,
  disabled,
  community,
  onChange,
  onBusyChange,
  avatarRef,
}: {
  name: string;
  selection: AvatarSelection;
  disabled: boolean;
  community?: string | undefined;
  onChange(selection: AvatarSelection): void;
  onBusyChange(busy: boolean): void;
  avatarRef: Ref<{ prepare(): Promise<string> }>;
}) {
  const surfaceCorners = useMediaCorners();
  const filmCorners = useMediaCorners();
  const mode = selection.kind;
  const picture = selection.kind === "emoji" ? "" : selection.picture;
  const lastEmoji = useRef<EmojiSelection>({
    kind: "emoji",
    emoji: "😀",
    color: defaultEmojiColor,
  });
  const [animateEmoji, setAnimateEmoji] = useState(false);
  const [animateBackdrop, setAnimateBackdrop] = useState(false);
  const [animateColor, setAnimateColor] = useState(false);
  const emojiSelection =
    selection.kind === "emoji" ? selection : lastEmoji.current;
  const { emoji, color } = emojiSelection;
  const setEmoji = (change: Partial<EmojiSelection>) => {
    lastEmoji.current = { ...emojiSelection, ...change };
    onChange(lastEmoji.current);
  };
  const [emojiOpen, setEmojiOpen] = useState(false);
  // The chosen file shows at once; it stays the artwork after its upload lands.
  type Local = {
    url: string;
    fixed?: boolean;
    picture?: string;
    progress?: number;
  };
  const [local, setLocal] = useState<Local | null>(null);
  // A replacement keeps the framed source until it lands, so a failed or
  // canceled upload restores it.
  const kept = useRef<Local | null>(null);
  // The crop lives in the selection so its owner can tell a reframe is a change.
  const crop = (selection.kind !== "gloopie" && selection.crop) || uncropped;
  const cropImage = useRef<HTMLImageElement>(null);
  // An image keeps only the framing it shows, so zooming back out restores
  // the original.
  const setCrop = (value: AvatarCrop) => {
    if (selection.kind === "emoji") return setEmoji({ crop: value });
    const image = cropImage.current;
    onChange({
      kind: "image",
      picture,
      crop: image?.naturalWidth
        ? avatarCropBox(image.naturalWidth / image.naturalHeight, value).crop
        : value,
    });
  };
  const uploading = local && local.picture === undefined ? local : null;
  const busy = !!uploading;
  const localUrl = local?.url;
  useEffect(
    () => () => {
      if (localUrl && localUrl !== kept.current?.url)
        URL.revokeObjectURL(localUrl);
    },
    [localUrl],
  );
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const selected =
    selection.kind === "gloopie"
      ? agentAvatars.find((avatar) => avatar.url === picture)
      : undefined;
  const [lastAvatar, setLastAvatar] = useState(
    () => selected ?? randomAgentAvatar(),
  );
  const [slots, setSlots] = useState(() =>
    agentAvatars
      .filter((avatar) => avatar.url !== picture)
      .map((avatar) => ({ id: avatar.id, avatar })),
  );
  const center = useRef<HTMLDivElement>(null);
  const swap = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => swap.current?.(), []);
  const dockPointer = useRef<number | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    left: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [magnifier] = useState(createDockMagnifier);
  useEffect(() => () => magnifier.dispose(), [magnifier]);
  const resetDock = (dock: HTMLElement) => {
    dockPointer.current = null;
    magnifier.move(dock, null);
  };
  const endDrag = (event: React.PointerEvent<HTMLFieldSetElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const dockEvents = {
    onPointerDown: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      suppressClick.current = false;
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      const dock = event.currentTarget;
      if (disabled || busy || dock.scrollWidth <= dock.clientWidth) return;
      event.preventDefault();
      drag.current = {
        pointer: event.pointerId,
        x: event.clientX,
        left: dock.scrollLeft,
        moved: false,
      };
    },
    onPointerMove: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      const dock = event.currentTarget;
      const gesture = drag.current;
      if (gesture?.pointer === event.pointerId) {
        if (!event.buttons || disabled || busy) {
          endDrag(event);
          return;
        }
        const distance = event.clientX - gesture.x;
        if (!gesture.moved && Math.abs(distance) < 4) return;
        gesture.moved = true;
        suppressClick.current = true;
        dock.setPointerCapture(event.pointerId);
        dock.dataset.dragging = "true";
        resetDock(dock);
        dock.scrollLeft = gesture.left - distance;
        return;
      }
      const bounds = dock.getBoundingClientRect();
      // The native scrollbar is navigation, not part of the magnification area.
      if (event.clientY >= bounds.top + dock.clientHeight || event.buttons) {
        resetDock(dock);
        return;
      }
      if (
        !disabled &&
        !busy &&
        event.pointerType === "mouse" &&
        avatarMotionAllowed()
      ) {
        dockPointer.current = event.clientX;
        magnifier.move(dock, event.clientX);
      }
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onClickCapture: (event: React.MouseEvent<HTMLFieldSetElement>) => {
      // A released drag must never choose the avatar underneath it. Keyboard
      // activation has detail 0 and remains available after a drag.
      if (suppressClick.current && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onPointerLeave: (event: React.PointerEvent<HTMLFieldSetElement>) =>
      resetDock(event.currentTarget),
    onKeyDown: (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
      dockPointer.current = null;
      magnifier.move(event.currentTarget, null, true);
    },
    onScroll: (event: React.UIEvent<HTMLFieldSetElement>) =>
      magnifier.move(event.currentTarget, dockPointer.current),
  };
  const dockSurface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = dockSurface.current;
    if (!surface) return;
    // The dock hides its scrollbar; the dominant axis of any wheel moves it.
    const wheel = (event: WheelEvent) => {
      const dock = surface.querySelector("fieldset");
      if (!dock || event.ctrlKey) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? dock.clientWidth
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : 1;
      const delta =
        (Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY) * unit;
      const room = dock.scrollWidth - dock.clientWidth;
      if (
        !delta ||
        room <= 0 ||
        (delta < 0 && dock.scrollLeft <= 0) ||
        (delta > 0 && dock.scrollLeft >= room)
      )
        return;
      event.preventDefault();
      dock.scrollBy({ left: delta, behavior: "instant" });
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, []);
  const preview = useAvatarPreview(selected ? "" : picture, community, "small");
  useEffect(
    () => () => {
      pending.current?.abort();
      if (kept.current) URL.revokeObjectURL(kept.current.url);
    },
    [],
  );
  const shown = local?.picture === picture ? local?.url : undefined;
  const cropping = shown && !local?.fixed ? shown : undefined;
  useImperativeHandle(avatarRef, () => ({
    async prepare() {
      const image = cropImage.current;
      const request = new AbortController();
      pending.current = request;
      try {
        // Default framing keeps the original upload.
        if (cropping)
          await image?.decode().catch(() => {
            // Saving the original would silently drop the framing.
            if (crop.zoom !== 1 || crop.x || crop.y)
              throw new Error("Couldn't frame the image. Try again.");
          });
        request.signal.throwIfAborted();
        const framed =
          cropping && image?.naturalWidth
            ? avatarCropBox(image.naturalWidth / image.naturalHeight, crop).crop
            : uncropped;
        const paint =
          selection.kind === "emoji"
            ? () =>
                emojiAvatar(
                  selection.emoji,
                  selection.color,
                  emojiAvatarScale * crop.zoom,
                  crop.y,
                  crop.x,
                )
            : image && (framed.zoom !== 1 || framed.x || framed.y)
              ? () => croppedAvatar(image, crop)
              : undefined;
        if (!paint) return selection.kind === "emoji" ? "" : selection.picture;
        if (!community)
          throw new Error("Select a community to use an emoji avatar.");
        const file = await paint();
        request.signal.throwIfAborted();
        return await uploadAvatar(file, community, request.signal);
      } finally {
        if (pending.current === request) pending.current = null;
      }
    },
  }));
  const upload = async (file: File) => {
    if (!community || pending.current || disabled) return;
    const request = new AbortController();
    pending.current = request;
    const url = URL.createObjectURL(file);
    kept.current = local;
    setLocal({ url });
    onBusyChange(true);
    setError("");
    try {
      const value = await uploadAvatar(
        file,
        community,
        request.signal,
        (sent, total) => {
          if (!request.signal.aborted && total)
            setLocal({ url, progress: sent / total });
        },
      );
      // Uploads stay as chosen when painting would keep only an animation's
      // first frame, or when this browser can't decode them (HEIC outside
      // WebKit, which the host converts).
      const fixed =
        (await animatedImage(file).catch(() => true)) || !(await decodes(url));
      if (request.signal.aborted) return;
      if (kept.current) URL.revokeObjectURL(kept.current.url);
      kept.current = null;
      setLocal({ url, fixed, picture: value });
      onChange({ kind: "image", picture: value });
    } catch (reason) {
      if (request.signal.aborted) return;
      restore();
      setError(
        reason instanceof Error
          ? reason.message
          : "Image upload failed. Try again.",
      );
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        onBusyChange(false);
      }
    }
  };
  const restore = () => {
    setLocal(kept.current);
    kept.current = null;
  };
  const cancelUpload = () => {
    pending.current?.abort();
    pending.current = null;
    restore();
    onBusyChange(false);
  };
  const chooseImage = () => {
    if (!community) {
      setError("Select a community to upload an image.");
      return;
    }
    input.current?.click();
  };
  const locked = disabled || busy;
  const emojiPan = useAvatarPan(
    crop,
    (x, y) => setCrop({ ...crop, x: emojiCenter(x), y: emojiCenter(y) }),
    locked,
  );
  return (
    <>
      <div
        ref={surfaceCorners}
        className={styles.avatarSurface}
        data-color-transition={animateColor || undefined}
        style={
          mode === "emoji"
            ? {
                backgroundColor:
                  color === "transparent"
                    ? "var(--surface-panel)"
                    : `color-mix(in srgb, ${color} 14%, var(--surface-panel))`,
              }
            : undefined
        }
      >
        {(busy || mode !== "emoji") && (
          <AgentAvatarBackdrop
            animate={animateBackdrop}
            src={uploading?.url ?? selected?.preview ?? shown ?? preview}
          />
        )}
        <div className="flex items-center justify-end">
          <Tabs<AvatarSelection["kind"]>
            label="Avatar type"
            variant="segmented-icons"
            value={mode}
            items={[
              {
                value: "gloopie",
                label: "Gloopies",
                disabled: locked,
                icon: (
                  <Avatar
                    src={lastAvatar.preview}
                    alt=""
                    fallback={lastAvatar.label}
                    size="fill"
                    shape="squircle"
                  />
                ),
              },
              {
                value: "emoji",
                label: "Emoji",
                icon: <SmileyIcon />,
                disabled: locked,
              },
              {
                value: "image",
                label: "Upload image",
                icon: <ImageIcon />,
                disabled: locked,
              },
            ]}
            onValueChange={(next) => {
              swap.current?.();
              swap.current = undefined;
              setAnimateBackdrop(false);
              setAnimateColor(false);
              if (next === "image") {
                chooseImage();
                return;
              }
              onChange(
                next === "gloopie"
                  ? { kind: "gloopie", picture: lastAvatar.url }
                  : lastEmoji.current,
              );
              setError("");
            }}
            onReselect={(next) => {
              if (next === "image") chooseImage();
            }}
          />
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          aria-label="Upload an image"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        <div className={styles.avatarBrowser}>
          <div className={styles.avatarStage}>
            <div ref={center} className={styles.avatarSelected}>
              {uploading ? (
                <div className={styles.avatarUploading}>
                  <Avatar
                    src={uploading.url}
                    alt="Uploading avatar"
                    fallback={name}
                    size="fill"
                    shape="squircle"
                  />
                  <span className={styles.uploadCancel}>
                    <IconButton
                      variant="glass"
                      shape="round"
                      size="large"
                      aria-label="Cancel upload"
                      icon={
                        <span className={styles.uploadControl}>
                          <svg
                            viewBox="0 0 24 24"
                            role="progressbar"
                            aria-label="Uploading image"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={
                              uploading.progress === undefined
                                ? undefined
                                : Math.round(uploading.progress * 100)
                            }
                            className={
                              uploading.progress === undefined
                                ? styles.uploadPreparing
                                : undefined
                            }
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              opacity="0.5"
                            />
                            <circle
                              className={styles.uploadArc}
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              pathLength="100"
                              strokeDasharray={`${uploading.progress === undefined ? 25 : uploading.progress * 100} 100`}
                              transform="rotate(-90 12 12)"
                            />
                          </svg>
                          <XIcon aria-hidden="true" />
                        </span>
                      }
                      onClick={cancelUpload}
                    />
                  </span>
                </div>
              ) : mode === "emoji" ? (
                <PopoverRoot
                  open={emojiOpen}
                  onOpenChange={(open) => {
                    // The click that ends a drag only moves the emoji.
                    if (!open || !emojiPan.moved.current) setEmojiOpen(open);
                  }}
                >
                  <PopoverTrigger
                    render={
                      <SurfaceButton
                        className={styles.emojiAvatarButton}
                        aria-label="Choose emoji"
                        aria-description="Drag or use the arrow keys to move the emoji"
                        disabled={locked}
                        {...emojiPan.handlers}
                      />
                    }
                  >
                    <span
                      data-avatar-shape="squircle"
                      className={styles.emojiAvatarArtwork}
                      style={{ backgroundColor: color }}
                    >
                      <EmojiSwap
                        emoji={emoji}
                        crop={crop}
                        animate={animateEmoji}
                      />
                    </span>
                  </PopoverTrigger>
                  <PopoverPopup
                    aria-label="Choose emoji"
                    onKeyDownCapture={(event) => {
                      // Emoji Mart consumes Escape in its shadow-root search.
                      // Close this popup before the key reaches the widget.
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setEmojiOpen(false);
                      }
                    }}
                    side="bottom"
                    align="start"
                  >
                    <AvatarEmojiPicker
                      disabled={locked}
                      onSelect={(value, animate) => {
                        setAnimateEmoji(animate);
                        setEmoji({ emoji: value });
                        setEmojiOpen(false);
                      }}
                    />
                  </PopoverPopup>
                </PopoverRoot>
              ) : selected ? (
                <PackedAgentAvatar avatar={selected} />
              ) : cropping ? (
                <AvatarCropFrame
                  src={cropping}
                  shape="squircle"
                  crop={crop}
                  disabled={locked}
                  imageRef={cropImage}
                  onChange={setCrop}
                />
              ) : (
                <Avatar
                  src={shown ?? preview}
                  alt="Selected avatar"
                  fallback={name}
                  size="fill"
                  shape="squircle"
                />
              )}
              {/* Floats over the artwork so showing it never moves the card. */}
              {!uploading && (mode === "emoji" || (cropping && !selected)) && (
                <AvatarZoom
                  className={`${styles.avatarZoom} glass-secondary`}
                  crop={crop}
                  disabled={locked}
                  onChange={(value) =>
                    setCrop(
                      selection.kind === "emoji"
                        ? value
                        : // An image zooms about the frame's centre, so the
                          // framed subject stays in place.
                          {
                            ...value,
                            x: (crop.x * value.zoom) / crop.zoom,
                            y: (crop.y * value.zoom) / crop.zoom,
                          },
                    )
                  }
                />
              )}
            </div>
          </div>
          <div ref={dockSurface} className={styles.dockSurface}>
            <div
              ref={filmCorners}
              aria-hidden="true"
              className={`${styles.dockGlass} glass-secondary`}
            />
            {mode === "emoji" ? (
              <fieldset
                className={styles.avatarDock}
                {...dockEvents}
                aria-label="Avatar background"
                disabled={locked}
              >
                {backgrounds.map((swatch) => (
                  <span key={swatch} className={styles.dockItem}>
                    <IconButton
                      data-color-swatch={swatch}
                      variant="primary"
                      shape="round"
                      size="sm"
                      icon={
                        <CircleIcon
                          size={24}
                          strokeWidth={3}
                          aria-hidden="true"
                          className={
                            color === swatch ? "opacity-100" : "opacity-0"
                          }
                        />
                      }
                      aria-label={`Use ${swatch} background`}
                      aria-pressed={color === swatch}
                      style={
                        swatch === "transparent"
                          ? undefined
                          : { backgroundColor: swatch }
                      }
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse")
                          event.preventDefault();
                      }}
                      onClick={(event) => {
                        setAnimateColor(event.detail > 0);
                        setEmoji({ color: swatch });
                      }}
                    />
                  </span>
                ))}
              </fieldset>
            ) : (
              <fieldset
                className={styles.avatarDock}
                {...dockEvents}
                aria-label="Agent avatars"
                disabled={locked}
              >
                {slots.map(({ id, avatar }, index) => (
                  <span key={id} className={styles.dockItem}>
                    <SurfaceButton
                      className={styles.avatarDockButton}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse")
                          event.preventDefault();
                      }}
                      aria-label={avatar.label}
                      aria-pressed={picture === avatar.url}
                      onClick={(event) => {
                        swap.current?.();
                        setAnimateBackdrop(
                          event.detail > 0 && avatarMotionAllowed(),
                        );
                        if (
                          selected?.preview &&
                          avatar.preview &&
                          center.current &&
                          event.detail > 0 &&
                          avatarMotionAllowed() &&
                          typeof event.currentTarget.animate === "function"
                        ) {
                          swap.current = swapAvatarArtwork(
                            event.currentTarget,
                            center.current,
                            selected.preview,
                          );
                        }
                        setSlots((current) =>
                          current.map((item, slot) =>
                            slot === index
                              ? { ...item, avatar: selected ?? lastAvatar }
                              : item,
                          ),
                        );
                        setLastAvatar(avatar);
                        onChange({ kind: "gloopie", picture: avatar.url });
                      }}
                    >
                      <img
                        src={avatar.preview}
                        alt=""
                        loading="lazy"
                        draggable={false}
                      />
                    </SurfaceButton>
                  </span>
                ))}
              </fieldset>
            )}
          </div>
        </div>
        {busy && (
          <p role="status" className="sr-only">
            Uploading image…
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
      </div>
      {/* Reserve help outside the card so mode changes keep its size and inset. */}
      {!community && (
        <p
          className="m-0 text-body-sm text-secondary"
          style={{ visibility: mode === "emoji" ? "visible" : "hidden" }}
        >
          Select a community to use an emoji avatar.
        </p>
      )}
    </>
  );
}
