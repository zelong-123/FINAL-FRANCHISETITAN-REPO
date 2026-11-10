import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { fail, ok, pick, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { authenticate, roleName } from '../lib/middleware.ts';
import { audit, clientIp, liftExpiredSuspension, loadUser, loadUserRelations, publicUser } from '../services/users.ts';
import * as presence from '../services/presence.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from '../services/credentials.ts';

const USER_MODEL = 'App\\Models\\User';
const MAX_ATTEMPTS = 5;
const DECAY_SECONDS = 60;

// RateLimiter: only failed sign-ins count, per account + IP, so one person's mistakes can
// never lock out another department sharing the same network.
async function secondsLocked(db: Db, key: string): Promise<number> {
  const [row] = await db.query(
    `select ceil(extract(epoch from reset_at - now()))::int as seconds from login_attempts
     where throttle_key = $1 and attempts >= $2 and reset_at > now()`,
    [key, MAX_ATTEMPTS],
  );
  return row?.seconds ?? 0;
}

const recordFailure = (db: Db, key: string) => db.query(
  `insert into login_attempts (throttle_key, attempts, reset_at) values ($1, 1, now() + make_interval(secs => $2))
   on conflict (throttle_key) do update set
     attempts = case when login_attempts.reset_at > now() then login_attempts.attempts + 1 else 1 end,
     reset_at = case when login_attempts.reset_at > now() then login_attempts.reset_at else excluded.reset_at end`,
  [key, DECAY_SECONDS],
);

async function withPresence(c: Context<AppEnv>, db: Db, user: Row): Promise<Row> {
  return {
    ...publicUser(user),
    presence: await presence.forUser(db, user),
    features: { costing: c.get('deps').costingEnabled, payment_advanced: Boolean(c.get('deps').paymentAdvanced) },
  };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', async (c) => {
  const { db, auth } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    email: ['required', 'email'],
    password: ['required', 'string'],
    device_name: ['nullable', 'string', 'max:100'],
    portal: ['nullable', 'string', 'in:staff,branch'],
    session_key: ['nullable', 'string', 'max:64'],
  });

  const email = String(v.email).toLowerCase();
  const key = `login:${email}|${clientIp(c) ?? ''}`;
  const locked = await secondsLocked(db, key);
  if (locked > 0) fail('email', `Too many failed sign-in attempts for this account. Try again in ${locked} seconds.`);

  const session = await auth.signIn(email, v.password);
  const [row] = session
    ? await db.query(`select u.*, to_jsonb(r) as role from users u left join roles r on r.id = u.role_id where u.auth_user_id = $1::uuid`, [session.auth_user_id])
    : [];
  if (!session || !row) {
    if (session) await auth.revoke(session.access_token);
    await recordFailure(db, key);
    fail('email', 'The supplied credentials are incorrect.');
  }
  await db.query(`delete from login_attempts where throttle_key = $1`, [key]);
  const user = row as Row;

  // The password was right, so a Supabase session exists; anything refused from here on
  // has to end that session again, otherwise the refused user would still hold a token.
  const refuse = async (message: string) => {
    await auth.revoke(session!.access_token);
    return c.json({ message }, 403);
  };

  const role = user.role?.name;
  const portal = v.portal ?? (role === 'franchisee' ? 'branch' : 'staff');
  if (v.portal) {
    const allowed = v.portal === 'branch' ? ['franchisee'] : ['admin', 'marketing', 'sales', 'logistics'];
    if (!allowed.includes(role)) {
      return refuse(v.portal === 'branch'
        ? 'This sign-in is for branch accounts only. Use the staff login instead.'
        : 'This sign-in is for franchisor staff accounts only. Use the Branch Portal login instead.');
    }
  }

  await liftExpiredSuspension(db, user);
  if (user.account_status === 'suspended') {
    const until = user.suspended_until
      ? new Date(`${String(user.suspended_until).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' })
      : null;
    return refuse(until
      ? `This account is suspended until ${until}. Contact an administrator to restore access sooner.`
      : 'This account is suspended. Contact an administrator.');
  }
  if (user.account_status !== 'active') return refuse('This account is inactive. Ask an administrator to reactivate it.');

  if (portal === 'branch' && role === 'franchisee' && !(await resolveWorkspace(db, user))) {
    return refuse('This branch account is not linked to an active approved franchise with exactly one assigned branch. Contact an administrator.');
  }

  await audit(c, db, 'auth.login', { type: USER_MODEL, id: user.id }, null, null, user.id);
  await presence.touch(c, db, user, v.session_key);

  return ok(c, {
    token: session!.access_token,
    refresh_token: session!.refresh_token,
    token_type: 'Bearer',
    expires_at: session!.expires_at,
    expires_in_minutes: Math.round(session!.expires_in / 60),
    user: publicUser(user),
  }, 'Login successful.');
});

authRoutes.use('*', authenticate);

authRoutes.get('/me', async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  return ok(c, { ...(await withPresence(c, db, user)), ...(await loadUserRelations(db, user.id)) });
});

authRoutes.post('/heartbeat', async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { session_key: ['nullable', 'string', 'max:64'] });
  await presence.touch(c, db, c.get('user'), v.session_key);
  const fresh = await loadUser(db, c.get('user').id);
  return ok(c, { presence: await presence.forUser(db, fresh!) }, 'Session heartbeat recorded.');
});

authRoutes.post('/session-end', async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    session_key: ['nullable', 'string', 'max:64'],
    all: ['nullable', 'boolean'],
  });
  const user = c.get('user');
  if (v.all) await presence.endAll(db, user);
  else await presence.endSession(db, user, v.session_key);
  const fresh = await loadUser(db, user.id);
  return ok(c, { presence: await presence.forUser(db, fresh!) }, 'Session closed.');
});

authRoutes.post('/logout', async (c) => {
  const { db, auth } = c.get('deps');
  const user = c.get('user');
  await audit(c, db, 'auth.logout', { type: USER_MODEL, id: user.id });
  await presence.endAll(db, user);
  await auth.revoke(c.get('accessToken'));
  return ok(c, null, 'Logged out successfully.');
});

authRoutes.put('/profile', async (c) => {
  const { db, auth } = c.get('deps');
  const user = c.get('user');
  if (roleName(c) === 'franchisee') fail('full_name', 'Branch account details are managed through the applicant workflow.');

  const v = await validate(db, await readInput(c), {
    full_name: ['required', 'string', 'max:255'],
    email: ['required', 'email', 'max:255', `unique:users,email,${user.id}`],
    phone: ['nullable', /^[0-9]{11}$/],
  });
  const email = String(v.email).toLowerCase();
  const old = pick(user, ['full_name', 'email', 'phone']);
  if (email !== user.email) await auth.updateUser(user.auth_user_id, { email });
  const saved = await updateRow(db, 'users', user.id, { full_name: v.full_name, email, phone: v.phone ?? null });
  await audit(c, db, 'auth.profile_updated', { type: USER_MODEL, id: user.id }, old, pick(saved!, ['full_name', 'email', 'phone']));
  return ok(c, await withPresence(c, db, { ...saved, role: user.role }), 'Profile updated.');
});

authRoutes.put('/security', async (c) => {
  const { db, auth } = c.get('deps');
  const user = c.get('user');
  if (roleName(c) !== 'admin') return c.json({ message: 'Only the Admin account can change login credentials.' }, 403);

  const v = await validate(db, await readInput(c), {
    email: ['required', 'email', 'max:255', `unique:users,email,${user.id}`],
    password: ['nullable', 'string', 'min:8', 'max:15', 'confirmed'],
  });
  const email = String(v.email).toLowerCase();
  await auth.updateUser(user.auth_user_id, { email, ...(v.password ? { password: v.password } : {}) });
  const saved = await updateRow(db, 'users', user.id, { email });
  await auth.revokeOthers(c.get('accessToken'));
  await audit(c, db, 'auth.security_updated', { type: USER_MODEL, id: user.id }, { email: user.email }, { email, password_changed: Boolean(v.password) });
  return ok(c, await withPresence(c, db, { ...saved, role: user.role }), 'Login credentials updated.');
});

/**
 * First sign-in: an account created with a temporary password sets its own (8 to 15
 * characters). The temporary password stops working at once, and other sessions end.
 */
authRoutes.post('/first-password', async (c) => {
  const { db, auth } = c.get('deps');
  const user = c.get('user');
  if (!user.must_change_password) fail('password', 'This account has already set its own password.');
  const v = await validate(db, await readInput(c), {
    password: ['required', 'string', `min:${PASSWORD_MIN}`, `max:${PASSWORD_MAX}`],
    password_confirmation: ['required', 'same:password'],
  });
  // Re-using the temporary password is refused: it was shown to someone else.
  const same = await auth.signIn(user.email, v.password);
  if (same) {
    await auth.revoke(same.access_token);
    fail('password', 'Choose a new password, not the temporary one.');
  }
  await auth.updateUser(user.auth_user_id, { password: v.password });
  await auth.revokeOthers(c.get('accessToken'));
  const saved = await updateRow(db, 'users', user.id, { must_change_password: false, password_changed_at: new Date() });
  await audit(c, db, 'auth.first_password_set', { type: USER_MODEL, id: user.id });
  return ok(c, await withPresence(c, db, { ...saved, role: user.role }), 'Your new password is saved.');
});

authRoutes.put('/password', async (c) => {
  const { db, auth } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    current_password: ['required', 'string'],
    password: ['required', 'string', 'min:10', 'confirmed'],
  });
  const check = await auth.signIn(user.email, v.current_password);
  if (!check) fail('current_password', 'The current password is incorrect.');
  await auth.revoke(check!.access_token);
  await auth.updateUser(user.auth_user_id, { password: v.password });
  await auth.revokeOthers(c.get('accessToken'));
  await audit(c, db, 'auth.password_changed', { type: USER_MODEL, id: user.id });
  return ok(c, null, 'Password changed successfully.');
});
