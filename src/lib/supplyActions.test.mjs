import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSupplyActions, rowActionLabel, waitingLine } from './supplyActions.js';

const keys = (role, request) => getSupplyActions(role, request).map((a) => a.key);
const action = (role, request, key) => getSupplyActions(role, request).find((a) => a.key === key);

test('Admin in review: Endorse – Full is disabled when short, with the explanation', () => {
  const short = { status: 'under_review', can_endorse: false, endorse_block_reason: 'Stock is short; choose a Fulfillment Decision.' };
  assert.equal(action('admin', short, 'endorse').disabled, true);
  assert.equal(action('admin', short, 'endorse').reason, 'Stock is short; choose a Fulfillment Decision.');
  assert.equal(action('admin', short, 'fulfillment').disabled, false);
  const full = { status: 'under_review', can_endorse: true };
  assert.equal(action('admin', full, 'endorse').disabled, false);
  assert.equal(action('admin', full, 'fulfillment').disabled, true);
  assert.deepEqual(keys('admin', full), ['endorse', 'fulfillment', 'return', 'reject', 'cancel']);
});

test('Admin may cancel at every stage before dispatch, never after', () => {
  for (const status of ['submitted', 'under_review', 'returned', 'waiting_logistics', 'scheduled', 'on_hold', 'preparing']) {
    assert.ok(keys('admin', { status }).includes('cancel'), status);
  }
  for (const status of ['dispatched', 'delivered', 'discrepancy_review', 'completed', 'rejected', 'cancelled']) {
    assert.ok(!keys('admin', { status }).includes('cancel'), status);
  }
});

test('Admin answers Logistics: new date, shortage, hold, discrepancy', () => {
  assert.ok(keys('admin', { status: 'scheduled', pending_date_change: true }).includes('decide_date'));
  assert.ok(keys('admin', { status: 'scheduled', pending_shortage: true }).includes('fulfillment'));
  assert.deepEqual(keys('admin', { status: 'on_hold' }), ['resume', 'restock_date', 'reject', 'cancel']);
  assert.deepEqual(keys('admin', { status: 'discrepancy_review' }), ['resolve_discrepancy']);
});

test('Logistics steps, blocked while Admin decides', () => {
  assert.deepEqual(keys('logistics', { status: 'waiting_logistics' }), ['accept_schedule', 'request_date', 'shortage']);
  assert.deepEqual(keys('logistics', { status: 'scheduled' }), ['start_preparing', 'request_date', 'shortage']);
  assert.deepEqual(keys('logistics', { status: 'preparing' }), ['dispatch', 'shortage']);
  assert.deepEqual(keys('logistics', { status: 'dispatched' }), ['pod']);
  assert.deepEqual(keys('logistics', { status: 'dispatched', pod_encoded: true }), []);
  assert.equal(action('logistics', { status: 'preparing', pending_shortage: true }, 'dispatch').disabled, true);
  assert.ok(!keys('logistics', { status: 'preparing', stock_deducted_at: '2026-11-01' }).includes('shortage'), 'old pre-deducted requests are cancelled, not reported');
  assert.deepEqual(keys('logistics', { status: 'under_review' }), [], 'Logistics never acts in review');
  assert.ok(!keys('logistics', { status: 'under_review' }).includes('endorse'));
});

test('the one table button follows the owner and the stage', () => {
  assert.equal(rowActionLabel('admin', { status: 'under_review', owners: ['admin'] }), 'Review');
  assert.equal(rowActionLabel('admin', { status: 'on_hold', owners: ['admin'] }), 'Resume');
  assert.equal(rowActionLabel('admin', { status: 'discrepancy_review', owners: ['admin'] }), 'Resolve');
  assert.equal(rowActionLabel('admin', { status: 'scheduled', owners: ['admin'], pending_date_change: true }), 'Review date');
  assert.equal(rowActionLabel('logistics', { status: 'waiting_logistics', owners: ['logistics'] }), 'Confirm schedule');
  assert.equal(rowActionLabel('logistics', { status: 'scheduled', owners: ['logistics'] }), 'Start preparing');
  assert.equal(rowActionLabel('logistics', { status: 'preparing', owners: ['logistics'] }), 'Dispatch');
  assert.equal(rowActionLabel('logistics', { status: 'dispatched', owners: ['logistics', 'branch'] }), 'Encode POD');
  assert.equal(rowActionLabel('admin', { status: 'preparing', owners: ['logistics'] }), null, 'not my turn');
  assert.equal(waitingLine({ owners: ['logistics'] }), 'Waiting for Logistics.');
  assert.equal(waitingLine({ owners: [] }), 'Closed. No further action.');
});
