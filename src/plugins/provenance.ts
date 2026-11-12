// Host-internal; plugins cannot import it. The runtime marks the owner it
// creates for a host-shipped module. Object identity, not an id or revision a
// scope could claim through ctx.extend, establishes bundled provenance.
const owners = new WeakSet<object>();
const entries = new WeakSet<object>();

export function bundledOwner<T extends object>(owner: T): T {
  owners.add(owner);
  return owner;
}
export const isBundledOwner = (owner: object) => owners.has(owner);
/** Contribution registries mark an entry a bundled owner registered. */
export function bundledContribution(entry: object) {
  entries.add(entry);
}
export const isBundledContribution = (entry: object) => entries.has(entry);
