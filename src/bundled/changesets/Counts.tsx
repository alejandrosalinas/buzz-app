import styles from "./Changesets.module.css";

export function Counts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className={styles.counts}>
      <span className={styles.added}>+{additions}</span>
      <span className={styles.removed}>−{deletions}</span>
    </span>
  );
}

export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const totals = (
  files: readonly { additions: number; deletions: number }[],
) => ({
  additions: files.reduce((sum, file) => sum + file.additions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
});
