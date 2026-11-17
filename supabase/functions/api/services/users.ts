import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { fail, manilaToday } from '../lib/http.ts';
import { applicantJson } from './applicantModel.ts';

/** $hidden on the User model, plus the Supabase link. */
export function publicUser(row: Row): Row {
  const { auth_user_id: _auth, session_live: _live, ...visible } = row;
  return visible;
}

export async function loadUser(db: Db, id: number): Promise<Row | null> {
  const [row] = await db.query(
    `select u.*, to_jsonb(r) as role from users u left join roles r on r.id = u.role_id where u.id = $1`,
    [id],
  );
  return row ? publicUser(row) : null;
}

/** The user's applicant and franchisee.locations.brand relations. */
export async function loadUserRelations(db: Db, id: number): Promise<Row> {
  const [applicant] = await db.query(`select * from applicants where user_id = $1 limit 1`, [id]);
  const [franchisee] = await db.query(
    `select f.*, coalesce((
       select jsonb_agg(to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id)) order by l.id)
       from franchise_locations l where l.franchisee_id = f.id), '[]'::jsonb) as locations
     from franchisees f where f.user_id = $1 limit 1`,
    [id],
  );
  return { applicant: applicant ? applicantJson(applicant) : null, franchisee: franchisee ?? null };
}

const at = (v: unknown) => (v ? new Date(v as string).getTime() : null);

/**
 * The archive (suspension) clock, checked on sign-in, on every request and on list load — no
 * scheduled job: a suspended account cannot do anything until it is checked anyway.
 *  - A scheduled suspension (start time later than the archive action) begins once its start passes.
 *  - A suspension with an end time ends by itself once the end passes: the account is active again,
 *    unarchived, and the restore is written to audit_logs as "user.auto_restored".
 * Returns true when the account changed.
 */
export async function liftExpiredSuspension(db: Db, user: Row): Promise<boolean> {
  const now = Date.now();
  const from = at(user.suspended_from);
  const until = at(user.suspended_until);
  const inWindow = user.account_status === 'suspended' || (user.account_status === 'active' && from !== null);
  if (inWindow && until !== null && until <= now) {
    const old = { account_status: user.account_status, suspended_from: user.suspended_from, suspended_until: user.suspended_until, archived_at: user.archived_at, archive_reason: user.archive_reason ?? null };
    const cleared = { account_status: 'active', suspended_from: null, suspended_until: null, archived_at: null, archived_by_user_id: null, archive_reason: null };
    await db.query(
      `update users set account_status = 'active', suspended_from = null, suspended_until = null, archived_at = null, archived_by_user_id = null, archive_reason = null where id = $1`,
      [user.id],
    );
    await db.query(
      `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'user.auto_restored', 'App\\Models\\User', $1, $2, $3, now())`,
      [user.id, JSON.stringify(old), JSON.stringify({ account_status: 'active', note: 'The suspension end time passed.' })],
    );
    Object.assign(user, cleared);
    return true;
  }
  if (user.account_status === 'active' && from !== null && from <= now) {
    await db.query(`update users set account_status = 'suspended' where id = $1 and account_status = 'active'`, [user.id]);
    user.account_status = 'suspended';
    return true;
  }
  return false;
}

/** The same clock for every account with a suspension window (run when the user list loads). */
export async function liftExpiredSuspensions(db: Db): Promise<void> {
  const rows = await db.query(
    `select * from users where suspended_from is not null or suspended_until is not null or account_status = 'suspended'`,
  );
  for (const user of rows) await liftExpiredSuspension(db, user);
}

/** "Mon DD, YYYY h:mm AM" in Manila, for suspension messages. */
export function manilaTimeLabel(value: unknown, withTime = true): string {
  return new Date(value as string).toLocaleString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}), timeZone: 'Asia/Manila',
  });
}

/** HasPublicCode: USR-YYYY-NNNNN from the primary key, written once in the insert's transaction. */
export async function assignPublicCode(db: Db, table: string, column: string, prefix: string, id: number): Promise<string> {
  const [row] = await db.query<{ code: string }>(
    `update ${table}
     set ${column} = coalesce(${column}, $1 || '-' || to_char(coalesce(created_at, now()) at time zone 'Asia/Manila', 'YYYY') || '-' || lpad(id::text, 5, '0'))
     where id = $2 returning ${column} as code`,
    [prefix, id],
  );
  return row.code;
}

export function audit(
  c: Context<AppEnv>,
  db: Db,
  action: string,
  model?: { type: string; id: number } | null,
  oldValues?: Row | null,
  newValues?: Row | null,
  actorId?: number | null,
) {
  return db.query(
    `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, ip_address, user_agent, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      actorId ?? c.get('user')?.id ?? (model?.type === 'App\\Models\\User' ? model.id : null),
      action,
      model?.type ?? null,
      model?.id ?? null,
      oldValues && Object.keys(oldValues).length ? JSON.stringify(oldValues) : null,
      newValues && Object.keys(newValues).length ? JSON.stringify(newValues) : null,
      clientIp(c),
      c.req.header('user-agent') ?? null,
    ],
  );
}

export function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
}

/** How a new account gets its first sign-in: a temporary password, or an emailed invitation. */
export type AccountCredential = string | { invite: { redirectTo?: string | null; fullName?: string | null } };

/**
 * Creates the sign-in and the users row together; keeps auth.users.email and users.email identical.
 * Staff accounts are invited by email (the person sets their own password from the link); Franchisee
 * portal accounts keep a system-generated temporary password, shown once and changed at first sign-in.
 * The sign-in is created first; if the database insert then fails it is removed again, so no orphan
 * sign-in (invited or not) is left behind.
 */
export async function createAccount(c: Context<AppEnv>, fields: Row, credential: AccountCredential): Promise<Row> {
  const { db, auth } = c.get('deps');
  let authUserId: string;
  if (typeof credential === 'string') {
    authUserId = await auth.createUser(fields.email, credential);
  } else {
    try {
      authUserId = await auth.inviteUser(fields.email, credential.invite);
    } catch (error) {
      // Nothing was created: the invitation itself failed (e.g. email not sent, address refused).
      fail('email', `The invitation email could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    return await db.tx(async (tx) => {
      const columns = { ...fields, auth_user_id: authUserId };
      const keys = Object.keys(columns);
      const [row] = await tx.query(
        `insert into users (${keys.map((k) => `"${k}"`).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
        keys.map((k) => (columns as Row)[k]),
      );
      row.user_code = await assignPublicCode(tx, 'users', 'user_code', 'USR', row.id);
      return row;
    });
  } catch (error) {
    await auth.deleteUser(authUserId).catch(() => {});
    throw error;
  }
}
