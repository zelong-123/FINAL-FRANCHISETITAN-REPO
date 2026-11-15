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

test('payment label counts verified required payments, never money', () => {
  assert.equal(paidLabel({}), 'No required payments');
  assert.equal(paidLabel({ payments_required: 2, payments_verified: 0 }), '0 of 2 verified');
  assert.equal(paidLabel({ payments_required: 2, payments_verified: 2 }), '2 of 2 verified');
});

test('plan title', () => {
  assert.equal(planTitle({}), 'Admin has not set the required payments');
  assert.equal(planTitle({ payments_required: 3, payments_verified: 1 }), '2 required payments not verified yet');
  assert.equal(planTitle({ payments_required: 1, payments_verified: 0 }), '1 required payment not verified yet');
  assert.equal(planTitle({ payments_required: 2, payments_verified: 2 }), 'All required payments verified');
});

test('folder date', () => {
  const row = { updated_at: 'u', approved_at: 'a', rejected_at: 'r' };
  assert.equal(folderDate('active', row), 'u');
  assert.equal(folderDate('approved', row), 'a');
  assert.equal(folderDate('rejected', row), 'r');
});
