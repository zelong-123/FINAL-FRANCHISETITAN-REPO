// Imports a MySQL dump of Franchise Titan into the Postgres schema in supabase/migrations/,
// moves users to Supabase Auth with their password hashes, and copies uploads to Storage.
//
//   Rehearsal (in-memory Postgres, nothing leaves this machine):
//     npm run import:mysql -- --target pglite --dump backup.sql --files path/to/storage/app
//   Real project (migrations already applied, credentials in .env):
//     npm run import:mysql -- --target supabase --dump backup.sql --files path/to/storage/app
//
// Safe to run again. All table data loads in one transaction, so a failure leaves the database as it
// was. A database that already holds data is refused unless --replace is passed. Existing sign-ins are
// linked rather than overwritten, and uploads overwrite the same path. See the README for details.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDump } from './lib/parse-mysql-dump.mjs';

const MANILA = '+08:00'; // config/app.php: Laravel wrote naive Asia/Manila wall-clock time.
const BATCH_ROWS = 1000;
const BUCKETS = ['private', 'public']; // Same names as Laravel's disks, under storage/app/.

// Filled by the migrations. Replaced by the dump's rows, or kept if the dump has none.
const REFERENCE_TABLES = new Set(['roles', 'units']);

const REPLACED_TABLES = {
  api_tokens: 'replaced by Supabase Auth; everyone signs in again once',
  cache: 'Laravel plumbing',
  cache_locks: 'Laravel plumbing',
  failed_jobs: 'Laravel plumbing',
  job_batches: 'Laravel plumbing',
  jobs: 'Laravel plumbing',
  migrations: 'Laravel plumbing',
  password_reset_tokens: 'reset links are handled by Supabase Auth',
  sessions: 'Laravel plumbing',
};
const REPLACED_COLUMNS = {
  'users.password': 'moved to Supabase Auth',
  'users.remember_token': 'replaced by Supabase Auth',
};
const FILE_REFERENCES = [
  { table: 'documents', path: 'path', disk: 'disk', mime: 'mime_type' },
  { table: 'brand_products', path: 'image_path', bucket: 'public' },
  { table: 'profittrack_recipes', path: 'image_path', bucket: 'public' },
];
const CONTENT_TYPES = {
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const INTEGER_RANGE = {
  smallint: [-(2n ** 15n), 2n ** 15n - 1n],
  integer: [-(2n ** 31n), 2n ** 31n - 1n],
  bigint: [-(2n ** 63n), 2n ** 63n - 1n],
};

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

// ---------------------------------------------------------------- target schema

async function readTargetSchema(db) {
  const columns = await db.query(`
    select table_name, column_name, data_type, is_nullable, column_default, is_identity
    from information_schema.columns where table_schema = 'public'
    order by table_name, ordinal_position`);
  const keys = await db.query(`
    select cl.relname as table_name, c.contype::text as kind, ref.relname as ref_table,
      (select jsonb_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(n, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as cols,
      (select jsonb_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(n, ord)
        join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as ref_cols
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    left join pg_class ref on ref.oid = c.confrelid
    where c.connamespace = 'public'::regnamespace and c.contype in ('f', 'p')
    order by cl.relname, c.conname`);

  const tables = new Map();
  for (const c of columns) {
    if (!tables.has(c.table_name)) tables.set(c.table_name, { name: c.table_name, columns: new Map(), primaryKey: [], foreignKeys: [] });
    tables.get(c.table_name).columns.set(c.column_name, {
      name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', hasDefault: c.column_default !== null, identity: c.is_identity === 'YES',
    });
  }
  for (const k of keys) {
    const table = tables.get(k.table_name);
    if (k.kind === 'p') table.primaryKey = k.cols;
    else table.foreignKeys.push({ cols: k.cols, refTable: k.ref_table, refCols: k.ref_cols });
  }
  return tables;
}

/** Parents before children. A self reference is fine: Postgres checks it at the end of the statement. */
export function loadOrder(tables) {
  const remaining = new Set(tables.keys());
  const order = [];
  while (remaining.size) {
    const ready = [...remaining].filter((name) => tables.get(name).foreignKeys.every((f) => f.refTable === name || !remaining.has(f.refTable)));
    if (!ready.length) throw new Error(`Foreign keys form a cycle among: ${[...remaining].join(', ')}. The importer needs a decision on which to load first.`);
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  return order;
}

// ---------------------------------------------------------------- value conversion

const bad = (reason) => ({ problem: reason });

function parseWhen(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?$/.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year === 0 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (Number(m[4] ?? 0) > 23 || Number(m[5] ?? 0) > 59 || Number(m[6] ?? 0) > 59) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${m[7] ?? ''}` };
}

/** Converts one dumped string to what the target column takes; `problem` when it cannot. */
export function convertValue(raw, target, sourceType, timestampOffset) {
  switch (target.type) {
    case 'boolean':
      if (!/^-?\d+$/.test(raw)) return bad('not a tinyint');
      return { value: BigInt(raw) !== 0n }; // MySQL treats any non-zero value as true.
    case 'smallint':
    case 'integer':
    case 'bigint': {
      if (!/^-?\d+$/.test(raw)) return bad('not a whole number');
      const [low, high] = INTEGER_RANGE[target.type];
      return BigInt(raw) < low || BigInt(raw) > high ? bad(`out of ${target.type} range`) : { value: raw };
    }
    case 'numeric':
    case 'double precision':
      return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw) ? { value: raw } : bad('not a number');
    case 'date': {
      const when = parseWhen(raw);
      return when ? { value: when.date } : bad('invalid date');
    }
    case 'time without time zone':
      return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?$/.test(raw) ? { value: raw } : bad('invalid time');
    case 'timestamp with time zone': {
      const when = parseWhen(raw);
      if (!when) return bad('invalid date and time');
      // Only MySQL TIMESTAMP columns follow the dump's session time zone; DATETIME is stored as typed.
      return { value: `${when.date} ${when.time}${sourceType === 'timestamp' ? timestampOffset : MANILA}` };
    }
    case 'jsonb':
      try {
        JSON.parse(raw);
      } catch {
        return bad('invalid JSON');
      }
      // Postgres jsonb cannot hold a NUL character, even escaped.
      if (raw.includes('\\u0000')) return bad('JSON contains a NUL character');
      return { value: raw };
    case 'text':
      return raw.includes('\0') ? { value: raw.replaceAll('\0', ''), note: 'NUL character removed' } : { value: raw };
    default:
      throw new Error(`No conversion for Postgres type ${target.type}.`);
  }
}

function resolveTimestampOffset(dumpZone, override) {
  const pattern = /^[-+]\d{2}:\d{2}$/;
  if (override) {
    if (!pattern.test(override)) throw new Error('--timestamp-zone must look like +00:00 or +08:00.');
    return { offset: override, basis: 'set with --timestamp-zone' };
  }
  if (dumpZone && pattern.test(dumpZone)) return { offset: dumpZone, basis: 'read from the dump header (SET time_zone)' };
  if (dumpZone) throw new Error(`The dump's time zone "${dumpZone}" is not a fixed offset. Pass --timestamp-zone.`);
  return { offset: MANILA, basis: 'the dump does not name a time zone, so assumed Manila server time' };
}

// ---------------------------------------------------------------- planning

function planTable(dumpTable, target, timestampOffset, issues) {
  const shared = dumpTable.columns.filter((c) => target.columns.has(c.name));
  const pk = target.primaryKey;
  const rows = [];
  for (const source of dumpTable.rows) {
    const rowId = pk.length ? pk.map((c) => source[c]).join('/') : '?';
    const row = {};
    let skipped = false;
    for (const { name, type } of shared) {
      const column = target.columns.get(name);
      const raw = source[name];
      let value = null;
      let problem = null;
      if (raw === null || raw === undefined) {
        if (!column.nullable) problem = 'empty in a required column';
      } else {
        const converted = convertValue(raw, column, type, timestampOffset);
        if (converted.problem) problem = converted.problem;
        else value = converted.value;
        if (converted.note) issues.add(target.name, name, converted.note, 'value kept', rowId);
      }
      if (problem && column.nullable) {
        issues.add(target.name, name, problem, 'value cleared', rowId);
      } else if (problem) {
        issues.add(target.name, name, problem, 'row skipped', rowId);
        skipped = true;
        break;
      }
      row[name] = value;
    }
    if (!skipped) rows.push(row);
  }
  return {
    name: target.name,
    columns: shared.map((c) => c.name),
    jsonColumns: new Set(shared.filter((c) => target.columns.get(c.name).type === 'jsonb').map((c) => c.name)),
    rows,
    dumpRows: dumpTable.rows,
    rowsInDump: dumpTable.rows.length,
    autoIncrement: dumpTable.autoIncrement,
  };
}

/** Rows pointing at a parent that will not exist: clear the link if it may be empty, else skip the row. */
function resolveForeignKeys(plans, tables, issues) {
  const keyOf = (values) => values.join('\u0001');
  const kept = (name) => REFERENCE_TABLES.has(name) && !plans.get(name)?.rows.length;
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of plans.values()) {
      const table = tables.get(plan.name);
      for (const fk of table.foreignKeys) {
        if (kept(fk.refTable)) continue;
        const parent = plans.get(fk.refTable);
        const parents = new Set((parent?.rows ?? []).map((r) => keyOf(fk.refCols.map((c) => r[c]))));
        const survivors = [];
        for (const row of plan.rows) {
          const values = fk.cols.map((c) => row[c]);
          if (values.some((v) => v === null || v === undefined) || parents.has(keyOf(values))) {
            survivors.push(row);
            continue;
          }
          changed = true;
          const rowId = table.primaryKey.map((c) => row[c]).join('/') || '?';
          const clearable = fk.cols.filter((c) => table.columns.get(c).nullable);
          const label = fk.cols.join('+');
          const reason = `points at a missing ${fk.refTable} row`;
          if (clearable.length) {
            for (const c of clearable) row[c] = null;
            issues.add(plan.name, label, reason, 'value cleared', rowId);
            survivors.push(row);
          } else {
            issues.add(plan.name, label, reason, 'row skipped', rowId);
          }
        }
        // A skipped row can orphan one already checked, so the outer loop goes round until nothing changes.
        plan.rows = survivors;
      }
    }
  }
}

function makeIssueLog() {
  const groups = new Map();
  return {
    add(table, column, reason, action, rowId) {
      const key = `${table}|${column}|${reason}|${action}`;
      if (!groups.has(key)) groups.set(key, { table, column, reason, action, count: 0, rowIds: [] });
      const group = groups.get(key);
      group.count += 1;
      if (group.rowIds.length < 20) group.rowIds.push(rowId);
    },
    list: () => [...groups.values()],
  };
}

// ---------------------------------------------------------------- loading

function rowsAsJson(plan, rows) {
  const parts = rows.map((row) => {
    const fields = plan.columns.map((c) => {
      const value = row[c];
      // JSON columns go in as their original text, so numbers keep their exact digits.
      return `${JSON.stringify(c)}:${value !== null && plan.jsonColumns.has(c) ? value : JSON.stringify(value)}`;
    });
    return `{${fields.join(',')}}`;
  });
  return `[${parts.join(',')}]`;
}

async function insertRows(db, plan, rows) {
  const names = plan.columns.map(quote).join(', ');
  await db.query(
    `insert into public.${quote(plan.name)} (${names}) overriding system value
     select ${names} from jsonb_populate_recordset(null::public.${quote(plan.name)}, $1::text::jsonb)`,
    [rowsAsJson(plan, rows)],
  );
}

async function resetSequences(db, plan, table) {
  for (const column of table.columns.values()) {
    if (!column.identity) continue;
    // MySQL's counter, and every id in the dump: ids of deleted or skipped rows are never reissued,
    // because old log entries may still name them.
    let next = BigInt(plan?.autoIncrement ?? 1);
    for (const row of plan?.dumpRows ?? []) {
      if (/^\d+$/.test(row[column.name] ?? '') && BigInt(row[column.name]) >= next) next = BigInt(row[column.name]) + 1n;
    }
    if (next < 1n) next = 1n;
    const qualified = `public.${quote(table.name)}`.replaceAll("'", "''");
    await db.query(`select setval(pg_get_serial_sequence('${qualified}', '${column.name}'), ${next}, false)`);
  }
}

const tableRowCounts = async (db, names) => {
  const counts = new Map();
  for (const name of names) {
    const [row] = await db.query(`select count(*)::int as n from public.${quote(name)}`);
    counts.set(name, Number(row.n));
  }
  return counts;
};

async function loadTables(db, plans, tables, replace) {
  const order = loadOrder(tables);
  return db.tx(async (tx) => {
    const before = await tableRowCounts(tx, order);
    const occupied = order.filter((name) => before.get(name) > 0 && !REFERENCE_TABLES.has(name));
    if (occupied.length && !replace) {
      throw new Error(`The database already has data (${occupied.join(', ')}). Pass --replace to erase it and import again.`);
    }

    const keptReferences = order.filter((name) => REFERENCE_TABLES.has(name) && !plans.get(name)?.rows.length);
    const toClear = order.filter((name) => !keptReferences.includes(name));
    await tx.query(`truncate table ${toClear.map((n) => `public.${quote(n)}`).join(', ')} restart identity cascade`);

    for (const name of order) {
      const plan = plans.get(name);
      if (plan?.rows.length) {
        const selfReferencing = tables.get(name).foreignKeys.some((f) => f.refTable === name);
        // One statement for a self-referencing table, because the check runs at its end. The row a
        // user was archived by may come later in the file.
        const size = selfReferencing ? plan.rows.length : BATCH_ROWS;
        try {
          for (let i = 0; i < plan.rows.length; i += size) await insertRows(tx, plan, plan.rows.slice(i, i + size));
        } catch (error) {
          throw new Error(`Loading ${name} failed: ${error.message}`);
        }
      }
      if (!keptReferences.includes(name)) await resetSequences(tx, plan, tables.get(name));
    }

    const after = await tableRowCounts(tx, order);
    const mismatched = order.filter((name) => plans.get(name)?.rows.length && after.get(name) !== plans.get(name).rows.length);
    if (mismatched.length) {
      throw new Error(`Row counts do not match after loading: ${mismatched.map((n) => `${n} expected ${plans.get(n).rows.length}, found ${after.get(n)}`).join('; ')}.`);
    }
    return after;
  });
}

// ---------------------------------------------------------------- Supabase Auth

/** Laravel writes $2y$. It is the same algorithm as $2a$, which every bcrypt reader accepts. */
export function normaliseBcrypt(hash) {
  if (typeof hash !== 'string' || !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return null;
  return `$2a$${hash.slice(4)}`;
}

async function migrateUsers(db, dumpUsers, loadedIds, auth) {
  const result = { created: 0, linkedExisting: 0, skipped: [], failed: [], authUsersWithoutAppUser: 0 };
  const existing = new Map((await auth.listUsers()).map((u) => [String(u.email).toLowerCase(), u.id]));
  const claimed = new Set();
  const links = [];

  for (const user of dumpUsers) {
    if (!loadedIds.has(String(user.id))) continue;
    const email = String(user.email ?? '').trim().toLowerCase();
    const hash = normaliseBcrypt(user.password);
    if (!email) {
      result.skipped.push({ userId: user.id, reason: 'no email' });
    } else if (claimed.has(email)) {
      result.skipped.push({ userId: user.id, reason: 'email differs from another user only by letter case; Supabase Auth treats them as one' });
    } else if (existing.has(email)) {
      // Keeps whatever password this sign-in has now; it may have been changed since the last run.
      claimed.add(email);
      links.push({ id: user.id, auth_user_id: existing.get(email) });
      result.linkedExisting += 1;
    } else if (!hash) {
      result.skipped.push({ userId: user.id, reason: 'password is not a bcrypt hash, so this user needs a password reset' });
    } else {
      try {
        const authUserId = await auth.createUser({ email, passwordHash: hash });
        claimed.add(email);
        links.push({ id: user.id, auth_user_id: authUserId });
        result.created += 1;
      } catch (error) {
        result.failed.push({ userId: user.id, reason: error.message });
      }
    }
  }

  result.authUsersWithoutAppUser = [...existing.keys()].filter((email) => !claimed.has(email)).length;
  if (links.length) {
    await db.tx(async (tx) => {
      // Linking is not an edit to the user, so updated_at must keep its imported value.
      await tx.query('alter table public.users disable trigger set_updated_at');
      await tx.query(
        `update public.users u set auth_user_id = v.auth_user_id::uuid
         from jsonb_to_recordset($1::text::jsonb) as v(id bigint, auth_user_id text) where u.id = v.id`,
        [JSON.stringify(links)],
      );
      await tx.query('alter table public.users enable trigger set_updated_at');
    });
  }
  return result;
}

// ---------------------------------------------------------------- Storage

function* walk(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(join(dir, entry.name), relative);
    else if (entry.isFile()) yield relative;
  }
}

function fileReferences(plans) {
  const references = [];
  const unusableDisks = [];
  for (const spec of FILE_REFERENCES) {
    for (const row of plans.get(spec.table)?.rows ?? []) {
      const path = row[spec.path];
      if (!path) continue;
      const bucket = spec.bucket ?? row[spec.disk];
      if (BUCKETS.includes(bucket)) references.push({ bucket, path, table: spec.table, id: row.id, mime: spec.mime ? row[spec.mime] : null });
      else unusableDisks.push({ table: spec.table, id: row.id, disk: bucket });
    }
  }
  return { references, unusableDisks };
}

async function copyFiles(filesDir, plans, files) {
  const { references, unusableDisks } = fileReferences(plans);
  const result = {
    run: Boolean(filesDir), referenced: references.length, uploaded: { private: 0, public: 0 }, bytes: 0, unreferencedUploaded: 0,
    missing: [], failed: [], ignored: [], unusableDisks,
  };
  if (!filesDir) return result;

  const wanted = new Map(references.map((r) => [`${r.bucket}/${r.path}`, r]));
  const present = new Set();
  for (const bucket of BUCKETS) {
    const root = join(filesDir, bucket);
    if (!existsSync(root)) continue;
    for (const path of walk(root)) {
      const key = `${bucket}/${path}`;
      const isHidden = path.split('/').some((part) => part.startsWith('.'));
      // A database backup holds every password hash, so it never goes into a bucket.
      if (isHidden || path.startsWith('backups/')) {
        result.ignored.push(key);
        continue;
      }
      present.add(key);
      const bytes = readFileSync(join(root, path));
      const contentType = wanted.get(key)?.mime || CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
      try {
        await files.put(bucket, path, new Uint8Array(bytes), contentType);
        result.uploaded[bucket] += 1;
        result.bytes += bytes.length;
        if (!wanted.has(key)) result.unreferencedUploaded += 1;
      } catch (error) {
        result.failed.push({ file: key, reason: error.message });
      }
    }
  }
  result.missing = references.filter((r) => !present.has(`${r.bucket}/${r.path}`)).map((r) => ({ table: r.table, id: r.id, file: `${r.bucket}/${r.path}` }));
  return result;
}

// ---------------------------------------------------------------- the import

function latestCreatedAt(plans) {
  let latest = null;
  for (const plan of plans.values()) {
    for (const row of plan.rows) {
      const ms = row.created_at ? Date.parse(row.created_at.replace(' ', 'T')) : NaN;
      if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
    }
  }
  return latest === null ? null : `${new Date(latest + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} Manila`;
}

/** Never throws for a failed import: the report says what happened, and nothing is half-loaded. */
export async function runImport({ dumpPath, db, auth, files, filesDir = null, replace = false, timestampZone = null }) {
  const report = { status: 'failed', error: null, tablesLoaded: false, source: { path: resolve(dumpPath) }, tables: [], skippedTables: [], emptyTables: [], droppedColumns: [], defaultedColumns: [], issues: [] };
  try {
    // Checked before anything loads, so a mistyped path cannot leave tables loaded without files.
    if (filesDir && !BUCKETS.some((b) => existsSync(join(filesDir, b)))) {
      throw new Error(`${filesDir} has neither a private nor a public folder. Point --files at Laravel's storage/app.`);
    }
    const bytes = readFileSync(dumpPath);
    report.source.sha256 = createHash('sha256').update(bytes).digest('hex');
    const dump = parseDump(bytes.toString('utf8'));
    Object.assign(report.source, { format: dump.format, database: dump.database, generatedAt: dump.generatedAt });

    const { offset, basis } = resolveTimestampOffset(dump.timeZone, timestampZone);
    report.timestamps = { timestampColumnsWrittenIn: offset, basis, datetimeColumnsWrittenIn: MANILA };

    const tables = await readTargetSchema(db);
    const issues = makeIssueLog();
    const plans = new Map();
    for (const [name, dumpTable] of dump.tables) {
      const target = tables.get(name);
      if (!target) {
        report.skippedTables.push({ table: name, rows: dumpTable.rows.length, reason: REPLACED_TABLES[name] ?? 'NOT IN THE TARGET SCHEMA: these rows are not imported' });
        continue;
      }
      const present = new Set(dumpTable.columns.map((c) => c.name));
      for (const c of dumpTable.columns) {
        if (!target.columns.has(c.name)) report.droppedColumns.push({ column: `${name}.${c.name}`, reason: REPLACED_COLUMNS[`${name}.${c.name}`] ?? 'NOT IN THE TARGET SCHEMA: these values are not imported' });
      }
      for (const c of target.columns.values()) {
        if (present.has(c.name) || c.identity) continue;
        if (!c.nullable && !c.hasDefault && dumpTable.rows.length) {
          throw new Error(`${name}.${c.name} is required but the dump has no such column. This dump is older than the schema: export a newer one.`);
        }
        if (dumpTable.rows.length && `${name}.${c.name}` !== 'users.auth_user_id') report.defaultedColumns.push(`${name}.${c.name}`);
      }
      plans.set(name, planTable(dumpTable, target, offset, issues));
    }
    resolveForeignKeys(plans, tables, issues);
    report.timestamps.latestCreatedAt = latestCreatedAt(plans);
    report.issues = issues.list();
    report.emptyTables = [...tables.keys()].filter((name) => !dump.tables.has(name));

    const after = await loadTables(db, plans, tables, replace);
    for (const name of tables.keys()) {
      const plan = plans.get(name);
      const inDump = plan?.rowsInDump ?? 0;
      const loaded = plan?.rows.length ?? 0;
      const inTarget = after.get(name);
      const kept = REFERENCE_TABLES.has(name) && !loaded;
      report.tables.push({ table: name, inDump, loaded, skipped: inDump - loaded, inTarget, match: kept || inTarget === loaded });
    }
    report.tablesLoaded = true;

    const loadedIds = new Set((plans.get('users')?.rows ?? []).map((u) => String(u.id)));
    report.auth = await migrateUsers(db, dump.tables.get('users')?.rows ?? [], loadedIds, auth);
    report.files = await copyFiles(filesDir, plans, files);

    const unfinished = report.auth.failed.length || report.files.failed.length;
    report.status = unfinished ? 'incomplete' : 'loaded';
  } catch (error) {
    report.error = error.message;
    if (report.tablesLoaded) report.status = 'incomplete';
  }
  return report;
}

// ---------------------------------------------------------------- report text

export function formatReport(r) {
  const lines = [];
  const section = (title) => lines.push('', title);
  lines.push(`Import ${r.status === 'loaded' ? 'finished' : r.status.toUpperCase()}: ${r.source.path}`);
  if (r.source.generatedAt) lines.push(`Dump: ${r.source.format}, database ${r.source.database}, generated ${r.source.generatedAt}`);
  if (r.error) {
    lines.push(`ERROR: ${r.error}`);
    lines.push(r.tablesLoaded
      ? 'Table data IS loaded, but sign-ins or files did not finish. Fix the cause and run again with --replace.'
      : 'Table data was not changed: the transaction rolled back or never started.');
    return lines.join('\n');
  }

  section('Times');
  lines.push(`  MySQL TIMESTAMP columns read as ${r.timestamps.timestampColumnsWrittenIn} (${r.timestamps.basis})`);
  lines.push(`  MySQL DATETIME columns read as ${r.timestamps.datetimeColumnsWrittenIn} (Manila wall-clock)`);
  if (r.timestamps.latestCreatedAt) lines.push(`  Latest created_at: ${r.timestamps.latestCreatedAt}. It should be just before the dump was made.`);

  section('Row counts');
  lines.push(`  ${'table'.padEnd(40)} ${'dump'.padStart(7)} ${'loaded'.padStart(7)} ${'skipped'.padStart(7)} ${'target'.padStart(7)}`);
  for (const t of r.tables) lines.push(`  ${t.table.padEnd(40)} ${String(t.inDump).padStart(7)} ${String(t.loaded).padStart(7)} ${String(t.skipped).padStart(7)} ${String(t.inTarget).padStart(7)}${t.match ? '' : '  MISMATCH'}`);
  const sum = (key) => r.tables.reduce((n, t) => n + t[key], 0);
  lines.push(`  ${'TOTAL'.padEnd(40)} ${String(sum('inDump')).padStart(7)} ${String(sum('loaded')).padStart(7)} ${String(sum('skipped')).padStart(7)} ${String(sum('inTarget')).padStart(7)}`);

  section('Left out on purpose');
  for (const t of r.skippedTables) lines.push(`  table ${t.table}: ${t.rows} row(s), ${t.reason}`);
  for (const c of r.droppedColumns) lines.push(`  column ${c.column}: ${c.reason}`);
  for (const t of r.emptyTables) lines.push(`  table ${t}: not in the dump, starts empty or keeps its reference rows`);
  for (const c of r.defaultedColumns) lines.push(`  column ${c}: not in the dump, uses its default`);

  section('Data problems');
  if (!r.issues.length) lines.push('  None.');
  for (const i of r.issues) lines.push(`  ${i.table}.${i.column}: ${i.reason}. ${i.action} on ${i.count} row(s), ids ${i.rowIds.join(', ')}${i.count > i.rowIds.length ? ', ...' : ''}`);

  section('Sign-ins (Supabase Auth)');
  lines.push(`  ${r.auth.created} created with their password hash, ${r.auth.linkedExisting} already existed and were linked (password left alone)`);
  if (r.auth.authUsersWithoutAppUser) lines.push(`  ${r.auth.authUsersWithoutAppUser} sign-in(s) match no imported user. They were left alone.`);
  for (const s of r.auth.skipped) lines.push(`  SKIPPED user ${s.userId}: ${s.reason}`);
  for (const s of r.auth.failed) lines.push(`  FAILED user ${s.userId}: ${s.reason}`);

  section('Files (Supabase Storage)');
  if (!r.files.run) {
    lines.push(`  NOT RUN: no --files folder given. The database refers to ${r.files.referenced} file(s).`);
  } else {
    lines.push(`  Uploaded ${r.files.uploaded.private} to private, ${r.files.uploaded.public} to public (${r.files.bytes} bytes). ${r.files.unreferencedUploaded} of them no row refers to.`);
    for (const m of r.files.missing) lines.push(`  MISSING ${m.table} ${m.id}: ${m.file} is not in the folder`);
    for (const f of r.files.failed) lines.push(`  FAILED ${f.file}: ${f.reason}`);
    for (const f of r.files.ignored) lines.push(`  IGNORED ${f}: hidden file or database backup`);
  }
  for (const d of r.files.unusableDisks) lines.push(`  NOT COPIED ${d.table} ${d.id}: disk "${d.disk}" has no bucket`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- stand-ins and real services

/** Rehearsal stand-in for Supabase Auth. Keeps hashes in memory, so tests can read what would be sent. */
export function standInAuth(db) {
  const hashes = new Map();
  return {
    hashes,
    listUsers: () => db.query('select id, email from auth.users'),
    async createUser({ email, passwordHash }) {
      const [row] = await db.query('insert into auth.users (email) values ($1) returning id', [email]);
      hashes.set(email, passwordHash);
      return row.id;
    },
  };
}

export function standInFiles() {
  const store = new Map();
  return { store, async put(bucket, path, bytes, contentType) { store.set(`${bucket}/${path}`, { bytes, contentType }); } };
}

async function rehearsalTarget() {
  const { createTestPg, pgliteDb } = await import('../tests/support/testDb.ts');
  const db = pgliteDb(await createTestPg({ seed: false }));
  return { db, auth: standInAuth(db), files: standInFiles(), close: async () => {} };
}

async function supabaseTarget() {
  const { SUPABASE_DB_URL: dbUrl, VITE_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!dbUrl || !url || !key) throw new Error('Set SUPABASE_DB_URL, VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.');
  const [{ default: postgres }, { createClient }, { postgresDb }, { supabaseFiles }] = await Promise.all([
    import('postgres'), import('@supabase/supabase-js'), import('../supabase/functions/api/lib/db.ts'), import('../supabase/functions/api/services/supabaseFiles.ts'),
  ]);
  const db = postgresDb(postgres, dbUrl, { max: 1 });
  const { admin } = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }).auth;
  const auth = {
    async listUsers() {
      const users = [];
      for (let page = 1; ; page += 1) {
        const { data, error } = await admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`Could not list sign-ins: ${error.message}`);
        users.push(...data.users);
        if (data.users.length < 1000) return users;
      }
    },
    async createUser({ email, passwordHash }) {
      const { data, error } = await admin.createUser({ email, password_hash: passwordHash, email_confirm: true });
      if (error) throw new Error(error.message);
      return data.user.id;
    },
  };
  return { db, auth, files: supabaseFiles(url, key), close: () => db.close() };
}

const USAGE = `Usage: npm run import:mysql -- --target pglite|supabase --dump <file.sql> [options]
  --target pglite     Rehearsal on in-memory Postgres with stand-ins for Auth and Storage.
  --target supabase   The real project. Needs SUPABASE_DB_URL, VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
  --files <dir>       Laravel's storage/app folder, holding private/ and public/.
  --replace           Erase existing table data first. Without it, a database with data is refused.
  --report <file>     Where to write the JSON report (default import-report.json).
  --timestamp-zone    Offset of TIMESTAMP columns, such as +00:00, if the dump header is wrong or absent.`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        target: { type: 'string' }, dump: { type: 'string' }, files: { type: 'string' }, replace: { type: 'boolean', default: false },
        report: { type: 'string', default: 'import-report.json' }, 'timestamp-zone': { type: 'string' }, help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help || !values.dump || !['pglite', 'supabase'].includes(values.target)) {
    console.error(USAGE);
    return values.help ? 0 : 2;
  }

  const target = await (values.target === 'pglite' ? rehearsalTarget() : supabaseTarget());
  const report = await runImport({
    dumpPath: values.dump, db: target.db, auth: target.auth, files: target.files, filesDir: values.files ?? null, replace: values.replace, timestampZone: values['timestamp-zone'] ?? null,
  });
  await target.close();

  report.target = values.target;
  writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  if (values.target === 'pglite') console.log('\nRehearsal only: the in-memory database is gone now, and nothing was sent to Supabase.');
  console.log(`\nFull report: ${resolve(values.report)}`);
  return report.status === 'loaded' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
