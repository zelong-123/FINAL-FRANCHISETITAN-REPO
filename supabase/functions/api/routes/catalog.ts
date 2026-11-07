// BrandController, UnitController, ProductCategoryController, LocationController, ProductController.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { boolParam, fail, insertRow, intParam, ok, paginate, perPage, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';

export const catalogRoutes = new Hono<AppEnv>();
const admin = role('admin');

const collapse = (name: string) => name.trim().replace(/\s+/gu, ' ');
const BRAND = 'App\\Models\\Brand';
const LOCATION = 'App\\Models\\FranchiseLocation';
const PRODUCT = 'App\\Models\\Product';

// ---- Brands ----
catalogRoutes.get('/brands', async (c) => {
  const { db } = c.get('deps');
  const rows = await db.query(
    `select b.*, (select count(*)::int from products p where p.brand_id = b.id) as products_count,
       (select count(*)::int from franchise_locations l where l.brand_id = b.id) as locations_count
     from brands b ${boolParam(c.req.query('include_inactive')) ? '' : 'where b.is_active = true'} order by b.name`,
  );
  return ok(c, rows);
});

catalogRoutes.post('/brands', admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    name: ['required', 'string', 'max:150', 'unique:brands,name'],
    code: ['required', 'string', 'max:30', 'alpha_dash', 'unique:brands,code'],
    description: ['nullable', 'string'],
    is_active: ['nullable', 'boolean'],
  });
  if (v.is_active === null) delete v.is_active;
  const brand = await insertRow(db, 'brands', v);
  await audit(c, db, 'brand.created', { type: BRAND, id: brand.id }, null, brand);
  return ok(c, brand, 'Brand created.', 201);
});

catalogRoutes.put('/brands/:brand', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'brand');
  const [old] = await db.query(`select * from brands where id = $1`, [id]);
  requireFound(old);
  const v = await validate(db, await readInput(c), {
    name: ['sometimes', 'required', 'string', 'max:150', `unique:brands,name,${id}`],
    code: ['sometimes', 'required', 'string', 'max:30', 'alpha_dash', `unique:brands,code,${id}`],
    description: ['nullable', 'string'],
    is_active: ['sometimes', 'boolean'],
  });
  const brand = await updateRow(db, 'brands', id, v);
  await audit(c, db, 'brand.updated', { type: BRAND, id }, old, brand);
  return ok(c, brand, 'Brand updated.');
});

catalogRoutes.delete('/brands/:brand', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'brand');
  const [old] = await db.query(`select * from brands where id = $1`, [id]);
  requireFound(old);
  const brand = await updateRow(db, 'brands', id, { is_active: false });
  await audit(c, db, 'brand.deactivated', { type: BRAND, id }, old, brand);
  return ok(c, null, 'Brand deactivated.');
});

// ---- Units ----
catalogRoutes.get('/units', async (c) => ok(c, await c.get('deps').db.query(`select id, name from units order by id`)));

catalogRoutes.post('/units', role('admin', 'logistics', 'franchisee'), async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { name: ['required', 'string', 'max:20'] });
  const name = collapse(String(v.name));
  if (!/^\p{L}+$/u.test(name)) fail('name', 'Use letters only (for example "bottle").');
  const normalized = name.toLowerCase();
  if ((await db.query(`select 1 from units where name_normalized = $1`, [normalized])).length) fail('name', 'This unit already exists.');
  return ok(c, await insertRow(db, 'units', { name, name_normalized: normalized }), 'Unit added.', 201);
});

// ---- Product categories ----
catalogRoutes.get('/product-categories', async (c) => {
  const { db } = c.get('deps');
  const brandId = c.req.query('brand_id');
  const rows = await db.query(
    `select pc.id, pc.brand_id, pc.name, (select count(*)::int from products p where p.category_id = pc.id) as products_count
     from product_categories pc ${brandId ? 'where pc.brand_id = $1' : ''} order by pc.name`,
    brandId ? [intParam(brandId)] : [],
  );
  return ok(c, rows);
});

catalogRoutes.post('/product-categories', role('admin', 'logistics'), async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    brand_id: ['required', 'integer', 'exists:brands,id'],
    name: ['required', 'string', 'max:50'],
  });
  const name = collapse(String(v.name));
  if (!/^[\p{L} /-]+$/u.test(name)) fail('name', 'Use letters, spaces, "/" and "-" only (for example "Syrup / Flavoring").');
  const normalized = name.toLowerCase();
  const taken = await db.query(`select 1 from product_categories where brand_id = $1 and name_normalized = $2`, [v.brand_id, normalized]);
  if (taken.length) fail('name', 'This category already exists for the selected brand.');
  return ok(c, await insertRow(db, 'product_categories', { brand_id: v.brand_id, name, name_normalized: normalized }), 'Category added.', 201);
});

catalogRoutes.delete('/product-categories/:category', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'category');
  requireFound((await db.query(`select id from product_categories where id = $1`, [id]))[0]);
  const [{ used }] = await db.query<{ used: number }>(`select count(*)::int as used from products where category_id = $1`, [id]);
  if (used > 0) fail('category', `This category is used by ${used} product(s) and cannot be deleted.`);
  await db.query(`delete from product_categories where id = $1`, [id]);
  return ok(c, null, 'Category deleted.');
});

// ---- Locations ----
const LOCATION_SELECT = `l.*, (select to_jsonb(b) from brands b where b.id = l.brand_id) as brand,
  (select to_jsonb(f) || jsonb_build_object('user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) from users u where u.id = f.user_id))
   from franchisees f where f.id = l.franchisee_id) as franchisee`;
const loadLocation = async (db: Db, id: number) => (await db.query(`select ${LOCATION_SELECT} from franchise_locations l where l.id = $1`, [id]))[0];

function checkOwnership(type: string, franchiseeId: unknown, brandId: unknown) {
  if (type === 'franchise' && (!franchiseeId || !brandId)) fail('franchisee_id', 'A franchise location requires both a franchisee and a brand.');
  if (type === 'warehouse' && franchiseeId) fail('franchisee_id', 'A warehouse cannot be assigned to a franchisee.');
}

catalogRoutes.get('/locations', async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.type) add('l.type = ?', q.type);
  if (q.brand_id) add('l.brand_id = ?', intParam(q.brand_id));
  if (!boolParam(q.include_inactive)) where.push('l.is_active = true');
  if (roleName(c) === 'franchisee') add('exists (select 1 from franchisees f where f.id = l.franchisee_id and f.user_id = ?)', c.get('user').id);
  const rows = await db.query(`select ${LOCATION_SELECT} from franchise_locations l ${where.length ? `where ${where.join(' and ')}` : ''} order by l.name`, params);
  return ok(c, rows);
});

const locationRules = (id?: number) => ({
  franchisee_id: ['nullable', 'exists:franchisees,id'],
  brand_id: ['nullable', 'exists:brands,id'],
  name: id ? ['sometimes', 'required', 'string', 'max:255'] : ['required', 'string', 'max:255'],
  branch_code: ['nullable', 'string', 'max:50', 'alpha_dash', `unique:franchise_locations,branch_code${id ? `,${id}` : ''}`],
  type: id ? ['sometimes', 'in:franchise,warehouse'] : ['required', 'in:franchise,warehouse'],
  address: id ? ['sometimes', 'required', 'string'] : ['required', 'string'],
  city: ['nullable', 'string', 'max:100'],
  province: ['nullable', 'string', 'max:100'],
  region: ['nullable', 'string', 'max:100'],
  contact_number: ['nullable', 'string', 'max:50'],
  is_active: id ? ['sometimes', 'boolean'] : ['nullable', 'boolean'],
});

catalogRoutes.post('/locations', admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), locationRules());
  checkOwnership(v.type, v.franchisee_id, v.brand_id);
  if (v.is_active === null) delete v.is_active;
  const location = await insertRow(db, 'franchise_locations', v);
  await audit(c, db, 'location.created', { type: LOCATION, id: location.id }, null, location);
  return ok(c, await loadLocation(db, location.id), 'Location created.', 201);
});

catalogRoutes.put('/locations/:location', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'location');
  const [old] = await db.query(`select * from franchise_locations where id = $1`, [id]);
  requireFound(old);
  const v = await validate(db, await readInput(c), locationRules(id));
  checkOwnership(
    v.type ?? old.type,
    'franchisee_id' in v ? v.franchisee_id : old.franchisee_id,
    'brand_id' in v ? v.brand_id : old.brand_id,
  );
  const saved = await updateRow(db, 'franchise_locations', id, v);
  await audit(c, db, 'location.updated', { type: LOCATION, id }, old, saved);
  return ok(c, await loadLocation(db, id), 'Location updated.');
});

// ---- Products ----
const productJson = (row: Row): Row => ({ ...row, pack_size: row.pack_size === null ? null : Number(row.pack_size) });
const PRODUCT_SELECT = `p.*, (select to_jsonb(b) from brands b where b.id = p.brand_id) as brand`;
const loadProduct = async (db: Db, id: number) => productJson((await db.query(`select ${PRODUCT_SELECT} from products p where p.id = $1`, [id]))[0]);

catalogRoutes.get('/products', async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.brand_id) { params.push(intParam(q.brand_id)); where.push(`p.brand_id = $${params.length}`); }
  if (!boolParam(q.include_inactive)) where.push('p.is_active = true');
  if (q.search) { params.push(`%${q.search}%`); where.push(`(p.name ilike $${params.length} or p.sku ilike $${params.length})`); }
  return paginate(c, db, {
    columns: PRODUCT_SELECT, from: 'products p', where, params, orderBy: 'p.name', perPage: perPage(c, 50), map: productJson,
  });
});

catalogRoutes.post('/products', role('admin', 'logistics'), async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    brand_id: ['nullable', 'exists:brands,id'],
    sku: ['required', 'string', 'max:80', 'unique:products,sku'],
    name: ['required', 'string', 'max:255'],
    category: ['nullable', 'string', 'max:100'],
    unit: ['required', 'string', 'max:30'],
    is_active: ['nullable', 'boolean'],
  });
  if (v.is_active === null) delete v.is_active;
  const product = await insertRow(db, 'products', v);
  await audit(c, db, 'product.created', { type: PRODUCT, id: product.id }, null, product);
  return ok(c, await loadProduct(db, product.id), 'Product created.', 201);
});

catalogRoutes.put('/products/:product', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'product');
  const [old] = await db.query(`select * from products where id = $1`, [id]);
  requireFound(old);
  const v = await validate(db, await readInput(c), {
    brand_id: ['nullable', 'exists:brands,id'],
    sku: ['sometimes', 'required', 'string', 'max:80', `unique:products,sku,${id}`],
    name: ['sometimes', 'required', 'string', 'max:255'],
    category: ['nullable', 'string', 'max:100'],
    unit: ['sometimes', 'required', 'string', 'max:30'],
    is_active: ['sometimes', 'boolean'],
  });
  const saved = await updateRow(db, 'products', id, v);
  await audit(c, db, 'product.updated', { type: PRODUCT, id }, old, saved);
  return ok(c, await loadProduct(db, id), 'Product updated.');
});

catalogRoutes.delete('/products/:product', admin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'product');
  const [old] = await db.query(`select * from products where id = $1`, [id]);
  requireFound(old);
  const saved = await updateRow(db, 'products', id, { is_active: false });
  await audit(c, db, 'product.deactivated', { type: PRODUCT, id }, old, saved);
  return ok(c, null, 'Product deactivated.');
});
