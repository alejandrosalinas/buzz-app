import {
  AlarmIcon,
  BellIcon,
  BrowserIcon,
  ChatsCircleIcon,
  NoteIcon,
  GearIcon,
  LightningIcon,
  RobotIcon,
  SendIcon,
} from "../../shared/design-system/icons/index";
import type { RegisteredPage } from "../../features/pages/service";

// Shell-owned presentation keeps plugin content independent of navigation chrome.
// Add page identities here; unknown plugins inherit a consistent layout default.
export const shellPresentation = {
  settings: { label: "Settings", icon: GearIcon, tone: "lavender" },
  channels: { label: "Messages", icon: ChatsCircleIcon, tone: "lime" },
} as const;

// Navigation order is host policy, never plugin activation timing. Match full
// contribution keys so an external page's local ID cannot claim a bundled slot.
const bundledOrder = [
  "buzz.channels/channels",
  "buzz.inbox/inbox",
  "buzz.drafts-and-sent/drafts-sent",
  "buzz.reminders/reminders",
  "buzz.bestie/bestie",
];
const dockOrder = [
  "buzz.bestie/bestie",
  "buzz.inbox/inbox",
  "buzz.channels/channels",
  "buzz.reminders/reminders",
];
export function orderPages(
  pages: readonly RegisteredPage[],
  location: "default" | "dock" = "default",
) {
  const order = location === "dock" ? dockOrder : bundledOrder;
  const rank = (page: RegisteredPage) => {
    const slot = order.indexOf(page.key);
    return slot === -1 ? order.length : slot;
  };
  return [...pages].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      pagePresentation(a).label.localeCompare(
        pagePresentation(b).label,
        "en",
      ) ||
      a.key.localeCompare(b.key, "en"),
  );
}

const bundledIcons = new Map<string, typeof BrowserIcon>([
  ["buzz.inbox/inbox", BellIcon],
  ["buzz.drafts-and-sent/drafts-sent", SendIcon],
  ["buzz.reminders/reminders", AlarmIcon],
  ["buzz.agents/agents", RobotIcon],
  ["buzz.workflows/workflows", LightningIcon],
  ["buzz.relay-notes/notes", NoteIcon],
]);
/** Resolve host navigation policy once, independently of icons and registrations. */
export function pagePlacement(page: RegisteredPage) {
  if (!page.primary) return undefined;
  switch (page.key) {
    case "buzz.channels/channels":
    case "buzz.inbox/inbox":
    case "buzz.bestie/bestie":
    case "buzz.reminders/reminders":
    case "buzz.agents/agents":
    case "buzz.workflows/workflows":
      return "dock";
    default:
      // `topbar` and `toolbar` predate the dock; both mean it.
      return page.placement === undefined || page.placement === "sidebar"
        ? "sidebar"
        : "dock";
  }
}

/** The app whose navigation lists a destination: the dock selects it and the
 * shell shows its sidebar unless the page supplies its own. Pages listed in
 * the Messages sidebar belong to Messages while it is registered;
 * conversations already select the Messages page. Every other destination,
 * including Settings and unlisted pages, owns itself. */
export function navigationOwner(
  pages: readonly RegisteredPage[],
  selected: string,
) {
  const messages = "buzz.channels/channels";
  const page = pages.find((page) => page.key === selected);
  return page &&
    pagePlacement(page) === "sidebar" &&
    pages.some((page) => page.key === messages)
    ? messages
    : selected;
}

type PagePresentation = Readonly<{
  label: string;
  icon: typeof BrowserIcon;
  tone: string;
  image?: string;
}>;
export function pagePresentation(page: RegisteredPage): PagePresentation {
  if (page.key === "buzz.channels/channels") return shellPresentation.channels;
  const tone = page.layout === "workspace" ? "lime" : "sky";
  const bundledIcon = bundledIcons.get(page.key);
  if (bundledIcon) return { label: page.title, icon: bundledIcon, tone };
  return {
    label: page.title,
    icon: BrowserIcon,
    tone,
    ...(page.icon === undefined ? {} : { image: page.icon }),
  };
}
