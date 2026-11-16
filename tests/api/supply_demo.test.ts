// The local-only supply demo: it refuses anything but an in-memory PGlite with an explicit
// { local: true }, and it gives the demo real Days covered / Suggested numbers and a Critical item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, PASSWORD, setup } from '../support/harness.ts';
import { seedSupplyDemo } from '../../supabase/seed/supplyDemo.ts';

const { pg, app, call, login } = await setup();

test('the guard refuses without { local: true } and refuses anything that is not PGlite', async () => {
  await assert.rejects(seedSupplyDemo(pg as any, app, {}), /local: true/);
  const fake = { query: pg.query.bind(pg), dataDir: undefined };
  await assert.rejects(seedSupplyDemo(fake as any, app, { local: true }), /in-memory PGlite/);
  assert.equal((await pg.query(`select count(*)::int as n from supply_requests`)).rows[0].n, 0, 'nothing was written');
});

test('the demo has every state, real forecast numbers and a Critical item', async () => {
  const made = await seedSupplyDemo(pg as any, app, { local: true, password: PASSWORD });
  for (const key of ['completed', 'on_hold', 'partial', 'backorder', 'returned', 'date_change', 'shortage', 'weekend', 'discrepancy', 'consolidated', 'delivered', 'submitted', 'under_review', 'overdue']) {
    assert.ok(made[key], key);
  }
  const admin = await login(ADMIN);
  const counts = (await call('GET', '/supply-requests/counts', { token: admin })).json.data;
  for (const tab of ['under_review', 'on_hold', 'scheduled_preparing', 'dispatched', 'discrepancy', 'completed', 'needs_action']) assert.ok(counts.tabs[tab] > 0, tab);
  assert.ok(counts.kpis.overdue >= 1);
  const list = (await call('GET', '/supply-requests?tab=all&per_page=100', { token: admin })).json.data;
  const review = list.find((r: any) => r.request_number === made.under_review);
  const lines = (await call('GET', `/supply-requests/${review.id}`, { token: admin })).json.data.review_lines;
  assert.ok(lines.every((l: any) => typeof l.days_covered === 'number' && typeof l.suggested === 'number'), JSON.stringify(lines));
  assert.ok(lines.some((l: any) => l.critical), 'Fresh milk is Critical');
  const again = await seedSupplyDemo(pg as any, app, { local: true, password: PASSWORD });
  assert.ok(again.skipped, 'a second run changes nothing');
});
