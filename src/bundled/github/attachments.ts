import type { Attachment } from "../../features/relay/contracts";
import { MAX_MARKDOWN_LENGTH } from "../../features/relay/message-content";

type MediaKind = Exclude<Attachment["kind"], "file">;
/** `src` is a signed media URL from the rendered HTML, which loads without a
 * GitHub sign-in but expires within minutes. */
type Descriptor = {
  kind: MediaKind;
  name?: string | undefined;
  src?: string | undefined;
};
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const assetPath = new RegExp(`^/user-attachments/assets/(${uuid})$`, "i");
const legacyPath = new RegExp(`^/[^/]+/[^/]+/assets/\\d+/(${uuid})$`, "i");
const cdnPath = new RegExp(`^/\\d+/\\d+-(${uuid})\\.[a-z0-9]+$`, "i");

export function bodyUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function githubMediaUrl(value: string): URL | undefined {
  const safe = bodyUrl(value, "https://github.com");
  if (!safe) return;
  const url = new URL(safe);
  if (url.protocol !== "https:" || url.port) return;
  if (url.hostname === "github.com") {
    if (
      assetPath.test(url.pathname) ||
      legacyPath.test(url.pathname) ||
      /^\/user-attachments\/files\/\d+\/[^/]+$/.test(url.pathname)
    )
      return url;
  } else if (
    [
      "user-images.githubusercontent.com",
      "private-user-images.githubusercontent.com",
      "raw.githubusercontent.com",
    ].includes(url.hostname)
  )
    return url;
}

function assetKey(url: URL): string {
  const match =
    url.hostname === "github.com"
      ? (assetPath.exec(url.pathname) ?? legacyPath.exec(url.pathname))
      : cdnPath.exec(url.pathname);
  return match?.[1] ? `asset:${match[1].toLowerCase()}` : url.href;
}

function filenameKind(name: string): MediaKind | undefined {
  if (/\.(png|gif|jpe?g|svg|webp)$/i.test(name)) return "image";
  if (/\.(mp4|mov|webm)$/i.test(name)) return "video";
  if (/\.(mp3|wav|m4a|ogg)$/i.test(name)) return "audio";
}

// Template contents never enter the live document or fetch their resource URLs.
export function inertHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

export function attachmentMetadata(html = ""): ReadonlyMap<string, Descriptor> {
  const descriptors = new Map<string, Descriptor>();
  if (!html || html.length > MAX_MARKDOWN_LENGTH * 10) return descriptors;
  for (const element of inertHtml(html).querySelectorAll(
    "img, video, audio, source, a",
  )) {
    const tag =
      element.localName === "source"
        ? element.parentElement?.localName
        : element.localName;
    const name = (
      tag === "a"
        ? element.textContent
        : element.closest("details")?.querySelector("summary")?.textContent
    )?.trim();
    for (const attribute of ["src", "href", "data-canonical-src"]) {
      const url = githubMediaUrl(element.getAttribute(attribute) ?? "");
      if (!url) continue;
      const kind =
        tag === "img"
          ? "image"
          : tag === "video" || tag === "audio"
            ? tag
            : filenameKind(name ?? url.pathname);
      if (!kind) continue;
      const key = assetKey(url);
      const src =
        url.hostname === "private-user-images.githubusercontent.com"
          ? url.href
          : descriptors.get(key)?.src;
      descriptors.set(key, { kind, name, src });
    }
  }
  return descriptors;
}

export function attachmentFor(
  value: string,
  metadata: ReadonlyMap<string, Descriptor>,
  image = false,
): Attachment | undefined {
  const url = githubMediaUrl(value);
  if (!url) return;
  const descriptor = metadata.get(assetKey(url));
  const kind = image
    ? "image"
    : (descriptor?.kind ?? filenameKind(url.pathname));
  if (
    !kind ||
    (url.hostname === "raw.githubusercontent.com" && kind !== "image")
  )
    return;
  return {
    url: value,
    kind,
    ...(descriptor?.name ? { name: descriptor.name } : {}),
  };
}

/** `value`'s signed link in the rendered HTML, for a private repository's
 * media whose own link needs a GitHub sign-in. */
export function signedUrl(
  value: string,
  metadata: ReadonlyMap<string, Descriptor>,
): string | undefined {
  const url = githubMediaUrl(value);
  return url && metadata.get(assetKey(url))?.src;
}
