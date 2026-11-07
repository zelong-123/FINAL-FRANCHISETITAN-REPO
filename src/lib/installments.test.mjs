// Run with: node --test src/lib/installments.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentMinimum, downpaymentBase, entryRuleIssue, minDownpayment, minInstallment } from './installments.js';

test('the 100k / 30k example: 15k ×4 then 10k', () => {
  assert.equal(minDownpayment(100000, 20), 20000);
  assert.equal(minInstallment(30000, 50), 15000);
  assert.equal(currentMinimum(30000, 70000, 50), 15000);
  assert.equal(currentMinimum(30000, 10000, 50), 10000);
});

test('the discount base: 20% off 100k -> final 80k -> downpayment >= 16k', () => {
  assert.equal(minDownpayment(80000, 20), 16000);
});

test('entry rule messages match the API', () => {
  const base = { totalRequired: 100000, minDownpaymentPercent: 20, installmentPercent: 50 };
  assert.equal(
    entryRuleIssue({ ...base, type: 'downpayment', amount: 19999, remaining: 100000, base: null, hasEarlierEntries: false }),
    'The downpayment must be at least ₱20,000 (20% of the final total ₱100,000).',
  );
  assert.equal(entryRuleIssue({ ...base, type: 'downpayment', amount: 20000, remaining: 100000, base: null, hasEarlierEntries: false }), '');
  assert.equal(
    entryRuleIssue({ ...base, type: 'installment_payment', amount: 25000, remaining: 100000, base: null, hasEarlierEntries: false }),
    'Record the downpayment first (or settle the whole balance as a Full Payment).',
  );
  assert.equal(
    entryRuleIssue({ ...base, type: 'installment_payment', amount: 14999, remaining: 70000, base: 30000, hasEarlierEntries: true }),
    'An installment must be at least ₱15,000 (50% of the ₱30,000 downpayment).',
  );
  assert.equal(
    entryRuleIssue({ ...base, type: 'installment_payment', amount: 9999, remaining: 10000, base: 30000, hasEarlierEntries: true }),
    'An installment must be at least ₱10,000 (the remaining balance).',
  );
  // Paying more than the minimum (advance) is fine; a Full Payment needs no minimum.
  assert.equal(entryRuleIssue({ ...base, type: 'installment_payment', amount: 40000, remaining: 70000, base: 30000, hasEarlierEntries: true }), '');
  assert.equal(entryRuleIssue({ ...base, type: 'full_payment', amount: 5, remaining: 5, base: null, hasEarlierEntries: false }), '');
});

test('the base comes from the saved downpayment, else a drafted one', () => {
  assert.equal(downpaymentBase({ has_downpayment: true, downpayment_amount: 30000 }, []), 30000);
  assert.equal(downpaymentBase({ has_downpayment: false }, [{ payment_type: 'downpayment', amount: '25000' }]), 25000);
  assert.equal(downpaymentBase({ has_downpayment: false }, []), null);
});
