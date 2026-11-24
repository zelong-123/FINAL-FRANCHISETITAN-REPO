// Step 1: clears the old test data so the demo starts clean. Kept: the catalogue (brands, products,
// categories, units, brand products and their ingredients), every user account, PSGC, every setting,
// branch materials and recipes (their stock history is rebuilt), and the two real franchisees,
// Ceejay Francisco and John Rey Carillo (their applicant records and files stay exactly as they are).
import type { Db } from './common.ts';
import { MODELS } from './common.ts';

export const KEEP_EMAILS = ['cj@gmail.com', 'johnreycarillo@gmail.com'];

const list = (ids: number[]) => `{${ids.join(',')}}`;

export async function keptAndReused(db: Db) {
  const keep = (await db.query(`select a.id, a.inquiry_id from applicants a join users u on u.id = a.user_id where lower(u.email) = any($1::text[])`, [list(KEEP_EMAILS)]));
  if (keep.length !== KEEP_EMAILS.length) throw new Error(`Expected the applicants of ${KEEP_EMAILS.join(' and ')}; found ${keep.length}.`);
  const keepIds = keep.map((r) => Number(r.id));
  const keepInquiries = keep.map((r) => Number(r.inquiry_id)).filter(Boolean);
  const reused = await db.query(
    `select f.id as franchisee_id, f.applicant_id, f.user_id, l.id as location_id, l.brand_id from franchisees f join franchise_locations l on l.franchisee_id = f.id and l.type = 'franchise'
     where f.applicant_id <> all($1::bigint[]) order by f.id`, [list(keepIds)],
  );
  return { keepIds, keepInquiries, reused };
}

export async function cleanup(db: Db, log: (s: string) => void) {
  const { keepIds, keepInquiries, reused } = await keptAndReused(db);
  const reusedIds = reused.map((r) => Number(r.applicant_id));
  const K = list(keepIds);
  const KR = list([...keepIds, ...reusedIds]);
  const run = async (label: string, sql: string, params: unknown[] = []) => {
    const rows = await db.query(`with d as (${sql} returning 1) select count(*)::int as n from d`, params);
    if (rows[0].n) log(`removed ${label}: ${rows[0].n}`);
  };

  // Files that belong to anything other than the two kept applicants.
  await run('documents', `delete from documents d where not (
      (d.documentable_type = '${MODELS.applicant}' and d.documentable_id = any($1::bigint[]))
   or (d.documentable_type = '${MODELS.requirement}' and d.documentable_id in (select id from applicant_requirements where applicant_id = any($1::bigint[])))
   or (d.documentable_type = '${MODELS.activity}' and d.documentable_id in (select id from activity_schedules where applicant_id = any($1::bigint[])))
   or (d.documentable_type = '${MODELS.payment}' and d.documentable_id in (select id from payments where applicant_id = any($1::bigint[]))))`, [K]);

  // Scheduling: participants and sessions of everyone else.
  await run('session participants', `delete from schedule_session_participants where applicant_id <> all($1::bigint[])`, [K]);
  await run('sessions', `delete from schedule_sessions s where not exists (select 1 from schedule_session_participants p where p.session_id = s.id)`);
  await run('day locks', `delete from schedule_day_locks`);

  // Applicant records: everything of the reused nine (rebuilt), and every other applicant.
  for (const table of ['payment_requests', 'payments', 'activity_schedules', 'applicant_assessment_logs', 'applicant_brand_confirmations', 'applicant_follow_up_alerts',
    'applicant_follow_up_events', 'applicant_payment_plans', 'applicant_payments', 'applicant_required_payments', 'applicant_requirements', 'applicant_stage_histories',
    'applicant_status_histories']) {
    await run(table, `delete from ${table} where applicant_id <> all($1::bigint[])`, [K]);
  }
  await run('follow-ups', `delete from follow_ups where not (followable_type = 'applicant' and followable_id = any($1::bigint[])) and not (followable_type = 'inquiry' and followable_id = any($2::bigint[]))`, [K, list(keepInquiries)]);
  await run('applicants', `delete from applicants where id <> all($1::bigint[])`, [KR]);
  await run('inquiry archive logs', `delete from inquiry_archive_logs where franchise_inquiry_id <> all($1::bigint[])`, [list(keepInquiries)]);
  await run('inquiries', `delete from franchise_inquiries where id <> all($1::bigint[])`, [list(keepInquiries)]);

  // Supply requests (rebuilt from the branch simulation).
  await run('supply reservations', `delete from supply_reservations`);
  await run('shortage reports', `delete from supply_shortage_reports`);
  await run('backorder requests', `delete from supply_requests where parent_request_id is not null`);
  await run('supply requests', `delete from supply_requests`);

  // Stock history: warehouse and branch inventories (warehouse rows stay, their history is rebuilt).
  await run('branch sale items', `delete from branch_sale_items`);
  await run('branch sales', `delete from branch_sales`);
  await run('old forecasts', `delete from forecasts`);
  await run('inventory transactions', `delete from inventory_transactions`);
  await run('inventory audit logs', `delete from inventory_audit_logs`);
  await run('branch inventory rows', `delete from inventories i using franchise_locations l where l.id = i.location_id and l.type <> 'warehouse'`);

  // Branch ledgers (materials and recipes stay; stock, production and counts are rebuilt).
  for (const table of ['profittrack_sale_voids', 'profittrack_sale_items', 'profittrack_sales', 'profittrack_production_consumptions', 'profittrack_production_batches',
    'profittrack_counts', 'profittrack_material_movements', 'profittrack_audit_events', 'profittrack_operations', 'forecast_material_classes', 'forecast_week_exclusions',
    'forecast_closure_periods', 'stock_alert_views']) {
    await run(table, `delete from ${table}`);
  }
  await db.query(`update profittrack_material_balances set quantity_milli = 0, value_cents = null, unit_cost_micropesos = null`);
  await db.query(`update profittrack_finished_balances set quantity_pieces = 0, value_cents = 0, unit_cost_micropesos = 0`);

  // Notifications start empty; the demo adds the ones its records would have raised.
  await run('notifications', `delete from system_notifications`);
  return { keepIds, keepInquiries, reused };
}
