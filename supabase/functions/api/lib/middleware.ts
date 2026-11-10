import type { Context, Next } from 'hono';
import type { AppEnv } from './env.ts';
import type { Db, Row } from './db.ts';
import { abort, HttpError, RawError, ValidationError } from './http.ts';
import { liftExpiredSuspension } from '../services/users.ts';

const TOKEN_REQUIRED = 'Authentication token is required.';
const TOKEN_INVALID = 'The authentication token is invalid or expired.';

/** AuthenticateApiToken: a Supabase JWT stands in for the old API token. */
export async function authenticate(c: Context<AppEnv>, next: Next) {
  const header = c.req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return c.json({ message: TOKEN_REQUIRED }, 401);

  const { db, auth } = c.get('deps');
  const verified = await auth.verify(token);
  if (!verified) return c.json({ message: TOKEN_INVALID }, 401);

  // JWTs outlive sign-out, so the session row is checked on every request. This is what
  // makes logout, password changes and account blocks immediate, as deleting a token was.
  const user = await currentUser(db, verified.authUserId, verified.sessionId);
  if (!user || user.session_live === false) return c.json({ message: TOKEN_INVALID }, 401);
  delete user.session_live;

  await liftExpiredSuspension(db, user);
  if (user.account_status !== 'active') return c.json({ message: TOKEN_INVALID }, 401);

  c.set('user', user);
  c.set('accessToken', token);
  c.set('sessionId', verified.sessionId);
  // An account still on its temporary password can only read itself, set its own password
  // and sign out. Every other route is refused here, so no page or client can skip the change.
  if (user.must_change_password && !FIRST_PASSWORD_ALLOWED.test(c.req.path)) {
    return c.json({ message: PASSWORD_CHANGE_REQUIRED, code: 'password_change_required' }, 403);
  }
  await next();
}

export const PASSWORD_CHANGE_REQUIRED = 'Set a new password before using the system.';
const FIRST_PASSWORD_ALLOWED = /\/auth\/(me|first-password|logout|heartbeat|session-end)$/;

async function currentUser(db: Db, authUserId: string, sessionId: string | null): Promise<Row | null> {
  const [row] = await db.query(
    `select u.*, to_jsonb(r) as role,
       ($2::uuid is null or exists (select 1 from auth.sessions s where s.id = $2::uuid)) as session_live
     from users u left join roles r on r.id = u.role_id
     where u.auth_user_id = $1::uuid`,
    [authUserId, sessionId],
  );
  return row ?? null;
}

/** EnsureUserHasRole. */
export const role = (...roles: string[]) => async (c: Context<AppEnv>, next: Next) => {
  if (!roles.includes(c.get('user')?.role?.name)) {
    return c.json({ message: 'You do not have permission to perform this action.' }, 403);
  }
  await next();
};

export const roleName = (c: Context<AppEnv>): string => c.get('user')?.role?.name ?? '';

export function requireFound<T>(row: T | null | undefined, message = 'Record not found.'): T {
  if (row === null || row === undefined) abort(404, message);
  return row as T;
}

// App\Support\Costing::KEYS: money fields outside the applicant Payment Submission stage.
const COSTING_KEYS = new Set([
  'unit_cost', 'unit_cost_micropesos', 'unit_cost_exact', 'stock_value', 'value_cents',
  'total_cost', 'total_cost_cents', 'value_delta_cents', 'material_cost', 'month_material_cost',
  'standard_price_cents', 'realized_price_cents', 'selling_price_cents',
  'revenue_cents', 'cost_cents', 'profit_cents', 'cost', 'cost_recorded',
]);

export function stripCosting(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCosting);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([k]) => !COSTING_KEYS.has(k)).map(([k, v]) => [k, stripCosting(v)]),
  );
}

/** StripCostingFields. Applicant routes are never touched. */
export async function costingFilter(c: Context<AppEnv>, next: Next) {
  await next();
  const { costingEnabled } = c.get('deps');
  const type = c.res.headers.get('content-type') ?? '';
  if (costingEnabled || !type.includes('application/json') || /\/api\/v1\/applicants/.test(c.req.path)) return;
  const stripped = stripCosting(await c.res.clone().json());
  c.res = new Response(JSON.stringify(stripped), { status: c.res.status, headers: c.res.headers });
}

export function renderError(error: Error, c: Context<AppEnv>) {
  if (error instanceof RawError) return c.json(error.body, error.status as never);
  if (error instanceof ValidationError) return c.json({ message: error.message, errors: error.errors }, 422);
  if (error instanceof HttpError) return c.json({ message: error.message || 'Request failed.' }, error.status as never);
  console.error(error);
  return c.json({ message: 'An unexpected server error occurred.' }, 500);
}
