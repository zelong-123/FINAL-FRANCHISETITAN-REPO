import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Deps } from './lib/env.ts';
import { authenticate, costingFilter, renderError, role, roleName } from './lib/middleware.ts';
import { ok } from './lib/http.ts';
import { PERMISSIONS, PIPELINE } from './config/roles.ts';
import { authRoutes } from './routes/auth.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { chatRoutes } from './routes/chat.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { userRoutes } from './routes/users.ts';
import { archiveRoutes, inquiryRoutes } from './routes/inquiries.ts';
import { applicantRoutes } from './routes/applicants.ts';
import { requirementRoutes } from './routes/requirements.ts';
import { paymentRecordRoutes } from './routes/paymentRecord.ts';
import { activityRoutes } from './routes/activities.ts';
import { sessionRoutes } from './routes/scheduleSessions.ts';
import { inventoryRoutes } from './routes/inventory.ts';
import { supplyRoutes } from './routes/supply.ts';
import { brandProductRoutes } from './routes/brandProducts.ts';
import { workspaceRoutes } from './routes/branchWorkspace.ts';
import { portalRoutes } from './routes/branchPortal.ts';
import { branchRoutes } from './routes/branches.ts';
import { profitTrackRoutes } from './routes/profittrack.ts';
import { forecastRoutes } from './routes/estimatedRequirement.ts';
import { analyticsRoutes } from './routes/analytics.ts';

export function createApp(deps: Deps, allowedOrigins: string[] = ['*']) {
  const app = new Hono<AppEnv>().basePath('/api/v1');

  app.use('*', cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    allowHeaders: ['authorization', 'content-type', 'x-client-info', 'apikey'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['content-disposition', 'x-template-rows'],
  }));
  app.use('*', async (c, next) => { c.set('deps', deps); await next(); });
  app.use('*', costingFilter);
  app.onError(renderError);

  // Public
  app.get('/health', async (c) => {
    let database = 'ok';
    try { await deps.db.query('select 1'); } catch { database = 'unavailable'; }
    return c.json({
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      time: new Date().toISOString(),
      version: '3.0.0',
    }, database === 'ok' ? 200 : 503);
  });

  // auth/login is public; authRoutes authenticates everything after it.
  app.route('/auth', authRoutes);

  app.use('/chat/*', authenticate);
  app.route('/chat', chatRoutes);

  app.use('/notifications', authenticate);
  app.use('/notifications/*', authenticate);
  app.route('/notifications', notificationRoutes);

  for (const path of ['/users', '/users/*', '/audit-logs']) {
    app.use(path, authenticate, role('admin'));
  }
  app.route('/', userRoutes);

  for (const path of ['/brands', '/brands/*', '/units', '/product-categories', '/product-categories/*', '/locations', '/locations/*', '/products', '/products/*']) {
    app.use(path, authenticate);
  }
  app.route('/', catalogRoutes);

  for (const path of ['/inquiries', '/inquiries/*', '/archive', '/archive/*', '/applicants', '/applicants/*']) {
    app.use(path, authenticate);
  }
  app.route('/', inquiryRoutes);
  app.route('/', archiveRoutes);
  // Registered before the applicant routes' siblings: /applicants/:id/activities/set-again lives here.
  for (const path of ['/activities', '/activities/*', '/schedule-sessions', '/schedule-sessions/*']) {
    app.use(path, authenticate);
  }
  app.route('/', requirementRoutes);
  app.route('/', paymentRecordRoutes);
  app.route('/', applicantRoutes);
  app.route('/', activityRoutes);
  app.route('/', sessionRoutes);

  for (const path of ['/inventories', '/inventories/*', '/warehouse/*', '/inventory-audit-logs', '/inventory-transactions', '/forecasts', '/forecasts/*', '/supply-requests', '/supply-requests/*', '/supply-settings', '/brand-products', '/brand-products/*']) {
    app.use(path, authenticate);
  }
  app.route('/', inventoryRoutes);
  app.route('/', supplyRoutes);
  app.route('/', brandProductRoutes);

  for (const path of ['/branch/*', '/branches/*', '/profittrack/*']) app.use(path, authenticate);
  app.route('/', workspaceRoutes);
  app.route('/', portalRoutes);
  app.route('/', branchRoutes);
  app.route('/', profitTrackRoutes);

  for (const path of ['/estimated-requirement', '/estimated-requirement/*', '/analytics/*']) app.use(path, authenticate);
  app.route('/', forecastRoutes);
  app.route('/', analyticsRoutes);

  app.get('/pipeline-config', authenticate, (c) => ok(c, {
    ...PIPELINE,
    role: roleName(c),
    permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([key, roles]) => [key, roles.includes(roleName(c))])),
  }));

  // SystemController::syncStatus. Panels poll this, so it is one query, not nine.
  app.get('/sync-status', authenticate, async (c) => {
    const [v] = await deps.db.query(`select
      (select coalesce(max(id), 0) from inventory_transactions) as inventory_version,
      concat_ws(':', (select coalesce(max(id), 0) from supply_requests), (select coalesce(max(id), 0) from supply_request_status_histories),
        coalesce((select max(updated_at)::text from supply_requests), '')) as supply_request_version,
      concat_ws(':', (select coalesce(max(id), 0) from activity_schedules), (select count(*) from activity_schedules),
        coalesce((select max(updated_at)::text from activity_schedules), '')) as activity_version,
      concat_ws(':', (select coalesce(max(id), 0) from applicants), (select count(*) from applicants), coalesce((select max(updated_at)::text from applicants), ''),
        (select coalesce(max(id), 0) from payments), coalesce((select max(updated_at)::text from payments), '')) as applicant_version,
      concat_ws(':', (select coalesce(max(id), 0) from profittrack_operations), coalesce((select max(updated_at)::text from profittrack_production_batches), ''),
        coalesce((select max(updated_at)::text from forecast_closure_periods), ''), (select count(*) from forecast_closure_periods),
        coalesce((select max(updated_at)::text from forecast_week_exclusions), ''), (select count(*) from forecast_week_exclusions),
        coalesce((select max(updated_at)::text from forecast_settings), ''), (select coalesce(max(id), 0) from supply_requests),
        coalesce((select max(updated_at)::text from supply_requests), '')) as forecast_version`);
    return ok(c, { ...v, server_time: new Date().toISOString() });
  });

  // Retired with the Analytics page: blocked for every role.
  app.get('/profittrack/analytics', authenticate, (c) => c.json({ message: 'ProfitTrack analytics is not available.' }, 403));

  // Every Laravel route is ported, so anything else simply does not exist.
  app.all('*', (c) => c.json({ message: 'The requested resource was not found.' }, 404));

  return app;
}
