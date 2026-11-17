import { LockIcon } from "../../shared/design-system/icons";
import styles from "./ForwardMessage.module.css";

export function ForwardDisclosure({
  id,
  audience,
}: {
  id?: string;
  audience: string;
}) {
  return (
    <p id={id} className={`text-body-sm ${styles.privacy}`}>
      <LockIcon size={14} aria-hidden="true" />
      <span>
        {audience} will be able to read this message, even if they can’t see
        where it came from.
      </span>
    </p>
  );
}
