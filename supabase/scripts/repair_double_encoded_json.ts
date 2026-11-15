// Repairs jsonb values that were stored as a JSON *string* holding an object/array (double-encoded by
// a data script that used a raw postgres client): '"{\"a\":1}"' becomes '{"a":1}'. Every jsonb column
// in the public schema is scanned; only values whose text is an object or array are touched. Each
// repaired row is logged in audit_logs (data.json_double_encoding_repaired). Append-only history tables
// (a *_append_only trigger refuses updates) are never changed: they are only reported, and the API
// reads such values as JSON.
//
//   node --no-warnings supabase/scripts/repair_double_encoded_json.ts --dry-run
//   node --no-warnings supabase/scripts/repair_double_encoded_json.ts --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

export type RepairPlan = { table: string; column: string; ids: number[]; append_only: boolean };
const STRINGY = (col: string) => `jsonb_typeof("${col}") = 'string' and ("${col}" #>> '{}') ~ '^\\s*[\\[{]'`;

export async function repairDoubleEncodedJson(db: Db, apply: boolean): Promise<RepairPlan[]> {
  const columns = await db.query(
    `select c.table_name, c.column_name from information_schema.columns c
     join information_schema.columns k on k.table_schema = c.table_schema and k.table_name = c.table_name and k.column_name = 'id'
     where c.table_schema = 'public' and c.data_type = 'jsonb' order by c.table_name, c.column_name`,
  );
  const appendOnly = new Set((await db.query(
    `select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and t.tgname like '%append_only%' and not t.tgisinternal`,
  )).map((r: Row) => String(r.relname)));
  const plans: RepairPlan[] = [];
  for (const { table_name: table, column_name: column } of columns as Row[]) {
    const rows = await db.query(`select id from public."${table}" where ${STRINGY(column)} order by id`);
    if (rows.length) plans.push({ table, column, ids: rows.map((r: Row) => Number(r.id)), append_only: appendOnly.has(table) });
  }
  if (!apply || !plans.some((p) => !p.append_only)) return plans;
  await db.tx(async (tx) => {
    for (const p of plans.filter((x) => !x.append_only)) {
      const fixed = await tx.query(
        `update public."${p.table}" set "${p.column}" = ("${p.column}" #>> '{}')::jsonb where id = any($1::bigint[]) and ${STRINGY(p.column)} returning id`,
        [`{${p.ids.join(',')}}`],
      );
      for (const r of fixed) {
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.json_double_encoding_repaired', $1, $2, $3, $4, now())`,
          [`table:${p.table}`, r.id, JSON.stringify({ column: p.column, stored_as: 'json string' }), JSON.stringify({ column: p.column, stored_as: 'json object', script: 'repair_double_encoded_json' })],
        );
      }
    }
  });
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/repair_double_encoded_json.ts'));
if (isMain) {
  const apply = process.argv.includes('--apply');
  if (apply === process.argv.includes('--dry-run')) { console.error('Usage: exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  try {
    const plans = apply ? await repairDoubleEncodedJson(db, true) : await readOnly(db, (tx) => repairDoubleEncodedJson(tx, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({ table: p.table, column: p.column, rows: p.ids.length, action: p.append_only ? 'kept (append-only history; read as JSON)' : apply ? 'repaired' : 'repair',
      ids: p.ids.length > 10 ? `${p.ids.slice(0, 10).join(', ')}, …` : p.ids.join(', ') })));
    const fix = plans.filter((p) => !p.append_only);
    console.log(`${fix.reduce((n, p) => n + p.ids.length, 0)} values to repair in ${fix.length} columns; ${plans.filter((p) => p.append_only).reduce((n, p) => n + p.ids.length, 0)} append-only values kept`);
  } finally {
    await db.close();
  }
}
