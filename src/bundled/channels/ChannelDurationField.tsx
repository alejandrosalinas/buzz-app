import { motion, useReducedMotion } from "motion/react";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { MinusIcon, PlusIcon } from "../../shared/design-system/icons";
import styles from "./ChannelDurationField.module.css";

/** The temporary lifetimes a person can choose, shortest first. */
export const CHANNEL_DURATIONS = [86400, 604800, 1209600];
const durations = CHANNEL_DURATIONS;

/** Exact temporary lifetime in its largest whole unit, such as "7 days". */
export function channelDurationLabel(ttlSeconds: number) {
  const [duration, unit] =
    ttlSeconds === 1209600
      ? [2, "week"]
      : ttlSeconds % 86400 === 0
        ? [ttlSeconds / 86400, "day"]
        : ttlSeconds % 3600 === 0
          ? [ttlSeconds / 3600, "hour"]
          : ttlSeconds % 60 === 0
            ? [ttlSeconds / 60, "minute"]
            : [ttlSeconds, "second"];
  return `${duration} ${unit}${duration === 1 ? "" : "s"}`;
}

/** Draft-only lifetime controls shared by Create and Edit. */
export function ChannelDurationField({
  temporary,
  ttlSeconds,
  disabled = false,
  error,
  label: fieldLabel,
  onChange,
}: {
  temporary: boolean;
  ttlSeconds: number;
  disabled?: boolean;
  error?: string | undefined;
  label?: string;
  onChange(ttlSeconds: number | undefined): void;
}) {
  const reduceMotion = useReducedMotion();
  const instant =
    reduceMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  const transition = {
    duration: instant ? 0 : 0.2,
    ease: [0.2, 0.8, 0.2, 1] as const,
  };
  const shorter = [...durations].reverse().find((value) => value < ttlSeconds);
  const longer = durations.find((value) => value > ttlSeconds);
  const label = channelDurationLabel(ttlSeconds);
  return (
    <Field
      label={fieldLabel ?? "Duration"}
      labelVisibility={fieldLabel ? "visible" : "hidden"}
      error={error}
    >
      <RadioGroup
        value={temporary ? "temporary" : "ongoing"}
        disabled={disabled}
        onValueChange={(value) => {
          if (!disabled)
            onChange(value === "temporary" ? ttlSeconds : undefined);
        }}
      >
        <Radio
          value="ongoing"
          variant="card"
          label="Ongoing"
          description="No automatic archive."
        />
        <div className={styles.temporary}>
          <Radio
            value="temporary"
            variant="card"
            label={<span className={styles.temporaryLabel}>Temporary</span>}
            description={
              <>
                <span className="sr-only">
                  {temporary
                    ? `Archives after ${label} without activity.`
                    : "Archives without activity."}
                </span>
                <span aria-hidden="true">
                  Archives{" "}
                  <motion.span
                    className={styles.durationReveal}
                    initial={false}
                    animate={{
                      width: temporary ? "auto" : 0,
                      opacity: temporary ? 1 : 0,
                      whiteSpace: "nowrap",
                      transitionEnd: {
                        whiteSpace: temporary ? "normal" : "nowrap",
                      },
                    }}
                    transition={{ ...transition, whiteSpace: { duration: 0 } }}
                  >
                    <strong className={styles.duration}>after {label}</strong>
                    {"\u00a0"}
                  </motion.span>
                  without activity.
                </span>
              </>
            }
          />
          <motion.div
            className={styles.reveal}
            initial={false}
            animate={{
              width: temporary ? "auto" : 0,
              opacity: temporary ? 1 : 0,
            }}
            transition={transition}
            inert={!temporary}
            aria-hidden={!temporary || undefined}
          >
            <div className={styles.adjustments}>
              <IconButton
                aria-label="Decrease duration"
                icon={<MinusIcon />}
                variant="subtle"
                size="sm"
                disabled={disabled || shorter === undefined}
                onClick={() => {
                  if (shorter !== undefined) onChange(shorter);
                }}
              />
              <IconButton
                aria-label="Increase duration"
                icon={<PlusIcon />}
                variant="subtle"
                size="sm"
                disabled={disabled || longer === undefined}
                onClick={() => {
                  if (longer !== undefined) onChange(longer);
                }}
              />
            </div>
          </motion.div>
        </div>
      </RadioGroup>
    </Field>
  );
}
