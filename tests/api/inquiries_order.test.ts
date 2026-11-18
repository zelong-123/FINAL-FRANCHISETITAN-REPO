// Admin inquiry list: Endorsed (not converted) leads first, then Converted, then the rest (Rejected); within a group the
// existing order (id ascending) keeps pages stable. Marketing, date sort, archive and filters are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);

let seq = 0;
async function inquiry(status: string) {
  seq += 1;
  const created = await call('POST', '/inquiries', {
    token: marketing,
    body: { lead_name: `Order Lead ${seq}`, first_name: `Order${seq}`, last_name: 'Lead', phone: `0921${String(1000000 + seq).slice(1)}`, source: 'facebook', preferred_brand_id: brand.id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await q(`update franchise_inquiries set status = $2 where id = $1`, [created.json.data.id, status]);
  return Number(created.json.data.id);
}
const RANK: Record<string, number> = { endorsed: 0, converted: 1 };
const rank = (status: string) => RANK[status] ?? 2;

// Admin sees Endorsed, Converted and Rejected; Marketing (who encoded them) sees all of them.
for (const status of ['rejected', 'converted', 'endorsed', 'new', 'endorsed', 'converted', 'rejected', 'endorsed']) await inquiry(status);

const list = async (token: string, query = '') => (await call('GET', `/inquiries?per_page=100${query}`, { token })).json.data as any[];

test('Admin: Endorsed first, then Converted, then the rest; id ascending within each group', async () => {
  const rows = await list(admin);
  assert.deepEqual(rows.map((r) => r.status), ['endorsed', 'endorsed', 'endorsed', 'converted', 'converted', 'rejected', 'rejected']);
  for (let i = 1; i < rows.length; i += 1) {
    const [a, b] = [rows[i - 1], rows[i]];
    assert.ok(rank(a.status) < rank(b.status) || (rank(a.status) === rank(b.status) && Number(a.id) < Number(b.id)),
      `row ${i}: ${a.status}#${a.id} before ${b.status}#${b.id}`);
  }
  assert.equal(rows[0].status, 'endorsed');
});

test('Admin: server-side pages are stable (pages of 3 = the whole list)', async () => {
  const all = (await list(admin)).map((r) => r.id);
  const paged: number[] = [];
  for (let page = 1; paged.length < all.length && page < 50; page += 1) {
    const res = await call('GET', `/inquiries?per_page=3&page=${page}`, { token: admin });
    paged.push(...res.json.data.map((r: any) => r.id));
  }
  assert.deepEqual(paged, all);
  assert.equal((await call('GET', '/inquiries', { token: admin })).json.meta.per_page, 20, '20 per page by default');
});

test('unchanged: date sort, status filter, search and the Marketing order', async () => {
  const byDate = await list(admin, '&sort=date');
  for (let i = 1; i < byDate.length; i += 1) {
    const [a, b] = [byDate[i - 1], byDate[i]];
    assert.ok(a.inquiry_date > b.inquiry_date || (a.inquiry_date === b.inquiry_date && Number(a.id) > Number(b.id)), 'newest first, no grouping');
  }
  assert.ok((await list(admin, '&status=converted')).every((r) => r.status === 'converted'));
  const searched = await list(admin, '&search=Order%20Lead%203');
  assert.equal(searched[0].lead_name, 'Order Lead 3', 'search relevance still comes first');
  const mine = await list(marketing);
  const marketingRank: Record<string, number> = { new: 0, endorsed: 1, converted: 2 };
  for (let i = 1; i < mine.length; i += 1) {
    assert.ok((marketingRank[mine[i - 1].status] ?? 3) <= (marketingRank[mine[i].status] ?? 3), 'Marketing: New first, as before');
  }
});
