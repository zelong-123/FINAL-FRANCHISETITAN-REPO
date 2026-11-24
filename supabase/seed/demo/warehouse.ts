// The Central Warehouse: its history is rebuilt from the supply draws. Supplier deliveries arrive on
// the 1st and 16th of each month (sized to the next two weeks of draws), every dispatch is a
// 'fulfillment' transaction, and the final stock gives a mix of Normal, Low and Critical items while
// still covering every active reservation (and keeping the on-hold items short).
import type { Db, Row } from './common.ts';
import { addDays, at, Batch, Ids, LAST_DAY, MODELS, nextWeekday, rng, round } from './common.ts';
import type { Draw, Reserve } from './supply.ts';
import type { SimResult } from './branches.ts';

export async function writeWarehouse(db: Db, ids: Ids, batch: Batch, input: { draws: Draw[]; reserves: Reserve[]; holds: { productId: number; requested: number }[]; sims: SimResult[]; logistics: Row; warehouseId: number }) {
  const { draws, reserves, holds, logistics, warehouseId } = input;
  const r = rng('warehouse');
  const rows = await db.query(`select i.*, p.name, p.brand_id, p.unit from inventories i join products p on p.id = i.product_id where i.location_id = $1`, [warehouseId]);
  const byProduct = new Map<number, Row>(rows.map((x) => [Number(x.product_id), x]));
  // Products drawn by branches that have no warehouse row yet get one.
  for (const productId of new Set(draws.map((d) => d.productId))) {
    if (byProduct.has(productId)) continue;
    const id = await ids.next('inventories');
    const [p] = await db.query(`select id, name, brand_id, unit from products where id = $1`, [productId]);
    const row = { id, location_id: warehouseId, product_id: productId, current_stock: 0, reorder_level: 10, critical_level: 4, name: p.name, brand_id: p.brand_id, unit: p.unit };
    await db.query(`insert into inventories (id, location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, $3, 0, 10, 4)`, [id, warehouseId, productId]);
    byProduct.set(productId, row);
  }
  const reserved = new Map<number, number>();
  for (const x of reserves) reserved.set(x.productId, (reserved.get(x.productId) ?? 0) + x.qty);
  const held = new Map<number, number>(holds.map((h) => [h.productId, h.requested]));
  const start = '2025-06-02';
  const audit = (inv: Row, action: string, before: number, after: number, note: string, when: Date) => batch.add('inventory_audit_logs', {
    id: null, actor_user_id: logistics.id, actor_role: 'logistics', brand_id: inv.brand_id, product_id: inv.product_id, inventory_id: inv.id, action, source: 'manual', old_quantity: before, new_quantity: after, note, created_at: when, updated_at: when,
  });
  let lowCount = 0; let criticalCount = 0;
  for (const [productId, inv] of byProduct) {
    const mine = draws.filter((d) => d.productId === productId).sort((a, c) => a.at.getTime() - c.at.getTime());
    const reorder = Number(inv.reorder_level);
    const critical = Number(inv.critical_level);
    const monthly = mine.filter((d) => d.at >= at(addDays(LAST_DAY, -30), '00:00')).reduce((s, d) => s + d.qty, 0);
    // The final stock: mostly healthy, a few Low and Critical (never below what is reserved).
    const need = reserved.get(productId) ?? 0;
    let target: number;
    if (held.has(productId)) target = round(Math.max(0, held.get(productId)! * 0.3 + need), 2);
    else if (need === 0 && monthly > 0 && criticalCount < 3 && r.chance(0.12)) { target = round(Math.max(0.5, critical * 0.6), 2); criticalCount += 1; }
    else if (need === 0 && monthly > 0 && lowCount < 6 && r.chance(0.2)) { target = round((critical + reorder) / 2, 2); lowCount += 1; }
    else target = round(Math.max(reorder * (1.4 + r.next()), need + reorder, monthly * (0.9 + 0.8 * r.next())), 0);
    // Opening stock, then supplier deliveries on the 1st and 16th covering the next two weeks of draws.
    let stock = 0;
    const txns: Row[] = [];
    const push = (type: string, qty: number, when: Date, remarks: string, ref: Draw | null = null) => {
      const before = stock;
      stock = round(stock + qty, 2);
      txns.push({ id: null, inventory_id: inv.id, type, quantity: qty, balance_before: before, balance_after: stock, reference_type: ref ? MODELS.supply : null, reference_id: ref ? ref.requestId : null, remarks, recorded_by_user_id: logistics.id, transaction_date: when, created_at: when, updated_at: when });
      if (type !== 'fulfillment' || when >= at(addDays(LAST_DAY, -60), '00:00')) audit(inv, type === 'fulfillment' ? 'supply_request' : 'stock_adjusted', before, stock, remarks, when);
    };
    const firstDraw = mine[0]?.at ?? at(addDays(LAST_DAY, -60), '09:00');
    const openDay = firstDraw < at(start, '00:00') ? start : addDays(firstDraw.toISOString().slice(0, 10), -10);
    push('opening', Math.max(reorder * 2, round(mine.filter((d) => d.at < at(addDays(openDay, 20), '00:00')).reduce((s, d) => s + d.qty, 0) + reorder, 0)), at(openDay, '08:00'), 'Opening stock count');
    const restockDays: string[] = [];
    for (let d = openDay; d <= LAST_DAY; d = addDays(d, 1)) if (d.endsWith('-01') || d.endsWith('-16')) restockDays.push(nextWeekday(d));
    let di = 0;
    for (const day of restockDays) {
      const until = at(addDays(day, 16), '00:00');
      while (di < mine.length && mine[di].at < at(day, '07:00')) { const d = mine[di++]; if (stock < d.qty) push('adjustment_in', round(d.qty - stock + reorder, 0), new Date(d.at.getTime() - 3_600_000), 'Supplier delivery received at the Central Warehouse.'); push('fulfillment', -d.qty, d.at, `Dispatched ${d.number}`, d); }
      const upcoming = mine.filter((d) => d.at >= at(day, '07:00') && d.at < until).reduce((s, d) => s + d.qty, 0);
      const want = round(upcoming + reorder * 1.2 - stock, 0);
      if (want > 0 && day < LAST_DAY) push('adjustment_in', want, at(day, '08:30'), 'Supplier delivery received at the Central Warehouse.');
    }
    while (di < mine.length) { const d = mine[di++]; if (stock < d.qty) push('adjustment_in', round(d.qty - stock + reorder, 0), new Date(d.at.getTime() - 3_600_000), 'Supplier delivery received at the Central Warehouse.'); push('fulfillment', -d.qty, d.at, `Dispatched ${d.number}`, d); }
    // Land on the final stock with one last movement on Nov 20.
    const diff = round(target - stock, 2);
    if (diff > 0) push('adjustment_in', diff, at('2026-11-20', '08:30'), 'Supplier delivery received at the Central Warehouse.');
    else if (diff < 0) push('adjustment_out', diff, at('2026-11-20', '16:40'), 'Expired and damaged stock removed after the cycle count.');
    txns.sort((a, c) => a.transaction_date.getTime() - c.transaction_date.getTime());
    let running = 0;
    for (const t of txns) { t.balance_before = running; running = round(running + t.quantity, 2); t.balance_after = running; if (running < -1e-6) throw new Error(`Negative warehouse stock for ${inv.name}`); t.id = await ids.next('inventory_transactions'); batch.add('inventory_transactions', t); }
    await db.query(`update inventories set current_stock = $2, last_counted_at = $3, updated_by_user_id = $4, updated_at = $3 where id = $1`, [inv.id, running, at('2026-11-20', '16:45'), logistics.id]);
  }
  for (const a of batch.tables.get('inventory_audit_logs') ?? []) if (a.id === null) a.id = await ids.next('inventory_audit_logs');
  // Branch inventory rows follow their deliveries (the replenishment mirror), last 90 days.
  const since = at(addDays(LAST_DAY, -90), '00:00');
  for (const sim of input.sims) {
    const totals = new Map<number, { qty: number; tx: Row[] }>();
    for (const rc of sim.receipts) {
      if (rc.at < since) continue;
      for (const line of rc.lines) {
        if (!line.mat.wp || line.milli <= 0) continue;
        const entry = totals.get(line.mat.wp) ?? { qty: 0, tx: [] };
        const q = round(line.milli / 1000, 2);
        entry.tx.push({ quantity: q, at: rc.at, ref: rc.req.id, number: rc.req.number });
        entry.qty = round(entry.qty + q, 2);
        totals.set(line.mat.wp, entry);
      }
    }
    for (const [productId, entry] of totals) {
      const invId = await ids.next('inventories');
      batch.add('inventories', { id: invId, location_id: sim.branch.location.id, product_id: productId, current_stock: entry.qty, reorder_level: 0, critical_level: 0, updated_by_user_id: sim.branch.user.id, created_at: entry.tx[0].at, updated_at: entry.tx[entry.tx.length - 1].at });
      let run = 0;
      for (const t of entry.tx) {
        batch.add('inventory_transactions', { id: await ids.next('inventory_transactions'), inventory_id: invId, type: 'replenishment', quantity: t.quantity, balance_before: run, balance_after: round(run + t.quantity, 2), reference_type: MODELS.supply, reference_id: t.ref, remarks: `Delivered ${t.number}`, recorded_by_user_id: sim.branch.user.id, transaction_date: t.at, created_at: t.at, updated_at: t.at });
        run = round(run + t.quantity, 2);
      }
    }
  }
}
