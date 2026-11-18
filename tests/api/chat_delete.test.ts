// Chat message delete: "delete for everyone" (sender only; the text stays stored but is never returned) and
// "delete for me" (any member; the others still see it). Non-members are refused. Every delete is audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);

// A direct conversation between Admin and Sales (Marketing is not a member).
const direct = await call('POST', '/chat/direct', { token: admin, body: { recipient_id: Number(salesUser.id) } });
const channelId = direct.json.data.id;
const send = async (token: string, text: string) => (await call('POST', `/chat/channels/${channelId}/messages`, { token, body: { message: text } })).json.data;
const messages = async (token: string, query = '') => (await call('GET', `/chat/channels/${channelId}/messages${query}`, { token })).json.data;
const del = (token: string, id: number, scope?: string) => call('DELETE', `/chat/channels/${channelId}/messages/${id}${scope ? `?scope=${scope}` : ''}`, { token });
const audits = (action: string, id: number) => q(`select user_id, new_values from audit_logs where action = $1 and auditable_id = $2`, [action, id]);

test('delete for everyone: sender only; everyone sees "This message was deleted"; the text stays stored; audited', async () => {
  const msg = await send(admin, 'Secret pricing for the north branch');
  assert.equal((await del(sales, msg.id, 'everyone')).status, 403, 'not the sender');
  assert.equal((await del(admin, msg.id)).status, 422, 'the scope is required');
  const res = await del(admin, msg.id, 'everyone');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.scope, 'everyone');
  for (const token of [admin, sales]) {
    const seen = (await messages(token)).messages.find((m: any) => m.id === msg.id);
    assert.equal(seen.message, 'This message was deleted');
    assert.ok(seen.deleted_at);
  }
  const [stored] = await q(`select message, deleted_at from chat_messages where id = $1`, [msg.id]);
  assert.equal(stored.message, 'Secret pricing for the north branch', 'kept for the record');
  const [log] = await audits('chat.message_deleted_for_everyone', msg.id);
  assert.equal(Number(log.user_id), Number(adminUser.id));
  assert.deepEqual(log.new_values, { channel_id: channelId, scope: 'everyone' });
  assert.ok(!JSON.stringify(log).includes('Secret pricing'), 'the audit entry does not copy the text');
  assert.equal((await del(admin, msg.id, 'everyone')).status, 200, 'deleting again is harmless');
  assert.equal((await audits('chat.message_deleted_for_everyone', msg.id)).length, 1, 'audited once');
});

test('delete for me: any member; hidden only for them, the other person still sees it; audited', async () => {
  const theirs = await send(admin, 'See you at the orientation');
  const res = await del(sales, theirs.id, 'me');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(!(await messages(sales)).messages.some((m: any) => m.id === theirs.id), 'gone for Sales');
  assert.equal((await messages(admin)).messages.find((m: any) => m.id === theirs.id).message, 'See you at the orientation', 'Admin still sees it');
  assert.equal((await audits('chat.message_deleted_for_me', theirs.id)).length, 1);
  // The sender may also delete their own message just for themselves.
  const mine = await send(sales, 'Typo message');
  assert.equal((await del(sales, mine.id, 'me')).status, 200);
  assert.ok(!(await messages(sales)).messages.some((m: any) => m.id === mine.id));
  assert.equal((await messages(admin)).messages.find((m: any) => m.id === mine.id).message, 'Typo message');
  // The conversation list preview skips messages hidden for you.
  const last = await send(admin, 'Last line');
  await del(sales, last.id, 'me');
  const preview = ((await call('GET', '/chat/channels', { token: sales })).json.data as any[]).find((ch) => ch.id === channelId).last_message;
  assert.notEqual(preview?.id, last.id);
});

test('non-members are refused; messages of another channel cannot be deleted through this one', async () => {
  const msg = await send(admin, 'Members only');
  assert.equal((await del(marketing, msg.id, 'me')).status, 403);
  assert.equal((await del(marketing, msg.id, 'everyone')).status, 403);
  assert.equal((await call('GET', `/chat/channels/${channelId}/messages`, { token: marketing })).status, 403);
  const [dept] = await q(`select id from chat_channels where type = 'department' order by id limit 1`);
  if (dept) assert.equal((await call('DELETE', `/chat/channels/${dept.id}/messages/${msg.id}?scope=me`, { token: admin })).status, 404, 'wrong channel');
});

test('the deleted text is never returned: messages, polling (with deleted_ids), the channel list', async () => {
  const msg = await send(sales, 'Do not show this text again');
  const sinceId = msg.id;
  await send(sales, 'A later message');
  await del(sales, msg.id, 'everyone');
  const poll = await messages(admin, `?since_id=${sinceId}`);
  assert.ok(poll.deleted_ids.includes(msg.id), 'an open conversation learns about the delete');
  const responses = [
    await call('GET', `/chat/channels/${channelId}/messages`, { token: admin }),
    await call('GET', `/chat/channels/${channelId}/messages`, { token: sales }),
    await call('GET', `/chat/channels/${channelId}/messages?since_id=${sinceId - 1}`, { token: admin }),
    await call('GET', '/chat/channels', { token: admin }),
    await call('GET', '/chat/channels', { token: sales }),
  ];
  for (const res of responses) assert.ok(!JSON.stringify(res.json).includes('Do not show this text again'));
  // Unread counts still work (the deleted message counts like any other until read).
  const heartbeat = await call('POST', '/chat/heartbeat', { token: admin });
  assert.equal(heartbeat.status, 200);
  assert.equal(typeof heartbeat.json.data.total_unread, 'number');
});
