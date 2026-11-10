// GET /brand-products: optional pagination; without it the whole list comes back as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN, setup } from '../support/harness.ts';
import { replaceProducts } from '../../supabase/seed/replaceProducts.ts';

const { db, call, login } = await setup();
await replaceProducts(db, readFileSync(new URL('../../supabase/seed/products.csv', import.meta.url), 'utf8'));
const admin = await login(ADMIN);
const list = (qs: string) => call('GET', `/brand-products${qs}`, { token: admin });

test('without per_page the whole list is returned, as before', async () => {
  const all = await list('');
  assert.equal(all.status, 200);
  assert.equal(all.json.data.length, 33);
  assert.equal(all.json.meta, undefined);
  assert.ok(all.json.data.every((p: any) => p.ingredients.length > 0 && p.recipe_complete));
});

test('pages of 10: 33 products make 4 pages, in name order, with nothing missing or repeated', async () => {
  const names: string[] = [];
  for (let page = 1; page <= 4; page++) {
    const res = await list(`?page=${page}&per_page=10`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.meta, { current_page: page, last_page: 4, per_page: 10, total: 33, from: (page - 1) * 10 + 1, to: Math.min(page * 10, 33) });
    names.push(...res.json.data.map((p: any) => p.name));
  }
  const all = (await list('')).json.data.map((p: any) => p.name);
  assert.deepEqual(names, all, 'the pages together are exactly the full list');
  assert.equal((await list('?page=4&per_page=10')).json.data.length, 3);
});

test('filters are counted before paging, and a page past the end shows the last page', async () => {
  const [laPasta] = (await call('GET', '/brands', { token: admin })).json.data.filter((b: any) => b.name === 'La Pasta');
  const byBrand = await list(`?page=1&per_page=10&brand_id=${laPasta.id}`);
  assert.equal(byBrand.json.meta.total, 5);
  assert.equal(byBrand.json.meta.last_page, 1);
  const search = await list('?page=1&per_page=2&search=caramel');
  assert.equal(search.json.meta.total, 4);
  assert.equal(search.json.data.length, 2);
  const far = await list('?page=99&per_page=10');
  assert.equal(far.json.meta.current_page, 4);
  assert.equal(far.json.data.length, 3);
  assert.equal((await list('?page=1&per_page=500')).json.meta.per_page, 100, 'per_page is capped');
});
