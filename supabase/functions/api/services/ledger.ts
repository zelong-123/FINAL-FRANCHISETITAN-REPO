// App\Services\ProfitTrackLedger: the branch's materials, recipes, production and sales.
// Quantities are integer milli-units, money integer centavos, unit costs integer micro-pesos.
// Products of these are computed in BigInt so nothing rounds through a float.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, updateRow } from '../lib/http.ts';

const MAX_MILLI = 1_000_000_000_000;
const MAX_CENTS = 9_000_000_000_000_000;
const MAX_MICRO = 9_000_000_000_000_000;

async function fingerprintOf(payload: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))) fail(field, 'Enter a positive whole number in the supported range.');
  const n = Number(value);
  if (n < min || n > max) fail(field, 'Value is outside the supported range.');
  return n;
}
function safeAdd(a: number, b: number, max: number, field: string): number {
  const v = BigInt(a) + BigInt(b);
  if (v < 0n || v > BigInt(max)) fail(field, 'The operation exceeds supported inventory or accounting limits.');
  return Number(v);
}
function safeMultiply(a: number, b: number, max: number, field: string): number {
  const v = BigInt(a) * BigInt(b);
  if (v < 0n || v > BigInt(max)) fail(field, 'The operation exceeds supported inventory or accounting limits.');
  return Number(v);
}
/** Integer ratio rounded half-up (away from zero), with an optional power-of-ten scale. */
function roundRatio(numerator: bigint | number, denominator: bigint | number, scale = 0): number {
  const d = BigInt(denominator);
  const scaled = BigInt(numerator) * 10n ** BigInt(scale);
  const negative = (scaled < 0n) !== (d < 0n);
  const a = scaled < 0n ? -scaled : scaled;
  const b = d < 0n ? -d : d;
  const rounded = (a * 2n + b) / (b * 2n);
  return Number(negative ? -rounded : rounded);
}

const audit = (db: Db, location: Row, actor: Row, action: string, entity: string, entityId: number | null, reason: string | null = null, metadata: Row = {}) => insertRow(db, 'profittrack_audit_events', {
  location_id: location.id, actor_user_id: actor.id, action, entity_type: entity, entity_id: entityId, reason, metadata: Object.keys(metadata).length ? metadata : null, occurred_at: new Date(),
});

async function lockMaterial(tx: Db, location: Row, materialId: number) {
  const [material] = await tx.query(`select * from profittrack_materials where location_id = $1 and id = $2 for update`, [location.id, materialId]);
  if (!material) abort(404, 'Record not found.');
  const [balance] = await tx.query(`select * from profittrack_material_balances where location_id = $1 and material_id = $2 for update`, [location.id, material.id]);
  if (!balance) abort(404, 'Record not found.');
  return { material, balance };
}

const existingMovement = async (tx: Db, location: Row, key: string, fingerprint: string, what: string) => {
  const [existing] = await tx.query(
    `select m.*, (select to_jsonb(x) from profittrack_materials x where x.id = m.material_id) as material from profittrack_material_movements m where m.location_id = $1 and m.idempotency_key = $2`, [location.id, key],
  );
  if (!existing) return null;
  if (existing.request_fingerprint !== fingerprint) fail('idempotency_key', `This retry key was already used with different ${what} data.`);
  return { movement: existing, duplicate: true };
};
const withMaterial = async (tx: Db, movement: Row) => ({ ...movement, material: (await tx.query(`select * from profittrack_materials where id = $1`, [movement.material_id]))[0] });

export function addMaterial(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const material = await insertRow(tx, 'profittrack_materials', {
      location_id: location.id, name: String(data.name).trim(), variant: String(data.variant ?? '').trim(), unit: data.unit,
      warehouse_product_id: data.warehouse_product_id ?? null, source: data.source ?? (data.warehouse_product_id ? 'Warehouse' : 'Manual'),
    });
    const balance = await insertRow(tx, 'profittrack_material_balances', { location_id: location.id, material_id: material.id });
    await audit(tx, location, actor, 'material.created', 'material', material.id);
    return { ...material, balance };
  });
}

/** costingEnabled decides whether a material of unknown cost may be received. */
export async function receive(db: Db, location: Row, actor: Row, data: Row, costingEnabled = false): Promise<Row> {
  const quantity = integer(data.quantity_milli, 'quantity_milli', 1, MAX_MILLI);
  const totalCents = integer(data.total_cost_cents ?? 0, 'total_cost_cents', 0, MAX_CENTS);
  const payload = { material_id: Number(data.material_id), quantity_milli: quantity, total_cost_cents: totalCents, reason: String(data.reason ?? '').trim() };
  const fingerprint = await fingerprintOf(payload);
  return db.tx(async (tx) => {
    const again = await existingMovement(tx, location, data.idempotency_key, fingerprint, 'receipt');
    if (again) return again;
    const { material, balance } = await lockMaterial(tx, location, payload.material_id);
    const newQty = safeAdd(balance.quantity_milli, quantity, MAX_MILLI, 'quantity_milli');
    const incoming = roundRatio(totalCents, quantity, 7);
    let newValue: number | null;
    let avg: number | null;
    if (balance.quantity_milli === 0) { newValue = totalCents; avg = incoming; }
    else if (balance.value_cents === null) {
      if (costingEnabled) fail('material_id', 'This material has unknown cost; Admin must value its existing balance before receiving more.');
      newValue = null; avg = null;
    } else {
      newValue = safeAdd(balance.value_cents, totalCents, MAX_CENTS, 'total_cost_cents');
      avg = roundRatio(newValue, newQty, 7);
    }
    if ((avg ?? 0) > MAX_MICRO || (newValue ?? 0) > MAX_CENTS) fail('total_cost_cents', 'Receipt cost exceeds the supported financial limit.');
    await updateRow(tx, 'profittrack_material_balances', balance.id, { quantity_milli: newQty, value_cents: newValue, unit_cost_micropesos: avg });
    const movement = await insertRow(tx, 'profittrack_material_movements', {
      location_id: location.id, material_id: material.id, type: 'receipt', quantity_delta_milli: quantity, value_delta_cents: totalCents, unit_cost_micropesos: incoming,
      idempotency_key: data.idempotency_key, request_fingerprint: fingerprint, reason: payload.reason, recorded_by_user_id: actor.id, occurred_at: new Date(),
    });
    await audit(tx, location, actor, 'material.received', 'material_movement', movement.id, payload.reason);
    return { movement: await withMaterial(tx, movement), duplicate: false };
  });
}

/** Stock that arrived with no known cost yet: quantity only, value and unit cost untouched. */
export async function creditDelivery(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  const quantity = integer(data.quantity_milli, 'quantity_milli', 1, MAX_MILLI);
  const payload = { material_id: Number(data.material_id), quantity_milli: quantity, reason: String(data.reason ?? '').trim() };
  const fingerprint = await fingerprintOf(payload);
  return db.tx(async (tx) => {
    const again = await existingMovement(tx, location, data.idempotency_key, fingerprint, 'delivery');
    if (again) return again;
    const { material, balance } = await lockMaterial(tx, location, payload.material_id);
    await updateRow(tx, 'profittrack_material_balances', balance.id, { quantity_milli: safeAdd(balance.quantity_milli, quantity, MAX_MILLI, 'quantity_milli') });
    const movement = await insertRow(tx, 'profittrack_material_movements', {
      location_id: location.id, material_id: material.id, type: 'receipt', quantity_delta_milli: quantity, value_delta_cents: 0, unit_cost_micropesos: Number(balance.unit_cost_micropesos ?? 0),
      idempotency_key: data.idempotency_key, request_fingerprint: fingerprint, reason: payload.reason, recorded_by_user_id: actor.id, occurred_at: new Date(),
    });
    await audit(tx, location, actor, 'material.delivered', 'material_movement', movement.id, payload.reason);
    return { movement: await withMaterial(tx, movement), duplicate: false };
  });
}

export async function revalue(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  const quantity = integer(data.quantity_milli, 'quantity_milli', 1, MAX_MILLI);
  const cost = integer(data.total_cost_cents, 'total_cost_cents', 0, MAX_CENTS);
  const payload = { material_id: Number(data.material_id), quantity_milli: quantity, total_cost_cents: cost, reason: String(data.reason ?? '').trim() };
  const fingerprint = await fingerprintOf(payload);
  return db.tx(async (tx) => {
    const again = await existingMovement(tx, location, data.idempotency_key, fingerprint, 'cost');
    if (again) return again;
    const { material, balance } = await lockMaterial(tx, location, payload.material_id);
    const newValue = safeAdd(balance.value_cents ?? 0, cost, MAX_CENTS, 'total_cost_cents');
    const avg = roundRatio(newValue, Math.max(1, balance.quantity_milli), 7);
    if (avg > MAX_MICRO) fail('total_cost_cents', 'Receipt cost exceeds the supported financial limit.');
    await updateRow(tx, 'profittrack_material_balances', balance.id, { value_cents: newValue, unit_cost_micropesos: avg });
    const movement = await insertRow(tx, 'profittrack_material_movements', {
      location_id: location.id, material_id: material.id, type: 'revaluation', quantity_delta_milli: 0, value_delta_cents: cost, unit_cost_micropesos: avg,
      idempotency_key: data.idempotency_key, request_fingerprint: fingerprint, reason: payload.reason, recorded_by_user_id: actor.id, occurred_at: new Date(),
    });
    await audit(tx, location, actor, 'material.revalued', 'material_movement', movement.id, payload.reason);
    return { movement: await withMaterial(tx, movement), duplicate: false };
  });
}

async function operation(tx: Db, location: Row, actor: Row, type: string, key: string, fingerprint: string, reason: string | null) {
  const [existing] = await tx.query(`select * from profittrack_operations where location_id = $1 and idempotency_key = $2`, [location.id, key]);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint || existing.type !== type) fail('idempotency_key', 'This retry key was already used with different data.');
    return { operation: existing, duplicate: true };
  }
  // The transaction is already open, so a racing insert is resolved by the conflict clause.
  const [created] = await tx.query(
    `insert into profittrack_operations (location_id, type, idempotency_key, request_fingerprint, recorded_by_user_id, reason, occurred_at) values ($1, $2, $3, $4, $5, $6, now())
     on conflict (location_id, idempotency_key) do nothing returning *`,
    [location.id, type, key, fingerprint, actor.id, reason],
  );
  if (created) return { operation: created, duplicate: false };
  const [raced] = await tx.query(`select * from profittrack_operations where location_id = $1 and idempotency_key = $2`, [location.id, key]);
  if (raced.request_fingerprint !== fingerprint || raced.type !== type) fail('idempotency_key', 'This retry key was already used with different data.');
  return { operation: raced, duplicate: true };
}

export async function physicalCount(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  const counted = integer(data.counted_quantity_milli, 'counted_quantity_milli', 0, MAX_MILLI);
  const payload = { material_id: Number(data.material_id), counted_quantity_milli: counted, reason: String(data.reason).trim() };
  const fingerprint = await fingerprintOf(payload);
  return db.tx(async (tx) => {
    const op = await operation(tx, location, actor, 'count', data.idempotency_key, fingerprint, payload.reason);
    if (op.duplicate) return { count: (await tx.query(`select * from profittrack_counts where operation_id = $1`, [op.operation.id]))[0], duplicate: true };
    const { material, balance } = await lockMaterial(tx, location, payload.material_id);
    const before = balance.quantity_milli;
    const delta = counted - before;
    const unitCost = balance.unit_cost_micropesos;
    const valueDelta = unitCost === null ? null : roundRatio(BigInt(delta) * BigInt(unitCost), 10_000_000n);
    let value = balance.value_cents;
    if (valueDelta !== null) {
      const next = Number(value ?? 0) + valueDelta;
      if (next < 0 || next > MAX_CENTS) fail('counted_quantity_milli', 'The count would create an invalid inventory value.');
      value = next;
    } else if (counted === 0) value = 0;
    await updateRow(tx, 'profittrack_material_balances', balance.id, { quantity_milli: counted, value_cents: value, unit_cost_micropesos: counted === 0 ? null : unitCost });
    const count = await insertRow(tx, 'profittrack_counts', {
      location_id: location.id, operation_id: op.operation.id, material_id: material.id, recorded_quantity_milli: before, counted_quantity_milli: counted, quantity_delta_milli: delta,
      unit_cost_micropesos: unitCost, value_delta_cents: valueDelta,
    });
    await insertRow(tx, 'profittrack_material_movements', {
      location_id: location.id, material_id: material.id, type: 'physical_count', quantity_delta_milli: delta, value_delta_cents: valueDelta, unit_cost_micropesos: unitCost,
      operation_id: op.operation.id, reason: payload.reason, recorded_by_user_id: actor.id, occurred_at: new Date(),
    });
    await audit(tx, location, actor, 'material.counted', 'material_count', count.id, payload.reason);
    return { count, duplicate: false };
  });
}

function canonicalMilli(quantity: number, fromUnit: string, materialUnit: string): number {
  const from = fromUnit.trim().toLowerCase();
  const to = materialUnit.trim().toLowerCase();
  if (quantity <= 0) fail('ingredients', 'Each ingredient quantity must be greater than zero.');
  if (from === to) return Math.round(quantity * 1000);
  const factor = (from === 'g' && to === 'kg') || (from === 'ml' && to === 'l') ? 1 : (from === 'kg' && to === 'g') || (from === 'l' && to === 'ml') ? 1_000_000 : null;
  if (factor === null) fail('ingredients', `The recipe unit (${fromUnit}) is not compatible with the material unit (${materialUnit}).`);
  return Math.round(quantity * factor!);
}

async function replaceIngredients(tx: Db, location: Row, version: Row, ingredients: Row[]) {
  for (const row of ingredients) {
    const [material] = await tx.query(`select * from profittrack_materials where location_id = $1 and is_active = true and id = $2`, [location.id, Number(row.material_id)]);
    if (!material) abort(404, 'Record not found.');
    const unit = String(row.unit ?? material.unit).trim() || material.unit;
    const quantity = row.quantity !== undefined && row.quantity !== null
      ? canonicalMilli(Number(row.quantity), unit, material.unit)
      : integer(row.quantity_milli_per_piece ?? null, 'ingredients', 1, MAX_MILLI);
    if (quantity < 1) fail('ingredients', 'Each ingredient quantity must be greater than zero.');
    await insertRow(tx, 'profittrack_recipe_ingredients', { location_id: location.id, recipe_version_id: version.id, material_id: material.id, quantity_milli_per_piece: quantity, unit });
  }
}

export const RECIPE_RELATIONS = (r: string) => `coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object('ingredients', coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('material', (select to_jsonb(m) || jsonb_build_object('balance', (select to_jsonb(mb) from profittrack_material_balances mb where mb.material_id = m.id limit 1)) from profittrack_materials m where m.id = i.material_id)) order by i.id) from profittrack_recipe_ingredients i where i.recipe_version_id = v.id), '[]'::jsonb)) order by v.id) from profittrack_recipe_versions v where v.recipe_id = ${r}.id), '[]'::jsonb) as versions,
  (select to_jsonb(fb) from profittrack_finished_balances fb where fb.recipe_id = ${r}.id limit 1) as finished_balance`;
const freshRecipe = async (db: Db, id: number) => (await db.query(`select r.*, ${RECIPE_RELATIONS('r')} from profittrack_recipes r where r.id = $1`, [id]))[0];

export function createRecipe(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const price = integer(data.standard_price_cents ?? 0, 'standard_price_cents', 0, MAX_CENTS);
    const recipe = await insertRow(tx, 'profittrack_recipes', {
      location_id: location.id, name: String(data.name).trim(), sku: String(data.sku).trim(), image_path: data.image_path ?? null, standard_price_cents: price, current_version: 1,
      created_by_user_id: actor.id, updated_by_user_id: actor.id,
    });
    const version = await insertRow(tx, 'profittrack_recipe_versions', { location_id: location.id, recipe_id: recipe.id, version: 1, yield_pieces: 1, created_by_user_id: actor.id });
    await replaceIngredients(tx, location, version, data.ingredients);
    await insertRow(tx, 'profittrack_finished_balances', { location_id: location.id, recipe_id: recipe.id });
    await audit(tx, location, actor, 'recipe.created', 'recipe', recipe.id);
    return freshRecipe(tx, recipe.id);
  });
}

export function updateRecipe(db: Db, location: Row, actor: Row, recipeId: number, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const [recipe] = await tx.query(`select * from profittrack_recipes where location_id = $1 and id = $2 for update`, [location.id, recipeId]);
    if (!recipe) abort(404, 'Record not found.');
    const price = data.standard_price_cents !== undefined && data.standard_price_cents !== null ? integer(data.standard_price_cents, 'standard_price_cents', 0, MAX_CENTS) : recipe.standard_price_cents;
    const fields: Row = {
      name: 'name' in data ? String(data.name).trim() : recipe.name, sku: 'sku' in data ? String(data.sku).trim() : recipe.sku,
      image_path: 'image_path' in data ? data.image_path : recipe.image_path, standard_price_cents: price, is_active: data.is_active ?? recipe.is_active, updated_by_user_id: actor.id,
    };
    if ('ingredients' in data) {
      const number = recipe.current_version + 1;
      const version = await insertRow(tx, 'profittrack_recipe_versions', { location_id: location.id, recipe_id: recipe.id, version: number, yield_pieces: 1, created_by_user_id: actor.id });
      await replaceIngredients(tx, location, version, data.ingredients);
      fields.current_version = number;
    }
    await updateRow(tx, 'profittrack_recipes', recipe.id, fields);
    if (recipe.standard_price_cents !== price) await audit(tx, location, actor, 'recipe.price_changed', 'recipe', recipe.id, null, { from_cents: recipe.standard_price_cents, to_cents: price });
    else await audit(tx, location, actor, 'recipe.updated', 'recipe', recipe.id);
    return freshRecipe(tx, recipe.id);
  });
}

export function setMaterialValuation(db: Db, location: Row, actor: Row, materialId: number, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const [balance] = await tx.query(`select * from profittrack_material_balances where location_id = $1 and material_id = $2 for update`, [location.id, materialId]);
    if (!balance) abort(404, 'Record not found.');
    const cost = integer(data.unit_cost_micropesos, 'unit_cost_micropesos', 0, MAX_MICRO);
    const qty = balance.quantity_milli;
    const value = qty === 0 ? 0 : roundRatio(BigInt(qty) * BigInt(cost), 10_000_000n);
    if (value > MAX_CENTS) fail('unit_cost_micropesos', 'Valuation exceeds the supported inventory value.');
    const saved = await updateRow(tx, 'profittrack_material_balances', balance.id, { unit_cost_micropesos: qty === 0 ? null : cost, value_cents: qty === 0 ? null : value });
    const movement = await insertRow(tx, 'profittrack_material_movements', {
      location_id: location.id, material_id: materialId, type: 'admin_valuation', quantity_delta_milli: 0, value_delta_cents: 0, unit_cost_micropesos: cost,
      reason: String(data.reason).trim(), recorded_by_user_id: actor.id, occurred_at: new Date(),
    });
    await audit(tx, location, actor, 'material.valued', 'material_movement', movement.id, data.reason);
    return { ...saved, material: (await tx.query(`select * from profittrack_materials where id = $1`, [materialId]))[0] };
  });
}

const batchWithConsumptions = async (db: Db, id: number) => (await db.query(
  `select b.*, coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from profittrack_production_consumptions c where c.batch_id = b.id), '[]'::jsonb) as consumptions from profittrack_production_batches b where b.id = $1`, [id],
))[0];

export async function produce(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  const quantity = integer(data.quantity_pieces, 'quantity_pieces', 1, MAX_MILLI);
  const payload = { recipe_id: Number(data.recipe_id), quantity_pieces: quantity };
  const fingerprint = await fingerprintOf(payload);
  return db.tx(async (tx) => {
    const op = await operation(tx, location, actor, 'production', data.idempotency_key, fingerprint, null);
    if (op.duplicate) {
      const [existing] = await tx.query(`select id from profittrack_production_batches where operation_id = $1`, [op.operation.id]);
      return { batch: await batchWithConsumptions(tx, existing.id), duplicate: true };
    }
    const [recipe] = await tx.query(`select * from profittrack_recipes where location_id = $1 and is_active = true and id = $2 for update`, [location.id, payload.recipe_id]);
    if (!recipe) abort(404, 'Record not found.');
    const [version] = await tx.query(`select * from profittrack_recipe_versions where location_id = $1 and recipe_id = $2 and version = $3`, [location.id, recipe.id, recipe.current_version]);
    if (!version) abort(404, 'Record not found.');
    const ingredients = await tx.query(
      `select i.*, (select to_jsonb(m) from profittrack_materials m where m.id = i.material_id) as material from profittrack_recipe_ingredients i where i.recipe_version_id = $1 order by i.id`, [version.id],
    );
    if (!ingredients.length) fail('recipe_id', 'Recipe must include at least one material before production.');
    const balances = await tx.query(
      `select * from profittrack_material_balances where location_id = $1 and material_id = any($2::bigint[]) order by material_id for update`, [location.id, `{${ingredients.map((i) => i.material_id).join(',')}}`],
    );
    const consumptions: Row[] = [];
    let totalCost = 0;
    for (const ingredient of ingredients) {
      const balance = balances.find((b) => b.material_id === ingredient.material_id);
      const required = safeMultiply(ingredient.quantity_milli_per_piece, quantity, MAX_MILLI, 'quantity_pieces');
      if (!balance || balance.quantity_milli < required) fail('quantity_pieces', `Insufficient material: ${ingredient.material.name}.`);
      let unitCost = balance.unit_cost_micropesos;
      if (balance.value_cents === null || unitCost === null) {
        if (!data.allow_unvalued) fail('quantity_pieces', `Material ${ingredient.material.name} has unknown cost and cannot be consumed.`);
        unitCost = 0;
      }
      const cost = roundRatio(BigInt(required) * BigInt(unitCost), 10_000_000n);
      totalCost = safeAdd(totalCost, cost, MAX_CENTS, 'quantity_pieces');
      consumptions.push({ ingredient, balance, required, cost, unitCost });
    }
    const [finished] = await tx.query(`select * from profittrack_finished_balances where location_id = $1 and recipe_id = $2 for update`, [location.id, recipe.id]);
    if (!finished) abort(404, 'Record not found.');
    const totalPieces = safeAdd(finished.quantity_pieces, quantity, MAX_MILLI, 'quantity_pieces');
    const newValue = safeAdd(finished.value_cents, totalCost, MAX_CENTS, 'quantity_pieces');
    const newAvg = roundRatio(BigInt(newValue) * 10_000n, totalPieces);
    for (const { ingredient, balance, required, cost, unitCost } of consumptions) {
      const remaining = balance.quantity_milli - required;
      const unvalued = balance.value_cents === null;
      const remainingValue = unvalued ? null : remaining === 0 ? 0 : balance.value_cents - cost;
      if (remainingValue !== null && remainingValue < 0) fail('quantity_pieces', 'Material valuation would become negative; record a physical count or Admin valuation first.');
      await updateRow(tx, 'profittrack_material_balances', balance.id, { quantity_milli: remaining, value_cents: remainingValue, unit_cost_micropesos: unvalued ? null : remaining === 0 ? null : unitCost });
      await insertRow(tx, 'profittrack_material_movements', {
        location_id: location.id, material_id: ingredient.material_id, type: 'production_consumption', quantity_delta_milli: -required, value_delta_cents: unvalued ? null : -cost,
        unit_cost_micropesos: unvalued ? null : unitCost, operation_id: op.operation.id, reason: `Production ${op.operation.idempotency_key}`, recorded_by_user_id: actor.id, occurred_at: new Date(),
      });
    }
    await updateRow(tx, 'profittrack_finished_balances', finished.id, { quantity_pieces: totalPieces, value_cents: newValue, unit_cost_micropesos: newAvg });
    const batch = await insertRow(tx, 'profittrack_production_batches', {
      location_id: location.id, operation_id: op.operation.id, recipe_id: recipe.id, recipe_version_id: version.id, quantity_pieces: quantity, total_cost_cents: totalCost,
      unit_cost_micropesos: roundRatio(BigInt(totalCost) * 10_000n, quantity),
    });
    for (const { ingredient, required, cost, unitCost } of consumptions) {
      await insertRow(tx, 'profittrack_production_consumptions', {
        location_id: location.id, batch_id: batch.id, material_id: ingredient.material_id, quantity_milli: required, unit_cost_micropesos: unitCost, total_cost_cents: cost,
        material_name_snapshot: ingredient.material.name, unit_snapshot: ingredient.material.unit,
      });
    }
    await audit(tx, location, actor, 'production.recorded', 'production_batch', batch.id, null, payload);
    return { batch: await batchWithConsumptions(tx, batch.id), duplicate: false };
  });
}

const saleWithItems = async (db: Db, id: number) => (await db.query(
  `select s.*, coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from profittrack_sale_items i where i.sale_id = s.id), '[]'::jsonb) as items,
     (select to_jsonb(v) from profittrack_sale_voids v where v.sale_id = s.id limit 1) as void from profittrack_sales s where s.id = $1`, [id],
))[0];

export async function sell(db: Db, location: Row, actor: Row, data: Row): Promise<Row> {
  const normalized = data.items.map((line: Row) => ({
    recipe_id: Number(line.recipe_id), quantity_pieces: Number(line.quantity_pieces), realized_price_cents: line.realized_price_cents !== undefined && line.realized_price_cents !== null ? Number(line.realized_price_cents) : null,
    discount_reason: String(line.discount_reason ?? '').trim(),
  })).sort((a: Row, b: Row) => a.recipe_id - b.recipe_id);
  const fingerprint = await fingerprintOf({ items: normalized });
  return db.tx(async (tx) => {
    const op = await operation(tx, location, actor, 'sale', data.idempotency_key, fingerprint, null);
    if (op.duplicate) {
      const [existing] = await tx.query(`select id from profittrack_sales where operation_id = $1`, [op.operation.id]);
      return { sale: await saleWithItems(tx, existing.id), duplicate: true };
    }
    const ids = `{${normalized.map((l: Row) => l.recipe_id).join(',')}}`;
    const recipes = await tx.query(`select * from profittrack_recipes where location_id = $1 and id = any($2::bigint[]) order by id for update`, [location.id, ids]);
    if (recipes.length !== normalized.length) fail('items', 'Each product must be configured for this branch.');
    const balances = await tx.query(`select * from profittrack_finished_balances where location_id = $1 and recipe_id = any($2::bigint[]) order by recipe_id for update`, [location.id, ids]);
    let totalRevenue = 0;
    let totalCost = 0;
    const lines: Row[] = [];
    for (const [index, line] of normalized.entries()) {
      const recipe = recipes.find((r) => r.id === line.recipe_id)!;
      const balance = balances.find((b) => b.recipe_id === line.recipe_id);
      const qty = integer(line.quantity_pieces, `items.${index}.quantity_pieces`, 1, MAX_MILLI);
      if (!recipe.is_active) fail(`items.${index}.recipe_id`, 'This product is not active.');
      if (!balance || balance.quantity_pieces < qty) fail(`items.${index}.quantity_pieces`, `Insufficient finished stock for ${recipe.name}.`);
      const standard = recipe.standard_price_cents;
      const realized = line.realized_price_cents ?? standard;
      integer(realized, `items.${index}.realized_price_cents`, 0, MAX_CENTS);
      if (realized < standard && !line.discount_reason) fail(`items.${index}.discount_reason`, 'A reason is required for a discounted sale.');
      const cost = Math.min(roundRatio(BigInt(qty) * BigInt(balance.unit_cost_micropesos), 10_000n), MAX_CENTS);
      const revenue = safeMultiply(realized, qty, MAX_CENTS, `items.${index}.realized_price_cents`);
      totalRevenue = safeAdd(totalRevenue, revenue, MAX_CENTS, 'items');
      totalCost = safeAdd(totalCost, cost, MAX_CENTS, 'items');
      lines.push({ recipe, balance, qty, standard, realized, cost, revenue, reason: line.discount_reason });
    }
    const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const sale = await insertRow(tx, 'profittrack_sales', {
      location_id: location.id, operation_id: op.operation.id, sale_number: `PT-${location.id}-${stamp}-${op.operation.id}`, revenue_cents: totalRevenue, cost_cents: totalCost,
      profit_cents: totalRevenue - totalCost, sold_at: new Date(),
    });
    for (const line of lines) {
      const newQty = line.balance.quantity_pieces - line.qty;
      await updateRow(tx, 'profittrack_finished_balances', line.balance.id, {
        quantity_pieces: newQty, value_cents: newQty === 0 ? 0 : Math.max(0, line.balance.value_cents - line.cost), unit_cost_micropesos: newQty === 0 ? 0 : line.balance.unit_cost_micropesos,
      });
      await insertRow(tx, 'profittrack_sale_items', {
        location_id: location.id, sale_id: sale.id, recipe_id: line.recipe.id, quantity_pieces: line.qty, standard_price_cents: line.standard, realized_price_cents: line.realized,
        unit_cost_micropesos: line.balance.unit_cost_micropesos, revenue_cents: line.revenue, cost_cents: line.cost, profit_cents: line.revenue - line.cost,
        recipe_name_snapshot: line.recipe.name, discount_reason: line.reason || null,
      });
    }
    await audit(tx, location, actor, 'sale.recorded', 'sale', sale.id, null, { revenue_cents: totalRevenue, cost_cents: totalCost });
    return { sale: await saleWithItems(tx, sale.id), duplicate: false };
  });
}

export function voidSale(db: Db, location: Row, actor: Row, saleId: number, reason: string): Promise<Row> {
  return db.tx(async (tx) => {
    const [sale] = await tx.query(`select * from profittrack_sales where location_id = $1 and id = $2 for update`, [location.id, saleId]);
    if (!sale) abort(404, 'Record not found.');
    if ((await tx.query(`select 1 from profittrack_sale_voids where sale_id = $1`, [sale.id])).length) fail('sale', 'This sale has already been voided.');
    const items = await tx.query(`select * from profittrack_sale_items where sale_id = $1 order by recipe_id`, [sale.id]);
    const balances = await tx.query(
      `select * from profittrack_finished_balances where location_id = $1 and recipe_id = any($2::bigint[]) order by recipe_id for update`, [location.id, `{${items.map((i) => i.recipe_id).join(',')}}`],
    );
    for (const item of items) {
      const balance = balances.find((b) => b.recipe_id === item.recipe_id)!;
      const newQty = safeAdd(balance.quantity_pieces, item.quantity_pieces, MAX_MILLI, 'sale');
      const newValue = safeAdd(balance.value_cents, item.cost_cents, MAX_CENTS, 'sale');
      await updateRow(tx, 'profittrack_finished_balances', balance.id, { quantity_pieces: newQty, value_cents: newValue, unit_cost_micropesos: roundRatio(BigInt(newValue) * 10_000n, newQty) });
      balance.quantity_pieces = newQty;
      balance.value_cents = newValue;
    }
    const saved = await insertRow(tx, 'profittrack_sale_voids', { location_id: location.id, sale_id: sale.id, voided_by_user_id: actor.id, reason: reason.trim(), voided_at: new Date() });
    await audit(tx, location, actor, 'sale.voided', 'sale', sale.id, reason);
    return saved;
  });
}

export function voidProduction(db: Db, location: Row, actor: Row, batchId: number, reason: string): Promise<Row> {
  return db.tx(async (tx) => {
    const [batch] = await tx.query(`select * from profittrack_production_batches where location_id = $1 and id = $2 for update`, [location.id, batchId]);
    if (!batch) abort(404, 'Record not found.');
    if (batch.voided_at) fail('production', 'This production batch was already voided.');
    const [finished] = await tx.query(`select * from profittrack_finished_balances where location_id = $1 and recipe_id = $2 for update`, [location.id, batch.recipe_id]);
    if (!finished) abort(404, 'Record not found.');
    if (finished.quantity_pieces < batch.quantity_pieces) fail('production', 'The produced stock was already sold or consumed, so this batch cannot be voided.');
    const consumptions = await tx.query(`select * from profittrack_production_consumptions where batch_id = $1 order by id`, [batch.id]);
    for (const c of consumptions) {
      const [balance] = await tx.query(`select * from profittrack_material_balances where location_id = $1 and material_id = $2 for update`, [location.id, c.material_id]);
      if (!balance) abort(404, 'Record not found.');
      const quantity = safeAdd(balance.quantity_milli, c.quantity_milli, MAX_MILLI, 'production');
      const value = balance.value_cents === null ? null : safeAdd(balance.value_cents, c.total_cost_cents, MAX_CENTS, 'production');
      await updateRow(tx, 'profittrack_material_balances', balance.id, {
        quantity_milli: quantity, value_cents: value, unit_cost_micropesos: value === null || quantity === 0 ? null : roundRatio(BigInt(value) * 10_000_000n, quantity),
      });
    }
    const pieces = finished.quantity_pieces - batch.quantity_pieces;
    const remaining = Math.max(0, finished.value_cents - batch.total_cost_cents);
    await updateRow(tx, 'profittrack_finished_balances', finished.id, {
      quantity_pieces: pieces, value_cents: pieces === 0 ? 0 : remaining, unit_cost_micropesos: pieces === 0 ? 0 : roundRatio(BigInt(remaining) * 10_000n, pieces),
    });
    const saved = await updateRow(tx, 'profittrack_production_batches', batch.id, { voided_at: new Date(), voided_by_user_id: actor.id, void_reason: reason.trim() });
    await audit(tx, location, actor, 'production.voided', 'production_batch', batch.id, reason, {
      quantity_pieces_voided: batch.quantity_pieces,
      restored_materials: consumptions.map((c) => ({ material_id: c.material_id, quantity_milli: c.quantity_milli, cost_cents: c.total_cost_cents })),
    });
    return { ...saved, consumptions, voided_by: { id: actor.id, full_name: actor.full_name } };
  });
}
