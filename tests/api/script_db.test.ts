// Data scripts write through the API's adapter, so stringified JSON is stored as an object (a raw
// postgres client stored it as a JSON string). The repair script turns such strings back into objects.
// One connection only: the PGLite socket server serves a single client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestPg } from '../support/testDb.ts';
import { openScriptDb } from '../../supabase/scripts/lib/scriptDb.ts';
import { repairDoubleEncodedJson } from '../../supabase/scripts/repair_double_encoded_json.ts';

const pg = await createTestPg();
const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
const port = 21000 + (process.pid % 20000);
const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
await server.start();
const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

test('the script adapter stores stringified JSON as an object; the repair turns double-encoded strings back into objects', { timeout: 60_000 }, async () => {
  const db = await openScriptDb(url, { ssl: false });
  const typeOf = async (id: number) => (await db.query(`select jsonb_typeof(new_values) as t from audit_logs where id = $1`, [id]))[0].t;
  try {
    const [good] = await db.query(`insert into audit_logs (action, auditable_type, auditable_id, new_values, created_at) values ('test.json', 'x', 1, $1, now()) returning id`, [JSON.stringify({ a: 1 })]);
    assert.equal(await typeOf(Number(good.id)), 'object', 'the script adapter stores an object');

    // What a raw postgres client stored: the JSON text wrapped in a JSON string.
    const [bad] = await db.query(`insert into audit_logs (action, auditable_type, auditable_id, new_values, created_at) values ('test.json', 'x', 2, to_jsonb($1::text), now()) returning id`, [JSON.stringify({ b: 2 })]);
    assert.equal(await typeOf(Number(bad.id)), 'string');
    // A plain string value is left alone (not JSON text of an object/array).
    const [plain] = await db.query(`insert into audit_logs (action, auditable_type, auditable_id, new_values, created_at) values ('test.json', 'x', 3, to_jsonb('hello'::text), now()) returning id`);

    // A mutable table: an applicant whose milestones were double-encoded.
    const [a] = await db.query(`insert into applicants (full_name, status, application_date, milestones) values ('Json Person', 'scheduled', '2026-01-01', to_jsonb($1::text)) returning id`, [JSON.stringify({ orientation_attended: true })]);
    const dry = await repairDoubleEncodedJson(db, false);
    const audit = dry.find((p) => p.table === 'audit_logs' && p.column === 'new_values')!;
    assert.deepEqual([audit.ids, audit.append_only], [[Number(bad.id)], true], 'audit_logs is append-only: reported only');
    assert.deepEqual(dry.find((p) => p.table === 'applicants' && p.column === 'milestones')?.ids, [Number(a.id)]);
    await repairDoubleEncodedJson(db, true);
    assert.deepEqual((await db.query(`select milestones from applicants where id = $1`, [a.id]))[0].milestones, { orientation_attended: true });
    assert.equal(await typeOf(Number(bad.id)), 'string', 'the append-only row is never updated');
    assert.equal(await typeOf(Number(plain.id)), 'string', 'a plain string stays');
    const [log] = await db.query(`select jsonb_typeof(new_values) t from audit_logs where action = 'data.json_double_encoding_repaired' and auditable_id = $1`, [a.id]);
    assert.equal(log.t, 'object', 'the repair is logged, as an object');
    assert.deepEqual((await repairDoubleEncodedJson(db, false)).filter((p) => !p.append_only), [], 'nothing mutable is left');
  } finally {
    await db.close();
    await server.stop();
  }
});
