// An agent card as a picture: avatar-colored foil around a white panel, the Buzz
// mark, the agent's picture, its name, and its harness and model as stats.
// It is the same in either theme, as a thing handed to someone else.

import foilTextureUrl from "./assets/card-foil.webp";
import { fallbackAgentCardColor } from "./agent-card-color";

export const CARD_WIDTH = 820;
export const CARD_HEIGHT = 1230;
/** The card's outer corner, which the preview clips to. */
export const CARD_RADIUS = 56;
const PANEL = { inset: 22, radius: 40 };
export const CARD_BORDER = PANEL.inset;
const EDGE = 70;
export const CARD_PICTURE = { x: 110, y: 170, size: 600, radius: 48 };
const INK = "#121214";
const MUTED = "#6e6e76";
/** `public/buzz-mark.svg`, traced here since an SVG image may not draw on a
 * canvas everywhere. */
const MARK =
  "M18 9a8 8 0 0 1 8-8h12a8 8 0 0 1 8 8v3h4a12 12 0 1 1 0 24h-4v3a8 8 0 0 1-8 8H26a8 8 0 0 1-8-8v-3h-4a12 12 0 1 1 0-24h4V9Z";
const FONT = `"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;

const word = (text: string) => (text[0]?.toUpperCase() ?? "") + text.slice(1);

/** `claude-opus-5-5` as `Claude Opus 5.5` and an alias such as `opus` as
 * `Opus`; other ids unchanged. */
const tidy = (id: string) => {
  if (/^[a-z]+$/.test(id)) return word(id);
  const match = /^([a-z]+)-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!match) return id;
  const [, vendor = "", family = "", major, minor] = match;
  return `${word(vendor)} ${word(family)} ${major}${minor ? `.${minor}` : ""}`;
};

/** The model as the card states it beside its harness. The harness's own
 * name isn't said twice (Claude's `claude-opus-5-5` is Opus 5.5), and an
 * agent left on its harness's default model says so. */
export function cardModel(harness: string, model: string) {
  const text = model
    .split(" · ")
    .map((part) => tidy(part.trim()))
    .join(" · ")
    .trim();
  const name = harness.trim();
  if (!text || text.toLowerCase() === name.toLowerCase()) return "Default";
  const lead = name.split(/\s+/)[0] ?? "";
  const rest = text.slice(lead.length);
  return lead &&
    text.toLowerCase().startsWith(lead.toLowerCase()) &&
    /^\s+\S/.test(rest)
    ? rest.trim()
    : text;
}

/** Repeatable sparkle positions for one card. */
function random(seed: string) {
  let state = 2166136261;
  for (const char of seed)
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  // mulberry32
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function rounded(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  // Arcs rather than `roundRect`, which older WebKit lacks.
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** `text` cut to `width` with an ellipsis. An imported agent's model may be
 * thousands of characters long, so the cut is found by halving, in a few
 * measurements rather than one per character. */
export function ellipsize(
  context: Pick<CanvasRenderingContext2D, "measureText">,
  text: string,
  width: number,
) {
  if (context.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  const cut = (length: number) =>
    `${chars.slice(0, length).join("").trimEnd()}…`;
  // The longest prefix that fits lies in [low, high).
  let low = 0;
  let high = chars.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (context.measureText(cut(middle)).width <= width) low = middle;
    else high = middle;
  }
  return cut(low);
}

function spaced(context: CanvasRenderingContext2D, spacing: string) {
  // Older WebKit draws without tracking rather than failing.
  if ("letterSpacing" in context) context.letterSpacing = spacing;
}

function foil(
  context: CanvasRenderingContext2D,
  seed: string,
  accent: string,
  texture?: HTMLImageElement,
) {
  context.fillStyle = accent;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  if (texture) {
    context.save();
    // The original template mirrors this metallic texture horizontally.
    context.translate(CARD_WIDTH, 0);
    context.scale(-1, 1);
    context.drawImage(texture, 0, 0, CARD_WIDTH, CARD_HEIGHT);
    context.restore();
    context.save();
    context.globalCompositeOperation = "color";
    context.globalAlpha = 0.62;
    context.fillStyle = accent;
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    context.restore();
    return;
  }
  const shine = context.createLinearGradient(0, CARD_HEIGHT, CARD_WIDTH, 0);
  shine.addColorStop(0.35, "rgba(255,255,255,0)");
  shine.addColorStop(0.5, "rgba(255,255,255,0.55)");
  shine.addColorStop(0.65, "rgba(255,255,255,0)");
  context.fillStyle = shine;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  const next = random(seed);
  for (let index = 0; index < 220; index++) {
    context.fillStyle = `rgba(255,255,255,${0.35 + next() * 0.6})`;
    context.beginPath();
    context.arc(
      next() * CARD_WIDTH,
      next() * CARD_HEIGHT,
      0.6 + next() * 1.8,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
}

function panel(context: CanvasRenderingContext2D) {
  const { inset, radius } = PANEL;
  const width = CARD_WIDTH - inset * 2;
  const height = CARD_HEIGHT - inset * 2;
  rounded(context, inset, inset, width, height, radius);
  context.fillStyle = "#ffffff";
  context.fill();
}

function picture(
  context: CanvasRenderingContext2D,
  name: string,
  image: HTMLImageElement | undefined,
) {
  const { x, y, size, radius } = CARD_PICTURE;
  context.save();
  rounded(context, x, y, size, size, radius);
  context.clip();
  if (image) {
    // Cover the square from the image's middle.
    const width = image.naturalWidth || size;
    const height = image.naturalHeight || size;
    const crop = Math.min(width, height);
    context.drawImage(
      image,
      (width - crop) / 2,
      (height - crop) / 2,
      crop,
      crop,
      x,
      y,
      size,
      size,
    );
  } else {
    const tile = context.createLinearGradient(x, y, x + size, y + size);
    tile.addColorStop(0, "#efe9f8");
    tile.addColorStop(1, "#e3eef9");
    context.fillStyle = tile;
    context.fillRect(x, y, size, size);
    context.fillStyle = "#6b6482";
    context.font = `500 240px ${FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      Array.from(name.trim())[0]?.toUpperCase() ?? "?",
      x + size / 2,
      y + size / 2,
    );
  }
  context.restore();
}

function mark(context: CanvasRenderingContext2D) {
  const shape = new Path2D(MARK);
  // Its eyes and mouth, cut out by the even-odd fill.
  for (const x of [25, 39]) {
    shape.moveTo(x + 4, 14);
    shape.arc(x, 14, 4, 0, Math.PI * 2);
  }
  shape.rect(23, 24, 18, 5);
  shape.rect(23, 35, 18, 5);
  context.save();
  context.translate(EDGE, EDGE);
  context.scale(52 / 64, 52 / 64);
  context.fillStyle = INK;
  context.fill(shape, "evenodd");
  context.restore();
}

function stat(
  context: CanvasRenderingContext2D,
  label: string,
  value: string,
  baseline: number,
) {
  const right = CARD_WIDTH - EDGE;
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = MUTED;
  context.font = `500 22px ${FONT}`;
  spaced(context, "2px");
  context.fillText(label, EDGE, baseline);
  const labelWidth = context.measureText(label).width;
  context.textAlign = "right";
  context.fillStyle = INK;
  context.font = `500 32px ${FONT}`;
  spaced(context, "0px");
  context.fillText(
    ellipsize(context, value, right - EDGE - labelWidth - 32),
    right,
    baseline,
  );
}

function rule(context: CanvasRenderingContext2D, y: number) {
  context.fillStyle = "rgba(18,18,20,0.12)";
  context.fillRect(EDGE, y, CARD_WIDTH - EDGE * 2, 2);
}

/** The card as a PNG. Throws where no canvas draws or the picture's origin
 * keeps it from being read back. */
export async function drawShareCard(card: {
  name: string;
  harness: string;
  model: string;
  picture?: HTMLImageElement | undefined;
  accentColor?: string | undefined;
}): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn’t draw the card.");
  // The interface face may still be loading when Export is first chosen; a
  // slow one gives way to the fallback faces rather than holding the card.
  await Promise.race([
    Promise.all(
      ["500 32px", "600 60px"].map((font) =>
        document.fonts
          ?.load(`${font} "Inter Variable"`, `${card.name}${card.model}`)
          .catch(() => []),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  let texture: HTMLImageElement | undefined;
  let textureTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    texture = new Image();
    texture.src = foilTextureUrl;
    await Promise.race([
      texture.decode(),
      new Promise((_, reject) => {
        textureTimer = setTimeout(
          () => reject(new Error("Foil texture unavailable")),
          1000,
        );
      }),
    ]);
  } catch {
    if (texture) texture.src = "";
    texture = undefined;
  } finally {
    clearTimeout(textureTimer);
  }
  context.save();
  rounded(context, 0, 0, CARD_WIDTH, CARD_HEIGHT, CARD_RADIUS);
  context.clip();
  foil(
    context,
    card.name,
    card.accentColor ?? fallbackAgentCardColor(card.name),
    texture,
  );
  panel(context);
  mark(context);
  context.fillStyle = INK;
  context.font = `600 24px ${FONT}`;
  spaced(context, "1.5px");
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillText("BUZZ AGENT", CARD_WIDTH - EDGE, EDGE + 20);
  picture(context, card.name, card.picture);
  context.fillStyle = INK;
  context.font = `600 60px ${FONT}`;
  spaced(context, "0px");
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(
    ellipsize(context, card.name.trim().toUpperCase(), CARD_WIDTH - EDGE * 2),
    EDGE,
    890,
  );
  rule(context, 940);
  stat(context, "HARNESS", card.harness, 1003);
  rule(context, 1048);
  stat(context, "MODEL", card.model, 1111);
  context.restore();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("Couldn’t draw the card.");
  return blob;
}
