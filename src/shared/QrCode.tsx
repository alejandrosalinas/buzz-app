import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";

export type QrVariant = "light" | "dark";

/** Styled QR code SVG for a shareable, non-secret value, drawn by the native
 * host renderer that pairing uses (src-tauri/src/qr.rs). Dark draws light dots
 * on black. */
export const renderQrCode = (value: string, variant: QrVariant) =>
  invoke<string>("qr_code", { value, variant });

const colorMode = (): QrVariant =>
  document.documentElement.dataset.colorMode === "dark" ? "dark" : "light";

function subscribeColorMode(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-color-mode"],
  });
  return () => observer.disconnect();
}

/** The QR variant for the app's current color mode: light dots on black in
 * dark mode, dark dots on white otherwise. Follows a mode change. */
export const useQrVariant = () =>
  useSyncExternalStore(subscribeColorMode, colorMode);

/** A native QR code SVG at its fixed scannable size; the SVG paints its own
 * background. Reduced motion drops its reveal animation. */
export function QrCode({ svg, alt }: { svg: string; alt: string }) {
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <img
      className="block size-60 max-w-full shrink-0"
      src={`data:image/svg+xml,${encodeURIComponent(reducedMotion ? svg.replace(/<style>[\s\S]*?<\/style>/g, "") : svg)}`}
      alt={alt}
      width={240}
      height={240}
    />
  );
}
