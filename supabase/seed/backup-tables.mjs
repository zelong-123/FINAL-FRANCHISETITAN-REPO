// Read-only JSON backup of every table in the public schema, before a data change.
// Usage (from the project root): node supabase/seed/backup-tables.mjs
// Reads SUPABASE_DB_URL from .env; writes backup/<label>-<timestamp>/<table>.json plus _manifest.json.
// The backup/ folder is git-ignored: it holds real personal data, never commit it.
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is missing in .env');
const label = process.argv[2] || 'backup';
const dir = path.join('backup', `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(dir, { recursive: true });

const sql = postgres(env.SUPABASE_DB_URL, { max: 1, ssl: 'require', onnotice: () => {} });
try {
  const manifest = { taken_at: new Date().toISOString(), tables: {} };
  await sql.begin('isolation level repeatable read read only', async (tx) => {
    const tables = await tx`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    for (const { table_name: table } of tables) {
      const rows = await tx.unsafe(`select * from public."${table}"`);
      fs.writeFileSync(path.join(dir, `${table}.json`), JSON.stringify(rows, null, 1));
      manifest.tables[table] = rows.length;
    }
  });
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2));
  const total = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`Backup written to ${dir}: ${Object.keys(manifest.tables).length} tables, ${total} rows.`);
} finally {
  await sql.end();
}
