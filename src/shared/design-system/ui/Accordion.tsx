import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { CaretDownIcon } from "../icons/index";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/** Accessible disclosure groups. Base UI owns expansion and keyboard behavior. */
export function Accordion({
  items,
  defaultValue = [],
  value,
  onValueChange,
  variant = "default",
  headingLevel = 3,
  keepMounted = false,
  animate = false,
}: {
  items: readonly {
    value: string;
    title: ReactNode;
    triggerLabel?: string | undefined;
    triggerDescription?: string | undefined;
    content: ReactNode;
  }[];
  defaultValue?: string[];
  value?: string[];
  onValueChange?: (value: string[]) => void;
  variant?:
    | "default"
    | "form"
    | "settings"
    | "popout"
    | "navigation"
    | "activity"
    | "section";
  headingLevel?: 2 | 3;
  /** Preserve local form state while its panel is collapsed. */
  keepMounted?: boolean;
  /** Animate supporting detail panels; keyboard and reduced motion stay immediate. */
  animate?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <BaseAccordion.Root
      data-buzz-ui=""
      className="buzz-accordion"
      data-variant={variant}
      data-animate={animate || undefined}
      defaultValue={defaultValue}
      value={value}
      onValueChange={onValueChange}
      multiple
      keepMounted={keepMounted}
    >
      {items.map((item) => (
        <BaseAccordion.Item
          key={item.value}
          value={item.value}
          className="buzz-accordion-item"
        >
          <BaseAccordion.Header
            className="buzz-accordion-heading"
            render={(props) =>
              headingLevel === 2 ? (
                <h2 {...props}>{props.children}</h2>
              ) : (
                <h3 {...props}>{props.children}</h3>
              )
            }
          >
            <BaseAccordion.Trigger
              className={`buzz-accordion-trigger ${variant === "section" ? "text-label-sm" : "text-body"}`}
              aria-label={
                item.triggerLabel ??
                (variant === "settings" ? item.value : undefined)
              }
              aria-description={item.triggerDescription}
            >
              <span>{item.title}</span>
              <CaretDownIcon size={14} aria-hidden="true" />
            </BaseAccordion.Trigger>
          </BaseAccordion.Header>
          <BaseAccordion.Panel
            className="buzz-accordion-panel"
            render={
              animate
                ? (props, state) => {
                    // Modality is a document attribute, not React state; read
                    // it as each panel changes so keyboard toggles stay instant.
                    const instant =
                      reducedMotion ||
                      (typeof document !== "undefined" &&
                        document.documentElement.matches(
                          variant === "popout"
                            ? "[data-keyboard-input], [data-keyboard-navigation]"
                            : "[data-keyboard-navigation]",
                        ));
                    return (
                      <div {...props}>
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: state.open ? 1 : 0 }}
                          transition={{
                            duration: instant ? 0 : 0.22,
                            ease: [0.645, 0.045, 0.355, 1],
                          }}
                        >
                          {props.children}
                        </motion.div>
                      </div>
                    );
                  }
                : undefined
            }
          >
            {variant === "settings" || variant === "popout" || animate ? (
              <div className="buzz-accordion-content">{item.content}</div>
            ) : (
              item.content
            )}
          </BaseAccordion.Panel>
        </BaseAccordion.Item>
      ))}
    </BaseAccordion.Root>
  );
}
