export const routeTitles = {
  '/admin-dashboard': ['Executive dashboard', 'Organization-wide operations'],
  '/marketing-dashboard': ['Marketing dashboard', 'Lead acquisition and conversion'],
  '/sales-dashboard': ['Sales dashboard', 'Applicant pipeline and activities'],
  '/logistics-dashboard': ['Logistics dashboard', 'Inventory and fulfillment'],
  '/franchisee-dashboard': ['Franchise dashboard', 'Your application and supply activity'],
  '/inquiries': ['Leads & inquiries', 'Marketing and sales pipeline'],
  '/applicants': ['Applicant pipeline', 'Candidate progress and approvals'],
  '/activities': ['Activities & schedules', 'Orientations, training, and events'],
  '/users': ['User management', 'Accounts and role-based access'],
  '/admin-settings': ['Admin settings', 'Archive and restore records'],
  '/branches': ['Branches', 'Branch stock, deductions, and requests'],
  '/products': ['Products', 'Brand products, pictures and recipes'],
  '/inventory': ['Inventory', 'Warehouse stock and thresholds'],
  '/supply-requests': ['Supply requests', 'Ordering and fulfillment workflow'],
  '/estimated-requirement': ['Analytics and Forecasting', 'Usage-based demand and supply estimates'],
  '/estimated-requirement/network': ['Network requirement', 'Estimated need across branches against warehouse stock'],
  '/chat': ['Department Messenger', 'Real-time team chat & direct messaging'],
};

// Parent pages for nested routes, used to build the breadcrumb trail.
export const routeParents = {
  '/estimated-requirement/network': '/estimated-requirement',
};

// Sub-views shown as an extra crumb after the page. `param` is the query key that
// holds the active view; `defaultKey` is the view with no crumb of its own.
export const routeTabs = {
  '/applicants': {
    param: 'tab',
    defaultKey: 'pipeline',
    labels: { franchisees: 'Franchisees', archived: 'Archive', detail: 'Application Detail' },
  },
  '/activities': {
    param: 'view',
    defaultKey: 'table',
    labels: { table: 'Table', calendar: 'Calendar', 'master-schedule': 'Master Schedule' },
  },
};

export function getRouteTitle(pathname) {
  return routeTitles[pathname] || ['Herald workspace', 'Franchise operations'];
}

/** Breadcrumb trail, e.g. [{ label: 'Analytics and Forecasting', path: '/estimated-requirement' }, { label: 'Network requirement' }]. */
export function getBreadcrumbs(pathname, search = '') {
  const trail = [];
  let current = pathname;
  while (current && routeTitles[current]) {
    trail.unshift({ label: routeTitles[current][0], path: current });
    current = routeParents[current];
  }
  if (trail.length === 0) trail.push({ label: 'Herald workspace', path: null });
  const sub = routeTabs[pathname];
  const requested = sub ? new URLSearchParams(search).get(sub.param) : null;
  const key = sub && sub.labels[requested] ? requested : sub?.defaultKey;
  if (sub && key !== sub.defaultKey) {
    // The page crumb links back to the default view when a sub-view is shown.
    trail[trail.length - 1] = { label: trail[trail.length - 1].label, path: pathname };
    trail.push({ label: sub.labels[key] });
  } else {
    trail[trail.length - 1] = { label: trail[trail.length - 1].label };
  }
  return trail;
}
