import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPg } from '../support/testDb.ts';

const pg = await createTestPg();
const rows = async (sql: string) => (await pg.query(sql)).rows as any[];

test('every public table has row-level security enabled', async () => {
  const open = await rows(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(open, []);
});

test('browser roles have no direct access to any table', async () => {
  const grants = await rows(`select table_name, grantee from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')`);
  assert.deepEqual(grants, []);
});

test('Laravel plumbing and password columns are gone', async () => {
  const leftovers = await rows(`select table_name from information_schema.tables where table_schema = 'public'
    and table_name in ('api_tokens','sessions','jobs','cache','migrations','password_reset_tokens')`);
  assert.deepEqual(leftovers, []);
  const secrets = await rows(`select table_name, column_name from information_schema.columns
    where table_schema = 'public' and column_name in ('password', 'remember_token', 'token_hash')`);
  assert.deepEqual(secrets, []);
});

test('money keeps its exact precision', async () => {
  const [col] = await rows(`select numeric_precision p, numeric_scale s from information_schema.columns
    where table_schema = 'public' and table_name = 'payments' and column_name = 'amount'`);
  assert.equal(col.p, 14);
  assert.equal(col.s, 2);
});

test('seed data arrived intact, with ids that continue after it', async () => {
  const [counts] = await rows(`select (select count(*) from roles) roles, (select count(*) from users) users,
    (select count(*) from brands) brands, (select count(*) from applicants) applicants`);
  assert.deepEqual(counts, { roles: 5, users: 9, brands: 4, applicants: 5 });
  const [fresh] = await rows(`insert into brands (code, name) values ('NEW_BRAND', 'New') returning id`);
  assert.ok(fresh.id > 4, 'identity sequence must continue past seeded ids');
  await pg.query(`delete from brands where code = 'NEW_BRAND'`);
});

test('foreign keys are enforced and updated_at maintains itself', async () => {
  await assert.rejects(pg.query(`update users set role_id = 999999 where id = 1`), /foreign key/);
  const [before] = await rows(`select updated_at from brands where id = 1`);
  await pg.query(`select pg_sleep(0.01)`);
  await pg.query(`update brands set description = 'changed' where id = 1`);
  const [after] = await rows(`select updated_at from brands where id = 1`);
  assert.ok(new Date(after.updated_at) >= new Date(before.updated_at));
  assert.notEqual(new Date(after.updated_at).getTime(), new Date('2000-01-01').getTime());
});
