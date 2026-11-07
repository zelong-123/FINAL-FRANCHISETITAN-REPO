// Run with: node --test src/lib/recordFolders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchLabel, folderDate, paidLabel, planTitle } from './recordFolders.js';

test('branch line falls back business → location → brand → "No branch assigned"', () => {
  assert.equal(branchLabel({ business_name: 'Kkopi Alabang', location: 'Loc', brand: 'Kkopi' }), 'Kkopi Alabang');
  assert.equal(branchLabel({ business_name: null, location: 'Las Piñas Branch', brand: 'Kkopi' }), 'Las Piñas Branch');
  assert.equal(branchLabel({ business_name: null, location: null, brand: 'GoDo' }), 'GoDo');
  assert.equal(branchLabel({}), 'No branch assigned');
});

test('paid label separates "no plan" from a real 0%', () => {
  assert.equal(paidLabel({ payment_percent: 0, payment_required_amount: null }), 'No payment plan');
  assert.equal(paidLabel({ payment_percent: 0, payment_required_amount: 200000 }), '0% paid');
  assert.equal(paidLabel({ payment_percent: 25, payment_required_amount: 200000 }), '25% paid');
  // Legacy fully-paid franchisees report 100% without a total.
  assert.equal(paidLabel({ payment_percent: 100, payment_required_amount: null }), '100% paid');
});

test('plan title', () => {
  assert.equal(planTitle({}), 'No payment plan');
  assert.equal(planTitle({ payment_plan: { package_name: 'Kiosk' }, payment_required_amount: 5 }, (v) => `${v}.00`), 'Kiosk · ₱5.00');
  assert.equal(planTitle({ payment_plan: { package_name: null } }), 'Payment plan');
});

test('folder date', () => {
  const row = { updated_at: 'u', approved_at: 'a', rejected_at: 'r' };
  assert.equal(folderDate('active', row), 'u');
  assert.equal(folderDate('approved', row), 'a');
  assert.equal(folderDate('rejected', row), 'r');
});
