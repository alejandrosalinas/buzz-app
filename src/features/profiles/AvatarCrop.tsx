import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { type AvatarCrop, avatarCropBox } from "./avatar-upload";
import styles from "./AvatarCrop.module.css";

const arrows: Record<string, [number, number]> = {
  ArrowLeft: [-0.02, 0],
  ArrowRight: [0.02, 0],
  ArrowUp: [0, -0.02],
  ArrowDown: [0, 0.02],
};

/** Drag or arrow-key panning in frame widths. A mouse press never starts a
 * text selection, and `moved` is set only for the click that ends a drag. */
export function useAvatarPan(
  crop: AvatarCrop,
  move: (x: number, y: number) => void,
  disabled?: boolean,
) {
  const drag = useRef<{ x: number; y: number; crop: AvatarCrop } | null>(null);
  const moved = useRef(false);
  const end = () => {
    drag.current = null;
    if (moved.current) setTimeout(() => (moved.current = false));
  };
  return {
    moved,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (disabled || event.button) return;
        // Keep a drag from selecting text, but still take focus for the arrows.
        if (event.pointerType === "mouse") {
          event.preventDefault();
          event.currentTarget.focus();
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, crop };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = drag.current;
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        moved.current ||= Math.hypot(dx, dy) > 3;
        if (!moved.current) return;
        const size = event.currentTarget.clientWidth;
        move(start.crop.x + dx / size, start.crop.y + dy / size);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        const [dx, dy] = arrows[event.key] ?? [0, 0];
        if (disabled || (!dx && !dy)) return;
        event.preventDefault();
        move(crop.x + dx, crop.y + dy);
      },
    },
  };
}

/** Drag or use the arrow keys to pan an image inside its avatar shape. The
 * shape clips only the artwork, so the focus ring stays visible. Without
 * `onChange` it only shows the framed image. */
export function AvatarCropFrame({
  src,
  shape,
  crop,
  disabled,
  imageRef,
  onChange,
  onError,
}: {
  src: string;
  shape: "circle" | "squircle";
  crop: AvatarCrop;
  disabled?: boolean;
  imageRef?: Ref<HTMLImageElement>;
  onChange?(crop: AvatarCrop): void;
  onError?(): void;
}) {
  const [loaded, setLoaded] = useState<{ src: string; aspect: number }>();
  // An image's shape is unknown until it loads, so it stays hidden until
  // then rather than paint squashed into the square.
  const aspect = loaded?.src === src ? loaded.aspect : undefined;
  const box = avatarCropBox(aspect ?? 1, crop);
  const pan = useAvatarPan(
    box.crop,
    (x, y) => onChange?.(avatarCropBox(aspect ?? 1, { ...crop, x, y }).crop),
    disabled,
  );
  const artwork = (
    <div data-avatar-shape={shape} className={styles.artwork}>
      <img
        ref={imageRef}
        src={src}
        alt="Avatar preview"
        draggable={false}
        onError={onError}
        onLoad={(event) => {
          const image = event.currentTarget;
          setLoaded({
            src,
            aspect: image.naturalWidth / image.naturalHeight || 1,
          });
        }}
        style={{
          visibility: aspect ? undefined : "hidden",
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
          left: `${box.left * 100}%`,
          top: `${box.top * 100}%`,
        }}
      />
    </div>
  );
  if (!onChange) return artwork;
  return (
    <div
      // A 2D pan has no widget role; the description gives its keys.
      role="application"
      tabIndex={disabled ? -1 : 0}
      aria-label="Image position"
      aria-description="Drag or use the arrow keys to move the image"
      aria-disabled={disabled || undefined}
      className={styles.frame}
      {...pan.handlers}
    >
      {artwork}
    </div>
  );
}

export function AvatarZoom({
  className,
  crop,
  disabled,
  onChange,
}: {
  className?: string | undefined;
  crop: AvatarCrop;
  disabled?: boolean;
  onChange(crop: AvatarCrop): void;
}) {
  return (
    <label className={`${styles.zoom} ${className ?? ""}`}>
      <span className="sr-only">Zoom</span>
      <input
        type="range"
        min={1}
        max={3}
        step={0.05}
        value={crop.zoom}
        aria-valuetext={`${Math.round(crop.zoom * 100)}%`}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...crop, zoom: Number(event.target.value) })
        }
      />
    </label>
  );
}
