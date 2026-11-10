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
/** Products per ingredient query in the list (keeps each database result small). */
const LIST_CHUNK = 15;
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
  // The list is read in small pieces: one large result (all recipes as JSON, ~90 KB for the
  // current catalogue) makes the Edge runtime's Postgres connection drop with
  // "write CONNECTION_CLOSED". Products first, then their ingredients as plain columns,
  // at most LIST_CHUNK products per query. The response is the same as before.
  // Optional pagination: with ?per_page (1–100) the list comes one page at a time with `meta`;
  // without it, the whole list is returned as before.
  const paged = q.per_page !== undefined;
  const perPage = paged ? Math.min(100, Math.max(1, intParam(q.per_page, 10))) : 0;
  let page = paged ? Math.max(1, intParam(q.page, 1)) : 1;
  let total = 0;
  if (paged) {
    total = (await db.query(`select count(*)::int as n from brand_products bp ${f.where}`, f.params))[0].n;
    page = Math.min(page, Math.max(1, Math.ceil(total / perPage)));
  }
  const rows = await db.query(
    `select bp.*, (select jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code) from brands b where b.id = bp.brand_id) as brand
     from brand_products bp ${f.where} order by bp.name, bp.id${paged ? ` limit ${perPage} offset ${(page - 1) * perPage}` : ''}`, f.params,
  );
  const byProduct = new Map<number, Row[]>(rows.map((r) => [Number(r.id), []]));
  for (let start = 0; start < rows.length; start += LIST_CHUNK) {
    const ids = rows.slice(start, start + LIST_CHUNK).map((r) => r.id);
    const lines = await db.query(
      `select i.id, i.brand_product_id, i.product_id, i.batch_amount_milli, i.batch_unit, i.yield_pieces,
         p.name as product_name, p.unit as product_unit, p.sku as product_sku, p.brand_id as product_brand_id
       from brand_product_ingredients i left join products p on p.id = i.product_id
       where i.brand_product_id = any($1::bigint[]) order by i.id`, [`{${ids.join(',')}}`],
    );
    for (const l of lines) {
      byProduct.get(Number(l.brand_product_id))?.push({
        id: l.id, product_id: l.product_id, batch_amount_milli: l.batch_amount_milli, batch_unit: l.batch_unit, yield_pieces: l.yield_pieces,
        product: l.product_name == null ? null : { id: l.product_id, name: l.product_name, unit: l.product_unit, sku: l.product_sku, brand_id: l.product_brand_id },
      });
    }
  }
  const data = rows.map((r) => present(c, { ...r, ingredients: byProduct.get(Number(r.id)) ?? [] }));
  if (!paged) return ok(c, data);
  const from = total ? (page - 1) * perPage + 1 : null;
  return c.json({
    message: 'OK', data,
    meta: { current_page: page, last_page: Math.max(1, Math.ceil(total / perPage)), per_page: perPage, total, from, to: total ? (from as number) + data.length - 1 : null },
  });
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
