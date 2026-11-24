// The morning of the defense: today's production and counts, recorded through the real API at the
// real time (so nothing is back-dated and every ledger rule applies). CJ's branch is left alone so
// production and the supply request can be shown live there. Safe to run twice: idempotency keys.
import type { Db, Row } from './common.ts';
import { manilaDay } from './common.ts';
import { BRANCHES } from './branchSpecs.ts';
import { createApp } from '../../functions/api/app.ts';
import type { FileStore } from '../../functions/api/lib/env.ts';

const SKIP = ['cj@gmail.com'];
/** Branches whose counts stay stale on purpose (the Branches page and forecast show it). */
const NO_COUNT = ['dailydash@demo.herald.local'];

export async function recordToday(db: Db, files: FileStore, log: (s: string) => void = () => {}, options: { anyHour?: boolean } = {}) {
  const now = new Date();
  const day = manilaDay(now);
  const hour = Number(new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(11, 13));
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (!options.anyHour && (weekday === 0 || weekday === 6)) throw new Error(`Today (${day}) is a weekend: run this on a weekday.`);
  if (!options.anyHour && (hour < 7 || hour >= 17)) throw new Error(`It is ${hour}:00 in Manila: run this between 7:00 AM and 5:00 PM.`);
  const fraction = Math.min(0.6, Math.max(0.2, (hour - 6) / 10));

  const refuse = async () => { throw new Error('not available in the demo runner'); };
  const auth = { signIn: async () => null, verify: async (t: string) => (t.startsWith('demo:') ? { authUserId: t.slice(5), sessionId: null } : null), createUser: refuse, updateUser: refuse, deleteUser: refuse, revoke: async () => {}, revokeOthers: async () => {}, revokeAll: async () => {} };
  const app = createApp({ db, auth, files, costingEnabled: false } as never);
  const call = async (authUserId: string, path: string, body: Row) => {
    const res = await app.request(`/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer demo:${authUserId}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) as Row | null };
  };

  const report: Row[] = [];
  for (const spec of BRANCHES) {
    if (SKIP.includes(spec.email)) continue;
    const [b] = await db.query(
      `select u.auth_user_id, l.id as location_id, l.name from users u join franchisees f on f.user_id = u.id join franchise_locations l on l.franchisee_id = f.id where lower(u.email) = $1 and l.is_active = true`, [spec.email],
    );
    if (!b) { log(`${spec.email}: no active branch, skipped`); continue; }
    // A typical weekday so far: the last 4 weeks' average per recipe, scaled to the hour.
    const recipes = await db.query(
      `select r.id, r.name, r.brand_product_id, round(sum(pb.quantity_pieces)::numeric / 20)::int as per_day from profittrack_production_batches pb join profittrack_recipes r on r.id = pb.recipe_id
       where pb.location_id = $1 and pb.voided_at is null and pb.created_at >= now() - interval '28 days' and extract(isodow from pb.created_at at time zone 'Asia/Manila') <= 5
       group by r.id, r.name, r.brand_product_id having r.brand_product_id is not null order by 4 desc`, [b.location_id],
    );
    const [done] = await db.query(`select count(*)::int as n from profittrack_operations where location_id = $1 and idempotency_key like $2`, [b.location_id, `demo-today-${day}-${b.location_id}-%`]);
    if (done.n > 0) { log(`${b.name}: already recorded today, skipped`); report.push({ branch: b.name, production_entries: 'already done', pieces: 0, skipped_for_stock: 0, materials_counted: 0 }); continue; }
    let made = 0;
    let pieces = 0;
    let short = 0;
    for (const recipe of recipes) {
      const quantity = Math.round(recipe.per_day * fraction);
      if (quantity < 1) continue;
      // The same route the Branch Workspace Production form uses.
      const r = await call(b.auth_user_id, '/branch/workspace/produce-product', { idempotency_key: `demo-today-${day}-${b.location_id}-${recipe.id}`, items: [{ brand_product_id: recipe.brand_product_id, quantity_pieces: quantity }] });
      if (r.status < 300) { made += 1; pieces += quantity; } else { short += 1; if (process.env.DEMO_DEBUG) log(`${recipe.name}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); }
    }
    // A morning count of three materials at their current balance (no adjustment, just a fresh count).
    let counted = 0;
    if (!NO_COUNT.includes(spec.email)) {
      const mats = await db.query(
        `select m.id, coalesce(bal.quantity_milli, 0)::bigint as on_hand from profittrack_materials m left join profittrack_material_balances bal on bal.material_id = m.id
         where m.location_id = $1 and m.is_active = true order by m.id limit 3`, [b.location_id],
      );
      if (mats.length) {
        const r = await call(b.auth_user_id, '/branch/workspace/physical-count', { idempotency_key: `demo-today-count-${day}-${b.location_id}`, items: mats.map((m) => ({ material_id: m.id, counted_quantity_milli: Number(m.on_hand) })) });
        if (r.status < 300) counted = mats.length; else if (process.env.DEMO_DEBUG) log(`count: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
      }
    }
    report.push({ branch: b.name, production_entries: made, pieces, skipped_for_stock: short, materials_counted: counted });
    log(`${b.name}: ${made} production entries (${pieces} pcs), ${counted} counts`);
  }
  return report;
}
