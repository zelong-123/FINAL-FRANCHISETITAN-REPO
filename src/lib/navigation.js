/**
 * Small URL rules for the role page clean-up (kept here so they are tested).
 */

/** Roles that see the Master Schedule tab in Activities & Schedule. */
export const MASTER_SCHEDULE_ROLES = ['admin', 'sales'];

/** Roles that get the moved overview + Forecast history on Analytics and Forecasting. */
export const FORECASTING_SECTION_ROLES = ['admin', 'logistics'];

/**
 * Which Activities & Schedule view a URL asks for:
 *   ?view=master-schedule -> 'master' (Admin / Sales only, otherwise 'table')
 *   ?view=calendar        -> 'master' (the old Calendar was replaced by Master Schedule)
 *   anything else         -> 'table'
 */
export function activitiesView(viewParam, role) {
  if (viewParam === 'master-schedule' || viewParam === 'calendar') {
    return MASTER_SCHEDULE_ROLES.includes(role) ? 'master' : 'table';
  }
  return 'table';
}

/** Old /schedule?session=12 -> /activities?view=master-schedule&session=12 */
export function scheduleRedirectTarget(search = '') {
  const params = new URLSearchParams(search);
  params.set('view', 'master-schedule');
  return `/activities?${params.toString()}`;
}
