import { useMediaCorners } from "../../features/messages/use-media-corners";
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
  emojiAvatar,
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
] as const;

export type AvatarSelection =
  | { kind: "gloopie"; picture: string }
  | { kind: "emoji"; emoji: string; color: string }
  | { kind: "image"; picture: string };

const defaultEmojiColor = backgrounds[0];

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
  const lastEmoji = useRef("😀");
  const lastColor = useRef<string>(defaultEmojiColor);
  const [animateEmoji, setAnimateEmoji] = useState(false);
  const [animateBackdrop, setAnimateBackdrop] = useState(false);
  const [animateColor, setAnimateColor] = useState(false);
  const emoji =
    selection.kind === "emoji" ? selection.emoji : lastEmoji.current;
  const color =
    selection.kind === "emoji" ? selection.color : lastColor.current;
  const [emojiOpen, setEmojiOpen] = useState(false);
  // The chosen file shows at once; it stays the artwork after its upload lands.
  const [local, setLocal] = useState<{
    url: string;
    picture?: string;
    progress?: number;
  } | null>(null);
  const uploading = local && local.picture === undefined ? local : null;
  const busy = !!uploading;
  const localUrl = local?.url;
  useEffect(
    () => () => {
      if (localUrl) URL.revokeObjectURL(localUrl);
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
  const [magnifier] = useState(createDockMagnifier);
  useEffect(() => () => magnifier.dispose(), [magnifier]);
  const resetDock = (dock: HTMLElement) => {
    dockPointer.current = null;
    magnifier.move(dock, null);
  };
  const dockEvents = {
    onPointerMove: (event: React.PointerEvent<HTMLFieldSetElement>) => {
      const dock = event.currentTarget;
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
    // The dock hides its scrollbar, so a mouse wheel's vertical travel is the
    // only way through it; the dominant axis of any wheel moves the strip.
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
  useEffect(() => () => pending.current?.abort(), []);
  useImperativeHandle(avatarRef, () => ({
    async prepare() {
      if (selection.kind !== "emoji") return selection.picture;
      if (!community)
        throw new Error("Select a community to use an emoji avatar.");
      const request = new AbortController();
      pending.current = request;
      try {
        const file = await emojiAvatar(selection.emoji, selection.color);
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
      if (request.signal.aborted) return;
      setLocal({ url, picture: value });
      onChange({ kind: "image", picture: value });
    } catch (reason) {
      if (request.signal.aborted) return;
      setLocal(null);
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
  const cancelUpload = () => {
    pending.current?.abort();
    pending.current = null;
    setLocal(null);
    onBusyChange(false);
  };
  const chooseImage = () => {
    if (!community) {
      setError("Select a community to upload an image.");
      return;
    }
    input.current?.click();
  };
  const shown = local?.picture === picture ? local?.url : undefined;
  const locked = disabled || busy;
  return (
    <>
      <div
        ref={surfaceCorners}
        className={styles.avatarSurface}
        data-color-transition={animateColor || undefined}
        style={
          mode === "emoji"
            ? {
                backgroundColor: `color-mix(in srgb, ${color} 14%, var(--surface-panel))`,
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
                  : {
                      kind: "emoji",
                      emoji: lastEmoji.current,
                      color: lastColor.current,
                    },
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
              <PopoverRoot open={emojiOpen} onOpenChange={setEmojiOpen}>
                <PopoverTrigger
                  render={
                    <SurfaceButton
                      className={styles.emojiAvatarButton}
                      aria-label="Choose emoji"
                      disabled={locked}
                    />
                  }
                >
                  <span
                    data-avatar-shape="squircle"
                    className={styles.emojiAvatarArtwork}
                    style={{ backgroundColor: color }}
                  >
                    <EmojiSwap emoji={emoji} animate={animateEmoji} />
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
                      lastEmoji.current = value;
                      onChange({ kind: "emoji", emoji: value, color });
                      setEmojiOpen(false);
                    }}
                  />
                </PopoverPopup>
              </PopoverRoot>
            ) : selected ? (
              <PackedAgentAvatar avatar={selected} />
            ) : (
              <Avatar
                src={shown ?? preview}
                alt="Selected avatar"
                fallback={name}
                size="fill"
                shape="squircle"
              />
            )}
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
                      data-color-swatch=""
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
                      style={{ backgroundColor: swatch }}
                      onPointerDown={(event) => {
                        if (event.pointerType === "mouse")
                          event.preventDefault();
                      }}
                      onClick={(event) => {
                        setAnimateColor(event.detail > 0);
                        lastColor.current = swatch;
                        onChange({ kind: "emoji", emoji, color: swatch });
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
                      <img src={avatar.preview} alt="" loading="lazy" />
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
