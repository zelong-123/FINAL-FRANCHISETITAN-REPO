import {
  FaBoxesStacked,
  FaCalendarDays,
  FaChartLine,
  FaClipboardList,
  FaGear,
  FaHandshake,
  FaStore,
  FaTableColumns,
  FaUserShield,
  FaUsers,
  FaUtensils,
} from 'react-icons/fa6';

const item = (label, path, Icon, description) => ({ label, path, Icon, description });

/**
 * ONE central source of truth for role visibility.
 * Sidebar navigation, dashboard panels and route guards all read from this
 * file, so a stray panel or nav item can never appear for the wrong role.
 * Admin is the superset; every other role only lists its own department.
 */
export const NAVIGATION = {
  admin: [
    { label: 'Overview', items: [
      item('Executive dashboard', '/admin-dashboard', FaTableColumns, 'Organization health'),
    ] },
    { label: 'Inquiry', items: [
      item('Inquiries', '/inquiries', FaHandshake, 'Lead pipeline'),
      item('Applicants', '/applicants', FaUsers, 'Franchise candidates'),
      item('Activities', '/activities', FaCalendarDays, 'Events, schedules and Master Schedule'),
    ] },
    { label: 'Operations', items: [
      item('Branches', '/branches', FaStore, 'Branch command panel'),
      item('Products', '/products', FaUtensils, 'Brand product recipes'),
      item('Warehouse inventory', '/inventory', FaBoxesStacked, 'Central stock visibility'),
      item('Supply requests', '/supply-requests', FaClipboardList, 'Fulfillment workflow'),
      item('Users', '/users', FaUserShield, 'Access control'),
      item('Admin settings', '/admin-settings', FaGear, 'Archive and restore'),
    ] },
    { label: 'Intelligence', items: [
      item('Analytics and Forecasting', '/estimated-requirement', FaChartLine, 'Usage-based demand and supply estimates'),
    ] },
  ],
  marketing: [
    { label: 'Overview', items: [
      item('Marketing dashboard', '/marketing-dashboard', FaTableColumns, 'Acquisition health'),
    ] },
    { label: 'Growth', items: [
      item('Inquiries', '/inquiries', FaHandshake, 'Lead pipeline'),
      item('History', '/inquiry-history', FaClipboardList, 'Entered and endorsed leads'),
    ] },
  ],
  sales: [
    { label: 'Overview', items: [
      item('Sales dashboard', '/sales-dashboard', FaTableColumns, 'Pipeline health'),
    ] },
    { label: 'Pipeline', items: [
      item('Inquiries', '/inquiries', FaHandshake, 'Qualified leads'),
      item('Applicants', '/applicants', FaUsers, 'Candidate progress'),
      item('Activities', '/activities', FaCalendarDays, 'Touchpoints and Master Schedule'),
    ] },
  ],
  logistics: [
    { label: 'Overview', items: [
      item('Logistics dashboard', '/logistics-dashboard', FaTableColumns, 'Fulfillment health'),
    ] },
    { label: 'Operations', items: [
      item('Branches', '/branches', FaStore, 'Branch command panel'),
      item('Warehouse inventory', '/inventory', FaBoxesStacked, 'Central stock visibility'),
      item('Supply requests', '/supply-requests', FaClipboardList, 'Fulfillment workflow'),
    ] },
    { label: 'Intelligence', items: [
      item('Analytics and Forecasting', '/estimated-requirement', FaChartLine, 'Usage-based demand and supply estimates'),
    ] },
  ],
  franchisee: [],
};

/**
 * Dashboard panels per role — drives the dashboard renderer.
 * Panel ids: kpi, dateFilter, salesTrend, applicantFunnel, inquirySource,
 * inquiryAcquisition, topBranches, insights, recentApplications, transactions,
 * inventoryHealth, stageTracker, stageBreakdown, fulfillmentTrend.
 */
export const DASHBOARD_PANELS = {
  admin: [
    'kpi',
    'dateFilter',
    'inquiryAcquisition',
    'inventoryHealth',
    'applicantFunnel',
    'inquirySource',
    'salesTrend',
    'topBranches',
    'insights',
    'recentApplications',
    'transactions',
  ],
  sales: [
    'kpi',
    'dateFilter',
    'salesTrend',
    'applicantFunnel',
    'inquirySource',
    'topBranches',
    'recentApplications',
  ],
  marketing: [
    'kpi',
    'dateFilter',
    'inquiryAcquisition',
    'inquirySource',
  ],
  logistics: [
    'dateFilter',
    'stageTracker',
    'stageBreakdown',
    'fulfillmentTrend',
    'inventoryHealth',
    'transactions',
  ],
  franchisee: [],
};

/**
 * Permission matrix — the UI twin of backend/config/roles.php.
 *
 * The backend is always the gate (403/422); this map only decides which
 * buttons, tabs and panels are shown. It is also served live by
 * GET /api/v1/pipeline-config so both sides read the same keys.
 */
export const PERMISSIONS = {
  // Inquiries (Sales = view only)
  'inquiries.view': ['admin', 'marketing', 'sales'],
  'inquiries.view_archived': ['admin', 'marketing'],
  'inquiries.create': ['marketing'],
  'inquiries.reject': ['admin'],
  'inquiries.update': ['admin', 'marketing'],
  'inquiries.endorse': ['marketing'],
  'inquiries.convert': ['admin'],
  'inquiries.archive': ['admin', 'marketing'],
  'inquiries.restore': ['admin', 'marketing'],
  'inquiries.delete': ['admin'],

  // Payment Submission stage (Admin sets/reviews, Sales collects)
  'payments.set_total': ['admin'],
  'payments.entry_manage': ['sales'],
  'payments.turn_over': ['sales'],
  'payments.confirm': ['admin'],
  'payments.return': ['admin'],

  // Applicants
  'applicants.view': ['admin', 'sales', 'franchisee'],
  'applicants.view_archived': ['admin'],
  'applicants.create': ['admin'],
  'applicants.update': ['admin'],
  'applicants.transition': ['admin'],
  'applicants.payment_request': ['sales'],
  'applicants.payment_confirm': ['admin'],
  'applicants.review': ['admin'],
  'applicants.approve': ['admin'],
  'applicants.activate': ['admin'],
  'applicants.reject': ['admin'],
  'applicants.milestones': ['admin'],
  'applicants.archive': ['admin'],
  'applicants.restore': ['admin'],
  'applicants.delete': ['admin'],
  'applicants.portal_user': ['admin'],

  // Activities & schedule
  'activities.view': ['admin', 'sales', 'franchisee'],
  'activities.view_archived': ['admin', 'marketing'],
  'activities.schedule': ['admin', 'sales'],
  'activities.edit': ['admin', 'sales'],
  'activities.complete': ['sales'],
  'activities.approve': ['admin'],
  'activities.reject': ['admin'],
  'activities.cancel': ['admin'],

  // Master Schedule (sessions)
  'schedule_sessions.view': ['admin', 'sales'],
  'schedule_sessions.schedule': ['admin', 'sales'],
  'schedule_sessions.confirm': ['admin'],
  'schedule_sessions.cancel': ['admin'],
  'schedule_sessions.remove_participant': ['admin'],
  'schedule_sessions.merge': ['admin'],
  'schedule_sessions.override_warning': ['admin'],

  // Analytics / dashboards
  'analytics.view': [],
  // Forecast history + [Generate forecasts] on Analytics and Forecasting.
  'forecasts.view': ['admin', 'logistics'],
  'forecasts.generate': ['admin', 'logistics'],
  'analytics.include_archived': ['admin', 'marketing'],
  'analytics.franchising': ['admin', 'sales'],

  // Supply requests
  'supply.review': ['admin'],
  'supply.endorse': ['admin'],
  'supply.propose_date': ['admin'],
  'supply.confirm_date': ['logistics'],
  'supply.start_preparing': ['logistics'],
  'supply.dispatch': ['logistics'],
  'supply.deliver': ['logistics'],
  'supply.complete': ['admin'],
  'supply.cancel_reject': ['admin'],
  'supply.confirm_receipt': ['franchisee'],
  'supply.add_branch_product': ['admin'],

  // Warehouse & inventory
  'inventory.view': ['admin', 'logistics'],
  'inventory.add': ['admin', 'logistics'],
  'inventory.adjust': ['logistics'],
};

/** True when the signed-in role holds the permission. */
export function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

/** Route guards — App.jsx builds its RoleGuards from this map. */
export const ROUTE_ROLES = {
  '/admin-dashboard': ['admin'],
  '/branch-portal': ['franchisee'],
  '/users': ['admin'],
  '/admin-settings': ['admin'],
  '/marketing-dashboard': ['marketing'],
  '/sales-dashboard': ['sales'],
  '/logistics-dashboard': ['logistics'],
  '/franchisee-dashboard': ['franchisee'],
  '/inquiries': ['admin', 'marketing', 'sales'],
  '/applicants': ['admin', 'sales', 'franchisee'],
  '/activities': ['admin', 'sales', 'franchisee'],
  // Old Master Schedule URL: redirects to /activities?view=master-schedule.
  '/schedule': ['admin', 'sales'],
  '/branches': ['admin', 'logistics'],
  '/inventory': ['admin', 'logistics', 'franchisee'],
  '/products': ['admin'],
  '/supply-requests': ['admin', 'logistics'],
  // Retired page: no role may open it (direct URL -> the role's own dashboard).
  '/analytics': [],
  '/estimated-requirement': ['admin', 'logistics'],
  '/estimated-requirement/network': ['admin', 'logistics'],
  '/inquiry-history': ['marketing'],
};

export function rolesFor(path) {
  return ROUTE_ROLES[path];
}

export function panelsFor(role) {
  return DASHBOARD_PANELS[role] || [];
}

export function hasPanel(role, panel) {
  return panelsFor(role).includes(panel);
}
