// Run with: node --test src/lib/navigation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAVIGATION, ROUTE_ROLES, can } from './roleAccess.js';
import { FORECASTING_SECTION_ROLES, activitiesView, scheduleRedirectTarget } from './navigation.js';

const labels = (role) => NAVIGATION[role].flatMap((group) => group.items.map((item) => item.label));
const paths = (role) => NAVIGATION[role].flatMap((group) => group.items.map((item) => item.path));

test('Test 1: the sidebar of every role matches the table', () => {
  assert.deepEqual(labels('admin'), [
    'Executive dashboard', 'Inquiries', 'Applicants', 'Activities',
    'Branches', 'Products', 'Warehouse inventory', 'Supply requests', 'Users', 'Admin settings',
    'Analytics and Forecasting',
  ]);
  assert.deepEqual(labels('marketing'), ['Marketing dashboard', 'Inquiries', 'History']);
  assert.deepEqual(labels('sales'), ['Sales dashboard', 'Inquiries', 'Applicants', 'Activities']);
  assert.deepEqual(labels('logistics'), [
    'Logistics dashboard', 'Branches', 'Warehouse inventory', 'Supply requests', 'Analytics and Forecasting',
  ]);
  for (const role of ['admin', 'marketing', 'sales', 'logistics']) {
    assert.ok(!paths(role).includes('/schedule'), `${role}: no Master schedule item`);
    assert.ok(!paths(role).includes('/analytics'), `${role}: no Analytics item`);
    assert.ok(!labels(role).includes('Estimated requirement'), `${role}: renamed`);
    // No empty section header (e.g. "Intelligence" with nothing in it).
    NAVIGATION[role].forEach((group) => assert.ok(group.items.length > 0, `${role}: empty ${group.label}`));
  }
  const intelligence = NAVIGATION.admin.find((group) => group.label === 'Intelligence');
  assert.equal(intelligence.items[0].description, 'Usage-based demand and supply estimates');
  assert.ok(!/\b(AI|machine learning)\b/i.test(JSON.stringify(intelligence)));
});

test('Test 2: the removed pages are blocked for every role', () => {
  assert.deepEqual(ROUTE_ROLES['/analytics'], []);
  for (const role of ['admin', 'marketing', 'sales', 'logistics', 'franchisee']) {
    assert.equal(can(role, 'analytics.view'), false);
  }
  // The renamed page keeps its URL; the branch workspace no longer has this page.
  assert.deepEqual(ROUTE_ROLES['/estimated-requirement'], ['admin', 'logistics']);
});

test('Test 3: the old /schedule URL goes to the Master Schedule tab with its session', () => {
  assert.equal(scheduleRedirectTarget('?session=12'), '/activities?session=12&view=master-schedule');
  assert.equal(scheduleRedirectTarget(''), '/activities?view=master-schedule');
  assert.deepEqual(ROUTE_ROLES['/schedule'], ['admin', 'sales']);
});

test('?view=master-schedule: Admin and Sales only; anyone else falls back to the table', () => {
  assert.equal(activitiesView('master-schedule', 'admin'), 'master');
  assert.equal(activitiesView('master-schedule', 'sales'), 'master');
  assert.equal(activitiesView('master-schedule', 'franchisee'), 'table');
  assert.equal(activitiesView('master-schedule', 'logistics'), 'table');
  assert.equal(activitiesView('calendar', 'sales'), 'calendar');
  assert.equal(activitiesView(null, 'admin'), 'table');
  // Same rule as the permission matrix used by the tab button.
  assert.equal(can('admin', 'schedule_sessions.view'), true);
  assert.equal(can('franchisee', 'schedule_sessions.view'), false);
});

test('Forecasting sections: Admin + Logistics only, never the franchisee tab', () => {
  assert.deepEqual(FORECASTING_SECTION_ROLES, ['admin', 'logistics']);
  assert.equal(can('sales', 'forecasts.view'), false);
  assert.equal(can('franchisee', 'forecasts.view'), false);
  assert.equal(can('logistics', 'forecasts.generate'), true);
});
