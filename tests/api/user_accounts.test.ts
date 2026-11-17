// User Management: staff accounts (emailed invitation; the person sets their own password) and
// Franchisee accounts from applicants (temporary password, changed at first sign-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../support/harness.ts';
import { NEW_PASSWORD, signInInvited } from '../support/accounts.ts';
import { createAccount } from '../../supabase/functions/api/services/users.ts';

// Everything written to the console during these tests, to prove no password is ever logged.
const logged: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); original(...args); };
}

const ADMIN = 'admin@franchisetitan.local';
const { pg, call, login, auth, deps } = await setup();
const admin = await login(ADMIN);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);

const staff = (body: Record<string, unknown>) => call('POST', '/users', { token: admin, body: { email: `u${Math.random().toString(36).slice(2, 8)}@example.test`, role: 'sales', ...body } });
const firstError = (res: { json: any }) => Object.values(res.json?.errors ?? {}).flat()[0] as string;

test('staff account: valid names are accepted, including accented letters, period, hyphen and apostrophe', async () => {
  const created = await staff({ full_name: "  María  Ñ. Dela Cruz-O'Brien ", email: 'maria.staff@example.test', role: 'marketing' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.full_name, "María Ñ. Dela Cruz-O'Brien", 'extra spaces are tidied');
  assert.equal(created.json.data.role.name, 'marketing');
  assert.equal(created.json.data.phone, null, 'phone is optional');
  assert.equal(created.json.data.credentials.method, 'email_link');
  assert.equal(created.json.data.credentials.note, 'Invite email sent to maria.staff@example.test. They set their own password when they open the link.');
  assert.equal(created.json.data.account_status, 'invited', 'invited until the person accepts');
  
  for (const role of ['sales', 'logistics']) assert.equal((await staff({ full_name: 'Jose Rizal', role })).status, 201);
});

test('a name with digits or other symbols is refused', async () => {
  for (const name of ['Juan 2', 'Ana_Cruz', 'Pedro@Home', 'J', '...']) {
    const res = await staff({ full_name: name });
    assert.equal(res.status, 422, name);
    assert.match(firstError(res), /letters, spaces, period, hyphen and apostrophe only|required/);
  }
  assert.equal((await q(`select count(*)::int c from users where full_name = 'Juan 2'`))[0].c, 0);
});

test('phone is optional, and when given it must be exactly 11 digits', async () => {
  assert.equal((await staff({ full_name: 'No Phone', phone: '' })).status, 201);
  const ok = await staff({ full_name: 'With Phone', phone: '09171234567' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.data.phone, '09171234567');
  for (const phone of ['0917123456', '091712345678', '0917abc4567', '+639171234567']) {
    const res = await staff({ full_name: 'Bad Phone', phone });
    assert.equal(res.status, 422, phone);
    assert.match(firstError(res), /exactly 11 digits/);
  }
});

test('email is required, valid and unique', async () => {
  assert.ok((await call('POST', '/users', { token: admin, body: { full_name: 'No Email', role: 'sales' } })).json.errors.email);
  assert.ok((await staff({ full_name: 'Bad Email', email: 'not-an-email' })).json.errors.email);
  assert.match((await staff({ full_name: 'Taken Email', email: 'MARIA.STAFF@example.test' })).json.errors.email[0], /already been taken/);
});

test('another Admin needs an explicit confirmation; Franchisee is not created as a plain staff account', async () => {
  const asAdmin = await staff({ full_name: 'Would Be Admin', role: 'admin' });
  assert.equal(asAdmin.status, 422);
  assert.match(firstError(asAdmin), /You are creating another Admin with full access/);
  const confirmed = await staff({ full_name: 'Second Admin', email: 'second.admin@example.test', role: 'admin', confirm_admin: true });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
  assert.deepEqual([confirmed.json.data.role.name, confirmed.json.data.account_status], ['admin', 'invited']);
  const [log] = await q(`select new_values from audit_logs where action = 'user.created' and auditable_id = $1`, [confirmed.json.data.id]);
  assert.deepEqual([log.new_values.role, log.new_values.admin_confirmed], ['admin', true], 'audited as a confirmed Admin');
  const asFranchisee = await staff({ full_name: 'Would Be Franchisee', role: 'franchisee' });
  assert.equal(asFranchisee.status, 422);
  assert.match(firstError(asFranchisee), /created from an approved or active applicant/);
  assert.equal((await q(`select count(*)::int c from users where full_name like 'Would Be%'`))[0].c, 0);
});

test('staff invitation: the email is sent with the app link and the name; no password is created or shown', async () => {
  const email = 'Invited.Person@Example.test';
  const created = await staff({ full_name: 'Invited Person', email, redirect_to: 'https://app.example.test/reset-password' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.data.credentials, { method: 'email_link', sent_to: email.toLowerCase(), note: `Invite email sent to ${email.toLowerCase()}. They set their own password when they open the link.` });
  assert.equal(created.json.data.must_change_password, false);
  assert.ok(!JSON.stringify(created.json).includes('temporary_password'), 'no password in the response');
  const invite = auth.invites.at(-1)!;
  assert.deepEqual([invite.email, invite.redirectTo, invite.fullName], [email.toLowerCase(), 'https://app.example.test/reset-password', 'Invited Person']);
  const [row] = await q(`select auth_user_id from users where email = $1`, [email.toLowerCase()]);
  assert.equal(row.auth_user_id, invite.authUserId, 'the users row is linked to the invited sign-in');

  // Before the link is opened there is no password to sign in with.
  assert.equal((await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal: 'staff' } })).status, 422);
  // The link shows who it is for: the role and the email (the username).
  const link = await auth.openInviteLink(email.toLowerCase());
  const holder = await call('GET', '/auth/invite', { token: link });
  assert.equal(holder.status, 200, JSON.stringify(holder.json));
  assert.deepEqual([holder.json.data.kind, holder.json.data.email, holder.json.data.role.name, holder.json.data.invite_state], ['invite', email.toLowerCase(), 'sales', 'invited']);
  // A password set but not accepted yet still cannot sign in.
  await auth.acceptInvite(email.toLowerCase(), NEW_PASSWORD);
  const early = await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal: 'staff' } });
  assert.equal(early.status, 403);
  assert.match(early.json.message, /Finish setting up your account/);
  const token = await signInInvited(call, email);
  const [accepted] = await q(`select account_status, invite_accepted_at from users where email = $1`, [email.toLowerCase()]);
  assert.equal(accepted.account_status, 'active');
  assert.ok(accepted.invite_accepted_at);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.invite_accepted' and auditable_id = (select id from users where email = $1)`, [email.toLowerCase()]))[0].c, 1);
  assert.equal((await call('GET', '/applicants', { token })).status, 200, 'works straight away: no forced password change');

  const [log] = await q(`select new_values from audit_logs where action = 'user.created' and auditable_id = (select id from users where email = $1)`, [email.toLowerCase()]);
  assert.equal(log.new_values.credential_method, 'email_link');
});

test('staff invitation: the link must be an http(s) address; without one Supabase uses the Site URL', async () => {
  const bad = await staff({ full_name: 'Bad Link', redirect_to: 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.redirect_to[0], /http\(s\)/);
  const none = await staff({ full_name: 'No Link', email: 'no.link@example.test' });
  assert.equal(none.status, 201);
  assert.equal(auth.invites.at(-1)!.redirectTo, null);
});

test('a failed invitation creates no account and no sign-in', async () => {
  const email = 'invite.fails@example.test';
  auth.failNextInvite('Email rate limit exceeded');
  const res = await staff({ full_name: 'Invite Fails', email });
  assert.equal(res.status, 422);
  assert.match(res.json.errors.email[0], /The invitation email could not be sent: Email rate limit exceeded/);
  assert.equal((await q(`select count(*)::int c from users where email = $1`, [email]))[0].c, 0);
  assert.equal((await q(`select count(*)::int c from auth.users where email = $1`, [email]))[0].c, 0);
  assert.equal((await q(`select count(*)::int c from audit_logs a where a.action = 'user.created' and a.new_values->>'email' = $1`, [email]))[0].c, 0);
  assert.equal((await staff({ full_name: 'Invite Fails', email })).status, 201, 'the same address can be invited again');
});

test('when the database insert fails after the invitation, the invited sign-in is removed again', async () => {
  const email = 'db.fails@example.test';
  const c = { get: (key: string) => (key === 'deps' ? deps : undefined) } as any;
  await assert.rejects(createAccount(c, { role_id: 999999, full_name: 'Db Fails', email, account_status: 'active', must_change_password: false }, { invite: { fullName: 'Db Fails' } }));
  assert.equal(auth.invites.at(-1)!.email, email, 'the invitation was sent');
  assert.equal((await q(`select count(*)::int c from auth.users where email = $1`, [email]))[0].c, 0, 'no orphan sign-in');
  assert.equal((await q(`select count(*)::int c from users where email = $1`, [email]))[0].c, 0);
});

test('existing accounts are not affected', async () => {
  const [seed] = await q(`select bool_or(must_change_password) as any from users where email like '%@franchisetitan.local'`);
  assert.equal(seed.any, false);
  assert.equal((await call('GET', '/applicants', { token: admin })).status, 200);
});

test('Franchisee: candidates are Approved or Active Franchisee applicants without an account (Admin only)', async () => {
  const mk = async (name: string, status: string, userId: number | null = null) => (await q(
    `insert into applicants (full_name, email, phone, status, application_date, preferred_brand_id, user_id, applicant_code) values ($1, $2, '09170000555', $3, current_date, $4, $5, $6) returning id`,
    [name, `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`, status, brand.id, userId, `APL-UA-${name.replace(/\W+/g, '')}`],
  ))[0].id as number;
  const [someUser] = await q(`select id from users where email = 'maria.staff@example.test'`);
  const approved = await mk('Candidate Approved', 'approved');
  const active = await mk('Candidate Active', 'active_franchisee');
  await mk('Candidate Linked', 'active_franchisee', someUser.id);
  await mk('Candidate Payment', 'payment');
  await mk('Candidate Rejected', 'rejected');

  const list = await call('GET', '/users/franchisee-candidates', { token: admin });
  assert.equal(list.status, 200);
  const names = list.json.data.map((r: any) => r.full_name);
  assert.ok(names.includes('Candidate Approved') && names.includes('Candidate Active'));
  assert.ok(!names.some((n: string) => ['Candidate Linked', 'Candidate Payment', 'Candidate Rejected'].includes(n)), 'only approved/active without an account');
  const row = list.json.data.find((r: any) => r.id === active);
  assert.equal(row.email, 'candidate.active@example.test');
  assert.equal(row.preferred_brand.name, brand.name);
  assert.equal((await call('GET', '/users/franchisee-candidates', { token: await login('sales@franchisetitan.local') })).status, 403);

  // An approved applicant still has every activation gate: here the signed agreement is missing.
  const gated = await call('POST', `/applicants/${approved}/portal-user`, { token: admin, body: { email: 'gated.branch@example.test' } });
  assert.equal(gated.status, 422);
  assert.match(firstError(gated), /Signed franchise agreement/);
  assert.equal((await q(`select count(*)::int c from users where email = 'gated.branch@example.test'`))[0].c, 0, 'the refused account is removed');

  // Other stages, or an applicant that already has an account, are refused.
  const [payment] = await q(`select id from applicants where full_name = 'Candidate Payment'`);
  assert.equal((await call('POST', `/applicants/${payment.id}/portal-user`, { token: admin, body: { email: 'x1@example.test' } })).status, 422);
  const [linked] = await q(`select id from applicants where full_name = 'Candidate Linked'`);
  assert.equal((await call('POST', `/applicants/${linked.id}/portal-user`, { token: admin, body: { email: 'x2@example.test' } })).status, 422);
  assert.match(firstError(await call('POST', `/applicants/${active}/portal-user`, { token: admin, body: { email: 'x3@example.test', phone: '0917' } })), /exactly 11 digits/);

  // An active franchisee without an account gets an invitation; phone may be left empty.
  const created = await call('POST', `/applicants/${active}/portal-user`, { token: admin, body: { email: 'Candidate.Branch@Example.Test' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.role.name, 'franchisee');
  assert.equal(created.json.data.must_change_password, false);
  assert.deepEqual([created.json.data.account_status, created.json.data.credentials.method], ['invited', 'email_link']);
  assert.equal(created.json.message, 'Invite email sent to candidate.branch@example.test.');
  assert.equal((await q(`select phone from applicants where id = $1`, [active]))[0].phone, '09170000555', 'an empty phone keeps the applicant phone');
  assert.ok(!(await call('GET', '/users/franchisee-candidates', { token: admin })).json.data.some((r: any) => r.id === active), 'no longer a candidate');

  // Not usable until the franchisee accepts; then the branch portal works straight away.
  assert.equal((await call('POST', '/auth/login', { body: { email: 'candidate.branch@example.test', password: NEW_PASSWORD, portal: 'branch' } })).status, 422);
  const token = await signInInvited(call, 'candidate.branch@example.test', 'branch');
  assert.equal((await call('GET', '/branch/context', { token })).status, 200);

  const [log] = await q(`select user_id, new_values from audit_logs where action = 'user.created' and auditable_id = $1`, [created.json.data.id]);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(log.user_id), Number(adminRow.id), 'who created it');
  assert.equal(log.new_values.role, 'franchisee');
  assert.equal(log.new_values.credential_method, 'email_link');
  assert.equal(Number(log.new_values.applicant_id), active, 'the linked applicant');
});

test('Franchisee activation waits for the invite: Approved until accepted, then Active Franchisee with its branch', async () => {
  const [sales] = await q(`select id from users where email = 'sales@franchisetitan.local'`);
  const [a] = await q(
    `insert into applicants (full_name, email, phone, status, application_date, preferred_brand_id, applicant_code, approved_at, assigned_sales_user_id)
     values ('Waiting Franchisee', 'waiting.franchisee@example.test', '09170000666', 'approved', current_date, $1, 'APL-UA-WAIT', now(), $2) returning id`, [brand.id, sales.id],
  );
  // The signed agreement is the activation gate.
  await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_at, reviewed_at) values ($1, 'franchise_agreement', 'activation', 'accepted', '{}', now(), now())`, [a.id]);
  const invited = await call('POST', `/applicants/${a.id}/portal-user`, { token: admin, body: { email: 'waiting.franchisee@example.test' } });
  assert.equal(invited.status, 201, JSON.stringify(invited.json));
  const before = (await call('GET', `/applicants/${a.id}`, { token: admin })).json.data;
  assert.equal(before.status, 'approved', 'still Approved');
  assert.equal(before.user.account_status, 'invited', 'the UI shows "Approved – waiting for franchisee to accept invite"');
  assert.equal((await q(`select count(*)::int c from franchisees where applicant_id = $1`, [a.id]))[0].c, 0, 'no franchise yet');

  await signInInvited(call, 'waiting.franchisee@example.test', 'branch');
  const after = (await call('GET', `/applicants/${a.id}`, { token: admin })).json.data;
  assert.equal(after.status, 'active_franchisee');
  assert.equal(after.franchisee.locations.length, 1, 'the branch is provisioned');
  const [history] = await q(`select changed_by_user_id from applicant_status_histories where applicant_id = $1 and to_status = 'active_franchisee'`, [a.id]);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(history.changed_by_user_id), Number(adminRow.id), 'the inviting Admin is recorded as who activated it');
});

test('declining an invitation: the account cannot sign in, Admin sees Declined, and can resend', async () => {
  const email = 'decliner@example.test';
  assert.equal((await staff({ full_name: 'Decliner', email })).status, 201);
  const link = await auth.openInviteLink(email);
  const declined = await call('POST', '/auth/invite/decline', { token: link });
  assert.equal(declined.status, 200, JSON.stringify(declined.json));
  const [row] = await q(`select id, account_status, invite_declined_at from users where email = $1`, [email]);
  assert.equal(row.account_status, 'declined');
  assert.ok(row.invite_declined_at);
  assert.match((await call('POST', '/auth/invite/accept', { token: link })).json.errors.link[0], /declined/);
  const listed = (await call('GET', '/users?search=Decliner', { token: admin })).json.data[0];
  assert.equal(listed.invite_state, 'declined');
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.invite_declined' and auditable_id = $1`, [row.id]))[0].c, 1);

  const resent = await call('POST', `/users/${row.id}/resend-invite`, { token: admin });
  assert.equal(resent.status, 200, JSON.stringify(resent.json));
  assert.equal(resent.json.message, `Invite email sent to ${email}.`);
  assert.equal(resent.json.data.account_status, 'invited');
  assert.equal(auth.invites.filter((i) => i.email === email).length, 2, 'a fresh invitation was emailed');
  await signInInvited(call, email);
});

test('an expired or invalid link: a friendly message; Admin sees Expired and can resend', async () => {
  const bad = await call('POST', '/auth/invite/accept', { token: 'not-a-real-link' });
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.link[0], /expired or was already used\. Ask your Admin to resend the invite/);
  const email = 'late.person@example.test';
  const created = await staff({ full_name: 'Late Person', email });
  await q(`update users set invited_at = now() - interval '2 days' where email = $1`, [email]);
  assert.equal((await call('GET', '/users?search=Late', { token: admin })).json.data[0].invite_state, 'expired');
  assert.equal((await call('POST', `/users/${created.json.data.id}/resend-invite`, { token: admin })).status, 200);
  assert.equal((await call('GET', '/users?search=Late', { token: admin })).json.data[0].invite_state, 'invited');
  // An accepted account cannot get another invitation.
  const [active] = await q(`select id from users where email = 'maria.staff@example.test'`);
  await signInInvited(call, 'maria.staff@example.test');
  assert.match(firstError(await call('POST', `/users/${active.id}/resend-invite`, { token: admin })), /not accepted yet/);
});

test('account creation is audited with who and which role', async () => {
  const [log] = await q(`select a.user_id, a.new_values from audit_logs a join users u on u.id = a.auditable_id where a.action = 'user.created' and u.email = 'maria.staff@example.test'`);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(log.user_id), Number(adminRow.id));
  assert.equal(log.new_values.role, 'marketing');
  assert.equal(log.new_values.credential_method, 'email_link');
});

test('no password anywhere: no response, table or log carries a password or a temporary password', async () => {
  const [branchUser] = await q(`select id from users where email = 'candidate.branch@example.test'`);
  const later = [
    await call('GET', `/users/${branchUser.id}`, { token: admin }),
    await call('GET', '/users', { token: admin }),
    await call('GET', '/users?search=Candidate', { token: admin }),
    await call('GET', '/audit-logs', { token: admin }),
  ];
  for (const res of later) {
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json);
    assert.ok(!text.includes('temporary_password') && !text.includes('"credentials"'), 'no credentials field after creation');
    assert.ok(!text.includes(NEW_PASSWORD), 'the chosen password is not in any response');
  }
  for (const table of ['audit_logs', 'users', 'system_notifications', 'applicant_stage_histories', 'franchisees', 'applicants']) {
    const dump = JSON.stringify(await q(`select * from ${table}`));
    assert.ok(!dump.includes(NEW_PASSWORD) && !dump.includes('temporary_password'), `no password stored in ${table}`);
  }
  const consoleText = logged.join('\n');
  assert.ok(!consoleText.includes(NEW_PASSWORD), 'not written to any log');
  // Passwords are never set through the API either.
  const [someone] = await q(`select id from users where email = 'maria.staff@example.test'`);
  assert.match(firstError(await call('PUT', `/users/${someone.id}`, { token: admin, body: { password: 'Abcdefg1', password_confirmation: 'Abcdefg1' } })), /set by the person from their email link/);
});