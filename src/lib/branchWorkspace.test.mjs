import assert from 'node:assert/strict';
import test from 'node:test';
import {
  branchPlace, breadcrumbFor, combineLine, findDuplicate, putLine, removeLine, resolveView, toRequestItems,
} from './branchWorkspace.js';

const beef = { product_id: 1, name: 'Beef', quantity: 20 };
const buns = { product_id: 2, name: 'Buns', quantity: 5 };

test('an unknown or retired view opens the dashboard', () => {
  assert.equal(resolveView('supply'), 'supply');
  assert.equal(resolveView('estimate'), 'dashboard');
  assert.equal(resolveView('constructor'), 'dashboard');
  assert.equal(resolveView(null), 'dashboard');
});

test('breadcrumbs link every level but the current one', () => {
  assert.deepEqual(breadcrumbFor('supply'), [
    { label: 'Branch Workspace', view: 'dashboard' },
    { label: 'Supply Request Panel', view: null },
  ]);
  assert.deepEqual(breadcrumbFor('transactions'), [
    { label: 'Branch Workspace', view: 'dashboard' },
    { label: 'Branch Dashboard', view: 'dashboard' },
    { label: 'All Transactions', view: null },
  ]);
});

test('the sidebar name is a place, never the owner repeated', () => {
  assert.equal(branchPlace({ address: 'Muntinlupa City', city: 'X' }, 'Ana'), 'Muntinlupa City');
  assert.equal(branchPlace({ address: 'Ceejay Francisco', city: 'Talon 3' }, 'ceejay francisco'), 'Talon 3');
  assert.equal(branchPlace({ address: 'Location not set', city: null }, 'Ana'), 'Location not set');
  assert.equal(branchPlace(null, 'Ana'), 'Location not set');
});

test('a duplicate is another row, not the row being edited', () => {
  assert.equal(findDuplicate([beef, buns], 1), beef);
  assert.equal(findDuplicate([beef, buns], 3), null);
  assert.equal(findDuplicate([beef, buns], 1, 1), null);
  assert.equal(findDuplicate([beef, buns], '2', 1), buns);
});

test('adding appends and editing replaces in place', () => {
  assert.deepEqual(putLine([beef], buns), [beef, buns]);
  const edited = { ...beef, quantity: 7 };
  assert.deepEqual(putLine([beef, buns], edited, 1), [edited, buns]);
  const swapped = { product_id: 3, name: 'Rice', quantity: 2 };
  assert.deepEqual(putLine([beef, buns], swapped, 1), [swapped, buns]);
});

test('combining adds the quantities and never leaves a duplicate row', () => {
  assert.deepEqual(combineLine([beef, buns], { ...beef, quantity: 5 }), [{ ...beef, quantity: 25 }, buns]);
  // Editing Buns into Beef folds it into the Beef row.
  assert.deepEqual(combineLine([beef, buns], { ...beef, quantity: 5 }, 2), [{ ...beef, quantity: 25 }]);
  assert.equal(combineLine([{ ...beef, quantity: 0.1 }], { ...beef, quantity: 0.2 })[0].quantity, 0.3);
});

test('unselecting removes one row and the payload keeps every item', () => {
  assert.deepEqual(removeLine([beef, buns], 1), [buns]);
  assert.deepEqual(toRequestItems([beef, buns]), [
    { product_id: 1, quantity_requested: 20 },
    { product_id: 2, quantity_requested: 5 },
  ]);
});

test('the branch tracker: Submitted → Approved → On the way → Received', async () => {
  const { branchStep, BRANCH_STEPS } = await import('./branchWorkspace.js');
  assert.deepEqual(BRANCH_STEPS, ['Submitted', 'Approved', 'On the way', 'Received']);
  assert.equal(branchStep('under_review').step, 0);
  assert.equal(branchStep('returned').label, 'Returned – edit and resubmit');
  assert.equal(branchStep('scheduled').step, 1);
  assert.equal(branchStep('on_hold').label, 'Approved – on hold for restock');
  assert.equal(branchStep('dispatched').step, 2);
  assert.equal(branchStep('dispatched', '2026-11-11T08:00:00Z').step, 3, 'received before the POD');
  assert.equal(branchStep('completed_with_discrepancy').step, 3);
  assert.equal(branchStep('cancelled').stopped, true);
  assert.equal(branchStep('draft').step, -1);
});

test('Confirm Receipt lines are checked like the server does', async () => {
  const { receiptLineErrors } = await import('./branchWorkspace.js');
  assert.deepEqual(receiptLineErrors({ good: 10, damaged: 0, short: 0 }, 10), {});
  assert.match(receiptLineErrors({ good: 8, damaged: 0, short: 0 }, 10).sum, /must equal the 10 dispatched \(now 8\)/);
  const damaged = receiptLineErrors({ good: 8, damaged: 2, short: 0 }, 10);
  assert.ok(damaged.damage_reason && damaged.photo && !damaged.sum);
  assert.deepEqual(receiptLineErrors({ good: 8, damaged: 2, short: 0, damage_reason: 'Crushed box', photo: {} }, 10), {});
  assert.ok(receiptLineErrors({ good: 9, damaged: 0, short: 1 }, 10).short_reason);
  assert.ok(receiptLineErrors({ good: -1, damaged: 0, short: 0 }, 10).sum);
  assert.ok(receiptLineErrors({ good: '', damaged: 0, short: 0 }, 10).sum, 'empty good is not zero');
});
