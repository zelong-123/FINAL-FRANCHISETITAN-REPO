// Defense demo data (Nov 25, 2026). Run from the project root, in this order:
//
//   node supabase/seed/backup-tables.mjs pre-demo       1. backup first (already done once)
//   npm run demo:seed                                   2. dry run: does everything, prints the report, rolls back
//   npm run demo:seed -- --apply                        3. for real (one transaction: all or nothing)
//   npm run demo:today -- --apply                       4. the morning of the defense, after 7:00 AM: today's production and counts
//
// Keeps the Products catalogue, brands, sources, raw materials, units, users, rules and settings,
// and CJ's and John Rey's applicant records. Reads SUPABASE_DB_URL, VITE_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY from .env (server-side only; never commit them).
import fs from 'node:fs';
import postgres from 'postgres';
import { postgresDb } from '../functions/api/lib/db.ts';
import { supabaseFiles } from '../functions/api/services/supabaseFiles.ts';
import { seedDefenseDemo } from './demo/index.ts';
import { recordToday } from './demo/today.ts';

const apply = process.argv.includes('--apply');
const today = process.argv.includes('--today');
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
for (const key of ['SUPABASE_DB_URL', 'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[key]) throw new Error(`${key} is missing in .env`);
if (!today && apply && !fs.existsSync('backup') ) throw new Error('No backup/ folder: run  node supabase/seed/backup-tables.mjs pre-demo  first.');

const realFiles = supabaseFiles(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// A dry run uploads nothing.
const files = apply ? realFiles : { ...realFiles, put: async () => {}, remove: async () => {} };
const ROLLBACK = Symbol('dry run');
const db = postgresDb(postgres, env.SUPABASE_DB_URL, { max: 1, ssl: 'require' });
const log = (line) => console.log(`  ${line}`);
const started = Date.now();
let result;
try {
  await db.tx(async (tx) => {
    result = today ? await recordToday(tx, files, log) : await seedDefenseDemo(tx, files, log);
    if (!apply) throw ROLLBACK;
  });
} catch (error) {
  if (error !== ROLLBACK) { console.error(`\nStopped: ${error?.message ?? error}\nNothing was changed (the transaction was rolled back).`); process.exitCode = 1; }
} finally {
  await db.close();
}
if (result && today) console.table(result);
if (result && !today) {
  const n = (t) => result.batch.count(t);
  console.table({ inquiries: n('franchise_inquiries'), applicants_new: n('applicants'), applicants_updated: result.people.updates.length, sessions: n('schedule_sessions'), activities: n('activity_schedules'),
    requirements: n('applicant_requirements'), documents: n('documents'), payments: n('payments'), supply_requests: n('supply_requests'), production_batches: n('profittrack_production_batches') });
}
if (result) console.log(apply ? `\nApplied in ${Math.round((Date.now() - started) / 1000)} s.` : '\nDry run only: nothing was changed. Add --apply to run it for real.');
