/** Largest count shown in full; larger counts read as "99+". */
const MAX_VISIBLE = 99;

/**
 * A quiet count bubble for navigation rows: a circle for one digit that
 * stretches into a pill for more. The visible number caps at 99+, while the
 * accessible label always carries the exact count and what it counts.
 */
export function CountBadge({
  count,
  label,
}: {
  count: number;
  /** Spoken description, such as "5 drafts". */
  label: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-buzz-ui=""
      className="buzz-count-badge"
      role="img"
      aria-label={label}
    >
      {count > MAX_VISIBLE ? `${MAX_VISIBLE}+` : count}
    </span>
  );
}
