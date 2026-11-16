// Read-only use of the existing estimated-requirement forecast for the supply workflow: the
// suggested quantity (the same figure EstimateHint shows) and the days covered, per warehouse
// product, for one branch. Nothing here changes how the forecast is calculated.
import type { Db, Row } from '../lib/db.ts';
import { forLocation, settingsFrom, settingsRow } from './forecast.ts';
import { phpRound } from './forecast.ts';

export interface ProductForecast { suggested: number | null; days_covered: number | null }

export async function forecastFor(db: Db, location: Row, productIds: number[]): Promise<Map<number, ProductForecast>> {
  const out = new Map<number, ProductForecast>();
  if (!productIds.length) return out;
  let result: Row;
  try {
    result = await forLocation(db, location, 1, settingsFrom(await settingsRow(db)));
  } catch {
    return out; // no forecast for this branch yet: the checks that need it are skipped
  }
  for (const id of productIds) {
    let suggested = 0;
    let ready = false;
    let days: number | null = null;
    for (const item of result.items ?? []) {
      if (Number(item.warehouse_product?.product_id) !== Number(id)) continue;
      if (item.days_left !== null && item.days_left !== undefined) days = days === null ? Number(item.days_left) : Math.min(days, Number(item.days_left));
      if (!item.warehouse_product?.unit_match) continue; // a quantity in another unit cannot be added to the product's
      suggested += item.suggested_reorder ?? 0;
      ready = ready || Boolean(item.ready);
    }
    out.set(Number(id), { suggested: ready ? phpRound(suggested, 3) : null, days_covered: days });
  }
  return out;
}
