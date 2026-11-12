// @vitest-environment jsdom
import { expect, it } from "vitest";
import { attachmentFor, attachmentMetadata, signedUrl } from "./attachments";

const asset =
  "https://github.com/user-attachments/assets/cd0773ee-9861-46d9-8a0f-352ae951ec7f";
const signed =
  "https://private-user-images.githubusercontent.com/1/2-cd0773ee-9861-46d9-8a0f-352ae951ec7f.png?jwt=token";

it("keeps a private asset's own link and finds its signed link in the rendered HTML", () => {
  // A later reference to the same asset keeps its signed link.
  const metadata = attachmentMetadata(
    `<a href="${signed}"><img src="${signed}" data-canonical-src="${asset}"></a>`,
  );
  expect(attachmentFor(asset, metadata, true)).toEqual({
    url: asset,
    kind: "image",
  });
  expect(signedUrl(asset, metadata)).toBe(signed);
});

it("keeps public and raw media on their own links", () => {
  const raw = "https://raw.githubusercontent.com/block/buzz-app/main/icon.png";
  const metadata = attachmentMetadata(
    `<img src="${asset}"><img src="https://camo.githubusercontent.com/1/2" data-canonical-src="${raw}">`,
  );
  expect(attachmentFor(asset, metadata, true)?.url).toBe(asset);
  expect(attachmentFor(raw, metadata, true)?.url).toBe(raw);
  expect(signedUrl(asset, metadata)).toBeUndefined();
  expect(signedUrl(raw, metadata)).toBeUndefined();
});
