/*
 * Activities & Schedules — which people the "Schedule per person" table lists.
 *
 * A person leaves the table when BOTH Orientation/Tasting and Training are fully done (Sales
 * completed + Admin verified/attended), when archived, or when Admin cancelled with zero completed
 * activities (the API already leaves those out). "Show completed" brings the fully done back so they
 * can still be opened; archived people stay out either way. Calendar and Master Schedule are not
 * affected.
 */

/**
 * @param {object} p
 * @param {object[]} p.tableGroups  people the API lists for the table (fully done already left out)
 * @param {object[]} p.allGroups    every person with a schedule (include_completed=1)
 * @param {boolean} p.showCompleted the "Show completed" toggle
 * @param {(group: object) => boolean} p.isArchived
 */
export function tableRows({ tableGroups = [], allGroups = [], showCompleted = false, isArchived = () => false }) {
  const source = showCompleted ? allGroups : tableGroups;
  return source.filter((group) => !isArchived(group));
}

/** How many fully done (not archived) people the toggle would add back. */
export function completedCount({ tableGroups = [], allGroups = [], isArchived = () => false }) {
  const listed = new Set(tableGroups.map((group) => String(group.applicant_id ?? group.person)));
  return allGroups.filter((group) => !isArchived(group) && !listed.has(String(group.applicant_id ?? group.person))).length;
}

export const TABLE_FOOTER = 'A person leaves this table when both activities (Orientation/Tasting and Training) are done, when Admin archives them, or when Admin cancels with zero completed activities. Turn on Show completed to open the fully done.';
