// App\Services\BranchStockReceipt and BrandProductService.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, updateRow } from '../lib/http.ts';
import { adjustStock, stockAudit } from './inventory.ts';
import * as ledger from './ledger.ts';

const SUPPLY_MODEL = 'App\\Models\\SupplyRequest';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const itemsOf = (db: Db, id: number) => db.query(
  `select si.*, (select to_jsonb(p) from products p where p.id = si.product_id) as product from supply_request_items si where si.supply_request_id = $1 order by si.id`, [id],
);

export async function materialFor(db: Db, locationId: number, product: Row): Promise<Row | null> {
  const [m] = await db.query(
    `select * from profittrack_materials where location_id = $1 and is_active = true and (warehouse_product_id = $2 or (lower(name) = lower($3) and lower(variant) = '')) order by id limit 1`,
    [locationId, product.id, String(product.name).trim()],
  );
  return m ?? null;
}

export async function safeUnit(db: Db, unit: string): Promise<string> {
  const [known] = await db.query(`select name from units where lower(name) = lower($1) limit 1`, [String(unit).trim()]);
  return known?.name ?? 'pcs';
}

/** The branch's own Inventory row follows its ledger; a replenishment never counts twice. */
async function mirror(db: Db, location: Row, actor: Row, product: Row, quantity: number, request: Row) {
  if (quantity <= 0) return;
  let [destination] = await db.query(`select * from inventories where location_id = $1 and product_id = $2 for update`, [location.id, product.id]);
  destination ??= await insertRow(db, 'inventories', { location_id: location.id, product_id: product.id, current_stock: 0, reorder_level: 0, critical_level: 0, updated_by_user_id: actor.id });
  const counted = await db.query(
    `select 1 from inventory_transactions where inventory_id = $1 and type = 'replenishment' and reference_type = $2 and reference_id = $3 limit 1`, [destination.id, SUPPLY_MODEL, request.id],
  );
  if (counted.length) return;
  const before = Number(destination.current_stock);
  await adjustStock(db, destination.id, quantity, 'replenishment', actor, { referenceType: SUPPLY_MODEL, referenceId: request.id, remarks: `Delivered ${request.request_number}` });
  await stockAudit(db, actor, 'supply_request_delivered', `supply request ${request.id}`, before, round2(before + quantity), {
    inventory: { ...destination, product }, note: `Delivered ${request.request_number} into branch inventory`,
  });
}

/** Called once by the Delivered transition: credits the branch, creating missing materials. */
export async function deliverToBranch(db: Db, request: Row, actor: Row): Promise<Row> {
  if (request.branch_received_at) return { created_materials: [], credited: 0, duplicate: true };
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [request.location_id]);
  if (!location) fail('location', 'The requesting branch is no longer configured.');
  const created: string[] = [];
  let credited = 0;
  for (const item of await itemsOf(db, request.id)) {
    const quantity = Number(item.quantity_requested);
    const product = item.product;
    if (quantity <= 0 || !product) continue;
    let material = await materialFor(db, location.id, product);
    if (!material) {
      material = await ledger.addMaterial(db, location, actor, { name: product.name, variant: '', unit: await safeUnit(db, product.unit), warehouse_product_id: product.id, source: 'Warehouse' });
      created.push(material!.name);
    }
    await ledger.creditDelivery(db, location, actor, {
      material_id: material!.id, quantity_milli: Math.round(quantity * 1000), reason: `Delivered ${request.request_number}`, idempotency_key: `delivery-${request.id}-${product.id}`,
    });
    await mirror(db, location, actor, product, quantity, request);
    credited += 1;
    if (item.product_name_snapshot === null) {
      await updateRow(db, 'supply_request_items', item.id, { quantity_fulfilled: item.quantity_requested, product_name_snapshot: product.name, unit_snapshot: product.unit });
    }
  }
  await updateRow(db, 'supply_requests', request.id, { branch_received_at: new Date(), branch_received_by_user_id: actor.id });
  return { created_materials: created, credited, duplicate: false };
}

/** Manual per-line receipt at the branch. `lines` maps product id to { quantity, ... }. */
export async function receiveLines(db: Db, request: Row, actor: Row, lines: Map<number, Row>, costFor: (line: Row) => number, costingEnabled: boolean): Promise<Row> {
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [request.location_id]);
  const created: string[] = [];
  let received = 0;
  for (const item of await itemsOf(db, request.id)) {
    const line = lines.get(item.product_id);
    if (!line || Number(line.quantity) <= 0) continue;
    const product = item.product;
    if (!product) fail('lines', 'One delivered item is no longer available in the catalog.');
    let material = await materialFor(db, location.id, product);
    if (!material) {
      material = await ledger.addMaterial(db, location, actor, { name: product.name, variant: '', unit: await safeUnit(db, product.unit), warehouse_product_id: product.id, source: 'Warehouse' });
      created.push(material!.name);
    }
    received += 1;
    await ledger.receive(db, location, actor, {
      material_id: material!.id, quantity_milli: Math.round(Number(line.quantity) * 1000), total_cost_cents: costFor(line),
      reason: `Received from supply request ${request.request_number}`, idempotency_key: `supply-${request.id}-${product.id}`,
    }, costingEnabled);
    await mirror(db, location, actor, product, Number(line.quantity), request);
    if (item.product_name_snapshot === null) await updateRow(db, 'supply_request_items', item.id, { product_name_snapshot: product.name, unit_snapshot: product.unit });
  }
  if (!received) fail('lines', 'Confirm a received quantity for at least one item.');
  await updateRow(db, 'supply_requests', request.id, { branch_received_at: new Date(), branch_received_by_user_id: actor.id });
  return { created_materials: created, credited: received, duplicate: false };
}

export async function recordCost(db: Db, request: Row, actor: Row, lines: Map<number, Row>, totalCostCents: number) {
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [request.location_id]);
  const all = [...lines.values()];
  const totalQuantity = all.reduce((sum, l) => sum + Number(l.quantity), 0);
  const lineCount = Math.max(1, all.length);
  for (const item of await itemsOf(db, request.id)) {
    const line = lines.get(item.product_id);
    const product = item.product;
    if (!line || !product || Number(line.quantity) <= 0) continue;
    const material = await materialFor(db, location.id, product);
    if (!material) continue;
    const cost = line.total_cost_cents !== undefined && line.total_cost_cents !== null ? Number(line.total_cost_cents)
      : totalQuantity > 0 ? Math.round(totalCostCents * (Number(line.quantity) / totalQuantity)) : Math.trunc(totalCostCents / lineCount);
    if (cost <= 0) continue;
    await ledger.revalue(db, location, actor, {
      material_id: material.id, quantity_milli: Math.round(Number(line.quantity) * 1000), total_cost_cents: cost, reason: `Receipt cost for ${request.request_number}`, idempotency_key: `delivery-cost-${request.id}-${product.id}`,
    });
  }
}

// ---- BrandProductService ----
export async function nextBrandProductSku(db: Db, brandId: number): Promise<string> {
  const [brand] = await db.query(`select code, name from brands where id = $1`, [brandId]);
  const raw = String(brand?.code || brand?.name || 'BRAND');
  const prefix = (raw.replace(/[^A-Za-z]/g, '') || 'BRAND').slice(0, 4).toUpperCase();
  const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from brand_products where brand_id = $1`, [brandId]);
  for (let sequence = n + 1; ; sequence++) {
    const sku = `${prefix}-P${String(sequence).padStart(4, '0')}`;
    if (!(await db.query(`select 1 from brand_products where brand_id = $1 and sku = $2`, [brandId, sku])).length) return sku;
  }
}

export function convertMilli(milli: number, fromUnit: string, toUnit: string): number | null {
  const from = fromUnit.trim().toLowerCase();
  const to = toUnit.trim().toLowerCase();
  if (!from || !to) return null;
  if (from === to) return milli;
  const factor = (from === 'g' && to === 'kg') || (from === 'ml' && to === 'l') ? 1 : (from === 'kg' && to === 'g') || (from === 'l' && to === 'ml') ? 1_000_000 : null;
  return factor === null ? null : Math.round((milli * factor) / 1000);
}

/** Each brand ingredient resolved against this branch's own materials. */
export async function resolveBrandProduct(db: Db, productId: number, location: Row): Promise<Row[]> {
  const ingredients = await db.query(
    `select i.*, (select to_jsonb(p) from products p where p.id = i.product_id) as product from brand_product_ingredients i where i.brand_product_id = $1 order by i.id`, [productId],
  );
  const materials = await db.query(
    `select m.*, coalesce((select b.quantity_milli from profittrack_material_balances b where b.material_id = m.id limit 1), 0) as quantity_milli from profittrack_materials m where m.location_id = $1 and m.is_active = true order by m.id`, [location.id],
  );
  return ingredients.map((ingredient) => {
    const wp = ingredient.product;
    const material = materials.find((m) => m.warehouse_product_id !== null && m.warehouse_product_id === ingredient.product_id)
      ?? materials.find((m) => wp && String(m.name).trim().toLowerCase() === String(wp.name).trim().toLowerCase() && String(m.variant ?? '').trim() === '');
    const unit = ingredient.batch_unit || String(wp?.unit ?? '');
    const yieldPieces = Math.max(1, ingredient.yield_pieces);
    const perPiece = Math.round(ingredient.batch_amount_milli / yieldPieces);
    let required = material ? convertMilli(perPiece, unit, String(material.unit)) : null;
    if (required !== null) required = Math.max(1, required);
    const available = Number(material?.quantity_milli ?? 0);
    return {
      product_id: ingredient.product_id, name: wp?.name ?? 'Material', unit, batch_amount: Math.round(ingredient.batch_amount_milli) / 1000, yield_pieces: yieldPieces,
      quantity_per_piece: Math.round(perPiece) / 1000, material_id: material?.id ?? null, material_unit: material?.unit ?? unit, available_milli: available, available: available / 1000,
      required_milli: required, missing: !material || required === null,
    };
  });
}

export async function requirementsFor(db: Db, items: Row[], location: Row) {
  const totals = new Map<string, Row>();
  for (const item of items) {
    for (const row of await resolveBrandProduct(db, item.product.id, location)) {
      const key = row.material_id !== null ? `m${row.material_id}` : `p${row.product_id}`;
      if (!totals.has(key)) {
        totals.set(key, { material_id: row.material_id, product_id: row.product_id, name: row.name, unit: row.material_unit || row.unit, required_milli: 0, available_milli: row.available_milli, missing: row.missing });
      }
      if (row.required_milli !== null) totals.get(key)!.required_milli += row.required_milli * item.pieces;
    }
  }
  const materials = [...totals.values()];
  return { materials, shortages: materials.filter((r) => r.missing || r.available_milli < r.required_milli) };
}

/** Keeps the branch's recipe in step; only a changed recipe creates a new version. */
export async function syncRecipe(db: Db, product: Row, location: Row, actor: Row): Promise<Row> {
  const rows = await resolveBrandProduct(db, product.id, location);
  const missing = rows.filter((r) => r.missing);
  if (missing.length) fail('items', `Missing branch raw material: ${missing.map((r) => r.name).join(', ')}. Receive stock first.`);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ name: product.name, image: product.image_path, ingredients: rows.map((r) => [r.material_id, r.required_milli]) })));
  const signature = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const ingredients = rows.map((r) => ({ material_id: r.material_id, quantity_milli_per_piece: r.required_milli }));
  const [recipe] = await db.query(`select * from profittrack_recipes where location_id = $1 and brand_product_id = $2 for update`, [location.id, product.id]);
  if (!recipe) {
    const created = await ledger.createRecipe(db, location, actor, { name: product.name, sku: product.sku, image_path: product.image_path, standard_price_cents: 0, ingredients });
    await updateRow(db, 'profittrack_recipes', created.id, { brand_product_id: product.id, source_signature: signature });
    return { ...created, brand_product_id: product.id, source_signature: signature };
  }
  const data: Row = { name: product.name, image_path: product.image_path, is_active: Boolean(product.is_active) };
  if (recipe.source_signature !== signature) data.ingredients = ingredients;
  const saved = await ledger.updateRecipe(db, location, actor, recipe.id, data);
  await updateRow(db, 'profittrack_recipes', recipe.id, { brand_product_id: product.id, source_signature: signature });
  return { ...saved, brand_product_id: product.id, source_signature: signature };
}

export function assertBranchAccess(owned: boolean) {
  if (!owned) abort(403, 'You cannot access this branch.');
}
