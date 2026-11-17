// Assembly budgets inherited from the document renderer.
export const MAX_RENDER_CHARS = 1_000_000;
export const MAX_RENDER_DEPTH = 100;

/** Assert an indexed value after its owning scan has established the bound. */
export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing Markdown scanner value");
  return value;
}
