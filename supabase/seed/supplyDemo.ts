// LOCAL-ONLY demo data for the supply workflow (Objective 3). It runs only inside the in-memory
// dev API (`npm run dev:api:demo`): it refuses anything but a PGlite database created in this
// process, and needs an explicit { local: true }. It can never reach a live database.
//
// What it builds, for the Kkopi brand:
// - Warehouse products and stock (Logistics adds them through the API).
// - Branch inventory with ten complete weeks of usage at two branches, so Days covered and
//   Suggested show real numbers; Fresh milk is Critical at Kkopi - Las Piñas Sample.
// - Requests in every state of the ten demo scenarios (see docs/defense-demo.md, Objective 3).
import { PGlite } from '@electric-sql/pglite';
import type { Row } from '../functions/api/lib/db.ts';

type PG = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>; dataDir?: string };
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

const KKOPI = 1;
const SAMPLE = 2; // Kkopi - Las Piñas Sample (franchisee@franchisetitan.local)
const BRANCH1 = 3; // Herald Branch 1 - Las Piñas
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

// name, unit, warehouse stock, weekly use at SAMPLE and BRANCH1, on hand now, low and critical levels
const CATALOG: [string, string, number, number, number, number, number, number, number][] = [
  ['Coffee beans', 'kg', 120, 14, 10, 6, 6, 8, 3],
  ['Fresh milk', 'l', 16, 35, 28, 1, 2, 12, 5],
  ['Paper cups 12oz', 'pcs', 600, 700, 500, 260, 220, 400, 150],
  ['Caramel syrup', 'bottle', 4, 3, 2, 2, 3, 2, 1],
  ['White sugar', 'kg', 60, 5, 4, 9, 7, 4, 2],
  ['Cup lids', 'pcs', 900, 700, 500, 300, 240, 400, 150],
];

export async function seedSupplyDemo(pg: PG, app: App, options: { local?: boolean; password?: string } = {}) {
  // ---- the local guard ----
  if (options.local !== true) throw new Error('supplyDemo: refused. Call it with { local: true } from the local dev API only.');
  // An in-process PGlite with no data directory lives only in this process's memory.
  if (!(pg instanceof PGlite) || (pg.dataDir && pg.dataDir !== 'memory://')) throw new Error('supplyDemo: refused. Only the in-memory PGlite database of npm run dev:api:demo may be seeded.');
  const q = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows;
  if ((await q(`select count(*)::int as n from supply_requests`))[0].n > 0) return { skipped: 'supply requests already exist' };

  const password = options.password ?? 'Password123!';
  const login = async (email: string, portal?: string) => {
    const res = await app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, ...(portal ? { portal } : {}) }) });
    const json = await res.json() as Row;
    if (!json?.data?.token) throw new Error(`supplyDemo: cannot sign in as ${email}`);
    return json.data.token as string;
  };
  const admin = await login('admin@franchisetitan.local');
  const logistics = await login('logistics@franchisetitan.local');
  const branch = await login('franchisee@franchisetitan.local', 'branch');
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData;
    const res = await app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body && !form ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) });
    const json = await res.json().catch(() => null) as Row | null;
    if (res.status >= 400) throw new Error(`supplyDemo: ${method} ${path} -> ${res.status} ${JSON.stringify(json?.errors ?? json?.message)}`);
    return json?.data;
  };

  // ---- warehouse products (through the API, as Logistics would) ----
  const [category] = await q(`select id from product_categories where brand_id = $1 order by id limit 1`, [KKOPI]);
  const P: Record<string, Row> = {};
  for (const [name, unit, stock] of CATALOG) {
    const item = await call(logistics, 'POST', '/inventories/items', { name, brand_id: KKOPI, category_id: category?.id ?? null, unit, reorder_level: 5, critical_level: 1, opening_quantity: stock });
    P[name] = { id: item.product_id, unit };
  }

  // ---- branch inventory and ten complete weeks of usage (SQL: history has to be dated back) ----
  const [{ monday }] = await q(`select date_trunc('week', now() at time zone 'Asia/Manila')::date as monday`);
  const [owner] = await q(`select id from users where email = 'franchisee@franchisetitan.local'`);
  for (const [name, unit, , useSample, useBranch1, onSample, onBranch1, low, critical] of CATALOG) {
    for (const [location, weekly, onHand] of [[SAMPLE, useSample, onSample], [BRANCH1, useBranch1, onBranch1]] as const) {
      const [m] = await q(
        `insert into profittrack_materials (location_id, name, unit, warehouse_product_id, source, low_level, critical_level) values ($1, $2, $3, $4, 'Warehouse', $5, $6) returning id`,
        [location, name, unit, P[name].id, low, critical],
      );
      await q(`insert into profittrack_material_balances (location_id, material_id, quantity_milli, value_cents) values ($1, $2, $3, 0)`, [location, m.id, Math.round(onHand * 1000)]);
      for (let ago = 10; ago >= 1; ago--) {
        await q(
          `insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at)
           values ($1, $2, 'physical_count', $3, 'Used', $4, (($5::date - $6 * 7) + 2)::timestamp at time zone 'Asia/Manila')`,
          [location, m.id, -Math.round(weekly * 1000 * (0.9 + ((ago * 7) % 5) / 25)), owner?.id ?? null, monday, ago],
        );
      }
    }
  }

  // ---- requests in every state ----
  const items = (...pairs: [string, number][]) => pairs.map(([n, quantity]) => ({ product_id: P[n].id, quantity_requested: quantity }));
  // A bulk reason only where the quantity is really far above the suggestion (the API says so).
  const make = async (token: string, location: number, list: Row[], extra: Row = {}) => {
    const body = { location_id: location, delivery_address: location === SAMPLE ? 'Las Piñas City' : 'Alabang–Zapote Road, Las Piñas', items: list, ...extra };
    try {
      return await call(token, 'POST', '/supply-requests', body);
    } catch (error) {
      if (!String((error as Error).message).includes('bulk_reason')) throw error;
      return call(token, 'POST', '/supply-requests', { ...body, bulk_reason: 'Stock for the weekend promo' });
    }
  };
  const act = (token: string, id: number, action: string, body: Row = {}) => call(token, 'POST', `/supply-requests/${id}/${action}`, body);
  const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const driver = (departed: string, eta: string) => ({ driver_name: 'Juan Dela Cruz', driver_contact: '09171234567', plate_number: 'NBC 1234', departed_at: departed, eta_at: eta });
  const toPreparing = async (id: number) => { await act(admin, id, 'start-review'); await act(admin, id, 'endorse'); await act(logistics, id, 'accept-schedule'); await act(logistics, id, 'prepare'); };
  const pod = async (id: number, actual = ago(30)) => {
    const f = new FormData(); f.append('file', new File([PNG], 'pod.png', { type: 'image/png' })); f.append('received_by', 'Ana Santos'); f.append('actual_delivered_at', actual);
    return call(logistics, 'POST', `/supply-requests/${id}/pod`, f);
  };
  const made: Row = {};

  // 1. Normal, full stock, completed.
  const s1 = await make(branch, SAMPLE, items(['Coffee beans', 10], ['Cup lids', 200]));
  await toPreparing(s1.id); const d1 = await act(logistics, s1.id, 'dispatch', driver(ago(600), ago(480))); await pod(s1.id);
  await call(branch, 'POST', `/supply-requests/${s1.id}/receipt`, { lines: d1.items.map((i: Row) => ({ item_id: i.id, good: Number(i.quantity_prepared), damaged: 0, short: 0 })) });
  made.completed = s1.request_number;
  // 2. Short, not urgent: Hold for Restock (resume after Logistics adds caramel syrup).
  const s2 = await make(admin, BRANCH1, items(['Caramel syrup', 10]));
  await act(admin, s2.id, 'start-review');
  await act(admin, s2.id, 'fulfillment', { type: 'hold', reason: 'Waiting for the syrup supplier', items: [{ item_id: s2.items[0].id, restock_date: later(4) }] });
  made.on_hold = s2.request_number;
  // 3. Short and Critical: Partial – Ship Now with the -B backorder.
  const s3 = await make(branch, SAMPLE, items(['Fresh milk', 30]), { urgency: 'critical', urgency_reason: 'Out of milk since this morning', target_delivery_date: (await call(branch, 'GET', '/supply-settings')).earliest_urgent });
  await act(admin, s3.id, 'start-review');
  const split = await act(admin, s3.id, 'fulfillment', { type: 'partial_ship_now', reason: 'Ship the available milk today', items: [{ item_id: s3.items[0].id, restock_date: later(2) }] });
  made.partial = s3.request_number; made.backorder = split.result.child.request_number;
  // 5. Bulk, returned for correction (the branch edits and resubmits in the demo).
  const s5 = await make(branch, SAMPLE, items(['White sugar', 60]), { bulk_reason: 'Town fiesta next week' });
  await act(admin, s5.id, 'start-review'); await act(admin, s5.id, 'return', { reason: 'Please order one week only' });
  made.returned = s5.request_number;
  // 6. Logistics asked for a new date; Admin decides in the demo.
  const s6 = await make(admin, BRANCH1, items(['Cup lids', 100]));
  await act(admin, s6.id, 'start-review'); await act(admin, s6.id, 'endorse');
  await act(logistics, s6.id, 'date-change', { proposed_date: later(6), reason: 'The truck is in repair' });
  made.date_change = s6.request_number;
  // 7. Logistics reported a shortage; Admin makes a new decision in the demo.
  const s7 = await make(branch, SAMPLE, items(['White sugar', 8]));
  await act(admin, s7.id, 'start-review'); await act(admin, s7.id, 'endorse'); await act(logistics, s7.id, 'accept-schedule');
  await act(logistics, s7.id, 'shortage', { reason: 'Two bags were wet', items: [{ item_id: s7.items[0].id, actual_count: 6 }] });
  made.shortage = s7.request_number;
  // 8. Dispatched last Thursday with a Sunday ETA, received by the branch; the POD is still to encode.
  let thursday = new Date(Date.now() - 7 * 86_400_000);
  while (thursday.getUTCDay() !== 4) thursday = new Date(thursday.getTime() - 86_400_000);
  const day = thursday.toISOString().slice(0, 10);
  const sunday = new Date(Date.parse(`${day}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  const s8 = await make(branch, SAMPLE, items(['Coffee beans', 4]));
  await toPreparing(s8.id);
  const d8 = await act(logistics, s8.id, 'dispatch', driver(`${day}T15:00:00+08:00`, `${sunday}T10:00:00+08:00`));
  await call(branch, 'POST', `/supply-requests/${s8.id}/receipt`, { lines: d8.items.map((i: Row) => ({ item_id: i.id, good: Number(i.quantity_prepared), damaged: 0, short: 0 })) });
  made.weekend = s8.request_number;
  // 9. Damaged items: discrepancy review with the branch's photo.
  const s9 = await make(branch, SAMPLE, items(['Paper cups 12oz', 200]));
  await toPreparing(s9.id); const d9 = await act(logistics, s9.id, 'dispatch', driver(ago(300), ago(200))); await pod(s9.id);
  const rf = new FormData();
  rf.append('lines', JSON.stringify([{ item_id: d9.items[0].id, good: 190, damaged: 10, short: 0, damage_reason: 'Crushed box' }]));
  rf.append(`photo_${d9.items[0].id}`, new File([PNG], 'damage.png', { type: 'image/png' }));
  await call(branch, 'POST', `/supply-requests/${s9.id}/receipt`, rf);
  made.discrepancy = s9.request_number;
  // 4. Partial – Consolidated: the available cups are reserved for one trip.
  const s4 = await make(admin, BRANCH1, items(['Paper cups 12oz', 800]));
  await act(admin, s4.id, 'start-review');
  await act(admin, s4.id, 'fulfillment', { type: 'partial_consolidated', reason: 'Same trip once the cups arrive', items: [{ item_id: s4.items[0].id, restock_date: later(5) }] });
  made.consolidated = s4.request_number;
  // Delivered (POD in), waiting for the branch's Confirm Receipt.
  const s10 = await make(branch, SAMPLE, items(['Cup lids', 150]));
  await toPreparing(s10.id); await act(logistics, s10.id, 'dispatch', driver(ago(180), ago(60))); await pod(s10.id);
  made.delivered = s10.request_number;
  // 10. For the permissions walkthrough: one submitted (branch can still cancel), one under review,
  // and one Admin has left for a week (overdue).
  made.submitted = (await make(branch, SAMPLE, items(['Coffee beans', 6]))).request_number;
  const s12 = await make(admin, BRANCH1, items(['Fresh milk', 10]));
  await act(admin, s12.id, 'start-review');
  made.under_review = s12.request_number;
  const s13 = await make(admin, BRANCH1, items(['White sugar', 3]));
  await q(`update supply_requests set status_changed_at = now() - interval '7 days', created_at = now() - interval '7 days' where id = $1`, [s13.id]);
  made.overdue = s13.request_number;
  return made;
}
