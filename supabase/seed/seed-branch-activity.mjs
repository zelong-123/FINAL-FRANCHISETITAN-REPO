// Fills every active franchise branch with 14 days of activity (see branchActivity.ts).
//
//   node supabase/seed/seed-branch-activity.mjs            dry run: does everything, prints the report, rolls back
//   node supabase/seed/seed-branch-activity.mjs --apply    does it for real
//
// Reads SUPABASE_DB_URL from .env (server-side only; never put it in the frontend or the repo).
// Take a backup first: node supabase/seed/backup-tables.mjs pre-branch-activity
import fs from 'node:fs';
import postgres from 'postgres';
import { postgresDb } from '../functions/api/lib/db.ts';
import { seedBranchActivity } from './branchActivity.ts';

const apply = process.argv.includes('--apply');
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is missing in .env');

const ROLLBACK = Symbol('dry run');
const db = postgresDb(postgres, env.SUPABASE_DB_URL, { max: 1 });
const log = (line) => console.log(`  ${line}`);
let report;
try {
  if (apply) {
    report = await seedBranchActivity(db, { log });
  } else {
    // The whole run inside one transaction that is rolled back at the end.
    await db.tx(async (tx) => {
      report = await seedBranchActivity(tx, { log });
      throw ROLLBACK;
    });
  }
} catch (error) {
  if (error !== ROLLBACK) throw error;
} finally {
  await db.close();
}
console.log(`\nWarehouse supplier delivery: ${report.warehouse_restock.items} items`);
console.table(report.branches.map((b) => ({ branch: b.branch, brand: b.brand, status: b.status, delivered: b.delivered, open: b.open.join(', '), days: b.production_days, pieces: b.pieces, materials: b.materials })));
console.log(apply ? '\nApplied.' : '\nDry run only: nothing was changed. Add --apply to run it for real.');
