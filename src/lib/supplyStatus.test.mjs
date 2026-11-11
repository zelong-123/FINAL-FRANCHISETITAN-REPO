import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as front from './supplyStatus.js';
import * as back from '../../supabase/functions/api/services/supplyStatus.ts';

test('the browser status lists match the API ones', () => {
  for (const name of ['MAIN_PATH', 'SIDE', 'STATUSES', 'TERMINAL', 'OPEN', 'SUBMITTED_OPEN', 'IN_TRANSIT', 'TO_SHIP', 'EDITABLE', 'DELIVERED_ON']) {
    assert.deepEqual([...front[name]], [...back[name]], name);
  }
  assert.deepEqual(front.LABELS, back.LABELS);
});

test('labels', () => {
  assert.equal(front.supplyStatusLabel('waiting_logistics'), 'Waiting for Logistics');
  assert.equal(front.supplyStatusLabel('completed_with_discrepancy'), 'Completed with discrepancy');
  assert.equal(front.supplyStatusLabel('something_new'), 'Something New');
  assert.equal(front.supplyStatusLabel(null), '');
});
