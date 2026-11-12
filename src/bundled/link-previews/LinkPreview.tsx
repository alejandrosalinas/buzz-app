import { useEffect, useState } from "react";
import type { LinkPreviewProps } from "../../features/conversation/contracts";
import type { Loader, Page } from "./loader";
import { domainOf } from "./safety";
import styles from "./LinkPreview.module.css";

function Media({
  loader,
  image,
  alt,
  onWide,
}: {
  loader: Loader;
  image: string;
  alt: string;
  onWide(wide: boolean): void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setSrc(null);
    setBroken(false);
    const lease = loader.image(image);
    void lease.src.then((blob) => live && setSrc(blob));
    return () => {
      live = false;
      lease.release();
    };
  }, [loader, image]);
  if (!src || broken) return null;
  return (
    <span className={styles.media}>
      <img
        src={src}
        alt={alt}
        decoding="async"
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          onWide(naturalWidth > naturalHeight * 1.3);
        }}
        onError={() => setBroken(true)}
      />
    </span>
  );
}

export function LinkPreview({
  url,
  open,
  loader,
}: LinkPreviewProps & { loader: Loader }) {
  const [page, setPage] = useState<Page | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let live = true;
    setPage(null);
    setWide(false);
    void loader.page(url).then((found) => live && setPage(found));
    return () => {
      live = false;
    };
  }, [loader, url]);
  if (!page) return null;
  const domain = domainOf(url);
  const site =
    page.siteName && page.siteName.toLowerCase() !== domain.toLowerCase()
      ? `${page.siteName} · ${domain}`
      : domain;
  return (
    <a
      className={styles.card}
      href={url}
      data-wide={wide || undefined}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
    >
      {page.image && (
        <Media
          loader={loader}
          image={page.image}
          alt={page.imageAlt ?? ""}
          onWide={setWide}
        />
      )}
      <span className={styles.body}>
        <span className={styles.site}>{site}</span>
        <span className={styles.title}>{page.title}</span>
        {page.description && (
          <span className={styles.description}>{page.description}</span>
        )}
      </span>
    </a>
  );
}
