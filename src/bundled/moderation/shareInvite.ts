import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderQrCode } from "../../shared/QrCode";

export const canShareInvite = () => isTauri() && /Mac/.test(navigator.platform);

/** Export the fully revealed, light QR so recipients can scan it independently
 * of the sender's theme or the SVG reveal animation. */
export async function shareInvite(url: string, anchor: DOMRect): Promise<void> {
  const svg = (await renderQrCode(url, "light")).replace(
    /<style>[\s\S]*?<\/style>/g,
    "",
  );
  const image = new Image();
  image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create the QR image.");
  context.drawImage(image, 0, 0, 720, 720);
  await invoke("share_image", {
    png: canvas.toDataURL("image/png").split(",")[1],
    url,
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
    height: anchor.height,
  });
}
