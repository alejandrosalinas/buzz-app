import { CaretDownIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import type { SectionCap } from "./sidebar-section-caps";
import styles from "./Channels.module.css";

/** Show more and Show fewer share one row below a capped section's rows. */
export function SectionShowMore({
  sectionKey,
  title,
  cap,
  more,
  fewer,
}: {
  sectionKey: string;
  title: string;
  cap: SectionCap;
  more(): void;
  fewer(): void;
}) {
  if (!cap.hidden && !cap.foldable) return null;
  return (
    <div className={styles.sectionShowMore} data-section-show-more={sectionKey}>
      {cap.hidden > 0 && (
        <NavigationItem
          variant="text"
          data-show-more-expand=""
          label="Show more"
          aria-label={`Show more in ${title}`}
          icon={
            <span className={styles.sectionShowMoreIcon} aria-hidden="true">
              <CaretDownIcon size={16} />
            </span>
          }
          onClick={more}
        />
      )}
      {cap.foldable && (
        <NavigationItem
          variant="text"
          data-show-more-fold=""
          label="Show fewer"
          aria-label={`Show fewer in ${title}`}
          onClick={fewer}
        />
      )}
    </div>
  );
}
