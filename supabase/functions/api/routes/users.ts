// UserController and AuditLogController. Admin only, enforced where these are mounted.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import { fail, intParam, ok, paginate, perPage, pick, routeId, updateRow, manilaToday } from '../lib/http.ts';
import type { Db, Row } from '../lib/db.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound } from '../lib/middleware.ts';
import { audit, liftExpiredSuspensions, loadUser, loadUserRelations, publicUser } from '../services/users.ts';
import { forUsers } from '../services/presence.ts';
import { accountAuditValues, cleanOptionalPhone, cleanPersonName } from '../services/credentials.ts';
import { archiveUser, cancelInvite, inviteAccount, inviteDelivery, inviteState, isLastActiveAdmin, resendInvite, restoreUser } from '../services/accounts.ts';

export const userRoutes = new Hono<AppEnv>();
const USER = 'App\\Models\\User';
const STAFF = ['admin', 'sales', 'marketing', 'logistics'];
/** Roles User Management may invite directly. Admin needs an explicit confirmation; Franchisee only from its applicant. */
const STAFF_CREATABLE = ['admin', 'marketing', 'sales', 'logistics'];
const AUDIT_KEYS = ['full_name', 'email', 'phone', 'role_id', 'account_status', 'suspended_from', 'suspended_until'];

const loadTarget = async (db: Db, id: number) =>
  requireFound((await db.query(`select u.*, to_jsonb(r) as role from users u left join roles r on r.id = u.role_id where u.id = $1`, [id]))[0]);

/** Main lists hide archived accounts; ?archived=1 lists only them. Each row carries its invite state. */
userRoutes.get('/users', async (c) => {
  const { db, inviteTtlHours } = c.get('deps');
  await liftExpiredSuspensions(db);

  const q = c.req.query();
  const where: string[] = [q.archived === '1' || q.archived === 'true' ? 'u.archived_at is not null' : 'u.archived_at is null'];
  const params: unknown[] = [];
  if (q.role === 'staff') { params.push(`{${STAFF.join(',')}}`); where.push(`r.name = any($${params.length}::text[])`); }
  else if (q.role) { params.push(q.role); where.push(`r.name = $${params.length}`); }
  if (q.status) { params.push(q.status); where.push(`u.account_status = $${params.length}`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(u.full_name ilike $${params.length} or u.email ilike $${params.length} or u.user_code ilike $${params.length})`);
  }

  const page = await paginate(c, db, {
    columns: `u.*, to_jsonb(r) as role`,
    from: 'users u left join roles r on r.id = u.role_id',
    where, params, orderBy: 'u.full_name', perPage: perPage(c, 20),
    map: (row: Row) => ({ ...publicUser(row), invite_state: inviteState(row, inviteTtlHours) }),
  });
  const body = await page.json();
  const presence = await forUsers(db, body.data);
  body.data = body.data.map((user: Row) => ({ ...user, presence: presence[user.id] ?? null }));
  return c.json(body);
});

/**
 * Staff and Admin accounts. Every account is invited by email: the person sets their own password
 * on the app's /reset-password page (APP_STAFF_URL), so no password is ever created, shown or stored
 * here. A Franchisee account is invited from its applicant (POST /applicants/:id/portal-user) so every
 * activation gate applies. Creating another Admin needs confirm_admin = true (the UI asks first).
 */
userRoutes.post('/users', async (c) => {
  const { db } = c.get('deps');
  const input = await readInput(c);
  if (input.role === 'franchisee') fail('role', 'A Franchisee account is created from an approved or active applicant. Choose the applicant as the Full name.');
  const v = await validate(db, input, {
    full_name: ['required', 'string', 'max:255'],
    email: ['required', 'email', 'max:255', 'unique:users,email'],
    phone: ['nullable'],
    role: ['required', `in:${STAFF_CREATABLE.join(',')}`],
    redirect_to: ['nullable', 'string', 'max:500'],
    confirm_admin: ['nullable', 'boolean'],
  });
  if (v.role === 'admin' && v.confirm_admin !== true) {
    fail('confirm_admin', 'You are creating another Admin with full access. Confirm to send the invitation.');
  }
  const fullName = cleanPersonName(v.full_name);
  const phone = cleanOptionalPhone(v.phone);
  const email = String(v.email).toLowerCase();
  const [roleRow] = await db.query(`select id from roles where name = $1`, [v.role]);
  const user = await inviteAccount(c, { role_id: requireFound(roleRow).id, full_name: fullName, email, phone }, v.role, v.redirect_to);
  const delivery = inviteDelivery(email);
  await audit(c, db, 'user.created', { type: USER, id: user.id }, null,
    accountAuditValues(user, v.role, delivery, v.role === 'admin' ? { admin_confirmed: true } : {}));
  return ok(c, { ...(await loadUser(db, user.id)), credentials: delivery }, `Invite email sent to ${email}.`, 201);
});

/** A fresh invitation for an account nobody accepted (Invited, Expired or Declined). */
userRoutes.post('/users/:user/resend-invite', async (c) => {
  const { db } = c.get('deps');
  const target = await loadTarget(db, routeId(c, 'user'));
  await resendInvite(c, target);
  return ok(c, await loadUser(db, target.id), `Invite email sent to ${target.email}.`);
});

/** Cancel an invitation nobody accepted: the account and its pending sign-in are removed completely. */
userRoutes.delete('/users/:user/invite', async (c) => {
  const { db } = c.get('deps');
  const target = await loadTarget(db, routeId(c, 'user'));
  await cancelInvite(c, target);
  return ok(c, null, `The invitation for ${target.email} was cancelled.`);
});

/**
 * Archive (suspend): from a start time (default now; may be later) until an optional end time, with
 * an optional reason. The account cannot sign in while suspended and its sessions are revoked; it
 * leaves the main lists and shows under Admin settings -> Archive -> Users. It is restored by itself
 * once the end passes. Not yourself, not the last active Admin.
 */
userRoutes.post('/users/:user/archive', async (c) => {
  const { db } = c.get('deps');
  const target = await loadTarget(db, routeId(c, 'user'));
  const v = await validate(db, await readInput(c), {
    suspended_from: ['nullable', 'date'],
    suspended_until: ['nullable', 'date'],
    reason: ['nullable', 'string', 'max:2000'],
  });
  await archiveUser(c, target, { from: v.suspended_from, until: v.suspended_until, reason: v.reason });
  return ok(c, await loadUser(db, target.id), `${target.full_name} was archived.`);
});

/** Restore (unarchive) at once: the account is active again. */
userRoutes.post('/users/:user/restore', async (c) => {
  const { db } = c.get('deps');
  const target = await loadTarget(db, routeId(c, 'user'));
  await restoreUser(c, target);
  return ok(c, await loadUser(db, target.id), `${target.full_name} was restored.`);
});

/** Applicants who may get a Franchisee account: Approved or Active Franchisee, with no account yet. */
userRoutes.get('/users/franchisee-candidates', async (c) => {
  const { db } = c.get('deps');
  const rows = await db.query(
    `select a.id, a.applicant_code, a.full_name, a.email, a.phone, a.status, a.preferred_brand_id,
       (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = a.preferred_brand_id) as preferred_brand
     from applicants a
     where a.status in ('approved', 'active_franchisee') and a.user_id is null
     order by a.full_name, a.id`,
  );
  return ok(c, rows);
});

userRoutes.get('/users/:user', async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'user');
  const user = requireFound(await loadUser(db, id));
  return ok(c, { ...user, ...(await loadUserRelations(db, id)) });
});

userRoutes.on(['PUT', 'PATCH'], '/users/:user', async (c) => {
  const { db, auth } = c.get('deps');
  const id = routeId(c, 'user');
  const [target] = await db.query(`select u.*, to_jsonb(r) as role from users u left join roles r on r.id = u.role_id where u.id = $1`, [id]);
  requireFound(target);

  if (c.get('user').id === id) fail('user', 'You cannot change your own account from User Management. Use My profile instead.');
  const input = await readInput(c);
  if (target.role?.name === 'franchisee' && ['role', 'full_name', 'email', 'phone', 'password'].some((k) => k in input)) {
    fail('user', 'Branch account identity changes must be made through the applicant workflow.');
  }

  // Passwords are only ever set by the person themselves, from their invitation or reset email.
  if ('password' in input || 'confirm_password' in input) {
    fail('password', 'Passwords are set by the person from their email link. Use "Resend invite" for an account that was not set up yet.');
  }
  // Suspension is "Archive (suspend)" (POST /users/:id/archive), with its own window and audit.
  if (input.account_status === 'suspended' || 'suspended_from' in input || 'suspended_until' in input) {
    fail('account_status', 'Use "Archive (suspend)" to suspend an account.');
  }
  // An invitation becomes active only when the person accepts it and sets a password.
  if (['invited', 'declined'].includes(target.account_status) && 'account_status' in input) {
    fail('account_status', 'This invitation was not accepted yet. Resend or cancel the invite instead.');
  }

  const v = await validate(db, input, {
    full_name: ['sometimes', 'required', 'string', 'max:255'],
    email: ['sometimes', 'required', 'email', 'max:255', `unique:users,email,${id}`],
    phone: ['sometimes', 'required', /^[0-9]{11}$/],
    role: ['sometimes', 'in:marketing,sales,logistics,franchisee'],
    account_status: ['sometimes', 'in:active,inactive'],
  });

  if (target.role?.name === 'admin' && v.role && v.role !== 'admin') fail('role', 'The Admin role cannot be changed through User Management.');
  if (target.role?.name === 'admin' && v.account_status === 'inactive' && await isLastActiveAdmin(db, target)) {
    fail('account_status', 'This is the last active Admin. Make another Admin active first.');
  }

  const { role: newRole, ...changes } = v;
  if (newRole) changes.role_id = requireFound((await db.query(`select id from roles where name = $1`, [newRole]))[0]).id;
  if (changes.email) changes.email = String(changes.email).toLowerCase();

  if (target.auth_user_id && changes.email && changes.email !== target.email) {
    await auth.updateUser(target.auth_user_id, { email: changes.email });
  }
  const saved = await updateRow(db, 'users', id, changes);

  // A blocked account cannot keep using the system.
  if (saved!.account_status !== 'active' && target.auth_user_id) await auth.revokeAll(target.auth_user_id);
  await audit(c, db, 'user.updated', { type: USER, id }, pick(target, AUDIT_KEYS), pick(saved!, AUDIT_KEYS));
  return ok(c, await loadUser(db, id), 'User account updated.');
});

userRoutes.delete('/users/:user', async (c) => {
  const { db, auth } = c.get('deps');
  const id = routeId(c, 'user');
  const target = await loadTarget(db, id);
  if (c.get('user').id === id) return c.json({ message: 'You cannot deactivate your own account.' }, 422);
  if (await isLastActiveAdmin(db, target)) fail('user', 'This is the last active Admin. Make another Admin active first.');

  const cleared = { account_status: 'inactive', suspended_from: null, suspended_until: null };
  await updateRow(db, 'users', id, cleared);
  if (target.auth_user_id) await auth.revokeAll(target.auth_user_id);
  await audit(c, db, 'user.deactivated', { type: USER, id }, pick(target, Object.keys(cleared)), cleared);
  return ok(c, null, 'User account deactivated.');
});

userRoutes.get('/audit-logs', async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.action) { params.push(q.action); where.push(`a.action = $${params.length}`); }
  if (q.user_id) { params.push(intParam(q.user_id)); where.push(`a.user_id = $${params.length}`); }
  if (q.auditable_type) { params.push(q.auditable_type); where.push(`a.auditable_type = $${params.length}`); }
  return paginate(c, db, {
    columns: `a.*, (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) from users u where u.id = a.user_id) as "user"`,
    from: 'audit_logs a', where, params, orderBy: 'a.created_at desc', perPage: perPage(c, 50),
  });
});
