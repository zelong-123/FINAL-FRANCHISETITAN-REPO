// Runs the production postgres.js adapter over a real Postgres socket, because every other
// test uses PGlite's own driver and could not catch a decoding or transaction bug in it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { postgresDb } from '../../supabase/functions/api/lib/db.ts';
import { insertRow, updateRow } from '../../supabase/functions/api/lib/http.ts';
import { stripCosting } from '../../supabase/functions/api/lib/middleware.ts';
import { createTestPg } from '../support/testDb.ts';

const pg = await createTestPg();
const PORT = 54329;
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: '127.0.0.1' });
await server.start();
const db = postgresDb(postgres, `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`, { max: 1 });
after(async () => { await db.close?.(); await server.stop(); });

test('decodes values the way the frontend expects', async () => {
  const [row] = await db.query(`select 7::bigint as id, 12.50::numeric(14,2) as amount, '2026-11-07'::date as day,
    '2026-11-07 12:00:00+08'::timestamptz as at, true as flag, '{"a":1}'::jsonb as data, null::text as nothing`);
  assert.strictEqual(row.id, 7);
  assert.strictEqual(row.amount, '12.50');
  assert.strictEqual(row.day, '2026-11-07');
  assert.ok(row.at instanceof Date);
  assert.strictEqual(row.at.toISOString(), '2026-11-07T04:00:00.000Z');
  assert.strictEqual(row.flag, true);
  assert.deepStrictEqual(row.data, { a: 1 });
  assert.strictEqual(row.nothing, null);
});

test('binds parameters of every type the routes send', async () => {
  const brand = await insertRow(db, 'brands', { code: 'ADAPTER', name: "O'Brien; drop table brands", is_active: true });
  assert.strictEqual(brand.name, "O'Brien; drop table brands");
  const saved = await updateRow(db, 'brands', brand.id, { is_active: false, description: null });
  assert.strictEqual(saved.is_active, false);
  const [found] = await db.query(`select id from users where id = any($1::bigint[])`, ['{1,2}']);
  assert.strictEqual(found.id, 1);
  const n = await insertRow(db, 'system_notifications', { user_id: 1, type: 't', title: 'T', message: 'M', data: { applicant_id: 9 } });
  assert.deepStrictEqual(n.data, { applicant_id: 9 });
  // What the audit trail and mark-seen rely on: a JSON object in the column, not a string.
  const [stored] = await db.query(`select jsonb_typeof(data) as kind, (data ->> 'applicant_id')::int as id from system_notifications where id = $1`, [n.id]);
  assert.deepStrictEqual(stored, { kind: 'object', id: 9 });
  const [viaText] = await db.query(`insert into audit_logs (action, new_values, created_at) values ('t', $1, now()) returning jsonb_typeof(new_values) as kind`, [JSON.stringify({ a: 1 })]);
  assert.strictEqual(viaText.kind, 'object');
});

test('transactions commit, and roll back everything on failure', async () => {
  await db.tx(async (tx) => { await tx.query(`insert into brands (code, name) values ('TX_OK', 'Tx ok')`); });
  assert.equal((await db.query(`select 1 from brands where code = 'TX_OK'`)).length, 1);
  await assert.rejects(db.tx(async (tx) => {
    await tx.query(`insert into brands (code, name) values ('TX_BAD', 'Tx bad')`);
    await tx.query(`select * from table_that_does_not_exist`);
  }));
  assert.equal((await db.query(`select 1 from brands where code = 'TX_BAD'`)).length, 0);
});

test('costing fields are stripped at any depth, and payment amounts are kept', () => {
  const clean = stripCosting({ data: [{ id: 1, unit_cost: 5, amount: '10.00', nested: { profit_cents: 3, name: 'x' } }] });
  assert.deepStrictEqual(clean, { data: [{ id: 1, amount: '10.00', nested: { name: 'x' } }] });
});
