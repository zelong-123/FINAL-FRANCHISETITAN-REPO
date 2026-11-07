// Compares Laravel's real route table (docs/laravel-routes.json, from `artisan route:list --json`)
// with what the Edge Function serves, so migration progress is measured rather than estimated.
// Usage: node --no-warnings tools/route-coverage.mjs [--list]
import { readFileSync } from 'node:fs';
import { createApp } from '../supabase/functions/api/app.ts';

const laravel = JSON.parse(readFileSync(new URL('../docs/laravel-routes.json', import.meta.url), 'utf8'))
  .filter((r) => r.uri.startsWith('api/v1'))
  .flatMap((r) => r.method.split('|').filter((m) => !['HEAD'].includes(m)).map((method) => ({
    method,
    // Parameter names differ harmlessly between the two, so compare the path's shape.
    shape: `/${r.uri}`.replace(/\{[^}]+\}/g, ':'),
    controller: (r.action.match(/([A-Za-z]+)Controller/) || [, 'closure'])[1],
  })));

const app = createApp({ db: null, auth: null, costingEnabled: false });
const served = new Set(app.routes
  .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
  .map((r) => `${r.method} ${r.path.replace(/:[^/]+/g, ':').replace(/\/$/, '')}`));

const byController = {};
const missing = [];
for (const route of laravel) {
  const bucket = (byController[route.controller] ??= { done: 0, total: 0 });
  bucket.total += 1;
  if (served.has(`${route.method} ${route.shape}`)) bucket.done += 1;
  else missing.push(`${route.method} ${route.shape}`);
}
const done = laravel.length - missing.length;
console.log(`Routes ported: ${done} of ${laravel.length} (${Math.round((done / laravel.length) * 100)}%)\n`);
for (const [name, b] of Object.entries(byController).sort((a, b2) => (b2[1].total - b2[1].done) - (a[1].total - a[1].done))) {
  console.log(`${String(b.done).padStart(4)} / ${String(b.total).padEnd(4)} ${name}`);
}
if (process.argv.includes('--list')) console.log(`\nMissing:\n${missing.join('\n')}`);
