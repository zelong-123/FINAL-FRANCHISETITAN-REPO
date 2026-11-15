import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedCount, TABLE_FOOTER, tableRows } from './activityTable.js';

const active = { applicant_id: 1, person: 'Ana' };
const done = { applicant_id: 2, person: 'Ben' };
const archived = { applicant_id: 3, person: 'Cy', is_archived: true };
const isArchived = (g) => Boolean(g.is_archived);
const tableGroups = [active, archived];
const allGroups = [active, done, archived];

test('the table hides fully done people unless Show completed is on; archived never show', () => {
  assert.deepEqual(tableRows({ tableGroups, allGroups, showCompleted: false, isArchived }).map((g) => g.person), ['Ana']);
  assert.deepEqual(tableRows({ tableGroups, allGroups, showCompleted: true, isArchived }).map((g) => g.person), ['Ana', 'Ben']);
  assert.equal(completedCount({ tableGroups, allGroups, isArchived }), 1);
});

test('the footer names both activities', () => {
  assert.match(TABLE_FOOTER, /both activities \(Orientation\/Tasting and Training\)/);
  assert.doesNotMatch(TABLE_FOOTER, /three/);
});
