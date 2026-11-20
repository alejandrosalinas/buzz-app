import type { Groups } from "../channel-templates/model";
import type { SidebarGroups } from "./sidebar-preferences";

const displacedTeamPrefix = "legacy-team:";

/** Both sources are verified heads. Preserve Solo IDs as template coordinates. */
export function mergeLegacyWorkspaces(
  team: SidebarGroups,
  solo: Groups | undefined,
): SidebarGroups {
  if (!solo) return team;
  const soloIds = new Set(solo.groups.map(({ id }) => id));
  const teamIds = new Set(team.sections.map(({ id }) => id));
  const remapTeam = (id: string) => {
    if (!soloIds.has(id)) return id;
    const remapped = displacedTeamPrefix + id;
    if (teamIds.has(remapped))
      throw new Error("Saved workspace IDs could not be merged.");
    return remapped;
  };
  const sections = [
    ...solo.groups.map(({ id, name }) => ({ id, name })),
    ...team.sections.map((section) => ({
      ...section,
      id: remapTeam(section.id),
    })),
  ].map((section, order) => ({ ...section, order }));
  const live = new Set(sections.map(({ id }) => id));
  const groupKeys = sections.map(({ id }) => `group:${id}`);
  const soloCount = solo.groups.length;
  return {
    sections,
    ...(soloCount
      ? {
          // The old Solo sidebar listed workspaces above its loose chats.
          sectionOrder: [
            ...groupKeys.slice(0, soloCount),
            "solo",
            "starred",
            ...groupKeys.slice(soloCount),
          ],
        }
      : {}),
    assignments: {
      ...Object.fromEntries(
        Object.entries(team.assignments).map(([conversation, id]) => [
          conversation,
          remapTeam(id),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(solo.assignments).filter(([, id]) => live.has(id)),
      ),
    },
    legacyTemplates: Object.fromEntries(
      solo.groups.flatMap(({ id, defaultTemplateId }) =>
        defaultTemplateId ? [[id, defaultTemplateId]] : [],
      ),
    ),
  };
}
