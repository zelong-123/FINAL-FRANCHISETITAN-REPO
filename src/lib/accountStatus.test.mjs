import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountBadge, localDateTimeInput } from './accountStatus.js';
import { linkKind, passwordChecks, passwordProblem, passwordStrength } from './passwordRules.js';

test('status badges: invitation states, suspension window, online/offline', () => {
  assert.equal(accountBadge({ invite_state: 'invited', account_status: 'invited' }).label, 'Invited');
  assert.equal(accountBadge({ invite_state: 'expired', account_status: 'invited' }).label, 'Expired');
  assert.equal(accountBadge({ invite_state: 'declined', account_status: 'declined' }).label, 'Declined');
  const suspended = accountBadge({ account_status: 'suspended', suspended_from: '2026-11-17T01:00:00Z', suspended_until: null });
  assert.equal(suspended.label, 'Suspended');
  assert.match(suspended.detail, /until restored$/);
  assert.equal(accountBadge({ account_status: 'active' }, { is_online: true }).label, 'Active');
  assert.equal(accountBadge({ account_status: 'active' }, {}).label, 'InActive');
  assert.equal(accountBadge({ account_status: 'inactive' }).label, 'Deactivated');
  assert.match(localDateTimeInput(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('password rules: at least 8 characters, a letter and a number; strength is only a hint', () => {
  assert.deepEqual(passwordChecks('abc').map((c) => c.ok), [false, true, false]);
  assert.match(passwordProblem('abcdefgh', 'abcdefgh'), /a number/);
  assert.match(passwordProblem('12345678', '12345678'), /a letter/);
  assert.match(passwordProblem('abc1', 'abc1'), /at least 8 characters/);
  assert.equal(passwordProblem('Sunshine8', 'Sunshine9'), 'The two passwords do not match.');
  assert.equal(passwordProblem('Sunshine8', 'Sunshine8'), '');
  assert.equal(passwordStrength(''), null);
  assert.equal(passwordStrength('abcdefg1'), 'weak');
  assert.equal(passwordStrength('Abcdefg1'), 'fair');
  assert.equal(passwordStrength('Abcdefghij12'), 'good');
  assert.equal(passwordStrength('Abcdefghij12!'), 'strong');
});

test('the setup link: invite or recovery from the Supabase redirect; expired and broken links', () => {
  assert.deepEqual(linkKind('#access_token=a&refresh_token=r&type=invite'), { kind: 'invite', accessToken: 'a', refreshToken: 'r' });
  assert.equal(linkKind('#access_token=a&refresh_token=r&type=recovery').kind, 'recovery');
  assert.deepEqual(linkKind('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'), { kind: 'error', expired: true });
  assert.deepEqual(linkKind(''), { kind: 'error', expired: false });
});
