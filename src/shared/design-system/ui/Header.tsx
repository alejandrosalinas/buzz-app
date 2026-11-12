import type { ReactNode, Ref } from "react";

type HeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  align?: "start" | "end";
  id?: string;
  level?: 1 | 2 | 3 | 4;
  /** The heading element, for a caller that moves focus to it. */
  ref?: Ref<HTMLHeadingElement>;
  /** `-1` lets the heading take programmatic focus: a landing with no
   * tabbable descendants, for when the controls it introduces go away. */
  tabIndex?: -1;
};

/** Content hierarchy; panel chrome and dialog semantics remain with their owners. */
export function Header({ level = 2, ...props }: HeaderProps) {
  return <ContentHeader {...props} level={level} />;
}

export function InlineHeader({ level = 3, ...props }: HeaderProps) {
  return <ContentHeader {...props} level={level} inline />;
}

function ContentHeader({
  title,
  subtitle,
  eyebrow,
  icon,
  actions,
  align = "start",
  id,
  level = 2,
  inline = false,
  ref,
  tabIndex,
}: HeaderProps & { inline?: boolean }) {
  const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4";
  return (
    <div
      data-buzz-ui=""
      className="buzz-content-header"
      data-inline={inline || undefined}
      data-align={align === "start" ? undefined : align}
    >
      {icon && (
        <span className="buzz-content-header-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="buzz-content-header-copy">
        {eyebrow && <p className="buzz-content-header-eyebrow">{eyebrow}</p>}
        <Heading
          id={id}
          ref={ref}
          tabIndex={tabIndex}
          className="buzz-content-header-title"
        >
          {title}
        </Heading>
        {subtitle && <p className="buzz-content-header-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="buzz-content-header-actions">{actions}</div>}
    </div>
  );
}
