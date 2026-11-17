import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bellBadge, defaultTab, followUpCount, hasNewFollowUp, isFollowUpNotification, shouldShake, splitNotifications } from './bellState.js';

test('notifications split by type: follow-up ones only in the Follow-ups tab', () => {
  const items = [
    { id: 1, type: 'applicant_assigned' },
    { id: 2, type: 'applicant_overdue' },
    { id: 3, type: 'applicant_stalled' },
    { id: 4, type: 'applicant_reminder' },
    { id: 5, type: 'applicant_follow_up_logged' },
    { id: 6, type: 'applicant_on_hold' },
    { id: 7, type: 'supply_request_overdue' },
    { id: 8, type: 'follow_up_due' },
  ];
  const { general, followUp } = splitNotifications(items);
  assert.deepEqual(general.map((n) => n.id), [1, 7, 8], 'supply overdue and the old follow-up due stay general');
  assert.deepEqual(followUp.map((n) => n.id), [2, 3, 4, 5, 6]);
  assert.equal(isFollowUpNotification({ type: 'applicant_reminder' }), true);
  assert.equal(isFollowUpNotification(null), false);
});

test('follow-up counts per role: Sales counts On hold, Admin does not', () => {
  const rows = [{ follow_up: { state: 'overdue' } }, { follow_up: { state: 'stalled' } }, { follow_up: { state: 'on_hold' } }, { follow_up: { state: null } }];
  assert.equal(followUpCount(rows, 'sales'), 3);
  assert.equal(followUpCount(rows, 'admin'), 2);
  assert.equal(followUpCount([], 'admin'), 0);
  assert.equal(bellBadge({ followUps: 2, generalUnread: 3 }), 5);
});

test('the panel opens on Follow-ups only when there are items and no unread general notifications', () => {
  assert.equal(defaultTab({ followUps: 2, generalUnread: 0 }), 'follow_ups');
  assert.equal(defaultTab({ followUps: 2, generalUnread: 1 }), 'notifications');
  assert.equal(defaultTab({ followUps: 0, generalUnread: 0 }), 'notifications');
});

test('shake: only with follow-up items, never with reduced motion; at once when a new item arrives', () => {
  assert.equal(shouldShake({ followUps: 1 }), true);
  assert.equal(shouldShake({ followUps: 0 }), false, 'stops when there is nothing to follow up');
  assert.equal(shouldShake({ followUps: 3, reducedMotion: true }), false, 'badge only');
  assert.equal(hasNewFollowUp(null, [1, 2]), false, 'the first load is not new');
  assert.equal(hasNewFollowUp([1, 2], [2, 1]), false);
  assert.equal(hasNewFollowUp([1, 2], [1, 2, 3]), true);
  assert.equal(hasNewFollowUp([1, 2], [1]), false, 'a resolved item is not new');
});
