// Which portal this build serves, read once from VITE_PORTAL at build time.
//   staff  -> Admin, Marketing, Sales, Logistics only ("/" is the staff login)
//   branch -> franchisee accounts only ("/" is the branch login)
//   unset  -> every route, as in local development
const raw = String(import.meta.env.VITE_PORTAL ?? '').trim().toLowerCase();

if (raw && raw !== 'staff' && raw !== 'branch') {
  throw new Error(`VITE_PORTAL must be "staff", "branch" or unset (got "${import.meta.env.VITE_PORTAL}").`);
}

export const PORTAL = raw || 'all';
export const IS_STAFF_PORTAL = PORTAL === 'staff';
export const IS_BRANCH_PORTAL = PORTAL === 'branch';

const STAFF_ROLES = ['admin', 'marketing', 'sales', 'logistics'];

/** Where the branch workspace sends a signed-out visitor: this site's own login. */
export const BRANCH_LOGIN_PATH = PORTAL === 'all' ? '/branch-login' : '/';

/** True when a signed-in role does not belong on this build's portal. */
export function isWrongPortalRole(role) {
  if (IS_STAFF_PORTAL) return !STAFF_ROLES.includes(role);
  if (IS_BRANCH_PORTAL) return role !== 'franchisee';
  return false;
}

export const WRONG_PORTAL_MESSAGE = IS_BRANCH_PORTAL
  ? 'This is the Branch Portal. Staff accounts must use the Staff Portal.'
  : 'This is the Staff Portal. Branch accounts must use the Branch Portal.';

export const PORTAL_TITLE = {
  staff: 'Franchise Titan Staff Portal',
  branch: 'Franchise Titan Branch Portal',
}[PORTAL];
