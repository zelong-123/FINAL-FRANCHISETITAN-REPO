// Fills each franchise branch with 14 days of activity built from the real catalogue:
// supply requests from the Central Warehouse, deliveries received by the branch, daily
// production of the brand's products, and a few open requests. Every step goes through the
// system's own API routes (createApp in-process), so stock moves exactly as it does in use:
// warehouse stock drops when Logistics prepares a request, branch stock arrives when the
// branch confirms receipt, and production deducts branch stock per recipe.
//
// Order: (1) every branch is planned without writing anything; (2) the warehouse records one
// supplier delivery (Logistics "Adjust", increase) 15 days ago for exactly what the branches
// will draw, so it ends close to today's levels; (3) each branch runs its 14 days.
// New rows are dated back so the history reads naturally. The warehouse delivery and each branch
// are separate transactions; a branch that already has supply requests or branch materials is
// skipped, so a rerun changes nothing.
import type { Db, Row } from '../functions/api/lib/db.ts';
import type { AuthProvider, FileStore } from '../functions/api/lib/env.ts';
import { createApp } from '../functions/api/app.ts';

const DAYS = 14;
const HOUR = 3_600_000;
const BASE_PIECES: Record<string, number> = { kkopi: 14, 'daily dash': 12, godo: 10, 'la pasta': 6 };
const OPEN_STATUSES = ['submitted', 'under_review', 'endorsed', 'preparing'];
const SUPPLIER_NOTE = 'Supplier delivery received at the Central Warehouse.';

const key = (s: unknown) => String(s ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
/** Stable, well-mixed number for a string (FNV-1a + avalanche), so each branch gets its own picks. */
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return h >>> 0;
};
const up2 = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Acts as a given user without a password: only for this local script, never deployed. */
function trustedAuth(): AuthProvider {
  const refuse = async () => { throw new Error('Not available while seeding.'); };
  return {
    signIn: async () => null,
    verify: async (token) => (token.startsWith('seed:') ? { authUserId: token.slice(5), sessionId: null } : null),
    createUser: refuse, updateUser: refuse, deleteUser: refuse,
    revoke: async () => {}, revokeOthers: async () => {}, revokeAll: async () => {},
  };
}
const noFiles: FileStore = {
  put: async () => { throw new Error('No file uploads while seeding.'); },
  get: async () => null, remove: async () => {}, publicUrl: () => '',
};

/** Manila midnight `days` ago, plus `hours`. */
function at(days: number, hours: number, now: Date): Date {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
  return new Date(new Date(`${today}T00:00:00+08:00`).getTime() - days * 24 * HOUR + hours * HOUR);
}
const isoDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d);

// Tables whose new rows are dated back to the step that made them (updated_at is left to its trigger).
const DATED = [
  'supply_request_status_histories', 'deliveries', 'inventory_transactions', 'inventory_audit_logs', 'inventories', 'system_notifications',
  'profittrack_operations', 'profittrack_material_movements', 'profittrack_production_batches', 'profittrack_production_consumptions',
  'profittrack_audit_events', 'profittrack_materials', 'profittrack_recipes', 'profittrack_recipe_versions', 'profittrack_recipe_ingredients',
  'profittrack_finished_balances', 'profittrack_material_balances',
];

export interface BranchReport { branch: string; brand: string; status: string; delivered: number; open: string[]; production_days: number; pieces: number; materials: number }
export interface SeedReport { warehouse_restock: { items: number; lines: string[] }; branches: BranchReport[] }

interface Plan {
  branch: Row; index: number; kind: 'full' | 'awaiting';
  days: { day: number; items: { id: number; pieces: number }[] }[];
  first: Row[]; second: Row[]; open: Row[]; stage: string;
  levels: Map<number, { low: number; critical: number }>;
}

export async function seedBranchActivity(root: Db, options: { now?: Date; log?: (line: string) => void; planOnly?: boolean } = {}): Promise<SeedReport> {
  // Only one run at a time: a second run (e.g. a dry run left open in another terminal) stops here.
  const [{ locked }] = await root.query(`select pg_try_advisory_lock(hashtext('franchisetitan.seed-branch-activity')) as locked`);
  if (!locked) throw new Error('Another branch-activity run is still in progress. Wait for it to finish (or stop it), then run again.');
  try {
    return await run(root, options);
  } finally {
    await root.query(`select pg_advisory_unlock(hashtext('franchisetitan.seed-branch-activity'))`).catch(() => {});
  }
}

async function run(root: Db, options: { now?: Date; log?: (line: string) => void; planOnly?: boolean }): Promise<SeedReport> {
  const now = options.now ?? new Date();
  const log = options.log ?? (() => {});
  const one = async (sql: string, params: unknown[] = []) => (await root.query(sql, params))[0];
  const userOf = async (role: string) => {
    const u = await one(`select u.* from users u join roles r on r.id = u.role_id where r.name = $1 and u.account_status = 'active' and u.auth_user_id is not null order by u.id limit 1`, [role]);
    if (!u) throw new Error(`An active ${role} account is required.`);
    return u;
  };
  const admin = await userOf('admin');
  const logistics = await userOf('logistics');
  const warehouse = await one(`select id from franchise_locations where type = 'warehouse' and is_active order by id limit 1`);

  const tsCols: Record<string, { name: string; type: string }[]> = {};
  for (const t of DATED) {
    tsCols[t] = (await root.query(
      `select column_name as name, data_type as type from information_schema.columns where table_schema = 'public' and table_name = $1
         and data_type in ('timestamp with time zone', 'date') and column_name not in ('updated_at', 'voided_at', 'read_at', 'archived_at')`, [t],
    )).map((r) => ({ name: r.name, type: r.type }));
  }

  const branches = await root.query(
    `select l.id, l.name, l.brand_id, l.address, b.name as brand, u.auth_user_id as owner_auth, u.account_status as owner_status,
       (select count(*)::int from supply_requests s where s.location_id = l.id) + (select count(*)::int from profittrack_materials m where m.location_id = l.id) as existing
     from franchise_locations l join brands b on b.id = l.brand_id
     left join franchisees f on f.id = l.franchisee_id left join users u on u.id = f.user_id
     where l.type = 'franchise' and l.is_active and l.archived_at is null order by l.id`,
  );

  // ---- Products each brand can run: none whose warehouse item is already Low or Critical ----
  const brandProducts = new Map<number, { id: number; name: string; lines: Row[] }[]>();
  const unitOf = new Map<number, string>();
  for (const brandId of [...new Set(branches.map((b) => Number(b.brand_id)))]) {
    const rows = await root.query(
      `select bp.id, bp.name, i.product_id, p.unit, i.batch_amount_milli::float / greatest(i.yield_pieces, 1) / 1000 as per_piece,
         inv.current_stock::float as stock, inv.reorder_level::float as reorder
       from brand_products bp join brand_product_ingredients i on i.brand_product_id = bp.id join products p on p.id = i.product_id
       join inventories inv on inv.product_id = i.product_id and inv.location_id = $2
       where bp.brand_id = $1 and bp.is_active order by bp.name, i.id`, [brandId, warehouse.id],
    );
    for (const r of rows) unitOf.set(Number(r.product_id), key(r.unit));
    brandProducts.set(brandId, [...new Set(rows.map((r) => Number(r.id)))]
      .map((id) => ({ id, name: rows.find((r) => Number(r.id) === id).name, lines: rows.filter((r) => Number(r.id) === id) }))
      .filter((p) => p.lines.every((l: Row) => l.stock > l.reorder)));
  }
  const qty = (m: number, n: number) => (unitOf.get(m) === 'pcs' ? Math.ceil(n - 1e-9) : up2(n));
  const floor = (m: number) => (unitOf.get(m) === 'pcs' ? 10 : 0.2);

  // ---- 1. Plan every branch that is still empty ----
  const plans: Plan[] = [];
  const reports: BranchReport[] = [];
  for (const [index, branch] of branches.entries()) {
    if (branch.existing > 0) { reports.push({ branch: branch.name, brand: branch.brand, status: 'skipped (already has activity)', delivered: 0, open: [], production_days: 0, pieces: 0, materials: 0 }); continue; }
    const products = brandProducts.get(Number(branch.brand_id)) ?? [];
    const stage = OPEN_STATUSES[index % OPEN_STATUSES.length];
    if (branch.owner_status !== 'active' || !branch.owner_auth || !products.length) {
      // An inactive branch account cannot receive: one delivery waits for the branch to confirm it.
      const open = (products[0]?.lines ?? []).slice(0, 4).map((l: Row) => ({ product_id: Number(l.product_id), quantity_requested: qty(Number(l.product_id), Math.max(l.per_piece * 40, floor(Number(l.product_id)))) }));
      plans.push({ branch, index, kind: 'awaiting', days: [], first: [], second: [], open, stage: 'dispatched', levels: new Map() });
      continue;
    }
    const perDay = BASE_PIECES[key(branch.brand)] ?? 10;
    const rotation = [...products].sort((a, b) => hash(`${branch.id}|${a.name}`) - hash(`${branch.id}|${b.name}`));
    const days: Plan['days'] = [];
    for (let d = DAYS; d >= 1; d--) {
      const count = Math.min(rotation.length, 2 + ((d + index) % 2));
      const picked = Array.from({ length: count }, (_, j) => rotation[(d * 2 + j + index) % rotation.length]).filter((p, j, all) => all.findIndex((x) => x.id === p.id) === j);
      days.push({ day: d, items: picked.map((p, j) => ({ id: p.id, pieces: Math.max(1, Math.round((perDay / picked.length) * (0.75 + (hash(`${branch.id}|${d}|${j}`) % 50) / 100))) })) });
    }
    const lines = new Map(products.map((p) => [p.id, p.lines]));
    const useOn = (from: number, to: number) => {
      const use = new Map<number, number>();
      for (const day of days.filter((x) => x.day <= from && x.day >= to)) for (const item of day.items) for (const l of lines.get(item.id)!) {
        use.set(Number(l.product_id), (use.get(Number(l.product_id)) ?? 0) + l.per_piece * item.pieces);
      }
      return use;
    };
    const firstWeek = useOn(DAYS, 8);
    const secondWeek = useOn(7, 1);
    const all = useOn(DAYS, 1);
    const materials = [...all.keys()];
    const daily = new Map(materials.map((m) => [m, all.get(m)! / DAYS]));
    // Branch levels sized to its own usage: Low = 3 days, Critical = 1 day.
    const levels = new Map(materials.map((m) => {
      const low = r3(Math.max(3 * daily.get(m)!, floor(m) * 3));
      return [m, { low, critical: Math.min(r3(Math.max(daily.get(m)!, floor(m))), r3(low / 2)) }];
    }));
    // Branches differ: some end with one Critical item (needs attention) and one Low item, some with
    // one Low item only, some fully healthy. The open request always covers the Low item.
    const ordered = [...materials].sort((a, b) => hash(`${branch.id}|${a}`) - hash(`${branch.id}|${b}`));
    const mood = index % 3;
    const lowItem = mood === 2 ? -1 : ordered[0];
    const criticalItem = mood === 0 ? ordered[1] : -1;
    const endOf = (m: number) => {
      const l = levels.get(m)!;
      if (m === criticalItem) return r3(l.critical * 0.6);
      if (m === lowItem) return r3((l.low + l.critical) / 2);
      return r3(l.low + 4 * daily.get(m)! + floor(m));
    };
    const buffer = (m: number) => 2 * daily.get(m)!;
    const first = materials.map((m) => ({ product_id: m, quantity_requested: qty(m, (firstWeek.get(m) ?? 0) + buffer(m)) })).filter((i) => i.quantity_requested >= 0.01);
    const second = materials.map((m) => ({ product_id: m, quantity_requested: qty(m, (secondWeek.get(m) ?? 0) + endOf(m) - buffer(m)) })).filter((i) => i.quantity_requested >= 0.01);
    const open = [...(lowItem > 0 ? [lowItem] : []), ...ordered.slice(2, 4)].map((m) => ({ product_id: m, quantity_requested: qty(m, Math.max(7 * daily.get(m)!, floor(m))) }));
    plans.push({ branch, index, kind: 'full', days, first, second, open, stage, levels });
  }

  // ---- 2. One supplier delivery into the warehouse for exactly what the branches will draw ----
  const draw = new Map<number, number>();
  const add = (items: Row[]) => { for (const i of items) draw.set(i.product_id, (draw.get(i.product_id) ?? 0) + Number(i.quantity_requested)); };
  for (const p of plans) {
    add(p.first);
    add(p.second);
    if (p.kind === 'awaiting' || ['preparing'].includes(p.stage)) add(p.open);
  }
  // A run stopped part-way may already have recorded the supplier delivery while no branch was
  // filled yet: only what is still missing is added, so the warehouse is never restocked twice.
  const already = new Map<number, number>((await root.query(
    `select i.product_id, sum(t.quantity)::float as q from inventory_transactions t join inventories i on i.id = t.inventory_id
     where i.location_id = $1 and t.type = 'adjustment_in' and t.remarks = $2 group by i.product_id`, [warehouse.id, SUPPLIER_NOTE],
  )).map((r) => [Number(r.product_id), Number(r.q)]));
  for (const [productId, amount] of draw) draw.set(productId, Math.max(0, amount - (already.get(productId) ?? 0)));
  for (const [productId, amount] of draw) if (amount < 0.01) draw.delete(productId);
  if (options.planOnly) {
    return { warehouse_restock: { items: draw.size, lines: [...draw].map(([id, q]) => `${id}: +${qty(id, q)}`) }, branches: plans.map((p) => ({ branch: p.branch.name, brand: p.branch.brand, status: `planned (${p.kind})`, delivered: 0, open: [p.stage], production_days: p.days.length, pieces: p.days.reduce((s, d) => s + d.items.reduce((x, i) => x + i.pieces, 0), 0), materials: 0 })) };
  }
  const restock = { items: 0, lines: [] as string[] };
  if (draw.size) {
    await root.tx(async (db) => {
      const app = createApp({ db, auth: trustedAuth(), files: noFiles, costingEnabled: false, paymentAdvanced: false });
      const marks = await maxIds(db);
      for (const [productId, amount] of draw) {
        const [inv] = await db.query(`select i.id, p.name, p.unit from inventories i join products p on p.id = i.product_id where i.product_id = $1 and i.location_id = $2`, [productId, warehouse.id]);
        const quantity = qty(productId, amount);
        await request(app, `seed:${logistics.auth_user_id}`, 'POST', `/inventories/${inv.id}/quantity`, { direction: 'increase', quantity, note: SUPPLIER_NOTE }, 'Central Warehouse');
        restock.items++;
        restock.lines.push(`${inv.name}: +${quantity} ${inv.unit}`);
      }
      await stamp(db, marks, at(DAYS + 1, 8, now), true);
    });
    log(`warehouse: supplier delivery recorded for ${restock.items} items`);
  }

  // ---- 3. Each branch, in its own transaction ----
  for (const plan of plans) {
    const report = await root.tx((db) => runBranch(db, plan));
    reports.push(report);
    log(`${plan.branch.name}: ${report.status}`);
  }
  reports.sort((a, b) => branches.findIndex((x) => x.name === a.branch) - branches.findIndex((x) => x.name === b.branch));
  return { warehouse_restock: restock, branches: reports };

  // ---- helpers ----
  async function maxIds(db: Db) {
    return Object.fromEntries(await Promise.all(DATED.map(async (t) => [t, Number((await db.query(`select coalesce(max(id), 0) as m from public."${t}"`))[0].m)]))) as Record<string, number>;
  }
  /** Dates every row created since `marks` to `target` (never later than now). */
  async function stamp(db: Db, marks: Record<string, number>, target: Date, readNotifications: boolean) {
    const when = target > now ? new Date(now.getTime() - 60_000) : target;
    for (const t of DATED) {
      const sets = tsCols[t].map((c) => `"${c.name}" = case when "${c.name}" is null then null else ${c.type === 'date' ? '$1::date' : '$2::timestamptz'} end`);
      if (t === 'system_notifications' && readNotifications) sets.push(`read_at = $2::timestamptz`);
      // Both date parameters are referenced in every statement so Postgres always knows their types.
      if (sets.length) await db.query(`update public."${t}" set ${sets.join(', ')} where id > $3 and $1::date is not null and $2::timestamptz is not null`, [isoDate(when), when.toISOString(), marks[t]]);
    }
  }
  async function request(app: ReturnType<typeof createApp>, who: string, method: string, path: string, body: unknown, label: string) {
    const res = await app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${who}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json: any = await res.json().catch(() => null);
    if (res.status >= 400) throw new Error(`${label}: ${method} ${path} -> ${res.status} ${JSON.stringify(json?.errors ?? json?.message ?? json).slice(0, 300)}`);
    return json?.data;
  }

  async function runBranch(db: Db, plan: Plan): Promise<BranchReport> {
    const { branch } = plan;
    const app = createApp({ db, auth: trustedAuth(), files: noFiles, costingEnabled: false, paymentAdvanced: false });
    const ADMIN = `seed:${admin.auth_user_id}`;
    const LOGISTICS = `seed:${logistics.auth_user_id}`;
    const OWNER = plan.kind === 'full' ? `seed:${branch.owner_auth}` : ADMIN;
    const call = (who: string, method: string, path: string, body?: unknown) => request(app, who, method, path, body, branch.name);
    let marks = await maxIds(db);
    const step = async (when: Date, read = true) => { await stamp(db, marks, when, read); marks = await maxIds(db); };
    const address = branch.address || branch.name;
    const report: BranchReport = { branch: branch.name, brand: branch.brand, status: 'done', delivered: 0, open: [], production_days: 0, pieces: 0, materials: 0 };

    if (plan.kind === 'awaiting') {
      if (plan.open.length) {
        const sr = await call(ADMIN, 'POST', '/supply-requests', { location_id: branch.id, delivery_address: address, items: plan.open });
        await step(at(4, 10, now));
        await call(ADMIN, 'POST', `/supply-requests/${sr.id}/review`);
        await call(ADMIN, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'endorsed' });
        await step(at(4, 14, now));
        await call(LOGISTICS, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'preparing' });
        await step(at(3, 9, now));
        await call(LOGISTICS, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'dispatched' });
        await step(at(3, 13, now));
        await db.query(`update supply_requests set created_at = $2, reviewed_at = $3, endorsed_at = $3, preparing_at = $4, stock_deducted_at = $4, target_delivery_date = $5 where id = $1`,
          [sr.id, at(4, 10, now), at(4, 14, now), at(3, 9, now), isoDate(at(1, 0, now))]);
        report.open.push('dispatched (awaiting branch receipt, past target date)');
      }
      report.status = 'done (branch account inactive: delivery awaits receipt)';
      return report;
    }

    // A delivered request: submitted, reviewed, endorsed, prepared, dispatched, received, completed.
    const deliver = async (items: Row[], day: number) => {
      const sr = await call(OWNER, 'POST', '/supply-requests', { location_id: branch.id, delivery_address: address, items });
      await step(at(day + 1, 9, now));
      await call(ADMIN, 'POST', `/supply-requests/${sr.id}/review`);
      await call(ADMIN, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'endorsed' });
      await step(at(day + 1, 14, now));
      await call(LOGISTICS, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'preparing' });
      await step(at(day, 8, now));
      await call(LOGISTICS, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'dispatched' });
      await step(at(day, 10, now));
      await call(OWNER, 'POST', `/supply-requests/${sr.id}/acknowledge`, { recipient_name: 'Branch staff' });
      await step(at(day, 15, now));
      await call(ADMIN, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'completed' });
      await step(at(day, 17, now));
      await db.query(
        `update supply_requests set created_at = $2, reviewed_at = $3, endorsed_at = $3, preparing_at = $4, stock_deducted_at = $4, branch_received_at = $5, completed_at = $6, target_delivery_date = $7 where id = $1`,
        [sr.id, at(day + 1, 9, now), at(day + 1, 14, now), at(day, 8, now), at(day, 15, now), at(day, 17, now), isoDate(at(day, 0, now))],
      );
      report.delivered++;
    };

    await deliver(plan.first, DAYS);
    // Branch stock levels sized to this branch's usage (what Logistics sets on the Branches page).
    for (const m of await db.query(`select id, warehouse_product_id from profittrack_materials where location_id = $1`, [branch.id])) {
      const l = plan.levels.get(Number(m.warehouse_product_id));
      if (l) await call(LOGISTICS, 'PATCH', `/branches/${branch.id}/materials/${m.id}/levels`, { low_level: l.low, critical_level: l.critical });
    }
    await step(at(DAYS, 16, now));
    for (const day of plan.days) {
      if (day.day === 7) await deliver(plan.second, 7);
      await call(OWNER, 'POST', '/branch/workspace/produce-product', { idempotency_key: `seed-${branch.id}-${day.day}`, items: day.items.map((i) => ({ brand_product_id: i.id, quantity_pieces: i.pieces })) });
      await step(at(day.day, 19, now));
      report.production_days++;
      report.pieces += day.items.reduce((s, i) => s + i.pieces, 0);
    }

    // One open request, at a different stage per branch; it covers the Low item, not the Critical one.
    const sr = await call(OWNER, 'POST', '/supply-requests', { location_id: branch.id, delivery_address: address, items: plan.open, target_delivery_date: isoDate(at(-3, 0, now)) });
    await step(at(0, 9, now), false);
    if (plan.stage !== 'submitted') await call(ADMIN, 'POST', `/supply-requests/${sr.id}/review`);
    if (['endorsed', 'preparing'].includes(plan.stage)) await call(ADMIN, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'endorsed' });
    if (plan.stage === 'preparing') await call(LOGISTICS, 'PATCH', `/supply-requests/${sr.id}/status`, { status: 'preparing' });
    await step(at(0, 11, now), false);
    report.open.push(plan.stage);
    report.materials = (await db.query(`select count(*)::int as n from profittrack_materials where location_id = $1`, [branch.id]))[0].n;
    return report;
  }
}
