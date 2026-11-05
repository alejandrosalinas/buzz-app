import { defineIcon } from "./createDecorativeIcon";
export type { DefinedIcon } from "./createDecorativeIcon";
import { BestieMarkArtwork } from "./BestieMark";
import { BlockLogoArtwork } from "./BlockLogo";
import { GitHubIssueArtwork } from "./GitHubIssue";
import { OneDriveLogoArtwork } from "./OneDriveLogo";
import {
  BuilderlabLogoArtwork,
  GooseLogoArtwork,
  PiLogoArtwork,
  ClaudeLogoArtwork,
  CodexLogoArtwork,
  HermesLogoArtwork,
  DeepSeekLogoArtwork,
  GrokLogoArtwork,
  ZaiLogoArtwork,
  KimiLogoArtwork,
} from "./HarnessLogos";

// Brand artwork requested for Harness Settings; general UI glyphs remain Tabler.
export const BuilderlabLogoIcon = defineIcon("custom", BuilderlabLogoArtwork, {
  meaning: "Builderlab harness",
  category: "Custom brand mark",
  provenance:
    "Builderlab Event 2026 SVG supplied by Taylor Ho, adapted to currentColor for 16–32px UI use; corners optically rounded, source blur retained, grain and displacement omitted for legibility; see NOTICE.md",
  intendedSizes: [
    { width: 16, height: 16 },
    { width: 18, height: 18 },
    { width: 20, height: 20 },
    { width: 32, height: 32 },
  ],
});
export const GooseLogoIcon = defineIcon("custom", GooseLogoArtwork, {
  meaning: "Goose harness",
  category: "Custom brand mark",
  provenance:
    "Official Block Goose mark (Apache-2.0), reused from old Buzz by explicit design request; see NOTICE.md",
  intendedSizes: [{ width: 32, height: 32 }],
});
export const PiLogoIcon = defineIcon("custom", PiLogoArtwork, {
  meaning: "Pi harness",
  category: "Custom brand mark",
  provenance:
    "Official Earendil Pi favicon (MIT), reused from old Buzz by explicit design request; see NOTICE.md",
  intendedSizes: [{ width: 32, height: 32 }],
});

export const DeepSeekLogoIcon = defineIcon("custom", DeepSeekLogoArtwork, {
  meaning: "DeepSeek models",
  category: "Custom brand mark",
  provenance: "DeepSeek mark (MIT), from Wikimedia Commons; see NOTICE.md",
  intendedSizes: [{ width: 20, height: 20 }],
});
export const GrokLogoIcon = defineIcon("custom", GrokLogoArtwork, {
  meaning: "Grok models",
  category: "Custom brand mark",
  provenance:
    "Grok mark (public domain), from Wikimedia Commons; see NOTICE.md",
  intendedSizes: [{ width: 20, height: 20 }],
});
export const ZaiLogoIcon = defineIcon("custom", ZaiLogoArtwork, {
  meaning: "Z.ai / GLM models",
  category: "Custom brand mark",
  provenance:
    "Z.ai favicon (public domain), from Wikimedia Commons; see NOTICE.md",
  intendedSizes: [{ width: 20, height: 20 }],
});
export const KimiLogoIcon = defineIcon("custom", KimiLogoArtwork, {
  meaning: "Kimi models",
  category: "Custom brand mark",
  provenance: "Official Moonshot Kimi favicon, converted to PNG; see NOTICE.md",
  intendedSizes: [{ width: 20, height: 20 }],
});

import TablerArrowClockwiseIcon from "@tabler/icons-react/dist/esm/icons/IconRotateClockwise.mjs";
export const ArrowClockwiseIcon = defineIcon(
  "tabler",
  TablerArrowClockwiseIcon,
);
import TablerArrowCounterClockwiseIcon from "@tabler/icons-react/dist/esm/icons/IconRotate.mjs";
export const ArrowCounterClockwiseIcon = defineIcon(
  "tabler",
  TablerArrowCounterClockwiseIcon,
);
// Tabler only. Add individual exports as needed; outline icons are the default.
import TablerSparklesIcon from "@tabler/icons-react/dist/esm/icons/IconSparkles.mjs";
export const SparklesIcon = defineIcon("tabler", TablerSparklesIcon);
import TablerStarFilledIcon from "@tabler/icons-react/dist/esm/icons/IconStarFilled.mjs";
export const StarFilledIcon = defineIcon("tabler", TablerStarFilledIcon);
import TablerBrowserIcon from "@tabler/icons-react/dist/esm/icons/IconBrowser.mjs";
export const BrowserIcon = defineIcon("tabler", TablerBrowserIcon);
import TablerCalendarIcon from "@tabler/icons-react/dist/esm/icons/IconCalendar.mjs";
export const CalendarIcon = defineIcon("tabler", TablerCalendarIcon);
import TablerArrowDownIcon from "@tabler/icons-react/dist/esm/icons/IconArrowDown.mjs";
export const ArrowDownIcon = defineIcon("tabler", TablerArrowDownIcon);
import TablerArrowLeftIcon from "@tabler/icons-react/dist/esm/icons/IconArrowLeft.mjs";
export const ArrowLeftIcon = defineIcon("tabler", TablerArrowLeftIcon);
import TablerArrowRightIcon from "@tabler/icons-react/dist/esm/icons/IconArrowRight.mjs";
export const ArrowRightIcon = defineIcon("tabler", TablerArrowRightIcon);
import TablerArrowSquareLeftIcon from "@tabler/icons-react/dist/esm/icons/IconSquareArrowLeft.mjs";
export const ArrowSquareLeftIcon = defineIcon(
  "tabler",
  TablerArrowSquareLeftIcon,
);
import TablerArrowSquareRightIcon from "@tabler/icons-react/dist/esm/icons/IconSquareArrowRight.mjs";
export const ArrowSquareRightIcon = defineIcon(
  "tabler",
  TablerArrowSquareRightIcon,
);
import TablerArrowSquareOutIcon from "@tabler/icons-react/dist/esm/icons/IconExternalLink.mjs";
export const ArrowSquareOutIcon = defineIcon(
  "tabler",
  TablerArrowSquareOutIcon,
);
import TablerArrowUpIcon from "@tabler/icons-react/dist/esm/icons/IconArrowUp.mjs";
export const ArrowUpIcon = defineIcon("tabler", TablerArrowUpIcon);
import TablerArrowUpRightIcon from "@tabler/icons-react/dist/esm/icons/IconArrowUpRight.mjs";
export const ArrowUpRightIcon = defineIcon("tabler", TablerArrowUpRightIcon);
import TablerArrowsClockwiseIcon from "@tabler/icons-react/dist/esm/icons/IconRefresh.mjs";
export const ArrowsClockwiseIcon = defineIcon(
  "tabler",
  TablerArrowsClockwiseIcon,
);
import TablerArrowsInIcon from "@tabler/icons-react/dist/esm/icons/IconArrowsMinimize.mjs";
export const ArrowsInIcon = defineIcon("tabler", TablerArrowsInIcon);
import TablerArrowsOutIcon from "@tabler/icons-react/dist/esm/icons/IconArrowsMaximize.mjs";
export const ArrowsOutIcon = defineIcon("tabler", TablerArrowsOutIcon);
import TablerAlarmIcon from "@tabler/icons-react/dist/esm/icons/IconAlarm.mjs";
export const AlarmIcon = defineIcon("tabler", TablerAlarmIcon);
import TablerAtIcon from "@tabler/icons-react/dist/esm/icons/IconAt.mjs";
export const AtIcon = defineIcon("tabler", TablerAtIcon);
import TablerBellIcon from "@tabler/icons-react/dist/esm/icons/IconBell.mjs";
export const BellIcon = defineIcon("tabler", TablerBellIcon);
import TablerBellSlashIcon from "@tabler/icons-react/dist/esm/icons/IconBellOff.mjs";
export const BellSlashIcon = defineIcon("tabler", TablerBellSlashIcon);
import TablerCaretDownIcon from "@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs";
export const CaretDownIcon = defineIcon("tabler", TablerCaretDownIcon);
import TablerCaretLeftIcon from "@tabler/icons-react/dist/esm/icons/IconChevronLeft.mjs";
export const CaretLeftIcon = defineIcon("tabler", TablerCaretLeftIcon);
import TablerCaretRightIcon from "@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs";
export const CaretRightIcon = defineIcon("tabler", TablerCaretRightIcon);
import TablerCaretUpIcon from "@tabler/icons-react/dist/esm/icons/IconChevronUp.mjs";
export const CaretUpIcon = defineIcon("tabler", TablerCaretUpIcon);
import TablerChatCircleIcon from "@tabler/icons-react/dist/esm/icons/IconMessageCircle.mjs";
export const ChatCircleIcon = defineIcon("tabler", TablerChatCircleIcon);
import TablerMessageReplyIcon from "@tabler/icons-react/dist/esm/icons/IconMessageReply.mjs";
export const MessageReplyIcon = defineIcon("tabler", TablerMessageReplyIcon);
import TablerChatsCircleIcon from "@tabler/icons-react/dist/esm/icons/IconMessages.mjs";
export const ChatsCircleIcon = defineIcon("tabler", TablerChatsCircleIcon);
import { ChatUnreadArtwork } from "./ChatUnread";
export const ChatUnreadIcon = defineIcon("custom", ChatUnreadArtwork, {
  meaning: "Conversations with unread messages",
  category: "Message filtering",
  provenance:
    "Designer-requested adaptation of the MIT-licensed Tabler MessageCircle geometry with an unread dot.",
  intendedSizes: [{ width: 14, height: 14 }],
});
import TablerCheckIcon from "@tabler/icons-react/dist/esm/icons/IconCheck.mjs";
export const CheckIcon = defineIcon("tabler", TablerCheckIcon);
import TablerChecksIcon from "@tabler/icons-react/dist/esm/icons/IconChecks.mjs";
export const ChecksIcon = defineIcon("tabler", TablerChecksIcon);
import TablerTicketIcon from "@tabler/icons-react/dist/esm/icons/IconTicket.mjs";
export const TicketIcon = defineIcon("tabler", TablerTicketIcon);
import TablerCopyIcon from "@tabler/icons-react/dist/esm/icons/IconCopy.mjs";
export const CopyIcon = defineIcon("tabler", TablerCopyIcon);
import TablerCloudOffIcon from "@tabler/icons-react/dist/esm/icons/IconCloudOff.mjs";
export const CloudOffIcon = defineIcon("tabler", TablerCloudOffIcon);
import TablerCloudUploadIcon from "@tabler/icons-react/dist/esm/icons/IconCloudUpload.mjs";
export const CloudUploadIcon = defineIcon("tabler", TablerCloudUploadIcon);
import TablerCrownIcon from "@tabler/icons-react/dist/esm/icons/IconCrown.mjs";
export const CrownIcon = defineIcon("tabler", TablerCrownIcon);
import TablerDotsThreeIcon from "@tabler/icons-react/dist/esm/icons/IconDots.mjs";
export const DotsThreeIcon = defineIcon("tabler", TablerDotsThreeIcon);
import TablerDotsThreeVerticalIcon from "@tabler/icons-react/dist/esm/icons/IconDotsVertical.mjs";
export const DotsThreeVerticalIcon = defineIcon(
  "tabler",
  TablerDotsThreeVerticalIcon,
);
import TablerDownloadIcon from "@tabler/icons-react/dist/esm/icons/IconDownload.mjs";
export const DownloadIcon = defineIcon("tabler", TablerDownloadIcon);
import TablerDropboxLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandDropbox.mjs";
export const DropboxLogoIcon = defineIcon("tabler", TablerDropboxLogoIcon);
import TablerEnvelopeIcon from "@tabler/icons-react/dist/esm/icons/IconMail.mjs";
export const EnvelopeIcon = defineIcon("tabler", TablerEnvelopeIcon);
import TablerNotificationIcon from "@tabler/icons-react/dist/esm/icons/IconNotification.mjs";
export const NotificationIcon = defineIcon("tabler", TablerNotificationIcon);
import { NotificationFilledArtwork } from "./NotificationFilled";
export const NotificationFilledIcon = defineIcon(
  "custom",
  NotificationFilledArtwork,
  {
    meaning: "Unread-only filtering enabled",
    category: "State indicator",
    provenance:
      "Designer-requested filled counterpart to the MIT-licensed Tabler Notification icon, preserving its 24px geometry.",
    intendedSizes: [{ width: 20, height: 20 }],
  },
);
import TablerEnvelopeOpenIcon from "@tabler/icons-react/dist/esm/icons/IconMailOpened.mjs";
export const EnvelopeOpenIcon = defineIcon("tabler", TablerEnvelopeOpenIcon);
import TablerEyeIcon from "@tabler/icons-react/dist/esm/icons/IconEye.mjs";
export const EyeIcon = defineIcon("tabler", TablerEyeIcon);
import TablerEyeSlashIcon from "@tabler/icons-react/dist/esm/icons/IconEyeOff.mjs";
export const EyeSlashIcon = defineIcon("tabler", TablerEyeSlashIcon);
import TablerFigmaLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandFigma.mjs";
export const FigmaLogoIcon = defineIcon("tabler", TablerFigmaLogoIcon);
import TablerPaperclipIcon from "@tabler/icons-react/dist/esm/icons/IconPaperclip.mjs";
export const PaperclipIcon = defineIcon("tabler", TablerPaperclipIcon);
import TablerFileTextIcon from "@tabler/icons-react/dist/esm/icons/IconFileText.mjs";
export const FileTextIcon = defineIcon("tabler", TablerFileTextIcon);
import TablerFlagIcon from "@tabler/icons-react/dist/esm/icons/IconFlag.mjs";
export const FlagIcon = defineIcon("tabler", TablerFlagIcon);
import TablerFolderOpenIcon from "@tabler/icons-react/dist/esm/icons/IconFolderOpen.mjs";
export const FolderOpenIcon = defineIcon("tabler", TablerFolderOpenIcon);
import TablerFolderPlusIcon from "@tabler/icons-react/dist/esm/icons/IconFolderPlus.mjs";
export const FolderPlusIcon = defineIcon("tabler", TablerFolderPlusIcon);
import TablerCube3dSphereIcon from "@tabler/icons-react/dist/esm/icons/IconCube3dSphere.mjs";
export const Cube3dSphereIcon = defineIcon("tabler", TablerCube3dSphereIcon);
import TablerFolderSimpleIcon from "@tabler/icons-react/dist/esm/icons/IconFolder.mjs";
export const FolderSimpleIcon = defineIcon("tabler", TablerFolderSimpleIcon);
import TablerGearIcon from "@tabler/icons-react/dist/esm/icons/IconSettings.mjs";
export const GearIcon = defineIcon("tabler", TablerGearIcon);
import TablerGitBranchIcon from "@tabler/icons-react/dist/esm/icons/IconGitBranch.mjs";
export const GitBranchIcon = defineIcon("tabler", TablerGitBranchIcon);
import TablerGitCommitIcon from "@tabler/icons-react/dist/esm/icons/IconGitCommit.mjs";
export const GitCommitIcon = defineIcon("tabler", TablerGitCommitIcon);
import TablerCircleDashedIcon from "@tabler/icons-react/dist/esm/icons/IconCircleDashed.mjs";
export const CircleDashedIcon = defineIcon("tabler", TablerCircleDashedIcon);
import TablerGitMergeIcon from "@tabler/icons-react/dist/esm/icons/IconGitMerge.mjs";
export const GitMergeIcon = defineIcon("tabler", TablerGitMergeIcon);
import TablerGitPullRequestIcon from "@tabler/icons-react/dist/esm/icons/IconGitPullRequest.mjs";
export const GitPullRequestIcon = defineIcon(
  "tabler",
  TablerGitPullRequestIcon,
);
import TablerGithubLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandGithub.mjs";
export const GithubLogoIcon = defineIcon("tabler", TablerGithubLogoIcon);
import TablerGitlabLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandGitlab.mjs";
export const GitlabLogoIcon = defineIcon("tabler", TablerGitlabLogoIcon);
import TablerGlobeIcon from "@tabler/icons-react/dist/esm/icons/IconWorld.mjs";
export const GlobeIcon = defineIcon("tabler", TablerGlobeIcon);
import TablerGoogleDriveLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandGoogleDrive.mjs";
export const GoogleDriveLogoIcon = defineIcon(
  "tabler",
  TablerGoogleDriveLogoIcon,
);
import TablerHashIcon from "@tabler/icons-react/dist/esm/icons/IconHash.mjs";
export const HashIcon = defineIcon("tabler", TablerHashIcon);
import TablerHouseIcon from "@tabler/icons-react/dist/esm/icons/IconHome.mjs";
export const HouseIcon = defineIcon("tabler", TablerHouseIcon);
import TablerKeyboardIcon from "@tabler/icons-react/dist/esm/icons/IconKeyboard.mjs";
export const KeyboardIcon = defineIcon("tabler", TablerKeyboardIcon);
import TablerLightningIcon from "@tabler/icons-react/dist/esm/icons/IconBolt.mjs";
export const LightningIcon = defineIcon("tabler", TablerLightningIcon);
import TablerLinkIcon from "@tabler/icons-react/dist/esm/icons/IconLink.mjs";
export const LinkIcon = defineIcon("tabler", TablerLinkIcon);
import TablerLockIcon from "@tabler/icons-react/dist/esm/icons/IconLock.mjs";
export const LockIcon = defineIcon("tabler", TablerLockIcon);
import TablerMagnifyingGlassIcon from "@tabler/icons-react/dist/esm/icons/IconSearch.mjs";
export const MagnifyingGlassIcon = defineIcon(
  "tabler",
  TablerMagnifyingGlassIcon,
);
import TablerMicrosoftTeamsLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandTeams.mjs";
export const MicrosoftTeamsLogoIcon = defineIcon(
  "tabler",
  TablerMicrosoftTeamsLogoIcon,
);
import TablerMinusIcon from "@tabler/icons-react/dist/esm/icons/IconMinus.mjs";
export const MinusIcon = defineIcon("tabler", TablerMinusIcon);
import TablerMoonIcon from "@tabler/icons-react/dist/esm/icons/IconMoon.mjs";
export const MoonIcon = defineIcon("tabler", TablerMoonIcon);
import TablerMonitorIcon from "@tabler/icons-react/dist/esm/icons/IconDeviceDesktop.mjs";
export const MonitorIcon = defineIcon("tabler", TablerMonitorIcon);
import TablerDeviceMobileIcon from "@tabler/icons-react/dist/esm/icons/IconDeviceMobile.mjs";
export const DeviceMobileIcon = defineIcon("tabler", TablerDeviceMobileIcon);
import TablerNoteIcon from "@tabler/icons-react/dist/esm/icons/IconNote.mjs";
export const NoteIcon = defineIcon("tabler", TablerNoteIcon);
import TablerNotionLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandNotion.mjs";
export const NotionLogoIcon = defineIcon("tabler", TablerNotionLogoIcon);
import TablerPaletteIcon from "@tabler/icons-react/dist/esm/icons/IconPalette.mjs";
export const PaletteIcon = defineIcon("tabler", TablerPaletteIcon);
import TablerPauseIcon from "@tabler/icons-react/dist/esm/icons/IconPlayerPause.mjs";
export const PauseIcon = defineIcon("tabler", TablerPauseIcon);
import TablerPlayIcon from "@tabler/icons-react/dist/esm/icons/IconPlayerPlay.mjs";
export const PlayIcon = defineIcon("tabler", TablerPlayIcon);
import TablerPlugIcon from "@tabler/icons-react/dist/esm/icons/IconPlug.mjs";
export const PlugIcon = defineIcon("tabler", TablerPlugIcon);
import TablerPlusIcon from "@tabler/icons-react/dist/esm/icons/IconPlus.mjs";
export const PlusIcon = defineIcon("tabler", TablerPlusIcon);
import TablerPresentationIcon from "@tabler/icons-react/dist/esm/icons/IconPresentation.mjs";
export const PresentationIcon = defineIcon("tabler", TablerPresentationIcon);
import TablerQuestionIcon from "@tabler/icons-react/dist/esm/icons/IconHelpCircle.mjs";
export const QuestionIcon = defineIcon("tabler", TablerQuestionIcon);
import { RobotArtwork } from "./Robot";
export const RobotIcon = defineIcon("custom", RobotArtwork, {
  meaning: "AI agent",
  category: "Product mark",
  provenance:
    "Original Buzz Soft & wide robot, Fuller canvas refinement with inward ears, selected by the designer",
  intendedSizes: [
    { width: 14, height: 14 },
    { width: 16, height: 16 },
    { width: 24, height: 24 },
  ],
});
import TablerShieldIcon from "@tabler/icons-react/dist/esm/icons/IconShield.mjs";
export const ShieldIcon = defineIcon("tabler", TablerShieldIcon);
import TablerSidebarIcon from "@tabler/icons-react/dist/esm/icons/IconLayoutSidebar.mjs";
export const SidebarIcon = defineIcon("tabler", TablerSidebarIcon);
import TablerSidebarRightIcon from "@tabler/icons-react/dist/esm/icons/IconLayoutSidebarRight.mjs";
export const SidebarRightIcon = defineIcon("tabler", TablerSidebarRightIcon);
import TablerSlackLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandSlack.mjs";
export const SlackLogoIcon = defineIcon("tabler", TablerSlackLogoIcon);
import TablerSmileyIcon from "@tabler/icons-react/dist/esm/icons/IconMoodSmile.mjs";
export const SmileyIcon = defineIcon("tabler", TablerSmileyIcon);
import TablerSmileyPlusIcon from "@tabler/icons-react/dist/esm/icons/IconMoodPlus.mjs";
export const SmileyPlusIcon = defineIcon("tabler", TablerSmileyPlusIcon);
import TablerSmileyStickerIcon from "@tabler/icons-react/dist/esm/icons/IconSticker2.mjs";
export const SmileyStickerIcon = defineIcon("tabler", TablerSmileyStickerIcon);
import TablerFilter2Icon from "@tabler/icons-react/dist/esm/icons/IconFilter2.mjs";
export const Filter2Icon = defineIcon("tabler", TablerFilter2Icon);
import TablerSlidersHorizontalIcon from "@tabler/icons-react/dist/esm/icons/IconAdjustmentsHorizontal.mjs";
export const SlidersHorizontalIcon = defineIcon(
  "tabler",
  TablerSlidersHorizontalIcon,
);
import TablerSquaresFourIcon from "@tabler/icons-react/dist/esm/icons/IconLayoutGrid.mjs";
export const SquaresFourIcon = defineIcon("tabler", TablerSquaresFourIcon);
import TablerStopIcon from "@tabler/icons-react/dist/esm/icons/IconPlayerStop.mjs";
export const StopIcon = defineIcon("tabler", TablerStopIcon);
import TablerOctagonIcon from "@tabler/icons-react/dist/esm/icons/IconOctagon.mjs";
export const OctagonIcon = defineIcon("tabler", TablerOctagonIcon);
import TablerSunIcon from "@tabler/icons-react/dist/esm/icons/IconSun.mjs";
export const SunIcon = defineIcon("tabler", TablerSunIcon);
import TablerTableIcon from "@tabler/icons-react/dist/esm/icons/IconTable.mjs";
export const TableIcon = defineIcon("tabler", TablerTableIcon);
import TablerTelescopeIcon from "@tabler/icons-react/dist/esm/icons/IconTelescope.mjs";
export const TelescopeIcon = defineIcon("tabler", TablerTelescopeIcon);
import TablerTimerIcon from "@tabler/icons-react/dist/esm/icons/IconStopwatch.mjs";
export const TimerIcon = defineIcon("tabler", TablerTimerIcon);
import TablerClockIcon from "@tabler/icons-react/dist/esm/icons/IconClockHour4.mjs";
export const ClockIcon = defineIcon("tabler", TablerClockIcon);
import TablerBulbIcon from "@tabler/icons-react/dist/esm/icons/IconBulb.mjs";
export const BulbIcon = defineIcon("tabler", TablerBulbIcon);
import TablerTerminalWindowIcon from "@tabler/icons-react/dist/esm/icons/IconTerminal2.mjs";
export const TerminalWindowIcon = defineIcon(
  "tabler",
  TablerTerminalWindowIcon,
);
import TablerTrashIcon from "@tabler/icons-react/dist/esm/icons/IconTrash.mjs";
export const TrashIcon = defineIcon("tabler", TablerTrashIcon);
import TablerUserIcon from "@tabler/icons-react/dist/esm/icons/IconUser.mjs";
export const UserIcon = defineIcon("tabler", TablerUserIcon);
import TablerShareIcon from "@tabler/icons-react/dist/esm/icons/IconShare2.mjs";
export const ShareIcon = defineIcon("tabler", TablerShareIcon);
import TablerForwardIcon from "@tabler/icons-react/dist/esm/icons/IconArrowForwardUp.mjs";
export const ForwardIcon = defineIcon("tabler", TablerForwardIcon);
import TablerUsersIcon from "@tabler/icons-react/dist/esm/icons/IconUsers.mjs";
export const UsersIcon = defineIcon("tabler", TablerUsersIcon);
import TablerUsersPlusIcon from "@tabler/icons-react/dist/esm/icons/IconUsersPlus.mjs";
export const UsersPlusIcon = defineIcon("tabler", TablerUsersPlusIcon);
import TablerVideoCameraIcon from "@tabler/icons-react/dist/esm/icons/IconVideo.mjs";
export const VideoCameraIcon = defineIcon("tabler", TablerVideoCameraIcon);
import TablerVideoConferenceIcon from "@tabler/icons-react/dist/esm/icons/IconVideoPlus.mjs";
export const VideoConferenceIcon = defineIcon(
  "tabler",
  TablerVideoConferenceIcon,
);
import TablerWebhooksLogoIcon from "@tabler/icons-react/dist/esm/icons/IconWebhook.mjs";
export const WebhooksLogoIcon = defineIcon("tabler", TablerWebhooksLogoIcon);
import TablerWrenchIcon from "@tabler/icons-react/dist/esm/icons/IconTool.mjs";
export const WrenchIcon = defineIcon("tabler", TablerWrenchIcon);
import TablerXIcon from "@tabler/icons-react/dist/esm/icons/IconX.mjs";
export const XIcon = defineIcon("tabler", TablerXIcon);
import TablerXCircleIcon from "@tabler/icons-react/dist/esm/icons/IconCircleX.mjs";
export const XCircleIcon = defineIcon("tabler", TablerXCircleIcon);
import TablerYoutubeLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandYoutube.mjs";
export const YoutubeLogoIcon = defineIcon("tabler", TablerYoutubeLogoIcon);
export const OneDriveLogoIcon = defineIcon("custom", OneDriveLogoArtwork, {
  meaning: "Microsoft OneDrive link",
  category: "Custom brand mark",
  provenance:
    "Custom current-color outline recreation of the Microsoft OneDrive cloud mark.",
  intendedSizes: [{ width: 14, height: 14 }],
});
export const BlockLogoIcon = defineIcon("custom", BlockLogoArtwork, {
  meaning: "Block, Inc. corporate mark",
  category: "Custom brand mark",
  provenance:
    "Block, Inc. corporate mark, current-color grid from the Builderlab Buzz site's block-logo.svg.",
  intendedSizes: [{ width: 18, height: 18 }],
});
export const GitHubIssueIcon = defineIcon("custom", GitHubIssueArtwork, {
  meaning: "Open GitHub issue",
  category: "Product mark",
  provenance:
    "Buzz-owned mark based on GitHub’s issue symbol and Tabler Circle geometry.",
  intendedSizes: [{ width: 22, height: 22 }],
});
export const BestieIcon = defineIcon("custom", BestieMarkArtwork, {
  meaning: "Bestie page",
  category: "Product mark",
  provenance:
    "Buzz-owned Bestie artwork from public/bestie.png, framed as an SVG image for icon slots.",
  intendedSizes: [
    { width: 15, height: 15 },
    { width: 17, height: 17 },
  ],
});

import TablerCircleNotchIcon from "@tabler/icons-react/dist/esm/icons/IconLoader2.mjs";
export const CircleNotchIcon = defineIcon("tabler", TablerCircleNotchIcon);

import TablerTextAaIcon from "@tabler/icons-react/dist/esm/icons/IconLetterCase.mjs";
export const TextAaIcon = defineIcon("tabler", TablerTextAaIcon);

import TablerTextBIcon from "@tabler/icons-react/dist/esm/icons/IconBold.mjs";
export const TextBIcon = defineIcon("tabler", TablerTextBIcon);

import TablerTextItalicIcon from "@tabler/icons-react/dist/esm/icons/IconItalic.mjs";
export const TextItalicIcon = defineIcon("tabler", TablerTextItalicIcon);

import TablerTextStrikethroughIcon from "@tabler/icons-react/dist/esm/icons/IconStrikethrough.mjs";
export const TextStrikethroughIcon = defineIcon(
  "tabler",
  TablerTextStrikethroughIcon,
);

import TablerCodeIcon from "@tabler/icons-react/dist/esm/icons/IconCode.mjs";
export const CodeIcon = defineIcon("tabler", TablerCodeIcon);

import TablerCodeBlockIcon from "@tabler/icons-react/dist/esm/icons/IconSourceCode.mjs";
export const CodeBlockIcon = defineIcon("tabler", TablerCodeBlockIcon);

import TablerListBulletsIcon from "@tabler/icons-react/dist/esm/icons/IconList.mjs";
export const ListBulletsIcon = defineIcon("tabler", TablerListBulletsIcon);

import TablerListNumbersIcon from "@tabler/icons-react/dist/esm/icons/IconListNumbers.mjs";
export const ListNumbersIcon = defineIcon("tabler", TablerListNumbersIcon);

import TablerQuotesIcon from "@tabler/icons-react/dist/esm/icons/IconBlockquote.mjs";
export const QuotesIcon = defineIcon("tabler", TablerQuotesIcon);

import TablerDetectiveIcon from "@tabler/icons-react/dist/esm/icons/IconSpy.mjs";
export const DetectiveIcon = defineIcon("tabler", TablerDetectiveIcon);

import TablerPencilSimpleIcon from "@tabler/icons-react/dist/esm/icons/IconPencil.mjs";
export const PencilSimpleIcon = defineIcon("tabler", TablerPencilSimpleIcon);

import TablerListChecksIcon from "@tabler/icons-react/dist/esm/icons/IconListCheck.mjs";
export const ListChecksIcon = defineIcon("tabler", TablerListChecksIcon);

import TablerArchiveIcon from "@tabler/icons-react/dist/esm/icons/IconArchive.mjs";
export const ArchiveIcon = defineIcon("tabler", TablerArchiveIcon);

import TablerArchiveOffIcon from "@tabler/icons-react/dist/esm/icons/IconArchiveOff.mjs";
export const ArchiveOffIcon = defineIcon("tabler", TablerArchiveOffIcon);

import TablerArrowsLeftRightIcon from "@tabler/icons-react/dist/esm/icons/IconArrowsLeftRight.mjs";
export const ArrowsLeftRightIcon = defineIcon(
  "tabler",
  TablerArrowsLeftRightIcon,
);

import TablerBoxArrowUpIcon from "@tabler/icons-react/dist/esm/icons/IconUpload.mjs";
export const BoxArrowUpIcon = defineIcon("tabler", TablerBoxArrowUpIcon);

import TablerCheckCircleIcon from "@tabler/icons-react/dist/esm/icons/IconCircleCheck.mjs";
export const CheckCircleIcon = defineIcon("tabler", TablerCheckCircleIcon);

import TablerLinkBreakIcon from "@tabler/icons-react/dist/esm/icons/IconUnlink.mjs";
export const LinkBreakIcon = defineIcon("tabler", TablerLinkBreakIcon);

import TablerSignOutIcon from "@tabler/icons-react/dist/esm/icons/IconLogout.mjs";
export const SignOutIcon = defineIcon("tabler", TablerSignOutIcon);

import TablerWarningCircleIcon from "@tabler/icons-react/dist/esm/icons/IconAlertCircle.mjs";
export const WarningCircleIcon = defineIcon("tabler", TablerWarningCircleIcon);

import TablerArrowsDownUpIcon from "@tabler/icons-react/dist/esm/icons/IconArrowsDownUp.mjs";
export const ArrowsDownUpIcon = defineIcon("tabler", TablerArrowsDownUpIcon);

import TablerInfoIcon from "@tabler/icons-react/dist/esm/icons/IconInfoCircle.mjs";
export const InfoIcon = defineIcon("tabler", TablerInfoIcon);

import TablerSpeakerHighIcon from "@tabler/icons-react/dist/esm/icons/IconVolume.mjs";
export const SpeakerHighIcon = defineIcon("tabler", TablerSpeakerHighIcon);
import TablerSpeakerSlashIcon from "@tabler/icons-react/dist/esm/icons/IconVolumeOff.mjs";
export const SpeakerSlashIcon = defineIcon("tabler", TablerSpeakerSlashIcon);

import TablerThumbsUpIcon from "@tabler/icons-react/dist/esm/icons/IconThumbUp.mjs";
export const ThumbsUpIcon = defineIcon("tabler", TablerThumbsUpIcon);

import TablerColumnsIcon from "@tabler/icons-react/dist/esm/icons/IconColumns.mjs";
export const ColumnsIcon = defineIcon("tabler", TablerColumnsIcon);

import TablerPlayFilledIcon from "@tabler/icons-react/dist/esm/icons/IconPlayerPlayFilled.mjs";
export const PlayFilledIcon = defineIcon("tabler", TablerPlayFilledIcon);
import TablerPauseFilledIcon from "@tabler/icons-react/dist/esm/icons/IconPlayerPauseFilled.mjs";
export const PauseFilledIcon = defineIcon("tabler", TablerPauseFilledIcon);

import TablerArrowsInSimpleIcon from "@tabler/icons-react/dist/esm/icons/IconArrowsMinimize.mjs";
export const ArrowsInSimpleIcon = defineIcon(
  "tabler",
  TablerArrowsInSimpleIcon,
);

import TablerHeadphonesIcon from "@tabler/icons-react/dist/esm/icons/IconHeadphones.mjs";
export const HeadphonesIcon = defineIcon("tabler", TablerHeadphonesIcon);

import TablerMicrophoneSlashIcon from "@tabler/icons-react/dist/esm/icons/IconMicrophoneOff.mjs";
export const MicrophoneSlashIcon = defineIcon(
  "tabler",
  TablerMicrophoneSlashIcon,
);

import TablerPhoneDisconnectIcon from "@tabler/icons-react/dist/esm/icons/IconPhoneOff.mjs";
export const PhoneDisconnectIcon = defineIcon(
  "tabler",
  TablerPhoneDisconnectIcon,
);

import { HashArrowInArtwork } from "./HashArrowIn";
export const HashArrowInIcon = defineIcon("custom", HashArrowInArtwork, {
  meaning: "Send to channel",
  category: "messaging",
  provenance: "Original Buzz HashArrowIn; retained by explicit design request",
  intendedSizes: [{ width: 16, height: 16 }],
});

export const ClaudeLogoIcon = defineIcon("custom", ClaudeLogoArtwork, {
  meaning: "Claude harness",
  category: "Custom brand mark",
  provenance:
    "Bundled Claude mark reused from old Buzz by explicit design request; see NOTICE.md",
  intendedSizes: [{ width: 32, height: 32 }],
});

export const CodexLogoIcon = defineIcon("custom", CodexLogoArtwork, {
  meaning: "Codex harness",
  category: "Custom brand mark",
  provenance:
    "OpenAI Blossom mark from OpenAI's brand kit, by explicit design request; see NOTICE.md",
  intendedSizes: [{ width: 32, height: 32 }],
});

export const HermesLogoIcon = defineIcon("custom", HermesLogoArtwork, {
  meaning: "Hermes harness",
  category: "Custom brand mark",
  provenance:
    "Bundled Hermes mark reused from old Buzz by explicit design request; see NOTICE.md",
  intendedSizes: [
    { width: 24, height: 24 },
    { width: 32, height: 32 },
    { width: 48, height: 48 },
  ],
});

import TablerImageIcon from "@tabler/icons-react/dist/esm/icons/IconPhoto.mjs";
export const ImageIcon = defineIcon("tabler", TablerImageIcon);

import TablerOpenAILogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandOpenai.mjs";
export const OpenAILogoIcon = defineIcon("tabler", TablerOpenAILogoIcon);
import TablerGoogleLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandGoogle.mjs";
export const GoogleLogoIcon = defineIcon("tabler", TablerGoogleLogoIcon);
import TablerDatabricksLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandDatabricks.mjs";
export const DatabricksLogoIcon = defineIcon(
  "tabler",
  TablerDatabricksLogoIcon,
);
import TablerAwsLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandAws.mjs";
export const AwsLogoIcon = defineIcon("tabler", TablerAwsLogoIcon);
import TablerMicrophoneIcon from "@tabler/icons-react/dist/esm/icons/IconMicrophone.mjs";
export const MicrophoneIcon = defineIcon("tabler", TablerMicrophoneIcon);

import TablerCircleIcon from "@tabler/icons-react/dist/esm/icons/IconCircle.mjs";
export const CircleIcon = defineIcon("tabler", TablerCircleIcon);
import TablerCircleHalfIcon from "@tabler/icons-react/dist/esm/icons/IconCircleHalf.mjs";
export const CircleHalfIcon = defineIcon("tabler", TablerCircleHalfIcon);

import TablerGaugeIcon from "@tabler/icons-react/dist/esm/icons/IconGauge.mjs";
export const GaugeIcon = defineIcon("tabler", TablerGaugeIcon);
import TablerChartBarIcon from "@tabler/icons-react/dist/esm/icons/IconChartBar.mjs";
export const ChartBarIcon = defineIcon("tabler", TablerChartBarIcon);

import TablerStorefrontIcon from "@tabler/icons-react/dist/esm/icons/IconBuildingStore.mjs";
export const StorefrontIcon = defineIcon("tabler", TablerStorefrontIcon);

import TablerBrainIcon from "@tabler/icons-react/dist/esm/icons/IconBrain.mjs";
export const BrainIcon = defineIcon("tabler", TablerBrainIcon);

import TablerThinkingHighIcon from "@tabler/icons-react/dist/esm/icons/IconThinkingHigh.mjs";
export const ThinkingHighIcon = defineIcon("tabler", TablerThinkingHighIcon);

import TablerMetaLogoIcon from "@tabler/icons-react/dist/esm/icons/IconBrandMeta.mjs";
export const MetaLogoIcon = defineIcon("tabler", TablerMetaLogoIcon);
import TablerFileTypePdfIcon from "@tabler/icons-react/dist/esm/icons/IconFileTypePdf.mjs";
export const FileTypePdfIcon = defineIcon("tabler", TablerFileTypePdfIcon);

import TablerFileCodeIcon from "@tabler/icons-react/dist/esm/icons/IconFileCode.mjs";
export const FileCodeIcon = defineIcon("tabler", TablerFileCodeIcon);

import TablerFileZipIcon from "@tabler/icons-react/dist/esm/icons/IconFileZip.mjs";
export const FileZipIcon = defineIcon("tabler", TablerFileZipIcon);

import TablerFileSpreadsheetIcon from "@tabler/icons-react/dist/esm/icons/IconFileSpreadsheet.mjs";
export const FileSpreadsheetIcon = defineIcon(
  "tabler",
  TablerFileSpreadsheetIcon,
);

import TablerPhoneEndIcon from "@tabler/icons-react/dist/esm/icons/IconPhoneEnd.mjs";
export const PhoneEndIcon = defineIcon("tabler", TablerPhoneEndIcon);

import TablerArrowsDiagonalMinimize2Icon from "@tabler/icons-react/dist/esm/icons/IconArrowsDiagonalMinimize2.mjs";
export const ArrowsDiagonalMinimize2Icon = defineIcon(
  "tabler",
  TablerArrowsDiagonalMinimize2Icon,
);

import TablerPhoneIcon from "@tabler/icons-react/dist/esm/icons/IconPhone.mjs";
export const PhoneIcon = defineIcon("tabler", TablerPhoneIcon);

import TablerFoldIcon from "@tabler/icons-react/dist/esm/icons/IconFold.mjs";
export const FoldIcon = defineIcon("tabler", TablerFoldIcon);

import TablerCircleDottedIcon from "@tabler/icons-react/dist/esm/icons/IconCircleDotted.mjs";
export const CircleDottedIcon = defineIcon("tabler", TablerCircleDottedIcon);
