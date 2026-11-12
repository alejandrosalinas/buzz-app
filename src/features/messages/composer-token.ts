import type { JsonValue } from "../navigation/targets";

/** A host-internal semantic editor atom, separate from notification
 * recipients. Only bundled completion providers create one; it is not part of
 * the plugin contract. Extra JSON fields round-trip without interpretation. */
export type ComposerToken = Readonly<
  (
    | { kind: "folder"; id: string; label: string }
    | { kind: "skill"; id: string; label: string; target: string }
  ) & { readonly [key: string]: JsonValue | undefined }
>;

/** Copy only bounded JSON. A provider cannot retain mutable editor metadata or
 * turn a token into a recipient through a label, prototype or callback. */
export function composerToken(value: unknown): ComposerToken | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || new TextEncoder().encode(json).length > 8192) return;
    const token = JSON.parse(json);
    if (
      !token ||
      typeof token !== "object" ||
      Array.isArray(token) ||
      typeof token.id !== "string" ||
      !token.id ||
      token.id.length > 4096 ||
      /\p{Cc}/u.test(token.id) ||
      typeof token.label !== "string" ||
      !token.label.trim() ||
      token.label.length > 256 ||
      /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(token.label)
    )
      return;
    if (token.kind === "skill") {
      if (
        typeof token.target !== "string" ||
        !/^[0-9a-f]{64}$/.test(token.target)
      )
        return;
    } else if (token.kind !== "folder") return;
    const freeze = (item: object) => {
      for (const nested of Object.values(item))
        if (nested && typeof nested === "object") freeze(nested);
      Object.freeze(item);
    };
    freeze(token);
    return token as ComposerToken;
  } catch {
    return;
  }
}

/** The text a chip stands for in the draft and the sent message; the chip
 * itself shows its label. An agent invokes a skill as `$name` and opens a
 * folder by its path. */
export function composerTokenText(token: ComposerToken) {
  return token.kind === "skill" ? `$${token.label}` : token.id;
}

export function composerTokenName(token: ComposerToken) {
  return `${token.kind === "folder" ? "Folder" : "Skill"} ${token.label}`;
}
