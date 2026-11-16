// Objective 2: branch inventory visibility — physical count, status / levels / last count for the
// franchisee, stock-status tracking, the Branches alert cards, stale data and count-unit levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, setup } from '../support/harness.ts';
import * as ledger from '../../supabase/functions/api/services/ledger.ts';

const { pg, db, call, login, auth } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const w = '/branch/workspace';
let n = 0;

async function branchAccount() {
  n += 1;
  const email = `stock.owner${n}@test.local`;
  const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, $2, $3, 'active', $4::uuid) returning id, full_name`, [roleRow.id, `Stock Owner ${n}`, email, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ($1, 'active_franchisee', $2, $3, '2026-01-01') returning id`, [`Stock Owner ${n}`, user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
  const [location] = await q(
    `insert into franchise_locations (franchisee_id, brand_id, name, branch_code, type, address, city, is_active) values ($1, $2, $3, $4, 'franchise', 'Addr', 'Pasig', true) returning *`,
    [franchisee.id, brand.id, `Stock Branch ${n}`, `SB-${n}-${user.id}`],
  );
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { token: res.json.data.token as string, id: Number(location.id), location, user: { id: Number(user.id), full_name: user.full_name } };
}

/** A material with the given quantity on hand (received) and optional levels. */
async function material(b: Awaited<ReturnType<typeof branchAccount>>, name: string, unit: string, quantity: number, levels?: { low: number; critical: number }) {
  const created = await call('POST', '/profittrack/materials', { token: b.token, body: { name, unit } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = Number(created.json.data.id);
  if (levels) await q(`update profittrack_materials set low_level = $2, critical_level = $3 where id = $1`, [id, levels.low, levels.critical]);
  if (quantity > 0) {
    const received = await call('POST', '/profittrack/materials/receive', { token: b.token, body: { material_id: id, quantity_milli: Math.round(quantity * 1000), total_cost_cents: 0, idempotency_key: `rcv-${id}-${quantity}` } });
    assert.equal(received.status, 201, JSON.stringify(received.json));
  }
  return id;
}
const tracked = async (id: number) => (await q(`select stock_status, stock_status_changed_at from profittrack_materials where id = $1`, [id]))[0];
const count = (b: { token: string }, key: string, items: any[]) => call('POST', `${w}/physical-count`, { token: b.token, body: { idempotency_key: key, items } });

test('physical count: a franchisee batch writes balances, movements, count rows (one operation) and audits', async () => {
  const b = await branchAccount();
  const milk = await material(b, 'Fresh Milk', 'L', 10, { low: 5, critical: 2 });
  const lids = await material(b, 'Dome Lid', 'pcs', 83, { low: 30, critical: 10 });
  const mango = await material(b, 'Mango Puree', 'kg', 4.21, { low: 2, critical: 1 });
  const before = (await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [mango]))[0].quantity_milli;

  const res = await count(b, 'count-1', [
    { material_id: milk, counted_quantity_milli: 9500, reason_code: 'spoiled' },
    { material_id: lids, counted_quantity_milli: 83000 },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.counted, 2);
  assert.equal(res.json.data.adjusted, 1);
  assert.match(res.json.message, /2 counted, 1 adjusted\./);
  const milkRow = res.json.data.items.find((i: any) => i.material_id === milk);
  assert.deepEqual([milkRow.before_quantity_milli, milkRow.counted_quantity_milli, milkRow.delta_milli, milkRow.status_before, milkRow.status_after], [10000, 9500, -500, 'ok', 'ok']);

  assert.equal(Number((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [milk]))[0].quantity_milli), 9500);
  const ops = await q(`select id, type from profittrack_operations where location_id = $1 and idempotency_key = 'count-1'`, [b.id]);
  assert.deepEqual(ops.map((o) => o.type), ['count_batch']);
  const counts = await q(`select material_id, operation_id from profittrack_counts where operation_id = $1 order by material_id`, [ops[0].id]);
  assert.equal(counts.length, 2, 'one profittrack_counts row per item, linked to the single count_batch operation');
  const moves = await q(`select material_id, quantity_delta_milli, reason from profittrack_material_movements where operation_id = $1 and type = 'physical_count' order by material_id`, [ops[0].id]);
  assert.deepEqual(moves.map((m) => [Number(m.material_id), Number(m.quantity_delta_milli), m.reason]), [[milk, -500, 'Spoiled or expired'], [lids, 0, 'Counted, no change']]);
  assert.equal((await q(`select count(*)::int c from profittrack_audit_events where location_id = $1 and action = 'material.counted'`, [b.id]))[0].c, 2);
  assert.equal(Number((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [mango]))[0].quantity_milli), Number(before), 'a partial count leaves the rest untouched');

  // Worse status is reported, and "other" needs a note.
  const worse = await count(b, 'count-2', [{ material_id: mango, counted_quantity_milli: 1500, reason_code: 'other', note: 'Left out overnight' }]);
  assert.equal(worse.status, 201, JSON.stringify(worse.json));
  assert.match(worse.json.message, /Mango Puree is now Low stock/);
  assert.equal((await q(`select reason from profittrack_material_movements where material_id = $1 and type = 'physical_count'`, [mango]))[0].reason, 'Other: Left out overnight');

  // The history list shows counts with their reason.
  const history = await call('GET', `${w}/count-history`, { token: b.token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.data.slice(0, 3).map((h: any) => h.reason).sort(), ['Counted, no change', 'Other: Left out overnight', 'Spoiled or expired']);
});

test('physical count: validation, ownership, idempotency, roles and all-or-nothing', async () => {
  const b = await branchAccount();
  const other = await branchAccount();
  const milk = await material(b, 'Milk', 'L', 10);
  const cups = await material(b, 'Cups', 'pcs', 100);
  const theirs = await material(other, 'Their Milk', 'L', 10);

  assert.match((await count(b, 'v1', [{ material_id: milk, counted_quantity_milli: 9000 }])).json.errors['items.0.reason_code'][0], /differs from the system/);
  assert.match((await count(b, 'v2', [{ material_id: milk, counted_quantity_milli: 9000, reason_code: 'other' }])).json.errors['items.0.note'][0], /short note/);
  assert.match((await count(b, 'v3', [{ material_id: milk, counted_quantity_milli: 9000, reason_code: 'magic' }])).json.errors['items.0.reason_code'][0], /valid reason/);
  assert.match((await count(b, 'v4', [{ material_id: milk, counted_quantity_milli: 1000, reason_code: 'damaged' }, { material_id: milk, counted_quantity_milli: 2000, reason_code: 'damaged' }])).json.errors['items.1.material_id'][0], /twice/);
  assert.ok((await count(b, 'v5', [{ material_id: milk, counted_quantity_milli: -1, reason_code: 'damaged' }])).json.errors['items.0.counted_quantity_milli']);
  assert.ok((await count(b, 'v6', [{ material_id: milk, counted_quantity_milli: 1.5, reason_code: 'damaged' }])).json.errors['items.0.counted_quantity_milli']);
  assert.equal((await count(b, 'v7', [])).status, 422);
  assert.equal((await count(b, 'v8', [{ material_id: theirs, counted_quantity_milli: 1000, reason_code: 'damaged' }])).status, 404, "another branch's material");

  // All or nothing: the second item fails, so the first is not saved either.
  const allOrNothing = await count(b, 'v9', [{ material_id: cups, counted_quantity_milli: 90000, reason_code: 'damaged' }, { material_id: milk, counted_quantity_milli: 9000 }]);
  assert.equal(allOrNothing.status, 422);
  assert.equal(Number((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [cups]))[0].quantity_milli), 100000, 'nothing was saved');
  assert.equal((await q(`select count(*)::int c from profittrack_operations where idempotency_key = 'v9'`))[0].c, 0);

  const first = await count(b, 'same-key', [{ material_id: milk, counted_quantity_milli: 8000, reason_code: 'spilled' }]);
  assert.equal(first.status, 201);
  const again = await count(b, 'same-key', [{ material_id: milk, counted_quantity_milli: 8000, reason_code: 'spilled' }]);
  assert.equal(again.status, 200);
  assert.equal(again.json.data.duplicate, true);
  assert.deepEqual(again.json.data.items.map((i: any) => i.delta_milli), [-2000], 'the original result');
  assert.equal((await q(`select count(*)::int c from profittrack_counts where material_id = $1`, [milk]))[0].c, 1, 'no double posting');
  assert.match((await count(b, 'same-key', [{ material_id: milk, counted_quantity_milli: 7000, reason_code: 'spilled' }])).json.errors.idempotency_key[0], /different data/);

  const body = { idempotency_key: 'staff', branch_code: b.location.branch_code, items: [{ material_id: milk, counted_quantity_milli: 1000, reason_code: 'damaged' }] };
  assert.equal((await call('POST', `${w}/physical-count`, { token: admin, body })).status, 403, 'Admin cannot submit');
  assert.equal((await call('POST', `${w}/physical-count`, { token: logistics, body })).status, 403, 'Logistics cannot submit');
});

test('materials endpoint: status, levels, levels_source and last count are added; existing fields unchanged', async () => {
  const b = await branchAccount();
  const set = await material(b, 'Syrup', 'L', 1.5, { low: 3, critical: 2 });
  const dflt = await material(b, 'Straws', 'pcs', 500);
  const res = await call('GET', `${w}/materials`, { token: b.token });
  assert.equal(res.status, 200);
  const syrup = res.json.data.find((m: any) => m.id === set);
  for (const key of ['id', 'name', 'variant', 'unit', 'source', 'is_active', 'balance', 'low_level', 'critical_level']) assert.ok(key in syrup, `keeps ${key}`);
  assert.equal(syrup.balance.quantity_milli, 1500);
  assert.deepEqual([syrup.on_hand, syrup.low_level, syrup.critical_level, syrup.levels_source, syrup.status, syrup.status_label, syrup.last_counted_at], [1.5, 3, 2, 'set', 'critical', 'Critical', null]);
  const straws = res.json.data.find((m: any) => m.id === dflt);
  assert.deepEqual([straws.levels_source, straws.low_level, straws.critical_level, straws.status], ['default', 50, 10, 'ok']);
  await count(b, 'mat-count', [{ material_id: dflt, counted_quantity_milli: 500000 }]);
  assert.ok((await call('GET', `${w}/materials`, { token: b.token })).json.data.find((m: any) => m.id === dflt).last_counted_at);
  // Admin preview reads the same data.
  assert.equal((await call('GET', `${w}/materials`, { token: admin, body: undefined })).status, 404, 'Admin must name the branch');
});

test('stock status tracking: every balance-changing path and the levels change update the status and its time', async () => {
  const b = await branchAccount();
  const actor = { id: b.user.id, full_name: b.user.full_name };
  const sugar = await material(b, 'Sugar', 'kg', 10, { low: 5, critical: 2 });
  assert.equal((await tracked(sugar)).stock_status, 'ok', 'created empty (first status, no timestamp), then received to Normal');
  const fresh = await material(b, 'Brand New', 'kg', 0);
  assert.deepEqual([(await tracked(fresh)).stock_status, (await tracked(fresh)).stock_status_changed_at], ['out', null], 'a new empty material is not a new alert');

  // Production (via the ledger) drops Sugar to Low.
  const recipe = await ledger.createRecipe(db, b.location, actor, { name: 'Syrup', sku: `SY-${b.id}`, standard_price_cents: 0, ingredients: [{ material_id: sugar, quantity_milli_per_piece: 6000 }] });
  const made = await ledger.produce(db, b.location, actor, { recipe_id: recipe.id, quantity_pieces: 1, idempotency_key: `prod-${b.id}`, allow_unvalued: true });
  let s = await tracked(sugar);
  assert.equal(s.stock_status, 'low');
  assert.ok(s.stock_status_changed_at, 'production stamps the change');
  const afterProduction = new Date(s.stock_status_changed_at).getTime();

  // Production void restores it (no movement is written, but the status follows).
  await ledger.voidProduction(db, b.location, actor, made.batch.id, 'Wrong batch recorded');
  s = await tracked(sugar);
  assert.equal(s.stock_status, 'ok');
  assert.ok(new Date(s.stock_status_changed_at).getTime() >= afterProduction);

  // Receipt with no status change: the timestamp stays.
  const stamp = (await tracked(sugar)).stock_status_changed_at;
  await call('POST', '/profittrack/materials/receive', { token: b.token, body: { material_id: sugar, quantity_milli: 1000, total_cost_cents: 0, idempotency_key: `rcv-more-${sugar}` } });
  assert.equal(String((await tracked(sugar)).stock_status_changed_at), String(stamp), 'no change when the status stays the same');

  // Physical count to Critical.
  await count(b, `crit-${sugar}`, [{ material_id: sugar, counted_quantity_milli: 1500, reason_code: 'spilled' }]);
  assert.equal((await tracked(sugar)).stock_status, 'critical');

  // Levels change by Logistics (manual) and reset: both resync.
  const levels = (body: any) => call('PATCH', `/branches/${b.id}/materials/${sugar}/levels`, { token: logistics, body });
  assert.equal((await levels({ low_level: 1.4, critical_level: 1 })).status, 200);
  assert.equal((await tracked(sugar)).stock_status, 'ok', 'a lower threshold makes 1.5 kg Normal');
  assert.equal((await levels({ reset: true })).status, 200);
  assert.equal((await tracked(sugar)).stock_status, 'low', 'reset to the kg defaults (5 / 1): 1.5 kg is Low again');

  // CSV import receipt, and Confirm Receipt (supply workflow) on a delivered request.
  const csv = await call('POST', `${w}/materials-import`, { token: b.token, body: { csv: 'material_name,variant,unit,quantity\nSugar,,kg,10\n', resolutions: { 'sugar||kg': 'combine' } } });
  assert.equal(csv.status, 200, JSON.stringify(csv.json));
  assert.equal((await tracked(sugar)).stock_status, 'ok', 'CSV import');

  const [product] = await q(`insert into products (brand_id, sku, name, unit) values ($1, $2, 'Lids Stock', 'pcs') returning id`, [brand.id, `LID-${b.id}`]);
  const lids = await material(b, 'Lids', 'pcs', 5, { low: 30, critical: 10 });
  await q(`update profittrack_materials set warehouse_product_id = $2 where id = $1`, [lids, product.id]);
  assert.equal((await tracked(lids)).stock_status, 'critical');
  const [request] = await q(`insert into supply_requests (location_id, request_number, status, requested_by_user_id, delivery_address) values ($1, $2, 'delivered', $3, 'Addr') returning id`, [b.id, `SV-${b.id}`, b.user.id]);
  const [item] = await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested, quantity_endorsed, quantity_prepared) values ($1, $2, 100, 100, 100) returning id`, [request.id, product.id]);
  await q(`insert into deliveries (supply_request_id, dispatched_at, pod_encoded_at) values ($1, now(), now())`, [request.id]);
  const confirmed = await call('POST', `/supply-requests/${request.id}/receipt`, { token: b.token, body: { lines: [{ item_id: item.id, good: 100, damaged: 0, short: 0 }] } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  const l = await tracked(lids);
  assert.equal(l.stock_status, 'ok', 'Confirm Receipt');
  assert.ok(l.stock_status_changed_at);
});

test('stock alerts: low / critical / out only, open request, is_new before and after seen, new_counts, roles', async () => {
  const b = await branchAccount();
  const fine = await material(b, 'Fine Item', 'kg', 50);
  const lowItem = await material(b, 'Alert Low', 'kg', 20, { low: 5, critical: 2 });
  const critItem = await material(b, 'Alert Critical', 'kg', 20, { low: 5, critical: 2 });
  const [product] = await q(`insert into products (brand_id, sku, name, unit) values ($1, $2, 'Alert Critical Stock', 'kg') returning id`, [brand.id, `AC-${b.id}`]);
  await q(`update profittrack_materials set warehouse_product_id = $2 where id = $1`, [critItem, product.id]);
  const [request] = await q(`insert into supply_requests (location_id, request_number, status, requested_by_user_id, delivery_address) values ($1, $2, 'under_review', $3, 'Addr') returning id`, [b.id, `REQ-AL-${b.id}`, b.user.id]);
  await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested) values ($1, $2, 10)`, [request.id, product.id]);

  const alerts = async (token = logistics) => (await call('GET', '/branches/stock-alerts', { token })).json.data;
  await call('POST', '/branches/stock-alerts/seen', { token: logistics, body: {} });
  await count(b, 'alerts-1', [
    { material_id: lowItem, counted_quantity_milli: 4000, reason_code: 'damaged' },
    { material_id: critItem, counted_quantity_milli: 1000, reason_code: 'spoiled' },
  ]);
  const data = await alerts();
  const mine = data.items.filter((i: any) => i.branch_id === b.id);
  assert.deepEqual(mine.map((i: any) => i.material_id).sort(), [lowItem, critItem].sort(), 'only low, critical and out');
  assert.ok(!mine.some((i: any) => i.material_id === fine));
  const crit = mine.find((i: any) => i.material_id === critItem);
  assert.deepEqual([crit.status, crit.is_new, crit.source], ['critical', true, 'physical count']);
  assert.deepEqual(crit.open_request, { request_number: `REQ-AL-${b.id}`, status: 'under_review' });
  assert.equal(mine.find((i: any) => i.material_id === lowItem).open_request, null);
  assert.ok(data.new_counts.low >= 1 && data.new_counts.critical >= 1);
  const overview = (await call('GET', '/branches/overview', { token: logistics })).json.data;
  assert.equal(overview.summary.new_low_count, data.new_counts.low, 'the overview summary agrees');
  assert.equal(overview.summary.new_critical_count, data.new_counts.critical);

  assert.equal((await call('POST', '/branches/stock-alerts/seen', { token: logistics, body: {} })).status, 200);
  const after = await alerts();
  assert.ok(!after.items.some((i: any) => i.is_new), 'nothing is new after Mark as seen');
  assert.deepEqual(after.new_counts, { low: 0, critical: 0 });
  assert.equal(after.items.filter((i: any) => i.branch_id === b.id).length, 2, 'the items stay listed');
  assert.ok((await alerts(admin)).items.some((i: any) => i.material_id === critItem && i.is_new === true), "Admin's seen marker is separate from Logistics'");

  assert.equal((await call('GET', '/branches/stock-alerts', { token: b.token })).status, 403);
  assert.equal((await call('POST', '/branches/stock-alerts/seen', { token: b.token, body: {} })).status, 403);
});

test('stale data: from real counts only (profittrack_counts), older and newer than 3 days', async () => {
  const fresh = await branchAccount();
  const old = await branchAccount();
  const fake = await branchAccount();
  const a = await material(fresh, 'Counted Today', 'kg', 10);
  const o = await material(old, 'Counted Long Ago', 'kg', 10);
  const f = await material(fake, 'Seeded Usage Only', 'kg', 10);
  await count(fresh, 'stale-fresh', [{ material_id: a, counted_quantity_milli: 10000 }]);
  await count(old, 'stale-old', [{ material_id: o, counted_quantity_milli: 10000 }]);
  await q(`update profittrack_operations set occurred_at = now() - interval '5 days' where location_id = $1 and idempotency_key = 'stale-old'`, [old.id]);
  // A bare physical_count movement (like the supply demo seed's usage history) is NOT a count.
  await q(`insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at) values ($1, $2, 'physical_count', -500, 'Used', $3, now())`, [fake.id, f, fake.user.id]);

  const overview = (await call('GET', '/branches/overview', { token: admin })).json.data;
  const card = (id: number) => overview.branches.find((x: any) => x.id === id);
  assert.ok(card(fresh.id).last_count_at);
  assert.equal(card(fresh.id).is_stale, false);
  assert.ok(card(old.id).last_count_at);
  assert.equal(card(old.id).is_stale, true, 'older than 3 days');
  assert.equal(card(fake.id).last_count_at, null, 'a physical_count movement without a count row does not change the last count');
  assert.equal(card(fake.id).is_stale, true);
  const staleNow = overview.summary.stale_branches;
  assert.ok(staleNow >= 2);
  assert.equal(overview.summary.stale_count_days, 3);
  const s = overview.summary;
  assert.equal(s.live_branches + s.demo_branches + s.without_portal_account, s.active_branches, 'the Active branches breakdown adds up');

  const ops = (await call('GET', `/branches/${old.id}/operations`, { token: admin })).json.data;
  assert.equal(ops.branch.is_stale, true);
  assert.ok(ops.inventory.find((r: any) => r.id === o).last_counted_at);
  assert.equal(ops.inventory.find((r: any) => r.id === o).levels_source, 'default');
  assert.equal((await call('GET', `${w}/materials`, { token: fake.token })).json.data.find((m: any) => m.id === f).last_counted_at, null);

  await count(old, 'stale-old-2', [{ material_id: o, counted_quantity_milli: 10000 }]);
  const later = (await call('GET', '/branches/overview', { token: admin })).json.data;
  assert.equal(later.branches.find((x: any) => x.id === old.id).is_stale, false, 'a new count clears it');
  assert.equal(later.summary.stale_branches, staleNow - 1);
});

test('levels: count units need whole numbers; other units keep decimals; Admin stays read-only', async () => {
  const b = await branchAccount();
  const cups = await material(b, 'Cups 16oz', 'pcs', 40);
  const milk = await material(b, 'Milk Levels', 'L', 4);
  const set = (id: number, body: any, token = logistics) => call('PATCH', `/branches/${b.id}/materials/${id}/levels`, { token, body });
  assert.match((await set(cups, { low_level: 50.5, critical_level: 15 })).json.errors.low_level[0], /whole number/);
  assert.match((await set(cups, { low_level: 50, critical_level: 15.2 })).json.errors.critical_level[0], /whole number/);
  assert.equal((await set(cups, { low_level: 50, critical_level: 15 })).status, 200);
  assert.equal((await set(milk, { low_level: 1.25, critical_level: 0.5 })).status, 200, 'decimals are fine for L');
  assert.equal((await set(milk, { low_level: 2, critical_level: 1 }, admin)).status, 403, 'Admin cannot edit levels');
});
