import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareApi, dismissNote, NOTE_DISMISS_KEY, noteDismissed } from './apiVersion.js';

test('version banner: match, mismatch (strong warning), no stamp (soft note), or not checkable', () => {
  assert.deepEqual(compareApi('abc1234def', { api_tree: 'abc1234def', commit: 'fa2f9b5aa' }), { state: 'match', severity: null, message: null });
  const older = compareApi('abc1234def', { api_tree: '999aaaa', commit: '7f38297bb' });
  assert.equal(older.state, 'mismatch');
  assert.equal(older.severity, 'warning');
  assert.match(older.message, /^Live API is older than this app — tell the team\. \(Live API 7f38297, this app expects API code abc1234\.\)$/);
  const manual = compareApi('abc1234def', { status: 'ok', api_tree: null, commit: null });
  assert.deepEqual([manual.state, manual.severity], ['unknown', 'note'], 'no stamp is a soft note, not the warning');
  assert.match(manual.message, /deployed without npm run deploy:api/);
  assert.equal(compareApi('abc1234def', { status: 'ok' }).severity, 'note', 'an old API without build info at all');
  assert.equal(compareApi(null, { api_tree: 'x' }).state, 'unchecked', 'a build without git info shows nothing');
  assert.equal(compareApi('abc', null).state, 'unchecked', 'health unreachable shows nothing');
});

test('the note dismissal is remembered per browser and survives storage errors', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(noteDismissed(storage), false);
  dismissNote(storage);
  assert.equal(store.get(NOTE_DISMISS_KEY), '1');
  assert.equal(noteDismissed(storage), true);
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(noteDismissed(broken), false);
  assert.doesNotThrow(() => dismissNote(broken));
});
