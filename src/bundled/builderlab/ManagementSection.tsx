import type { ReactNode } from "react";
import styles from "./ManagementSection.module.css";

export type ManagementFact = {
  label: string;
  value: ReactNode;
  action?: ReactNode;
};

/** Account and collection facts shared by the management sections. */
export function ManagementFacts({
  items,
}: {
  items: readonly ManagementFact[];
}) {
  return (
    <dl className={styles.facts}>
      {items.map(({ label, value, action }) => (
        <div key={label} className={`${styles.fact} text-body-sm`}>
          <dt className="text-subtle">{label}</dt>
          <dd className={styles.value}>
            {value}
            {action}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Feature content only: Settings retains its title, navigation and scroll owner. */
export function ManagementSection({
  hero,
  facts,
  aside,
  children,
}: {
  hero: string;
  facts: readonly ManagementFact[];
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.frame}>
      <img src={hero} alt="" className={styles.hero} />
      <div className={styles.layout}>
        <div className={styles.main}>{children}</div>
        {(facts.length > 0 || aside) && (
          <aside className={styles.aside}>
            {facts.length > 0 && <ManagementFacts items={facts} />}
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}
