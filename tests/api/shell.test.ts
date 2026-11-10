import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../supabase/functions/api/app.ts';
import { createTestPg, pgliteDb } from '../support/testDb.ts';
import { fakeAuth, linkSeedUsers } from '../support/fakeAuth.ts';
import { memoryFiles } from '../support/harness.ts';
import { firstSignIn } from '../support/accounts.ts';

const PASSWORD = 'test-only-password';
const pg = await createTestPg();
const db = pgliteDb(pg);
const auth = fakeAuth(db);
await linkSeedUsers(db, auth, PASSWORD);
const app = createApp({ db, auth, files: memoryFiles(), costingEnabled: false });

async function call(method: string, path: string, { token, body, ip }: { token?: string; body?: unknown; ip?: string } = {}) {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() as any };
}

async function login(email: string, portal = 'staff', password = PASSWORD) {
  return call('POST', '/auth/login', { body: { email, password, portal, session_key: 'tab-1' }, ip: `10.0.0.${Math.floor(Math.random() * 200)}` });
}
const tokenFor = async (email: string, portal = 'staff') => (await login(email, portal)).json.data.token as string;
const ADMIN = 'admin@franchisetitan.local';

test('health is public and reports the database', async () => {
  const { status, json } = await call('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.database, 'ok');
});

test('login returns a session and never exposes the auth link', async () => {
  const { status, json } = await login(ADMIN);
  assert.equal(status, 200);
  assert.ok(json.data.token && json.data.refresh_token);
  assert.equal(json.data.user.role.name, 'admin');
  assert.ok(!('auth_user_id' in json.data.user));
});

test('wrong password uses the same generic message, and only failures lock', async () => {
  const body = { email: 'sales@franchisetitan.local', password: 'wrong', portal: 'staff' };
  const ip = '10.9.9.9';
  for (let i = 0; i < 5; i++) {
    const { status, json } = await call('POST', '/auth/login', { body, ip });
    assert.equal(status, 422);
    assert.equal(json.errors.email[0], 'The supplied credentials are incorrect.');
  }
  const locked = await call('POST', '/auth/login', { body, ip });
  assert.match(locked.json.errors.email[0], /Too many failed sign-in attempts/);
  // A different network is not affected by that lock.
  assert.equal((await login('sales@franchisetitan.local')).status, 200);
});

test('portals refuse the wrong role and leave no live session behind', async () => {
  const before = (await pg.query(`select count(*)::int c from auth.sessions`)).rows[0] as any;
  const { status, json } = await login(ADMIN, 'branch');
  assert.equal(status, 403);
  assert.match(json.message, /branch accounts only/);
  const after = (await pg.query(`select count(*)::int c from auth.sessions`)).rows[0] as any;
  assert.equal(after.c, before.c);
});

test('protected routes need a token, and logout kills it immediately', async () => {
  assert.equal((await call('GET', '/auth/me')).status, 401);
  assert.equal((await call('GET', '/auth/me', { token: 'garbage' })).status, 401);
  const token = await tokenFor(ADMIN);
  const me = await call('GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.email, ADMIN);
  assert.equal(me.json.data.presence.is_online, true);
  assert.deepEqual(me.json.data.features, { costing: false, payment_advanced: false }, 'both features are off unless configured');
  assert.equal((await call('POST', '/auth/logout', { token })).status, 200);
  assert.equal((await call('GET', '/auth/me', { token })).status, 401);
});

test('role gates match Laravel', async () => {
  const sales = await tokenFor('sales@franchisetitan.local');
  const denied = await call('GET', '/users', { token: sales });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.message, 'You do not have permission to perform this action.');
  assert.equal((await call('POST', '/brands', { token: sales, body: { name: 'X', code: 'X' } })).status, 403);
  assert.equal((await call('GET', '/brands', { token: sales })).status, 200);
});

test('admin creates a user who can sign in with a USR code, then blocks them', async () => {
  const admin = await tokenFor(ADMIN);
  const invalid = await call('POST', '/users', { token: admin, body: { full_name: 'Ana Cruz', email: 'nope', role: 'sales' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.message, 'The submitted data is invalid.');
  assert.ok(invalid.json.errors.email);
  assert.ok((await call('POST', '/users', { token: admin, body: { full_name: 'Ana Cruz', email: 'ana@example.com', role: 'admin' } })).json.errors.role);

  const email = 'New.Person@Example.com';
  const created = await call('POST', '/users', { token: admin, body: { full_name: 'New Person', email, phone: '09171234567', role: 'sales' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.email, email.toLowerCase());
  assert.match(created.json.data.user_code, /^USR-\d{4}-\d{5}$/);

  const duplicate = await call('POST', '/users', { token: admin, body: { full_name: 'Dup', email: email.toUpperCase(), phone: '09171234567', role: 'sales' } });
  assert.equal(duplicate.json.errors.email[0], 'The email has already been taken.', 'uniqueness stays case-insensitive as in MySQL');

  const userToken = await firstSignIn(call, email, created.json.data.credentials.temporary_password);

  const blocked = await call('PUT', `/users/${created.json.data.id}`, { token: admin, body: { account_status: 'inactive' } });
  assert.equal(blocked.status, 200);
  assert.equal((await call('GET', '/auth/me', { token: userToken })).status, 401, 'block is immediate');
  const retry = await call('POST', '/auth/login', { body: { email, password: 'Passw0rd!', portal: 'staff' } });
  assert.equal(retry.status, 403);
  assert.match(retry.json.message, /inactive/);
});

test('an admin cannot change their own row, and suspensions lift by themselves', async () => {
  const admin = await tokenFor(ADMIN);
  const me = await call('GET', '/auth/me', { token: admin });
  const self = await call('PUT', `/users/${me.json.data.id}`, { token: admin, body: { account_status: 'inactive' } });
  assert.match(self.json.errors.user[0], /cannot change your own account/);

  const logistics = 'logistics@franchisetitan.local';
  await pg.query(`update users set account_status = 'suspended', suspended_until = '2020-01-01' where email = $1`, [logistics]);
  assert.equal((await login(logistics)).status, 200, 'expired suspension restores the account');
  await pg.query(`update users set account_status = 'suspended', suspended_until = '2999-12-31' where email = $1`, [logistics]);
  const refused = await login(logistics);
  assert.equal(refused.status, 403);
  assert.match(refused.json.message, /suspended until Dec 31, 2999/);
  await pg.query(`update users set account_status = 'active', suspended_until = null where email = $1`, [logistics]);
});

test('user search is case-insensitive and rows carry presence', async () => {
  const admin = await tokenFor(ADMIN);
  const { json } = await call('GET', '/users?search=ADMINISTRATOR', { token: admin });
  assert.equal(json.data.length, 1);
  assert.ok(json.data[0].presence);
  assert.ok(!('auth_user_id' in json.data[0]));
  assert.deepEqual(Object.keys(json.meta).sort(), ['current_page', 'last_page', 'per_page', 'total']);
});

test('ids are numbers and decimals stay exact', async () => {
  const admin = await tokenFor(ADMIN);
  const { json } = await call('GET', '/brands', { token: admin });
  assert.equal(typeof json.data[0].id, 'number');
  assert.equal(typeof json.data[0].products_count, 'number');
  const product = await call('POST', '/products', { token: admin, body: { sku: 'SKU-1', name: 'Syrup', unit: 'bottle' } });
  assert.equal(product.status, 201);
  assert.equal(product.json.data.is_active, true);
  assert.equal((await call('GET', '/products?search=syrup', { token: admin })).json.data.length, 1);
});

test('unit and category rules', async () => {
  const admin = await tokenFor(ADMIN);
  assert.match((await call('POST', '/units', { token: admin, body: { name: 'bad unit 1' } })).json.errors.name[0], /letters only/);
  assert.equal((await call('POST', '/units', { token: admin, body: { name: 'Crate' } })).status, 201);
  assert.match((await call('POST', '/units', { token: admin, body: { name: 'CRATE' } })).json.errors.name[0], /already exists/);
  const brands = (await call('GET', '/brands', { token: admin })).json.data;
  const cat = await call('POST', '/product-categories', { token: admin, body: { brand_id: brands[0].id, name: 'Syrup / Extra' } });
  assert.equal(cat.status, 201);
  assert.equal((await call('DELETE', `/product-categories/${cat.json.data.id}`, { token: admin })).status, 200);
});

test('notifications are private to their owner', async () => {
  const admin = await tokenFor(ADMIN);
  const me = (await call('GET', '/auth/me', { token: admin })).json.data;
  const [row] = (await pg.query(
    `insert into system_notifications (user_id, type, title, message, data) values ($1, 't', 'T', 'M', '{"applicant_id": 7}') returning id`, [me.id],
  )).rows as any[];
  const sales = await tokenFor('sales@franchisetitan.local');
  assert.equal((await call('PATCH', `/notifications/${row.id}/read`, { token: sales })).status, 404);
  assert.equal((await call('GET', '/notifications', { token: sales })).json.data.length, 0);
  const seen = await call('POST', '/notifications/mark-seen', { token: admin, body: { record_type: 'applicant', record_id: 7 } });
  assert.equal(seen.json.data.marked, 1);
});

test('chat: direct messages are private, and fetching does not mark as read', async () => {
  const admin = await tokenFor(ADMIN);
  const sales = await tokenFor('sales@franchisetitan.local');
  const logistics = await tokenFor('logistics@franchisetitan.local');
  const directory = (await call('GET', '/chat/directory', { token: admin })).json.data;
  const salesUser = directory.find((u: any) => u.email === 'sales@franchisetitan.local');
  assert.ok(!('auth_user_id' in salesUser));

  const dm = (await call('POST', '/chat/direct', { token: admin, body: { recipient_id: salesUser.id } })).json.data;
  const sent = await call('POST', `/chat/channels/${dm.id}/messages`, { token: admin, body: { message: '  hello  ' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.data.message, 'hello');
  assert.ok(!('auth_user_id' in sent.json.data.user));
  assert.equal(sent.json.data.user.role.name, 'admin');

  assert.equal((await call('GET', `/chat/channels/${dm.id}/messages`, { token: logistics })).status, 403);

  const unread = async () => (await call('GET', '/chat/channels', { token: sales })).json.data.find((x: any) => x.id === dm.id).unread_count;
  assert.equal(await unread(), 1);
  await call('GET', `/chat/channels/${dm.id}/messages`, { token: sales });
  assert.equal(await unread(), 1);
  await call('GET', `/chat/channels/${dm.id}/messages?mark_read=1`, { token: sales });
  assert.equal(await unread(), 0);
});

test('pipeline config, sync status and unknown routes', async () => {
  const sales = await tokenFor('sales@franchisetitan.local');
  const config = (await call('GET', '/pipeline-config', { token: sales })).json.data;
  assert.equal(config.permissions['inquiries.view'], true);
  assert.equal(config.permissions['users.manage'], undefined);
  assert.equal(config.permissions['applicants.approve'], false);
  assert.equal((await call('GET', '/sync-status', { token: sales })).status, 200);
  assert.equal((await call('GET', '/inventories', { token: sales })).status, 403);
  assert.equal((await call('GET', '/inventories')).status, 401);
  assert.equal((await call('GET', '/no-such-route', { token: sales })).status, 404);
});
