import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareApi } from './apiVersion.js';

test('version banner: match, mismatch, deployed another way, or not checkable', () => {
  assert.equal(compareApi('abc1234def', { api_tree: 'abc1234def', commit: 'fa2f9b5aa' }).state, 'match');
  const older = compareApi('abc1234def', { api_tree: '999aaaa', commit: '7f38297bb' });
  assert.equal(older.state, 'mismatch');
  assert.match(older.message, /^Live API is older than this app — tell the team\. \(Live API 7f38297, this app expects API code abc1234\.\)$/);
  const manual = compareApi('abc1234def', { status: 'ok', api_tree: null, commit: null });
  assert.equal(manual.state, 'unknown', 'an API deployed without the safe script reports no tree');
  assert.match(manual.message, /deployed without npm run deploy:api/);
  assert.equal(compareApi('abc1234def', { status: 'ok' }).state, 'unknown', 'an old API without build info at all');
  assert.equal(compareApi(null, { api_tree: 'x' }).state, 'unchecked', 'a build without git info shows nothing');
  assert.equal(compareApi('abc', null).state, 'unchecked', 'health unreachable shows nothing');
});
