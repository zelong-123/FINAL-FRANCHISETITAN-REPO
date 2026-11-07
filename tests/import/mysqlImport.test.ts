// The MySQL importer, end to end on real Postgres (PGlite), from a made-up dump in
// tests/fixtures/ that holds every awkward case on purpose.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDump, parseRows, splitStatements } from '../../scripts/lib/parse-mysql-dump.mjs';
import { convertValue, formatReport, loadOrder, normaliseBcrypt, runImport, standInAuth, standInFiles } from '../../scripts/import-mysql-dump.mjs';
import { createTestPg, pgliteDb } from '../support/testDb.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'phpmyadmin-sample.sql');
const scratch = mkdtempSync(join(tmpdir(), 'ft-import-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeDump(name: string, sql: string) {
  const path = join(scratch, name);
  writeFileSync(path, sql);
  return path;
}

function storageFolder() {
  const root = join(scratch, `storage-${Math.random().toString(36).slice(2)}`);
  const put = (relative: string, content = 'bytes') => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  };
  put('private/applicants/1/loi/a.png', 'png');
  put('private/.gitignore');
  put('private/backups/full.sql.gz', 'every password hash');
  put('public/brand-products/p.jpg', 'jpg');
  put('public/no-row-refers-to-this.png');
  return root;
}

async function target() {
  const db = pgliteDb(await createTestPg({ seed: false }));
  return { db, auth: standInAuth(db), files: standInFiles() };
}

const SIMPLE_USERS = (rows: string) => `SET time_zone = "+00:00";
CREATE TABLE \`users\` (
  \`id\` bigint(20) UNSIGNED NOT NULL,
  \`role_id\` bigint(20) UNSIGNED NOT NULL,
  \`full_name\` varchar(255) NOT NULL,
  \`email\` varchar(255) NOT NULL,
  \`password\` varchar(255) NOT NULL
);
INSERT INTO \`users\` (\`id\`, \`role_id\`, \`full_name\`, \`email\`, \`password\`) VALUES ${rows};
`;

describe('reading a dump', () => {
  test('a semicolon inside a string or comment does not end the statement', () => {
    const statements = [...splitStatements(`-- a; comment\nSELECT 'a;b', "c;d";\n/* x; y */ SELECT 2;\n/*!40103 SET TIME_ZONE='+00:00' */;`)];
    assert.deepEqual(statements, [`SELECT 'a;b', "c;d"`, 'SELECT 2', `/*!40103 SET TIME_ZONE='+00:00' */`]);
  });

  test('values: escapes, NULL, numbers, hex, binary and bit', () => {
    const [row] = parseRows(`('it\\'s', 'a''b', 'back\\\\slash', 'n\\nl', 'nul\\0', NULL, -1.5, 0x4142, _binary 'z', b'1', '\\%')`, 0);
    assert.deepEqual(row, ["it's", "a'b", 'back\\slash', 'n\nl', 'nul\0', null, '-1.5', 'AB', 'z', '1', '\\%']);
  });

  test('several rows, with a closing bracket and comma inside a string', () => {
    assert.deepEqual(parseRows(`(1, '),('), (2, 'b')`, 0), [['1', '),('], ['2', 'b']]);
  });

  test('mysqldump form: no column list, counter in CREATE TABLE, zone in a version comment', () => {
    const dump = parseDump(`-- MySQL dump
-- Host: localhost    Database: rald_2_0
/*!40103 SET TIME_ZONE='+00:00' */;
DROP TABLE IF EXISTS \`roles\`;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE \`roles\` (
  \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4;
LOCK TABLES \`roles\` WRITE;
/*!40000 ALTER TABLE \`roles\` DISABLE KEYS */;
INSERT INTO \`roles\` VALUES (1,'a'),(2,'b');
/*!40000 ALTER TABLE \`roles\` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
-- Dump completed on 2026-11-02 13:26:24
`);
    const roles = dump.tables.get('roles')!;
    assert.equal(dump.timeZone, '+00:00');
    assert.equal(dump.database, 'rald_2_0');
    assert.equal(dump.generatedAt, '2026-11-02 13:26:24');
    assert.equal(roles.autoIncrement, 9);
    assert.deepEqual(roles.columns.map((c: any) => c.name), ['id', 'name']);
    assert.deepEqual(roles.rows, [{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
  });

  test('a dump of several databases is refused with a clear reason', () => {
    assert.throws(() => parseDump('USE `a`;\nCREATE TABLE `t` (\n  `id` int\n);\nUSE `b`;\nCREATE TABLE `u` (\n  `id` int\n);'), /2 databases/);
    assert.throws(() => parseDump('CREATE TABLE `t` (\n  `id` int\n);\nCREATE TABLE `t` (\n  `id` int\n);'), /more than once/);
    assert.throws(() => parseDump('select 1;'), /No CREATE TABLE/);
  });
});

describe('converting values', () => {
  const column = (type: string) => ({ name: 'c', type, nullable: true, hasDefault: false, identity: false });

  test('a TIMESTAMP column follows the dump zone; a DATETIME column is always Manila', () => {
    const when = column('timestamp with time zone');
    assert.equal(convertValue('2026-11-04 21:51:12', when, 'timestamp', '+00:00').value, '2026-11-04 21:51:12+00:00');
    assert.equal(convertValue('2026-11-04 21:51:12', when, 'timestamp', '+08:00').value, '2026-11-04 21:51:12+08:00');
    assert.equal(convertValue('2026-11-19 11:00:00', when, 'datetime', '+00:00').value, '2026-11-19 11:00:00+08:00');
    assert.ok(convertValue('0000-00-00 00:00:00', when, 'timestamp', '+00:00').problem);
    assert.ok(convertValue('2026-02-31 10:00:00', when, 'datetime', '+00:00').problem);
  });

  test('dates stay YYYY-MM-DD, tinyints become booleans, ranges and numbers are checked', () => {
    assert.equal(convertValue('2026-11-05', column('date'), 'date', '+00:00').value, '2026-11-05');
    assert.ok(convertValue('0000-00-00', column('date'), 'date', '+00:00').problem);
    assert.equal(convertValue('1', column('boolean'), 'tinyint', '+00:00').value, true);
    assert.equal(convertValue('0', column('boolean'), 'tinyint', '+00:00').value, false);
    assert.equal(convertValue('2', column('boolean'), 'tinyint', '+00:00').value, true);
    assert.ok(convertValue('70000', column('smallint'), 'int', '+00:00').problem);
    assert.ok(convertValue('abc', column('numeric'), 'decimal', '+00:00').problem);
    assert.equal(convertValue('12.50', column('numeric'), 'decimal', '+00:00').value, '12.50');
  });

  test('bcrypt hashes become $2a$ with the rest untouched; anything else is rejected', () => {
    const body = 'abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.';
    assert.equal(normaliseBcrypt(`$2y$12$${body}`), `$2a$12$${body}`);
    assert.equal(normaliseBcrypt(`$2b$10$${body}`), `$2a$10$${body}`);
    assert.equal(normaliseBcrypt('$argon2id$v=19$abc'), null);
    assert.equal(normaliseBcrypt('plaintext'), null);
    assert.equal(normaliseBcrypt(null), null);
  });

  test('the load order puts parents first, and a cycle stops with a reason', () => {
    const table = (foreignKeys: { refTable: string }[]) => ({ foreignKeys });
    assert.deepEqual(loadOrder(new Map([['child', table([{ refTable: 'parent' }])], ['parent', table([{ refTable: 'parent' }])]])), ['parent', 'child']);
    assert.throws(() => loadOrder(new Map([['a', table([{ refTable: 'b' }])], ['b', table([{ refTable: 'a' }])]])), /cycle/);
  });
});

describe('importing the sample dump', () => {
  let ctx: Awaited<ReturnType<typeof target>>;
  let report: any;
  let storage: string;
  const one = async (sql: string, params: unknown[] = []) => (await ctx.db.query<any>(sql, params))[0];

  before(async () => {
    ctx = await target();
    storage = storageFolder();
    report = await runImport({ dumpPath: FIXTURE, ...ctx, filesDir: storage });
    assert.equal(report.error, null);
  });

  test('row counts are compared per table and match', () => {
    assert.equal(report.status, 'loaded');
    assert.ok(report.tables.every((t: any) => t.match));
    const row = (name: string) => report.tables.find((t: any) => t.table === name);
    assert.deepEqual(row('users'), { table: 'users', inDump: 7, loaded: 6, skipped: 1, inTarget: 6, match: true });
    assert.deepEqual(row('documents'), { table: 'documents', inDump: 4, loaded: 3, skipped: 1, inTarget: 3, match: true });
    assert.deepEqual(row('user_sessions'), { table: 'user_sessions', inDump: 2, loaded: 1, skipped: 1, inTarget: 1, match: true });
  });

  test('every timestamp lands on the right instant', async () => {
    // start_at is Manila wall-clock. created_at was exported in UTC, so a flat +08 would be 8 hours off.
    const row = await one(`select to_char(start_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI:SS') as start_manila, to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI:SS') as created_manila from schedule_sessions where id = 1`);
    assert.equal(row.start_manila, '2026-11-19 11:00:00');
    assert.equal(row.created_manila, '2026-11-05 05:51:12');
  });

  test('tinyints are real booleans', async () => {
    assert.deepEqual(await ctx.db.query('select id, is_active from brands order by id'), [{ id: 1, is_active: true }, { id: 2, is_active: false }]);
  });

  test('strings come through byte for byte, and morph types keep their backslashes', async () => {
    const doc = await one('select documentable_type, original_name from documents where id = 1');
    assert.equal(doc.documentable_type, 'App\\Models\\Applicant');
    assert.equal(doc.original_name, `it's; a (test), "x" ''q'' C:\\dir\nline2 café 😀`);
  });

  test('JSON is stored as an object, not a string, with its digits intact', async () => {
    const row = await one(`select jsonb_typeof(metadata) as kind, metadata->>'note' as note, metadata#>>'{nested,ok}' as ok, metadata->>'amount' as amount from documents where id = 1`);
    assert.deepEqual(row, { kind: 'object', note: 'a "quoted" word', ok: 'true', amount: '1.10' });
  });

  test('ids are kept and sequences continue past the dump, including its AUTO_INCREMENT', async () => {
    assert.deepEqual((await ctx.db.query('select id from users order by id')).map((u: any) => u.id), [1, 2, 3, 4, 5, 6]);
    const session = await one(`insert into schedule_sessions (activity_type, start_at, end_at, max_capacity) values ('x', now(), now(), 1) returning id`);
    assert.equal(session.id, 50); // AUTO_INCREMENT=50, above the highest id.
    const user = await one(`insert into users (role_id, full_name, email) values (1, 'n', 'n@example.test') returning id`);
    assert.equal(user.id, 8); // User 7 was skipped, but old logs may name that id, so it is not reissued.
  });

  test('a user archived by someone later in the file, or by themself, still loads', async () => {
    assert.equal((await one('select archived_by_user_id as a from users where id = 1')).a, 2);
    assert.equal((await one('select archived_by_user_id as a from users where id = 2')).a, 2);
    assert.equal((await one('select merged_into_session_id as m from schedule_sessions where id = 1')).m, 2);
  });

  test('every problem row is reported, with what was done to it', () => {
    const find = (table: string, column: string) => report.issues.find((i: any) => i.table === table && i.column === column);
    assert.equal(find('users', 'role_id').action, 'row skipped');
    assert.deepEqual(find('users', 'role_id').rowIds, ['7']);
    assert.equal(find('users', 'archived_by_user_id').action, 'value cleared');
    assert.deepEqual(find('users', 'archived_by_user_id').rowIds, ['6']);
    assert.equal(find('documents', 'uploaded_by_user_id').action, 'row skipped');
    assert.equal(find('documents', 'metadata').reason, 'invalid JSON');
    assert.equal(find('user_sessions', 'ended_at').action, 'value cleared');
    assert.equal(find('user_sessions', 'user_id').action, 'row skipped'); // Follows its skipped user.
  });

  test('left-out tables and columns are named, and unknown ones stand out', () => {
    const table = (name: string) => report.skippedTables.find((t: any) => t.table === name);
    assert.match(table('api_tokens').reason, /Supabase Auth/);
    assert.match(table('legacy_notes').reason, /NOT IN THE TARGET SCHEMA/);
    assert.equal(table('legacy_notes').rows, 1);
    const column = (name: string) => report.droppedColumns.find((c: any) => c.column === name);
    assert.match(column('users.password').reason, /Supabase Auth/);
    assert.match(column('users.old_nickname').reason, /NOT IN THE TARGET SCHEMA/);
    assert.ok(report.emptyTables.includes('login_attempts'));
    assert.ok(report.emptyTables.includes('units'));
  });

  test('reference rows the dump does not replace stay; ones it has are replaced', async () => {
    assert.equal((await one('select count(*)::int as n from units')).n, 16);
    assert.deepEqual((await ctx.db.query('select id from roles order by id')).map((r: any) => r.id), [1, 3]);
  });

  test('sign-ins carry the existing hash and are linked, without touching updated_at', async () => {
    assert.equal(report.auth.created, 4);
    assert.equal(ctx.auth.hashes.get('ana@example.test'), '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.');
    const ana = await one(`select u.auth_user_id, a.email, to_char(u.updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as updated from users u join auth.users a on a.id = u.auth_user_id where u.id = 1`);
    assert.equal(ana.email, 'ana@example.test');
    assert.equal(ana.updated, '2026-01-02 03:04:05');
  });

  test('users who cannot get a sign-in are reported and stay unlinked', async () => {
    const reasons = Object.fromEntries(report.auth.skipped.map((s: any) => [s.userId, s.reason]));
    assert.match(reasons['4'], /letter case/);
    assert.match(reasons['5'], /not a bcrypt hash/);
    assert.equal((await ctx.db.query('select id from users where auth_user_id is null and id < 8 order by id')).map((u: any) => u.id).join(), '4,5');
    assert.equal((await one('select count(*)::int as n from auth.users')).n, 4);
  });

  test('uploads go to the right bucket with their type; hidden files and backups never do', () => {
    const { store } = ctx.files;
    assert.equal(store.get('private/applicants/1/loi/a.png').contentType, 'image/png');
    assert.equal(Buffer.from(store.get('private/applicants/1/loi/a.png').bytes).toString(), 'png');
    assert.equal(store.get('public/brand-products/p.jpg').contentType, 'image/jpeg');
    assert.ok(store.has('public/no-row-refers-to-this.png'));
    assert.equal(store.size, 3);
    assert.deepEqual(report.files.uploaded, { private: 1, public: 2 });
    assert.equal(report.files.unreferencedUploaded, 1);
    assert.deepEqual(report.files.ignored.sort(), ['private/.gitignore', 'private/backups/full.sql.gz']);
    assert.deepEqual(report.files.missing, [{ table: 'documents', id: '2', file: 'private/applicants/1/loi/missing.png' }]);
    assert.deepEqual(report.files.unusableDisks, [{ table: 'documents', id: '4', disk: 'local' }]);
  });

  test('the text report names what was skipped and holds no password hash', () => {
    const text = formatReport(report);
    for (const expected of ['legacy_notes', 'users.role_id', 'MISSING documents 2', 'SKIPPED user 5', 'read as +00:00']) assert.ok(text.includes(expected), expected);
    const serialised = `${text}${JSON.stringify(report)}`;
    assert.ok(!serialised.includes('$2y$') && !serialised.includes('$2a$'));
  });

  test('running again needs --replace, and refusal changes nothing', async () => {
    const refused = await runImport({ dumpPath: FIXTURE, ...ctx, filesDir: storage });
    assert.equal(refused.status, 'failed');
    assert.match(refused.error!, /--replace/);
    assert.equal(refused.tablesLoaded, false);
    assert.match(formatReport(refused), /not changed/);
    assert.equal((await one(`select count(*)::int as n from users where email = 'n@example.test'`)).n, 1);
  });

  test('--replace gives the same result and links existing sign-ins without changing them', async () => {
    const before = await ctx.db.query('select id, email from auth.users order by email');
    ctx.auth.hashes.set('ana@example.test', 'changed since the first import');
    const again = await runImport({ dumpPath: FIXTURE, ...ctx, filesDir: storage, replace: true });
    assert.equal(again.status, 'loaded');
    assert.ok(again.tables.every((t: any) => t.match));
    assert.equal(again.auth.created, 0);
    assert.equal(again.auth.linkedExisting, 4);
    assert.deepEqual(await ctx.db.query('select id, email from auth.users order by email'), before);
    assert.equal(ctx.auth.hashes.get('ana@example.test'), 'changed since the first import');
    assert.equal((await one(`select count(*)::int as n from users where email = 'n@example.test'`)).n, 0);
    assert.equal((await one('select count(*)::int as n from users where auth_user_id is not null')).n, 4);
  });
});

describe('when something goes wrong', () => {
  const hash = '$2y$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123.';

  test('a database error rolls back everything, including tables already loaded', async () => {
    const ctx = await target();
    const dump = writeDump('duplicate.sql', `${SIMPLE_USERS(`(1, 1, 'A', 'same@example.test', '${hash}'), (2, 1, 'B', 'same@example.test', '${hash}')`)}
CREATE TABLE \`roles\` (
  \`id\` bigint(20) NOT NULL,
  \`name\` varchar(255) NOT NULL,
  \`label\` varchar(255) NOT NULL
);
INSERT INTO \`roles\` (\`id\`, \`name\`, \`label\`) VALUES (1, 'only', 'Only');`);
    const report = await runImport({ dumpPath: dump, ...ctx });
    assert.equal(report.status, 'failed');
    assert.match(report.error!, /Loading users failed/);
    assert.equal((await ctx.db.query<any>('select count(*)::int as n from roles'))[0].n, 5); // The migrations' rows are back.
    assert.equal((await ctx.db.query<any>('select count(*)::int as n from auth.users'))[0].n, 0);
  });

  test('a bad files folder is caught before anything loads', async () => {
    const ctx = await target();
    const report = await runImport({ dumpPath: FIXTURE, ...ctx, filesDir: join(scratch, 'nowhere') });
    assert.equal(report.status, 'failed');
    assert.equal(report.tablesLoaded, false);
    assert.equal((await ctx.db.query<any>('select count(*)::int as n from users'))[0].n, 0);
  });

  test('one failed sign-in or upload does not stop the rest, and marks the run incomplete', async () => {
    const ctx = await target();
    const createUser = ctx.auth.createUser;
    ctx.auth.createUser = async (user: { email: string; passwordHash: string }) => {
      if (user.email === 'ana@example.test') throw new Error('Auth said no');
      return createUser(user);
    };
    const put = ctx.files.put;
    ctx.files.put = async (bucket: string, path: string, bytes: Uint8Array, type: string) => {
      if (path.endsWith('p.jpg')) throw new Error('Storage said no');
      return put(bucket, path, bytes, type);
    };
    const report = await runImport({ dumpPath: FIXTURE, ...ctx, filesDir: storageFolder() });
    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.auth.failed, [{ userId: '1', reason: 'Auth said no' }]);
    assert.equal(report.auth.created, 3);
    assert.deepEqual(report.files.failed, [{ file: 'public/brand-products/p.jpg', reason: 'Storage said no' }]);
  });

  test('a dump with no zone setting reads TIMESTAMP columns as Manila time; --timestamp-zone overrides', async () => {
    const noZone = writeDump('nozone.sql', readFileSync(FIXTURE, 'utf8').replace('SET time_zone = "+00:00";', ''));
    const ctx = await target();
    const report = await runImport({ dumpPath: noZone, ...ctx });
    assert.equal(report.timestamps.timestampColumnsWrittenIn, '+08:00');
    const row = (await ctx.db.query<any>(`select to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI:SS') as t from schedule_sessions where id = 1`))[0];
    assert.equal(row.t, '2026-11-04 21:51:12');

    const other = await target();
    const overridden = await runImport({ dumpPath: noZone, ...other, timestampZone: '+00:00' });
    assert.equal(overridden.timestamps.timestampColumnsWrittenIn, '+00:00');
    assert.match((await runImport({ dumpPath: noZone, ...(await target()), timestampZone: 'Manila' })).error!, /--timestamp-zone/);
  });

  test('a dump missing a column the schema requires stops before loading', async () => {
    const ctx = await target();
    const dump = writeDump('old.sql', 'CREATE TABLE `brands` (\n  `id` bigint(20) NOT NULL,\n  `name` varchar(255) NOT NULL\n);\nINSERT INTO `brands` (`id`, `name`) VALUES (1, \'x\');');
    const report = await runImport({ dumpPath: dump, ...ctx });
    assert.match(report.error!, /brands\.code is required/);
  });
});

describe('through the production postgres.js driver', () => {
  test('the sample dump loads the same, and JSON is not double-encoded', async () => {
    const [{ default: postgres }, { PGLiteSocketServer }, { postgresDb }] = await Promise.all([
      import('postgres'), import('@electric-sql/pglite-socket'), import('../../supabase/functions/api/lib/db.ts'),
    ]);
    const pg = await createTestPg({ seed: false });
    const port = 20000 + ((process.pid + 7) % 20000);
    const server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
    await server.start();
    const db = postgresDb(postgres, `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`, { max: 1 });
    try {
      const report = await runImport({ dumpPath: FIXTURE, db, auth: standInAuth(db), files: standInFiles(), filesDir: storageFolder() });
      assert.equal(report.error, null);
      assert.equal(report.status, 'loaded');
      assert.ok(report.tables.every((t: any) => t.match));
      const [doc] = await db.query<any>(`select jsonb_typeof(metadata) as kind, metadata->>'amount' as amount, documentable_type from documents where id = 1`);
      assert.deepEqual(doc, { kind: 'object', amount: '1.10', documentable_type: 'App\\Models\\Applicant' });
      const [{ next }] = await db.query<any>(`select nextval(pg_get_serial_sequence('public."schedule_sessions"', 'id')) as next`);
      assert.equal(Number(next), 50);
    } finally {
      await db.close();
      await server.stop();
    }
  });
});
