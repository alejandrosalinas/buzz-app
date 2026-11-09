// One Settings section policy for the standalone and shell presentations and
// route classification. Visibility and authorization stay with settingsCards.
import { isTauri } from "@tauri-apps/api/core";
import { developerMode } from "../features/developer/mode";
import {
  BellIcon,
  BrainIcon,
  ShieldIcon,
  ChatCircleIcon,
  DownloadIcon,
  KeyboardIcon,
  PaletteIcon,
  RobotIcon,
  SignOutIcon,
  SquaresFourIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
  GearIcon,
  LockIcon,
} from "../shared/design-system/icons/index";
import type { SettingsCard } from "../features/settings/service";
import type { Contribution } from "../plugins/contributions";

type Community = {
  name: string;
  localName?: string | undefined;
  publishedName?: string | undefined;
};
export type SettingsSection = {
  id: string;
  label: string;
  /** Contributed groups leave the icon to each presentation. */
  icon?: typeof UserIcon;
};
export type SettingsGroup = {
  id: string;
  label: string;
  sections: readonly SettingsSection[];
};

export { developerMode };

const profile: SettingsSection = {
  id: "profile",
  label: "Profile",
  icon: UserIcon,
};
const app: readonly SettingsSection[] = [
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "notifications", label: "Notifications", icon: BellIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  { id: "agents", label: "Agent setup", icon: RobotIcon },
  { id: "decisions", label: "Decisions API", icon: BrainIcon },
  { id: "updates", label: "Software updates", icon: DownloadIcon },
];
const plugins: SettingsSection = {
  id: "plugins",
  label: "Manage plugins",
  icon: SquaresFourIcon,
};
const developer: SettingsSection = {
  id: "developer",
  label: "Developer",
  icon: WrenchIcon,
};
const departure: SettingsSection = {
  id: "leave-community",
  label: "Leave or remove",
  icon: SignOutIcon,
};
const identity: SettingsSection = {
  id: "identity",
  label: "Identity",
  icon: ShieldIcon,
};
const security: SettingsSection = {
  id: "security",
  label: "Security",
  icon: LockIcon,
};
const local: SettingsSection = {
  id: "local-settings",
  label: "Local settings",
  icon: GearIcon,
};
// Keep frequent destinations first, regardless of plugin activation order.
// Other community contributions stay together before pairing.
const communityOrder: Readonly<Record<string, number>> = {
  "buzz.emoji/custom-emoji": 1,
  "buzz.pairing/mobile": 4,
};
const builtIn = new Set(
  [
    profile,
    identity,
    security,
    local,
    departure,
    plugins,
    ...app,
    ...(developerMode ? [developer] : []),
  ].map(({ id }) => id),
);

/** Host-owned sections; any other section is a plugin card contribution key. */
export const isBuiltInSettingsSection = (id: string) => builtIn.has(id);

export function settingsSections(
  cards: readonly Contribution<SettingsCard>[],
  community: Community | undefined,
) {
  const section = (
    card: Contribution<SettingsCard>,
    icon?: typeof UserIcon,
  ): SettingsSection => {
    const resolvedIcon = card.icon ?? icon;
    return {
      id: card.key,
      label: card.title,
      ...(resolvedIcon ? { icon: resolvedIcon } : {}),
    };
  };
  const administration = community
    ? cards
        .filter((card) => card.section === "administration")
        .map((card) => section(card, UsersIcon))
    : [];
  const groups: SettingsGroup[] = [
    ...(community
      ? [
          {
            id: "community",
            label: "Community",
            sections: [
              profile,
              local,
              ...[
                ...cards
                  .filter((card) => !card.group && !card.section)
                  .map((card) => section(card, ChatCircleIcon)),
              ].sort(
                (a, b) =>
                  (communityOrder[a.id] ?? 2) - (communityOrder[b.id] ?? 2),
              ),
              departure,
            ],
          },
        ]
      : [
          // Personal space keeps the local default profile with the community
          // cards that supply their own address, such as Pair mobile.
          {
            id: "personal",
            label: "Personal space",
            sections: [
              profile,
              ...cards
                .filter((card) => card.personal && !card.group && !card.section)
                .map((card) => section(card, ChatCircleIcon)),
            ],
          },
        ]),
    ...(administration.length > 0
      ? [
          {
            id: "administration",
            label: "Community admin",
            sections: administration,
          },
        ]
      : []),
    {
      id: "app",
      label: "Buzz",
      sections: [
        identity,
        // Paired command-line tools exist only in the desktop app.
        ...(isTauri() ? [security] : []),
        ...app.filter((item) => item.id !== "updates"),
        ...cards
          .filter((card) => card.group === "App")
          .map((card) => section(card)),
        ...app.filter((item) => item.id === "updates"),
        ...(developerMode ? [developer] : []),
      ],
    },
    {
      id: "plugins",
      label: "Plugins",
      sections: [
        plugins,
        ...cards
          .filter((card) => card.group === "Plugins")
          .map((card) => section(card))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ],
    },
    ...[
      ...new Set(
        cards.flatMap((card) =>
          card.group && card.group !== "App" && card.group !== "Plugins"
            ? [card.group]
            : [],
        ),
      ),
    ].map((label) => ({
      id: `group:${label}`,
      label,
      sections: cards
        .filter((card) => card.group === label)
        .map((card) => section(card)),
    })),
  ];
  return {
    groups,
    sections: groups.flatMap((group) => group.sections),
    defaultSection: community ? "profile" : "appearance",
  };
}
