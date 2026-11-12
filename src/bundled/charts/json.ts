export type Obj = Record<string, unknown>;

export const record = (x: unknown): x is Obj =>
  x !== null && typeof x === "object" && !Array.isArray(x);

export const list = (x: unknown): unknown[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];
