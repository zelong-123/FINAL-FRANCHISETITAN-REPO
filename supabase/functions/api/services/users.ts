import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { manilaToday } from '../lib/http.ts';
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

/** Suspensions end by themselves once their end date has passed. */
export async function liftExpiredSuspension(db: Db, user: Row): Promise<boolean> {
  if (user.account_status !== 'suspended' || !user.suspended_until) return false;
  if (String(user.suspended_until).slice(0, 10) >= manilaToday()) return false;
  await db.query(`update users set account_status = 'active', suspended_from = null, suspended_until = null where id = $1`, [user.id]);
  Object.assign(user, { account_status: 'active', suspended_from: null, suspended_until: null });
  return true;
}

export async function liftExpiredSuspensions(db: Db): Promise<void> {
  await db.query(
    `update users set account_status = 'active', suspended_from = null, suspended_until = null
     where account_status = 'suspended' and suspended_until is not null and suspended_until < $1::date`,
    [manilaToday()],
  );
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

/** Keeps auth.users.email and users.email identical. */
export async function createAccount(
  c: Context<AppEnv>,
  fields: Row,
  password: string,
): Promise<Row> {
  const { db, auth } = c.get('deps');
  const authUserId = await auth.createUser(fields.email, password);
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
