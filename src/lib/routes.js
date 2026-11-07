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

export function getRouteTitle(pathname) {
  return routeTitles[pathname] || ['Herald workspace', 'Franchise operations'];
}
