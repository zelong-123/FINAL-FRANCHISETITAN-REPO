// BrandProductController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { boolParam, fail, Filter, insertRow, intParam, ok, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { requireFound, role } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { nextBrandProductSku } from '../services/branchStock.ts';

export const brandProductRoutes = new Hono<AppEnv>();
const MODEL = 'App\\Models\\BrandProduct';
const admin = role('admin');
const SELECT = `bp.*, (select jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code) from brands b where b.id = bp.brand_id) as brand,
  coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'name', p.name, 'unit', p.unit, 'sku', p.sku, 'brand_id', p.brand_id) from products p where p.id = i.product_id)) order by i.id)
    from brand_product_ingredients i where i.brand_product_id = bp.id), '[]'::jsonb) as ingredients`;
const nameKey = (name: string) => name.trim().replace(/\s+/gu, ' ').toLowerCase();
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function present(c: Context<AppEnv>, p: Row): Row {
  const ingredients = p.ingredients.map((i: Row) => {
    const pieces = Math.max(1, i.yield_pieces);
    return {
      id: i.id, product_id: i.product_id, name: i.product?.name ?? 'Stock item', sku: i.product?.sku ?? null, unit: i.product?.unit || i.batch_unit,
      batch_amount: round3(Number(i.batch_amount_milli) / 1000), yield_pieces: pieces, quantity_per_piece: round3(Number(i.batch_amount_milli) / 1000 / pieces),
    };
  });
  return {
    id: p.id, brand_id: p.brand_id, sku: p.sku, name: p.name, description: p.description, image_path: p.image_path, is_active: p.is_active,
    image_url: p.image_path ? c.get('deps').files.publicUrl(p.image_path) : null, brand: p.brand ?? null, ingredients, recipe_complete: ingredients.length > 0,
  };
}
const loadFull = async (db: Db, id: number) => (await db.query(`select ${SELECT} from brand_products bp where bp.id = $1`, [id]))[0];

async function validatePayload(c: Context<AppEnv>, db: Db, existingId?: number): Promise<Row> {
  const v = await validate(db, await readInput(c), {
    brand_id: ['required', 'integer', 'exists:brands,id'], name: ['required', 'string', 'max:150'], description: ['nullable', 'string', 'max:500'], is_active: ['sometimes', 'boolean'], ingredients: ['sometimes', 'array', 'max:50'],
  });
  const rows = v.ingredients ? await validateEach(db, v.ingredients, 'ingredients', {
    product_id: ['required', 'integer', 'exists:products,id'], batch_amount: ['required', 'numeric', 'gt:0', 'max:100000000'], yield_pieces: ['required', 'integer', 'min:1', 'max:1000000'],
  }) : undefined;
  const name = String(v.name).trim().replace(/\s+/gu, ' ');
  if (!name) fail('name', 'Enter a product name.');
  const duplicate = await db.query(`select 1 from brand_products where brand_id = $1 and name_key = $2 and ($3::bigint is null or id <> $3::bigint) limit 1`, [v.brand_id, nameKey(name), existingId ?? null]);
  if (duplicate.length) fail('name', 'This brand already has a product with that name.');
  if (rows) {
    const seen = new Set<number>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.product_id)) fail(`ingredients.${index}.product_id`, 'The ingredients product id field has a duplicate value.');
      seen.add(row.product_id);
      const [product] = await db.query(`select name, brand_id from products where id = $1`, [row.product_id]);
      if (Number(product.brand_id) !== Number(v.brand_id)) fail(`ingredients.${index}.product_id`, `${product.name} belongs to another brand.`);
    }
  }
  return { ...v, name, ingredients: rows };
}

async function replaceIngredients(tx: Db, productId: number, brandId: number, rows: Row[]) {
  await tx.query(`delete from brand_product_ingredients where brand_product_id = $1`, [productId]);
  for (const row of rows) {
    const [source] = await tx.query(`select id, unit from products where id = $1`, [row.product_id]);
    const milli = Math.round(Number(row.batch_amount) * 1000);
    if (milli < 1) fail('ingredients', 'Each batch amount must be greater than zero.');
    await insertRow(tx, 'brand_product_ingredients', { brand_id: brandId, brand_product_id: productId, product_id: source.id, batch_amount_milli: milli, batch_unit: String(source.unit), yield_pieces: Math.max(1, Number(row.yield_pieces)) });
  }
}

async function assertActivationRule(tx: Db, product: Row) {
  if (!product.is_active) return;
  const has = await tx.query(`select 1 from brand_product_ingredients where brand_product_id = $1 limit 1`, [product.id]);
  if (!String(product.name).trim() || !(Number(product.brand_id) > 0) || !has.length) fail('is_active', 'Add a product name, a brand and at least one ingredient before activating this product.');
}

brandProductRoutes.get('/brand-products', async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = new Filter();
  if (q.brand_id) f.add('bp.brand_id = ?', intParam(q.brand_id));
  if (q.search) f.add('(bp.name ilike ? or bp.sku ilike ?)', `%${q.search}%`, `%${q.search}%`);
  if (!boolParam(q.include_inactive)) f.add('bp.is_active = true');
  const rows = await db.query(`select ${SELECT} from brand_products bp ${f.where} order by bp.name`, f.params);
  return ok(c, rows.map((r) => present(c, r)));
});

brandProductRoutes.post('/brand-products', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validatePayload(c, db);
  const created = await db.tx(async (tx) => {
    const row = await insertRow(tx, 'brand_products', {
      brand_id: v.brand_id, sku: await nextBrandProductSku(tx, v.brand_id), name: v.name, name_key: nameKey(v.name), description: v.description ?? null, is_active: Boolean(v.is_active),
      created_by_user_id: user.id, updated_by_user_id: user.id,
    });
    await replaceIngredients(tx, row.id, v.brand_id, v.ingredients ?? []);
    await assertActivationRule(tx, row);
    return row;
  });
  await audit(c, db, 'brand_product.created', { type: MODEL, id: created.id }, null, created);
  return ok(c, present(c, await loadFull(db, created.id)), 'Product created.', 201);
});

brandProductRoutes.put('/brand-products/:brandProduct', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'brandProduct');
  const old = requireFound(await loadFull(db, id));
  const v = await validatePayload(c, db, id);
  const saved = await db.tx(async (tx) => {
    const row = (await updateRow(tx, 'brand_products', id, {
      brand_id: v.brand_id, name: v.name, name_key: nameKey(v.name), description: v.description ?? null, is_active: Boolean(v.is_active), updated_by_user_id: c.get('user').id,
    }))!;
    if (v.ingredients) await replaceIngredients(tx, id, v.brand_id, v.ingredients);
    await assertActivationRule(tx, row);
    return row;
  });
  await audit(c, db, 'brand_product.updated', { type: MODEL, id }, old, saved);
  return ok(c, present(c, await loadFull(db, id)), 'Product saved.');
});

brandProductRoutes.post('/brand-products/:brandProduct/image', admin, async (c) => {
  const { db, files } = c.get('deps');
  const id = routeId(c, 'brandProduct');
  const product = requireFound(await loadFull(db, id));
  const input = await readInput(c);
  const file = input.image;
  if (!file) fail('image', 'Choose a picture to upload.');
  if (!(file instanceof File)) fail('image', 'The picture could not be uploaded. Please try again.');
  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension) || !String(file.type).startsWith('image/')) fail('image', 'The picture must be a JPG, JPEG, PNG or WEBP image.');
  if (file.size > 5120 * 1024) fail('image', 'The picture must not be larger than 5 MB.');
  const path = `brand-products/${crypto.randomUUID()}.${extension}`;
  await files.put('public', path, new Uint8Array(await file.arrayBuffer()), file.type);
  await updateRow(db, 'brand_products', id, { image_path: path, updated_by_user_id: c.get('user').id });
  if (product.image_path && product.image_path !== path) await files.remove('public', [product.image_path]).catch(() => {});
  return ok(c, { image_path: path, image_url: files.publicUrl(path) }, 'Product picture saved.');
});

brandProductRoutes.delete('/brand-products/:brandProduct/image', admin, async (c) => {
  const { db, files } = c.get('deps');
  const id = routeId(c, 'brandProduct');
  const product = requireFound(await loadFull(db, id));
  if (product.image_path) {
    await updateRow(db, 'brand_products', id, { image_path: null, updated_by_user_id: c.get('user').id });
    await files.remove('public', [product.image_path]).catch(() => {});
  }
  return ok(c, { image_path: null, image_url: null }, 'Product picture removed.');
});
