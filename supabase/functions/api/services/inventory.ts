// App\Services\InventoryService, InventoryAuditService, ForecastService and WarehouseCsvService.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, manilaToday, updateRow, ValidationError } from '../lib/http.ts';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function stockStatus(i: Row): string {
  const stock = Number(i.current_stock);
  if (stock <= Number(i.critical_level)) return 'critical';
  if (stock <= Number(i.reorder_level)) return 'low';
  return 'normal';
}

/** Inventory's $appends: stock_status plus days left from 30 days of consumption. */
export async function inventoryJson(db: Db, i: Row): Promise<Row> {
  const [{ total }] = await db.query<{ total: string }>(
    `select coalesce(sum(quantity), 0) as total from inventory_transactions where inventory_id = $1 and type = 'consumption' and transaction_date >= now() - interval '30 days'`, [i.id],
  );
  const daily = Number(total) / 30;
  return { ...i, stock_status: stockStatus(i), estimated_days_left: daily <= 0 ? null : Math.max(0, Math.round((Number(i.current_stock) / daily) * 10) / 10) };
}

export async function warehouse(db: Db): Promise<Row> {
  const [row] = await db.query(`select * from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  if (!row) fail('warehouse', 'No active warehouse location is configured.');
  return row;
}

interface Adjustment { referenceType?: string | null; referenceId?: number | null; remarks?: string | null }

/** Locks the row, refuses negative stock and writes the transaction, all atomically. */
export function adjustStock(db: Db, inventoryId: number, delta: number, type: string, user: Row | null, options: Adjustment = {}): Promise<Row> {
  return db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from inventories where id = $1 for update`, [inventoryId]);
    if (!locked) abort(404, 'Record not found.');
    const before = Number(locked.current_stock);
    const after = round2(before + delta);
    if (after < 0) fail('quantity', 'The transaction would make stock negative.');
    await updateRow(tx, 'inventories', inventoryId, { current_stock: after, last_counted_at: new Date(), updated_by_user_id: user?.id ?? null });
    return insertRow(tx, 'inventory_transactions', {
      inventory_id: inventoryId, type, quantity: delta, balance_before: before, balance_after: after, reference_type: options.referenceType ?? null,
      reference_id: options.referenceId ?? null, remarks: options.remarks ?? null, recorded_by_user_id: user?.id ?? null, transaction_date: new Date(),
    });
  });
}

export function setStock(db: Db, inventoryId: number, newStock: number, user: Row | null, remarks: string | null = null): Promise<Row> {
  if (newStock < 0) fail('quantity', 'Stock cannot be negative.');
  return db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from inventories where id = $1 for update`, [inventoryId]);
    if (!locked) abort(404, 'Record not found.');
    const before = Number(locked.current_stock);
    const after = round2(newStock);
    const delta = round2(after - before);
    await updateRow(tx, 'inventories', inventoryId, { current_stock: after, last_counted_at: new Date(), updated_by_user_id: user?.id ?? null });
    return insertRow(tx, 'inventory_transactions', {
      inventory_id: inventoryId, type: delta >= 0 ? 'adjustment_in' : 'adjustment_out', quantity: delta, balance_before: before, balance_after: after,
      remarks, recorded_by_user_id: user?.id ?? null, transaction_date: new Date(),
    });
  });
}

export function stockAudit(db: Db, actor: Row, action: string, source: string, oldQuantity: number | null, newQuantity: number | null, fields: { inventory?: Row | null; productBrandId?: number | null; note?: string | null } = {}) {
  return insertRow(db, 'inventory_audit_logs', {
    actor_user_id: actor.id, actor_role: actor.role?.name ?? null, brand_id: fields.productBrandId ?? fields.inventory?.product?.brand_id ?? null,
    product_id: fields.inventory?.product_id ?? null, inventory_id: fields.inventory?.id ?? null, action, source, old_quantity: oldQuantity, new_quantity: newQuantity, note: fields.note ?? null,
  });
}

// ---- Monthly forecast (ForecastService) ----
const SAFETY_PERCENT = 15;
const manilaMonth = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).format(d);

function monthsBack(periods: number) {
  const [y, m] = manilaMonth().split('-').map(Number);
  return Array.from({ length: periods }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (periods - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

export async function generateForecast(db: Db, inventory: Row, periods: number, user: Row | null): Promise<Row> {
  const months = monthsBack(periods);
  const start = `${months[0]}-01`;
  const [ey, em] = months[months.length - 1].split('-').map(Number);
  const end = new Date(Date.UTC(ey, em, 0)).toISOString().slice(0, 10);
  const rows = await db.query(
    `select to_char(transaction_date at time zone 'Asia/Manila', 'YYYY-MM') as month, sum(abs(quantity)) as quantity from inventory_transactions
     where inventory_id = $1 and type in ('consumption', 'fulfillment', 'adjustment_out')
       and transaction_date >= $2::date::timestamp at time zone 'Asia/Manila' and transaction_date < ($3::date + 1)::timestamp at time zone 'Asia/Manila' group by 1`,
    [inventory.id, start, end],
  );
  const series = months.map((period) => ({ period, quantity: round2(Number(rows.find((r) => r.month === period)?.quantity ?? 0)) }));
  const values = series.slice(-periods).map((s) => s.quantity);
  const prediction = values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const recommended = Math.max(0, Math.ceil(prediction * (1 + SAFETY_PERCENT / 100) - Number(inventory.current_stock)));
  return insertRow(db, 'forecasts', {
    inventory_id: inventory.id, method: 'simple_moving_average', period_start: start, period_end: end, periods_used: periods, predicted_quantity: prediction,
    recommended_reorder_quantity: recommended, input_series: series, generated_by_user_id: user?.id ?? null, generated_at: new Date(),
  });
}

// ---- Warehouse CSV ----
const TEMPLATE_HEADERS = ['brand', 'sku', 'product_name', 'category', 'unit', 'quantity'];
const IGNORED_COLUMNS = ['reorder_level', 'critical_level', 'status'];
const key = (v: string) => v.replace(/\s+/gu, ' ').trim().toLowerCase();
const cell = (v: unknown) => { const t = String(v ?? ''); return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const num = (v: unknown) => { const t = Number(v).toFixed(2).replace(/\.?0+$/, ''); return t === '' ? '0' : t; };
const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'brand';
const linesLabel = (lines: number[]) => (lines.length === 1 ? `Line ${lines[0]}` : `Lines ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`);

const activeProducts = (db: Db, brandId: number) => db.query(
  `select p.*, (select c.name from product_categories c where c.id = p.category_id) as category_name from products p
   where p.brand_id = $1 and p.is_active = true and p.archived_at is null order by p.name`, [brandId],
);
const loadBrand = async (db: Db, id: number) => {
  const [b] = await db.query(`select * from brands where id = $1`, [id]);
  if (!b) abort(404, 'Record not found.');
  return b;
};
const stockByProduct = async (db: Db, warehouseId: number, ids: number[]) => new Map((ids.length ? await db.query(
  `select product_id, current_stock from inventories where location_id = $1 and product_id = any($2::bigint[])`, [warehouseId, `{${ids.join(',')}}`],
) : []).map((r) => [r.product_id, r.current_stock]));

export async function csvTemplate(db: Db, brandId: number, mode: string) {
  const brand = await loadBrand(db, brandId);
  const products = await activeProducts(db, brandId);
  const stock = mode === 'set' && products.length ? await stockByProduct(db, (await warehouse(db)).id, products.map((p) => p.id)) : new Map();
  const lines = [TEMPLATE_HEADERS.join(',')];
  for (const p of products) lines.push([brand.name, p.sku, p.name, p.category_name ?? p.category, p.unit, stock.has(p.id) ? num(stock.get(p.id)) : ''].map(cell).join(','));
  return { filename: `warehouse_import_template_${slug(brand.name)}.csv`, csv: `${lines.join('\r\n')}\r\n`, rows: products.length };
}

export async function csvExport(db: Db, brandId: number) {
  const brand = await loadBrand(db, brandId);
  const wh = await warehouse(db);
  const rows = await db.query(
    `select i.*, p.sku, p.name, p.unit, p.category, (select c.name from product_categories c where c.id = p.category_id) as category_name
     from inventories i join products p on p.id = i.product_id where i.location_id = $1 and p.brand_id = $2 and p.is_active = true and p.archived_at is null order by p.name`, [wh.id, brandId],
  );
  const lines = ['brand,sku,product_name,category,unit,quantity,reorder_level,critical_level,status'];
  for (const r of rows) {
    lines.push([brand.name, r.sku, r.name, r.category_name ?? r.category, r.unit, num(r.current_stock), num(r.reorder_level), num(r.critical_level), stockStatus(r).toUpperCase()].map(cell).join(','));
  }
  return { filename: `warehouse_${slug(brand.name)}_${manilaToday()}.csv`, csv: `${lines.join('\r\n')}\r\n` };
}

/** RFC 4180 reading, like fgetcsv: quotes may hold delimiters and line breaks. */
export function readCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseCsv(raw: string) {
  const csv = raw.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n');
  if (!csv.trim()) fail('csv', 'The CSV file is empty.');
  const firstLine = csv.split('\n')[0];
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const all = readCsv(csv, delimiter);
  const header = all[0].map((c) => c.trim().toLowerCase().replace(/ /g, '_'));
  const missing = [];
  if (!header.includes('quantity')) missing.push('quantity');
  if (!header.includes('sku') && !header.includes('product_name')) missing.push('sku or product_name');
  if (missing.length) fail('csv', `The CSV is missing the required column(s): ${missing.join(', ')}. Expected: ${TEMPLATE_HEADERS.join(',')}.`);
  const records: Row[] = [];
  all.slice(1).forEach((fields, index) => {
    if (!fields.some((c) => c.trim() !== '')) return;
    const values: Row = {};
    header.forEach((h, i) => { if (h) values[h] = (fields[i] ?? '').trim(); });
    records.push({ line: index + 2, values });
  });
  if (!records.length) fail('csv', 'The CSV has no data rows under the header.');
  if (records.length > 5000) fail('csv', 'Import at most 5000 rows at a time.');
  return { records, ignored_columns: IGNORED_COLUMNS.filter((c) => header.includes(c)) };
}

function checkRow(record: Row, brand: Row, bySku: Map<string, Row>, byName: Map<string, Row[]>, stock: Map<number, unknown>, mode: string): Row {
  const { line, values } = record;
  const sku = String(values.sku ?? '').trim();
  const name = String(values.product_name ?? '').trim();
  const brandText = String(values.brand ?? '').trim();
  const unit = String(values.unit ?? '').trim();
  const quantityText = String(values.quantity ?? '').trim();
  const row: Row = {
    line, sku, product: name, status: 'error', message: null, product_id: null, product_sku: null, product_name: null, unit, quantity: null, current_quantity: null, new_quantity: null, unchanged: false,
  };
  const bad = (message: string) => ({ ...row, status: 'error', message });
  if (quantityText === '') return { ...row, status: 'skipped', message: 'Quantity is blank: row skipped (not set to 0).' };
  if (!sku && !name) return bad('Row has neither SKU nor product name.');
  if (brandText && key(brandText) !== key(brand.name)) return bad(`Brand "${brandText}" is not ${brand.name} (the brand of this import).`);
  if (sku && /^\d+(\.\d+)?e[+-]?\d+$/i.test(sku)) return bad(`SKU "${sku}" looks like scientific notation (changed by Excel). Format the SKU column as Text and type the SKU again.`);
  const clean = quantityText.replace(/ /g, '');
  if (clean === '' || Number.isNaN(Number(clean))) return bad(`Quantity "${quantityText}" is not a number.`);
  if (Number(clean) < 0) return bad(`Quantity ${quantityText} is negative. Use zero or more.`);
  let product: Row | undefined;
  if (sku) {
    product = bySku.get(key(sku));
    if (!product) return bad(`No active ${brand.name} product has SKU "${sku}"${name ? ` (row product "${name}")` : ''}. Import never creates products.`);
  } else {
    const named = byName.get(key(name)) ?? [];
    if (!named.length) return bad(`No active ${brand.name} product is named "${name}". Import never creates products.`);
    if (named.length > 1) return bad(`${named.length} active products are named "${name}" (${named.map((p) => p.sku).join(', ')}). Add the SKU to choose one.`);
    product = named[0];
  }
  if (unit && key(unit) !== key(String(product.unit))) return bad(`Unit "${unit}" does not match ${product.name}'s unit (${product.unit}).`);
  if (!stock.has(product.id)) return bad(`${product.name} has no warehouse stock record yet. Add it in Warehouse inventory first.`);
  const quantity = round2(Number(clean));
  const current = round2(Number(stock.get(product.id)));
  const next = mode === 'add' ? round2(current + quantity) : quantity;
  return { ...row, status: 'valid', message: null, product_id: product.id, product_sku: product.sku, product_name: product.name, unit: product.unit, quantity, current_quantity: current, new_quantity: next, unchanged: next === current };
}

export async function csvPreview(db: Db, brandId: number, csv: string, mode: string) {
  const brand = await loadBrand(db, brandId);
  const wh = await warehouse(db);
  const { records, ignored_columns } = parseCsv(csv);
  const products = await activeProducts(db, brandId);
  const bySku = new Map(products.map((p) => [key(String(p.sku)), p]));
  const byName = new Map<string, Row[]>();
  for (const p of products) byName.set(key(p.name), [...(byName.get(key(p.name)) ?? []), p]);
  const stock = await stockByProduct(db, wh.id, products.map((p) => p.id));
  const rows = records.map((r) => checkRow(r, brand, bySku, byName, stock, mode));
  const duplicates: Row[] = [];
  const groups = new Map<number, Row[]>();
  for (const r of rows.filter((x) => x.status === 'valid')) groups.set(r.product_id, [...(groups.get(r.product_id) ?? []), r]);
  for (const [productId, group] of groups) {
    if (group.length < 2) continue;
    const lines = group.map((r) => r.line);
    const message = `${linesLabel(lines)}: same product (${group[0].product_sku}, ${group[0].product_name}). Keep only one row.`;
    const snapshot = group.map((r) => ({ line: r.line, quantity: r.quantity }));
    for (const r of group) { r.status = 'duplicate'; r.message = message; }
    duplicates.push({ key: String(productId), product_id: productId, label: group[0].product_name, sku: group[0].product_sku, lines, message, rows: snapshot });
  }
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const errors = rows.filter((r) => r.status === 'error');
  return {
    brand: { id: brand.id, name: brand.name }, mode, total_rows: records.length, valid_count: count('valid'), error_count: errors.length, duplicate_count: count('duplicate'),
    skipped_count: count('skipped'), unchanged_count: rows.filter((r) => r.status === 'valid' && r.unchanged).length,
    can_apply: !errors.length && !count('duplicate') && count('valid') > 0, ignored_columns, rows,
    errors: errors.map((r) => ({ line: r.line, message: r.message })), duplicates,
  };
}

export async function csvApply(db: Db, brandId: number, csv: string, mode: string, actor: Row) {
  const preview = await csvPreview(db, brandId, csv, mode);
  const wh = await warehouse(db);
  if (preview.error_count > 0) fail('csv', 'Fix the row errors before applying the import.');
  if (preview.duplicate_count > 0) fail('csv', 'The file has duplicate rows for the same product. Keep only one row per product, then preview again.');
  if (preview.valid_count === 0) fail('csv', 'The file has no rows with a quantity to import.');
  const valid = preview.rows.filter((r) => r.status === 'valid');
  let updated = 0;
  await db.tx(async (tx) => {
    // Every stock row is locked first (id order) so nothing changes underneath.
    const locked = await tx.query(
      `select i.*, (select to_jsonb(p) from products p where p.id = i.product_id) as product from inventories i where i.location_id = $1 and i.product_id = any($2::bigint[]) order by i.id for update`,
      [wh.id, `{${valid.map((r) => r.product_id).join(',')}}`],
    );
    for (const row of valid) {
      if (row.unchanged) continue;
      const inventory = locked.find((i) => i.product_id === row.product_id);
      if (!inventory) throw new ValidationError({ csv: [`Line ${row.line}: ${row.product_name} has no warehouse stock record. Nothing was changed.`] });
      const before = Number(inventory.current_stock);
      let after = row.quantity;
      if (mode === 'add') {
        if (row.quantity > 0) await adjustStock(tx, inventory.id, row.quantity, 'adjustment_in', actor, { remarks: 'CSV import (add to quantity).' });
        after = round2(before + row.quantity);
      } else {
        await setStock(tx, inventory.id, row.quantity, actor, 'CSV import (set quantity).');
      }
      await stockAudit(tx, actor, 'import', 'CSV import', before, after, { inventory, note: `Warehouse CSV import · ${mode === 'add' ? 'add to quantity' : 'set quantity'} · line ${row.line}` });
      updated += 1;
    }
  });
  return { updated, skipped: preview.skipped_count, unchanged: preview.unchanged_count };
}
