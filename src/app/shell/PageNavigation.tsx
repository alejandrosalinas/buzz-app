import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactElement,
} from "react";
import type {
  PagePreviewProps,
  RegisteredPage,
} from "../../features/pages/service";
import type { NavigationOpenOptions } from "../../features/navigation/controller";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PageIcon } from "./PageIcon";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import {
  BestieUnreadBadge,
  BestieUnreadLabel,
  usePagePresentation,
} from "./BestieNavigation";
import { BESTIE_PAGE } from "./bestie-context";

export function PageNavigation({
  pages,
  selected,
  currentPage = selected,
  onSelect,
  placement = "sidebar",
  previews = false,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  currentPage?: string;
  onSelect(key: string, options?: Pick<NavigationOpenOptions, "focus">): void;
  placement?: "sidebar" | "topbar" | "toolbar";
  /** Show page hover previews; only the sidebar's own navigation opts in. */
  previews?: boolean;
}) {
  const presentation = usePagePresentation();
  const hover = useHoverPointer();
  const badgeId = useId();
  // A selected page is already showing what its preview would summarize.
  const previewed = (page: RegisteredPage) =>
    previews && hover && page.key !== selected;
  if (placement === "topbar") {
    return (
      <Tabs
        label="Topbar pages"
        variant="chrome"
        value={pages.some((page) => page.key === selected) ? selected : null}
        onValueChange={(key) => onSelect(key, { focus: "preserve" })}
        onReselect={(key) => {
          if (key !== currentPage) onSelect(key, { focus: "preserve" });
        }}
        items={pages.map((page) => {
          const Badge = page.badge;
          const { icon, image } = presentation(page);
          return {
            value: page.key,
            label: presentation(page).label,
            icon: (
              <PageIcon icon={icon} image={image} size={16} strokeWidth={2.5} />
            ),
            panelId: `shell-page-${page.key}`,
            trailing: Badge ? (
              <ContributionBoundary key={contributionKey(page)} fallback={null}>
                <Badge />
              </ContributionBoundary>
            ) : undefined,
          };
        })}
      />
    );
  }
  return pages.map((page, index) => {
    const { label, icon, image, avatar } = presentation(page);
    const Badge = page.badge;
    const badge = Badge && (
      <ContributionBoundary key={contributionKey(page)} fallback={null}>
        <Badge />
      </ContributionBoundary>
    );
    const select = () => {
      onSelect(page.key);
      document.getElementById("main-content")?.focus({ preventScroll: true });
    };
    const pageIcon = avatar ? (
      <Avatar
        key={page.key}
        src={avatar.src}
        alt=""
        fallback={label}
        shape={avatar.shape}
        size="compact"
      />
    ) : (
      <PageIcon
        key={page.key}
        icon={icon}
        image={image}
        size={16}
        strokeWidth={2.5}
      />
    );
    // The toolbar badge sits beside its icon-only button, not inside it, so
    // the button names the page and the badge describes it.
    const describedBy = badge ? `${badgeId}-${index}` : undefined;
    if (placement === "toolbar")
      return (
        <span className="shell-toolbar-page" key={page.key}>
          <IconButton
            aria-label={label}
            aria-describedby={describedBy}
            title={label}
            variant="chrome"
            aria-current={selected === page.key ? "page" : undefined}
            onClick={select}
            icon={pageIcon}
          />
          {badge && (
            <span id={describedBy} className="shell-toolbar-badge">
              {badge}
            </span>
          )}
        </span>
      );
    const item = (
      <NavigationItem
        key={page.key}
        onClick={select}
        selected={selected === page.key}
        aria-current={
          selected === page.key && currentPage !== selected ? true : undefined
        }
        label={
          page.key === BESTIE_PAGE ? <BestieUnreadLabel label={label} /> : label
        }
        title={page.preview && previewed(page) ? undefined : label}
        variant="row"
        trailing={
          page.key === BESTIE_PAGE ? (
            <>
              {badge}
              <BestieUnreadBadge pageKey={page.key} />
            </>
          ) : (
            badge
          )
        }
        icon={
          placement === "sidebar" ? (
            <span className="shell-page-icon">{pageIcon}</span>
          ) : undefined
        }
      />
    );
    return page.preview && previewed(page) ? (
      <PagePreview
        key={page.key}
        page={page}
        preview={page.preview}
        label={label}
      >
        {item}
      </PagePreview>
    ) : (
      item
    );
  });
}

const hoverQuery = "(hover: hover) and (pointer: fine)";
function useHoverPointer() {
  const [hover, setHover] = useState(
    () => window.matchMedia?.(hoverQuery).matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.(hoverQuery);
    if (!query) return;
    const update = () => setHover(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return hover;
}

/** The shell owns a preview's trigger, timing, placement and dismissal; the
 * page supplies only the content. */
function PagePreview({
  page,
  preview: Preview,
  label,
  children,
}: {
  page: RegisteredPage;
  preview: ComponentType<PagePreviewProps>;
  label: string;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  // Content that opens something hands focus to it; Base UI would otherwise
  // return focus to this row after closing.
  const handoff = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  const close = () => {
    handoff.current = true;
    if (actions.current) actions.current.close();
    else setOpen(false);
  };
  return (
    <PopoverRoot
      modal={false}
      open={open}
      actionsRef={actions}
      onOpenChange={(next, details) => {
        // Hover only: pressing the row selects the page instead.
        if (next) handoff.current = false;
        setOpen(next && details.reason !== "trigger-press");
      }}
    >
      {/* Marked transient, so a conversation's default focus is not held back. */}
      <PopoverTrigger
        openOnHover="preview"
        data-popup-preview=""
        render={children}
      />
      <PopoverPopup
        size="wide"
        padding="list"
        side="right"
        align="start"
        // 6px beside the row's hover background, lifted so the line under the
        // preview's header meets the background's top edge. Offsets ignore the
        // open animation's transform.
        sideOffset={6}
        alignOffset={() => {
          const header = popup.current?.querySelector("header");
          return header ? 1 - header.offsetTop - header.offsetHeight : 0;
        }}
        ref={popup}
        aria-label={label}
        finalFocus={() => !handoff.current}
      >
        <ContributionBoundary key={contributionKey(page)} fallback={null}>
          <Preview close={close} />
        </ContributionBoundary>
      </PopoverPopup>
    </PopoverRoot>
  );
}
