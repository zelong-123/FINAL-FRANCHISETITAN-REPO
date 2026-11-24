// Writes a simulated branch the way the ledger API writes it: operations, production batches with
// their consumptions and movements, physical counts, receipts, balances and the audit trail.
import type { Db, Row } from './common.ts';
import { addDays, Batch, Ids, LAST_DAY, MODELS } from './common.ts';
import type { SimResult } from './branches.ts';
import { evaluate } from '../../functions/api/services/materialStock.ts';

const COUNT_LABELS: Record<string, string> = {
  spoiled: 'Spoiled or expired', damaged: 'Damaged', spilled: 'Spilled or wasted', unrecorded_use: 'Used but not recorded', encoding_error: 'Encoding error', other: 'Other',
};

export async function writeLedger(db: Db, ids: Ids, batch: Batch, sim: SimResult, adminId: number) {
  const b = sim.branch;
  const loc = Number(b.location.id);
  const user = Number(b.user.id);
  const stamp = (d: Date) => ({ created_at: d, updated_at: d });
  for (const day of sim.days) {
    for (const p of day.batches) {
      const op = await ids.next('profittrack_operations');
      const id = await ids.next('profittrack_production_batches');
      const key = `demo-prod-${op}`;
      batch.add('profittrack_operations', { id: op, location_id: loc, type: 'production', idempotency_key: key, request_fingerprint: 'demo', recorded_by_user_id: user, reason: null, occurred_at: p.at, ...stamp(p.at) });
      batch.add('profittrack_production_batches', { id, location_id: loc, operation_id: op, recipe_id: p.recipe.id, recipe_version_id: p.recipe.versionId, quantity_pieces: p.pieces, total_cost_cents: 0, unit_cost_micropesos: 0, ...stamp(p.at) });
      for (const ing of p.recipe.ingredients) {
        const mat = b.mats.find((m) => m.id === ing.materialId)!;
        const q = ing.perPiece * p.pieces;
        batch.add('profittrack_production_consumptions', { id: await ids.next('profittrack_production_consumptions'), location_id: loc, batch_id: id, material_id: mat.id, quantity_milli: q, unit_cost_micropesos: 0, total_cost_cents: 0, material_name_snapshot: mat.name, unit_snapshot: mat.unit, ...stamp(p.at) });
        batch.add('profittrack_material_movements', { id: await ids.next('profittrack_material_movements'), location_id: loc, material_id: mat.id, type: 'production_consumption', quantity_delta_milli: -q, value_delta_cents: null, unit_cost_micropesos: null, operation_id: op, reason: `Production ${key}`, recorded_by_user_id: user, occurred_at: p.at, ...stamp(p.at) });
      }
      batch.add('profittrack_audit_events', { id: await ids.next('profittrack_audit_events'), location_id: loc, actor_user_id: user, action: 'production.recorded', entity_type: 'production_batch', entity_id: id, reason: null, metadata: { recipe_id: p.recipe.id, quantity_pieces: p.pieces }, occurred_at: p.at, ...stamp(p.at) });
    }
    if (day.counts) {
      const op = await ids.next('profittrack_operations');
      const at = day.counts.at;
      batch.add('profittrack_operations', { id: op, location_id: loc, type: 'count_batch', idempotency_key: `demo-count-${op}`, request_fingerprint: 'demo', recorded_by_user_id: user, reason: 'Physical count', occurred_at: at, ...stamp(at) });
      for (const item of day.counts.items) {
        const count = await ids.next('profittrack_counts');
        const reason = item.counted === item.before ? 'Counted, no change' : COUNT_LABELS[item.code ?? 'other'];
        batch.add('profittrack_counts', { id: count, location_id: loc, operation_id: op, material_id: item.mat.id, recorded_quantity_milli: item.before, counted_quantity_milli: item.counted, quantity_delta_milli: item.counted - item.before, unit_cost_micropesos: null, value_delta_cents: null, ...stamp(at) });
        batch.add('profittrack_material_movements', { id: await ids.next('profittrack_material_movements'), location_id: loc, material_id: item.mat.id, type: 'physical_count', quantity_delta_milli: item.counted - item.before, value_delta_cents: null, unit_cost_micropesos: null, operation_id: op, reason, recorded_by_user_id: user, occurred_at: at, ...stamp(at) });
        batch.add('profittrack_audit_events', { id: await ids.next('profittrack_audit_events'), location_id: loc, actor_user_id: user, action: 'material.counted', entity_type: 'material_count', entity_id: count, reason, metadata: null, occurred_at: at, ...stamp(at) });
      }
    }
  }
  for (const rc of sim.receipts) {
    for (const line of rc.lines) {
      if (line.milli <= 0) continue;
      const mv = await ids.next('profittrack_material_movements');
      const reason = `Received ${rc.req.number}`;
      batch.add('profittrack_material_movements', { id: mv, location_id: loc, material_id: line.mat.id, type: 'receipt', quantity_delta_milli: line.milli, value_delta_cents: 0, unit_cost_micropesos: 0, operation_id: null, idempotency_key: `receipt-${rc.req.id}-${line.mat.wp}`, request_fingerprint: 'demo', reason, recorded_by_user_id: user, occurred_at: rc.at, ...stamp(rc.at) });
      batch.add('profittrack_audit_events', { id: await ids.next('profittrack_audit_events'), location_id: loc, actor_user_id: user, action: 'material.delivered', entity_type: 'material_movement', entity_id: mv, reason, metadata: null, occurred_at: rc.at, ...stamp(rc.at) });
    }
  }
  // Final balances, finished goods, stock status, and the forecast shape (perishable cap, unmapped link).
  const shape = b.spec.forecast;
  for (const m of b.mats) {
    const q = sim.stock.get(m.id) ?? 0;
    await db.query(`update profittrack_material_balances set quantity_milli = $2, value_cents = null, unit_cost_micropesos = null, updated_at = $3 where id = $1`, [m.balanceId, q, new Date(`${LAST_DAY}T21:00:00+08:00`)]);
    const status = evaluate({ unit: m.unit, low_level: m.low, critical_level: m.critical, balance: { quantity_milli: q } }).status;
    const maxCover = shape.maxCover && shape.maxCover.test(m.name) && !b.mats.some((x) => x.id < m.id && shape.maxCover!.test(x.name)) ? 3 : null;
    const unmapped = shape.unmapped && shape.unmapped.test(m.name) && !b.mats.some((x) => x.id < m.id && shape.unmapped!.test(x.name));
    await db.query(`update profittrack_materials set stock_status = $2, stock_status_changed_at = $3, max_cover_days = $4 ${unmapped ? ', warehouse_product_id = null' : ''} where id = $1`,
      [m.id, status, new Date(`${addDays(LAST_DAY, -1)}T20:30:00+08:00`), maxCover]);
  }
  for (const r of b.recipes) if (r.finishedId) await db.query(`update profittrack_finished_balances set quantity_pieces = $2 where id = $1`, [r.finishedId, sim.finished.get(r.id) ?? 0]);
  // Forecast: closed periods and the excluded week, recorded by Admin (with reasons).
  for (const [from, to, reason] of shape.closures ?? []) {
    batch.add('forecast_closure_periods', { id: await ids.next('forecast_closure_periods'), location_id: loc, starts_on: from, ends_on: to, reason, created_by_user_id: adminId, created_at: new Date(`${addDays(from, -3)}T10:00:00+08:00`), updated_at: new Date(`${addDays(from, -3)}T10:00:00+08:00`) });
  }
  if (shape.excludedWeek) {
    const [monday, reason] = shape.excludedWeek;
    batch.add('forecast_week_exclusions', { id: await ids.next('forecast_week_exclusions'), location_id: loc, material_id: null, week_start: monday, reason, created_by_user_id: adminId, created_at: new Date(`${addDays(monday, 7)}T10:00:00+08:00`), updated_at: new Date(`${addDays(monday, 7)}T10:00:00+08:00`) });
  }
}

export const LEDGER_ORDER = ['profittrack_operations', 'profittrack_production_batches', 'profittrack_production_consumptions', 'profittrack_counts', 'profittrack_material_movements', 'profittrack_audit_events', 'forecast_closure_periods', 'forecast_week_exclusions'];
export type { Row };
export { MODELS };
