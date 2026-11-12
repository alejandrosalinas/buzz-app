import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finalizeEvent, getPublicKey } from "nostr-tools";

// Public fixture identity: tests must never access a saved OS credential.
const signingKey = new Uint8Array(32).fill(1);
export const publisher = getPublicKey(signingKey);

export async function signPackage(directory) {
  const [manifest, code] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8"),
    readFile(path.join(directory, "plugin.js"), "utf8"),
  ]);
  const artifact = { manifest: JSON.parse(manifest), code };
  for (const [file, field, encoding] of [
    ["README.md", "readme", "utf8"],
    ["icon.png", "iconPng", "base64"],
    ["icon.jpg", "iconJpg", "base64"],
  ]) {
    try {
      artifact[field] = (await readFile(path.join(directory, file))).toString(
        encoding,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const bytes = JSON.stringify(artifact);
  const event = finalizeEvent(
    {
      kind: 1064,
      created_at: 1,
      content: "",
      tags: [
        ["x", createHash("sha256").update(bytes).digest("hex")],
        ["t", "buzz-plugin-release-v1"],
      ],
    },
    signingKey,
  );
  await writeFile(path.join(directory, "plugin.artifact.json"), bytes);
  await writeFile(
    path.join(directory, "plugin.signature.json"),
    JSON.stringify(event),
  );
}
