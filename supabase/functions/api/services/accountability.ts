// Phase 1 rules shared by every applicant and inquiry route: required reasons, the assigned
// Sales user, and where Sales-facing alerts go.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail } from '../lib/http.ts';
import { roleName } from '../lib/middleware.ts';
import { notifyUser } from './notifications.ts';

export const REASON_MIN = 5;
export const UNASSIGNED_MESSAGE = 'Admin must assign a Sales user first.';

/** A required reason: trimmed, at least REASON_MIN characters. Returns the trimmed text. */
export function requireReason(value: unknown, field: string, what = 'a reason'): string {
  const text = String(value ?? '').trim();
  if (text.length < REASON_MIN) fail(field, `Give ${what} of at least ${REASON_MIN} characters.`);
  return text;
}

/** An optional reason that, when given, must still be meaningful. */
export function optionalReason(value: unknown, field: string, what = 'a reason'): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return requireReason(text, field, what);
}

export async function salesName(db: Db, userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db.query(`select full_name from users where id = $1`, [userId]);
  return row?.full_name ?? null;
}

/**
 * Only the assigned Sales user may act for an applicant (Admin is not affected here; each
 * route decides what Admin may do). An unassigned applicant blocks every Sales action.
 */
export async function assertAssignedSales(c: Context<AppEnv>, applicant: Row) {
  if (roleName(c) !== 'sales') return;
  if (!applicant.assigned_sales_user_id) abort(403, UNASSIGNED_MESSAGE);
  if (Number(applicant.assigned_sales_user_id) !== Number(c.get('user').id)) {
    const name = await salesName(c.get('deps').db, applicant.assigned_sales_user_id);
    abort(403, `Only the assigned Sales user${name ? ` (${name})` : ''} can do this for ${applicant.full_name}.`);
  }
}

/** Throws unless the id is an active Sales account; returns that user. */
export async function activeSalesUser(db: Db, id: unknown, field: string): Promise<Row> {
  if (id === undefined || id === null || id === '') fail(field, 'Choose the Sales user who will handle this applicant.');
  const [user] = await db.query(
    `select u.id, u.full_name, u.email, u.account_status, r.name as role_name from users u join roles r on r.id = u.role_id where u.id = $1`,
    [Number(id)],
  );
  if (!user || user.role_name !== 'sales' || user.account_status !== 'active') fail(field, 'Choose an active Sales user.');
  return user;
}

/** Sales-facing alerts go to the assigned Sales user only; an unassigned applicant alerts nobody in Sales. */
export async function notifyAssignedSales(db: Db, applicant: Row, type: string, title: string, message: string, data: Row = {}, actor?: Row | null) {
  if (!applicant.assigned_sales_user_id) return;
  await notifyUser(db, Number(applicant.assigned_sales_user_id), type, title, message, { applicant_id: applicant.id, ...data }, actor);
}
