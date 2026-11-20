import {
  GithubLogoIcon,
  GoogleDriveLogoIcon,
  FigmaLogoIcon,
  NotionLogoIcon,
  SlackLogoIcon,
  DropboxLogoIcon,
  OneDriveLogoIcon,
  GitlabLogoIcon,
  YoutubeLogoIcon,
  VideoCameraIcon,
  VideoConferenceIcon,
  MicrosoftTeamsLogoIcon,
  FileTextIcon,
  TableIcon,
  PresentationIcon,
  GlobeIcon,
  ChatCircleIcon,
  ThreadIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";
import {
  useContext,
  useEffect,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  LinkLabelContext,
  LinkContentContext,
  LinkChannelKindContext,
  LinkAccessibleNameContext,
} from "../../features/conversation/LinkLabelContext";
import { buzzLinkKind } from "../../features/navigation/buzz-links";
import styles from "../../shared/InlineReference.module.css";
import { channelIconClass } from "../../shared/inline-reference";

// Match actual host boundaries, never a service name found in a path or query.
const serviceHosts = {
  github: ["github.com"],
  figma: ["figma.com"],
  notion: ["notion.so", "notion.site"],
  slack: ["slack.com"],
  dropbox: ["dropbox.com", "dropboxusercontent.com", "db.tt"],
  onedrive: ["onedrive.live.com", "1drv.ms"],
  gitlab: ["gitlab.com"],
  youtube: ["youtube.com", "youtu.be"],
  loom: ["loom.com"],
  zoom: ["zoom.us", "zoom.com"],
  teams: ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"],
} as const;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Presentation only; the host keeps the source URL and chooses how to open it. */
export function githubSkillLabel(href: string): string | undefined {
  try {
    const url = new URL(href);
    // Read the original path because URL normalizes dot segments away.
    const raw = href.match(/^https:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#]|$)/i);
    if (
      !raw ||
      raw[1]?.toLowerCase() !== url.hostname ||
      !["github.com", "www.github.com", "raw.githubusercontent.com"].includes(
        url.hostname,
      )
    )
      return;
    const parts = (raw[2] ?? "").slice(1).split("/").map(decodeURIComponent);
    if (
      parts.some(
        (part) =>
          !part || part === "." || part === ".." || /[/\\\p{Cc}]/u.test(part),
      )
    )
      return;
    const [owner, repo, ...path] = parts;
    if (
      !owner ||
      !repo ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(repo)
    )
      return;
    if (
      url.hostname !== "raw.githubusercontent.com" &&
      !["blob", "raw"].includes(path.shift() ?? "")
    )
      return;
    if (path[0] === "refs" && ["heads", "tags"].includes(path[1] ?? ""))
      path.splice(0, 2);
    // A ref, a skill directory, and SKILL.md must all be present.
    if (path.length < 3 || path.at(-1) !== "SKILL.md") return;
    return `Skill: ${path.at(-2)} · ${owner}/${repo}`;
  } catch {
    return;
  }
}

export function linkKind(href: string) {
  try {
    const url = new URL(href);
    if (url.protocol === "buzz:") {
      return buzzLinkKind(href);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (githubSkillLabel(href)) return "github";
    // Microsoft's OneDrive for Business host shape; ordinary SharePoint stays generic.
    if (/^[a-z0-9-]+-my\.sharepoint\.com$/.test(url.hostname))
      return "onedrive";
    if (url.hostname === "drive.google.com") return "drive";
    if (url.hostname === "docs.google.com") {
      const product = url.pathname.split("/")[1];
      if (product === "document") return "document";
      if (product === "spreadsheets") return "spreadsheet";
      if (product === "presentation") return "presentation";
      return "drive";
    }
    for (const kind of Object.keys(
      serviceHosts,
    ) as (keyof typeof serviceHosts)[]) {
      if (
        serviceHosts[kind].some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      )
        return kind;
    }
    return "web";
  } catch {
    return null;
  }
}

const icons = {
  web: GlobeIcon,
  github: GithubLogoIcon,
  drive: GoogleDriveLogoIcon,
  figma: FigmaLogoIcon,
  notion: NotionLogoIcon,
  slack: SlackLogoIcon,
  dropbox: DropboxLogoIcon,
  onedrive: OneDriveLogoIcon,
  gitlab: GitlabLogoIcon,
  youtube: YoutubeLogoIcon,
  loom: VideoCameraIcon,
  zoom: VideoConferenceIcon,
  teams: MicrosoftTeamsLogoIcon,
  document: FileTextIcon,
  spreadsheet: TableIcon,
  presentation: PresentationIcon,
  buzz: ChatCircleIcon,
  chat: ChatCircleIcon,
  channel: HashIcon,
  message: ThreadIcon,
  thread: ThreadIcon,
};

/** Anchor wrapper for the isolated lab; messages use LinkLabel in a host-owned anchor. */
export function InlineLink({
  href,
  children,
  ...props
}: Omit<ComponentProps<"a">, "className" | "children"> & {
  href: string;
  children?: string;
}) {
  const kind = linkKind(href);
  if (!kind) return <>{children ?? href}</>;
  return (
    <a {...props} href={href} className={styles.link} data-kind={kind}>
      <LinkLabel href={href} label={children ?? href} />
    </a>
  );
}

export function LinkLabel({
  href,
  label = href,
  icon,
}: {
  href: string;
  label?: string;
  /** In place of the service's icon, for a renderer that knows more. */
  icon?: ReactNode;
}) {
  const contextualLabel = useContext(LinkLabelContext);
  const content = useContext(LinkContentContext);
  const channelKind = useContext(LinkChannelKindContext);
  const destination = linkKind(href);
  const kind =
    destination === "channel" && channelKind === "chat" ? "chat" : destination;
  if (kind && label === href && contextualLabel) label = contextualLabel;
  if (label === href) {
    if (kind === "channel") label = "Channel";
    else if (kind === "chat") label = "Chat";
    else if (kind === "message") label = "Message";
    else if (kind === "thread") label = "Thread";
    else if (kind === "buzz") label = "Buzz";
  }
  // The channel icon already supplies the visual hash.
  if (kind === "channel" && label.startsWith("#")) label = label.slice(1);
  const visibleContent =
    kind === "channel" && typeof content === "string" && content.startsWith("#")
      ? content.slice(1)
      : content;
  // Markdown encodes Unicode in destinations while retaining it in visible text.
  const rawDestination =
    label === href ||
    (kind !== null &&
      linkKind(label) !== null &&
      new URL(label).href === new URL(href).href);
  const skill =
    rawDestination || label.trim().toLowerCase() === "skill.md"
      ? githubSkillLabel(href)
      : undefined;
  const setAccessibleName = useContext(LinkAccessibleNameContext);
  useEffect(() => {
    setAccessibleName?.(skill);
    return () => setAccessibleName?.(undefined);
  }, [setAccessibleName, skill]);
  if (!kind) return <>{label}</>;
  if (skill) label = skill;
  const Icon =
    kind === "channel" && channelKind === "private" ? LockIcon : icons[kind];
  icon ??= (
    <Icon
      aria-hidden="true"
      className={kind === "channel" ? channelIconClass(Icon) : styles.icon}
    />
  );
  if (!skill && content !== undefined && !rawDestination)
    return (
      <span data-link-kind={kind}>
        {icon}
        {visibleContent}
      </span>
    );
  // Shorten only raw destinations; authored labels and resolved channel names stay intact.
  if (rawDestination && !skill) {
    const characters = Array.from(label);
    if (characters.length > 45)
      label = `${characters.slice(0, 34).join("")}…${characters.slice(-10).join("")}`;
  }
  // Keep the icon with the first character; the rest wraps within the message.
  const lead = graphemes.segment(label).containing(0)?.segment ?? "";
  return (
    <span data-link-kind={kind}>
      <span className={styles.lead}>
        {icon}
        {lead}
      </span>
      {label.slice(lead.length)}
    </span>
  );
}
