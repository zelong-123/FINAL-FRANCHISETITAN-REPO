// Replaces the product catalogue with supabase/seed/products.csv (see replaceProducts.ts).
//
//   node supabase/seed/replace-products.mjs            dry run: does everything, prints the report, rolls back
//   node supabase/seed/replace-products.mjs --apply    does it for real (one transaction)
//
// Reads SUPABASE_DB_URL from .env (server-side only; never put it in the frontend or the repo).
// Take a backup first: node supabase/seed/backup-tables.mjs pre-product-replace
import fs from 'node:fs';
import postgres from 'postgres';
import { postgresDb } from '../functions/api/lib/db.ts';
import { replaceProducts } from './replaceProducts.ts';

const apply = process.argv.includes('--apply');
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is missing in .env');
const csv = fs.readFileSync(new URL('./products.csv', import.meta.url), 'utf8');

const ROLLBACK = Symbol('dry run');
const db = postgresDb(postgres, env.SUPABASE_DB_URL, { max: 1 });
let report;
try {
  await db.tx(async (tx) => {
    report = await replaceProducts(tx, csv);
    if (!apply) throw ROLLBACK;
  });
} catch (error) {
  if (error !== ROLLBACK) throw error;
} finally {
  await db.close();
}
console.log(JSON.stringify(report, null, 2));
console.log(apply ? '\nApplied: the catalogue now matches products.csv.' : '\nDry run only: nothing was changed. Add --apply to run it for real.');
