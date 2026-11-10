// User Management: staff accounts, Franchisee accounts from applicants, temporary passwords
// and the forced change at first sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../support/harness.ts';
import { firstSignIn, NEW_PASSWORD } from '../support/accounts.ts';

// Everything written to the console during these tests, to prove no password is ever logged.
const logged: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); original(...args); };
}

const ADMIN = 'admin@franchisetitan.local';
const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);
const issued: string[] = [];

const staff = (body: Record<string, unknown>) => call('POST', '/users', { token: admin, body: { email: `u${Math.random().toString(36).slice(2, 8)}@example.test`, role: 'sales', ...body } });
const firstError = (res: { json: any }) => Object.values(res.json?.errors ?? {}).flat()[0] as string;

test('staff account: valid names are accepted, including accented letters, period, hyphen and apostrophe', async () => {
  const created = await staff({ full_name: "  María  Ñ. Dela Cruz-O'Brien ", email: 'maria.staff@example.test', role: 'marketing' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.full_name, "María Ñ. Dela Cruz-O'Brien", 'extra spaces are tidied');
  assert.equal(created.json.data.role.name, 'marketing');
  assert.equal(created.json.data.must_change_password, true);
  assert.equal(created.json.data.phone, null, 'phone is optional');
  assert.equal(created.json.data.credentials.method, 'temporary_password');
  assert.equal(created.json.data.credentials.note, 'Share it privately. The user must change it at first sign-in.');
  const temp = created.json.data.credentials.temporary_password as string;
  issued.push(temp);
  assert.match(temp, /^.{14}$/);
  assert.ok(/[A-Z]/.test(temp) && /[a-z]/.test(temp) && /[0-9]/.test(temp) && /[^A-Za-z0-9]/.test(temp), 'strong: upper, lower, digit and symbol');
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

test('the Admin role cannot be created, and Franchisee is not created as a plain staff account', async () => {
  const asAdmin = await staff({ full_name: 'Would Be Admin', role: 'admin' });
  assert.equal(asAdmin.status, 422);
  assert.match(firstError(asAdmin), /Admin account cannot be created/);
  const asFranchisee = await staff({ full_name: 'Would Be Franchisee', role: 'franchisee' });
  assert.equal(asFranchisee.status, 422);
  assert.match(firstError(asFranchisee), /created from an approved or active applicant/);
  assert.equal((await q(`select count(*)::int c from users where full_name like 'Would Be%'`))[0].c, 0);
});

test('the temporary password works only until it is changed, and the first sign-in requires a change', async () => {
  const email = 'first.signin@example.test';
  const created = await staff({ full_name: 'First Signin', email });
  const temp = created.json.data.credentials.temporary_password as string;
  issued.push(temp);

  const session = await call('POST', '/auth/login', { body: { email, password: temp, portal: 'staff' } });
  assert.equal(session.status, 200);
  assert.equal(session.json.data.user.must_change_password, true, 'the sign-in tells the app to ask for a new password');
  const token = session.json.data.token as string;

  // Until the change, only "who am I", the change itself and sign-out work — enforced by the API.
  assert.equal((await call('GET', '/auth/me', { token })).status, 200);
  for (const [method, path] of [['GET', '/applicants'], ['GET', '/inquiries'], ['GET', '/notifications'], ['GET', '/activities'], ['GET', '/analytics/overview']]) {
    const res = await call(method, path, { token });
    assert.equal(res.status, 403, path);
    assert.equal(res.json.code, 'password_change_required');
  }

  const tooShort = await call('POST', '/auth/first-password', { token, body: { password: 'Ab1!', password_confirmation: 'Ab1!' } });
  assert.equal(tooShort.status, 422);
  const tooLong = await call('POST', '/auth/first-password', { token, body: { password: 'Abcdefgh1234567!', password_confirmation: 'Abcdefgh1234567!' } });
  assert.equal(tooLong.status, 422, '16 characters is too long');
  const mismatch = await call('POST', '/auth/first-password', { token, body: { password: NEW_PASSWORD, password_confirmation: 'Different1!' } });
  assert.equal(mismatch.status, 422);
  const reuse = await call('POST', '/auth/first-password', { token, body: { password: temp, password_confirmation: temp } });
  assert.match(firstError(reuse), /not the temporary one/);

  const changed = await call('POST', '/auth/first-password', { token, body: { password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.must_change_password, false);
  assert.equal((await call('GET', '/applicants', { token })).status, 200, 'the same session now works');
  assert.equal((await call('POST', '/auth/first-password', { token, body: { password: 'Another1!', password_confirmation: 'Another1!' } })).status, 422, 'only once');

  const old = await call('POST', '/auth/login', { body: { email, password: temp, portal: 'staff' } });
  assert.equal(old.status, 422, 'the temporary password no longer works');
  const fresh = await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal: 'staff' } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.json.data.user.must_change_password, false);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'auth.first_password_set'`))[0].c, 1);
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

  // An active franchisee without an account gets one; phone may be left empty.
  const created = await call('POST', `/applicants/${active}/portal-user`, { token: admin, body: { email: 'Candidate.Branch@Example.Test' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.role.name, 'franchisee');
  assert.equal(created.json.data.must_change_password, true);
  const temp = created.json.data.credentials.temporary_password as string;
  issued.push(temp);
  assert.equal((await q(`select phone from applicants where id = $1`, [active]))[0].phone, '09170000555', 'an empty phone keeps the applicant phone');
  assert.ok(!(await call('GET', '/users/franchisee-candidates', { token: admin })).json.data.some((r: any) => r.id === active), 'no longer a candidate');

  // The branch account must also change its password first.
  const branch = await call('POST', '/auth/login', { body: { email: 'candidate.branch@example.test', password: temp, portal: 'branch' } });
  assert.equal(branch.status, 200);
  assert.equal((await call('GET', '/branch/context', { token: branch.json.data.token })).status, 403);
  const token = await firstSignIn(call, 'candidate.branch@example.test', temp, 'branch');
  assert.equal((await call('GET', '/branch/context', { token })).status, 200);

  const [log] = await q(`select user_id, new_values from audit_logs where action = 'user.created' and auditable_id = $1`, [created.json.data.id]);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(log.user_id), Number(adminRow.id), 'who created it');
  assert.equal(log.new_values.role, 'franchisee');
  assert.equal(Number(log.new_values.applicant_id), active, 'the linked applicant');
});

test('account creation is audited with who and which role', async () => {
  const [log] = await q(`select a.user_id, a.new_values from audit_logs a join users u on u.id = a.auditable_id where a.action = 'user.created' and u.email = 'maria.staff@example.test'`);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(log.user_id), Number(adminRow.id));
  assert.equal(log.new_values.role, 'marketing');
  assert.equal(log.new_values.credential_method, 'temporary_password');
});

test('a temporary password is returned once and never appears in a later response, the database or any log', async () => {
  const created = await staff({ full_name: 'Shown Once', email: 'shown.once@example.test' });
  const temp = created.json.data.credentials.temporary_password as string;
  issued.push(temp);
  const id = created.json.data.id;
  const later = [
    await call('GET', `/users/${id}`, { token: admin }),
    await call('GET', '/users', { token: admin, body: undefined }),
    await call('GET', `/users?search=Shown`, { token: admin }),
    await call('GET', '/audit-logs', { token: admin }),
  ];
  for (const res of later) {
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json);
    assert.ok(!text.includes('"temporary_password":') && !text.includes('"credentials"'), 'no credentials field after creation');
    for (const secret of issued) assert.ok(!text.includes(secret), 'the password is not in a later response');
  }
  const session = await call('POST', '/auth/login', { body: { email: 'shown.once@example.test', password: temp, portal: 'staff' } });
  const me = await call('GET', '/auth/me', { token: session.json.data.token });
  for (const secret of issued) assert.ok(!JSON.stringify([session.json, me.json]).includes(secret));

  const tables = ['audit_logs', 'users', 'system_notifications', 'applicant_stage_histories', 'franchisees', 'applicants'];
  for (const table of tables) {
    const dump = JSON.stringify(await q(`select * from ${table}`));
    for (const secret of issued) assert.ok(!dump.includes(secret), `not stored in ${table}`);
  }
  const consoleText = logged.join('\n');
  for (const secret of issued) assert.ok(!consoleText.includes(secret), 'not written to any log');
  assert.ok(issued.length >= 4);
});
