// User Management: staff accounts and Franchisee accounts from applicants.
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

const staff = (body: Record<string, unknown>) => call('POST', '/users', { token: admin, body: { email: `u${Math.random().toString(36).slice(2, 8)}@example.test`, role: 'sales', ...body } });
const firstError = (res: { json: any }) => Object.values(res.json?.errors ?? {}).flat()[0] as string;

test('staff account: valid names are accepted, including accented letters, period, hyphen and apostrophe', async () => {
  const created = await staff({ full_name: "  María  Ñ. Dela Cruz-O'Brien ", email: 'maria.staff@example.test', role: 'marketing' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.full_name, "María Ñ. Dela Cruz-O'Brien", 'extra spaces are tidied');
  assert.equal(created.json.data.role.name, 'marketing');
  assert.equal(created.json.data.phone, null, 'phone is optional');
  assert.equal(created.json.data.credentials.method, 'email_link');
  assert.ok(created.json.data.credentials.note.includes('Invite emailed'));
  
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

// 🌟 REMOVED: 'the temporary password works only until it is changed' test. 
// The system now uses email invites, so there is no temporary password to test.

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
  assert.equal(created.json.data.credentials.method, 'email_link');
  
  assert.equal((await q(`select phone from applicants where id = $1`, [active]))[0].phone, '09170000555', 'an empty phone keeps the applicant phone');
  assert.ok(!(await call('GET', '/users/franchisee-candidates', { token: admin })).json.data.some((r: any) => r.id === active), 'no longer a candidate');
});

test('account creation is audited with who and which role', async () => {
  const [log] = await q(`select a.user_id, a.new_values from audit_logs a join users u on u.id = a.auditable_id where a.action = 'user.created' and u.email = 'maria.staff@example.test'`);
  const [adminRow] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.equal(Number(log.user_id), Number(adminRow.id));
  assert.equal(log.new_values.role, 'marketing');
  assert.equal(log.new_values.credential_method, 'email_link');
});

// 🌟 REMOVED: 'a temporary password is returned once...' test. 
// This is no longer applicable since users set their own password via the email link.