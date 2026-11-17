// Account lifecycle: invitations (every account type) and archive/suspend.
//
// Invitations — no temporary passwords anywhere:
//   create -> 'invited' (Supabase emails the link) -> the person sets a password on /reset-password and
//   accepts -> 'active'; or declines -> 'declined'. 'expired' = still invited after the link lifetime.
//   Admin can resend (a fresh invitation) or cancel (removes the account and its pending sign-in) an
//   invitation nobody accepted.
// Archive (suspend): a start time (now or later), an optional end time and a reason; the account cannot
//   sign in while suspended, its sessions are revoked, it leaves the main lists, and it comes back by
//   itself after the end time (services/users.ts liftExpiredSuspension) or when an Admin restores it.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';
import { audit, createAccount } from './users.ts';

const USER = 'App\\Models\\User';
export const NEVER_ACCEPTED = ['invited', 'declined'];

/** 'invited' | 'expired' | 'declined' for an invitation nobody accepted yet; null otherwise. */
export function inviteState(user: Row, ttlHours = 24): 'invited' | 'expired' | 'declined' | null {
  if (user.account_status === 'declined') return 'declined';
  if (user.account_status !== 'invited') return null;
  const sent = user.invited_at ? new Date(user.invited_at).getTime() : 0;
  return sent && Date.now() - sent > ttlHours * 3600e3 ? 'expired' : 'invited';
}

/**
 * Where the email link opens: <APP_STAFF_URL or APP_BRANCH_URL>/reset-password. Without those
 * settings (local development) the address the browser sent is used, if it is an http(s) URL.
 */
export function inviteRedirect(c: Context<AppEnv>, role: string, sent?: unknown): string | null {
  const urls = c.get('deps').appUrls;
  const base = role === 'franchisee' ? urls?.branch : urls?.staff;
  if (base) return `${String(base).replace(/\/+$/, '')}/reset-password`;
  const fallback = sent ? String(sent).trim() : '';
  if (!fallback) return null;
  if (!/^https?:\/\/\S+$/i.test(fallback)) fail('redirect_to', 'The invitation link must open an http(s) address.');
  return fallback;
}

/** "Invite email sent to <email>" — the only thing ever returned about credentials. */
export const inviteDelivery = (email: string) => ({
  method: 'email_link' as const,
  sent_to: email,
  note: `Invite email sent to ${email}. They set their own password when they open the link.`,
});

/** Creates an account as 'invited' and emails the invitation (removed again if anything fails). */
export async function inviteAccount(c: Context<AppEnv>, fields: Row, role: string, redirectSent?: unknown): Promise<Row> {
  const redirectTo = inviteRedirect(c, role, redirectSent);
  return createAccount(c, {
    ...fields,
    account_status: 'invited',
    invited_at: new Date(),
    invited_by_user_id: c.get('user')?.id ?? null,
    must_change_password: false,
  }, { invite: { redirectTo, fullName: fields.full_name } });
}

/**
 * Sends an invitation nobody accepted (invited, expired or declined) again. Normally the old pending
 * sign-in is removed and a fresh one invited (the "Invite user" email), so the new link works whether
 * or not the old one was opened. If Supabase will not remove the old sign-in (e.g. an older account
 * created with a temporary password), it is kept and a "Reset password" email is sent instead; that
 * link opens the same /reset-password page, where setting the password still accepts the invitation.
 * Returns the saved row and which email went out.
 */
export async function resendInvite(c: Context<AppEnv>, target: Row): Promise<{ user: Row; email: 'invite' | 'reset_password' }> {
  const { db, auth } = c.get('deps');
  if (!NEVER_ACCEPTED.includes(target.account_status)) fail('user', 'Only an invitation that was not accepted yet can be sent again.');
  const role = target.role?.name ?? (await db.query(`select r.name from roles r where r.id = $1`, [target.role_id]))[0]?.name;
  const redirectTo = inviteRedirect(c, role);
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

  let authUserId: string | null = target.auth_user_id ?? null;
  let email: 'invite' | 'reset_password' = 'invite';
  const removed = authUserId ? await auth.deleteUser(authUserId).then(() => true, () => false) : true;
  if (removed) {
    // The old sign-in is gone; until the new one exists the row points at nothing.
    if (authUserId) await db.query(`update users set auth_user_id = null where id = $1`, [target.id]);
    try {
      authUserId = await auth.inviteUser(target.email, { redirectTo, fullName: target.full_name });
    } catch (error) {
      fail('email', `The invitation email could not be sent: ${reason(error)}`);
    }
  } else {
    email = 'reset_password';
    try {
      await auth.sendPasswordReset(target.email, { redirectTo });
    } catch (error) {
      fail('email', `The email could not be sent: ${reason(error)}`);
    }
  }
  const [saved] = await db.query(
    `update users set auth_user_id = $2::uuid, account_status = 'invited', invited_at = now(), invited_by_user_id = $3, invite_declined_at = null where id = $1 returning *`,
    [target.id, authUserId, c.get('user')?.id ?? null],
  );
  await audit(c, db, 'user.invite_resent', { type: USER, id: target.id },
    { account_status: target.account_status, invited_at: target.invited_at }, { account_status: 'invited', sent_to: target.email, email });
  return { user: saved, email };
}

/**
 * Removes an invitation nobody accepted, completely: the users row and its pending Supabase sign-in.
 * Refused for anyone who ever accepted or signed in (archive them instead — the audit trail stays).
 */
export async function cancelInvite(c: Context<AppEnv>, target: Row): Promise<void> {
  const { db, auth } = c.get('deps');
  if (!NEVER_ACCEPTED.includes(target.account_status) || target.invite_accepted_at || target.last_seen_at) {
    fail('user', 'Only an invitation that was never accepted can be cancelled. Archive this account instead.');
  }
  // Sessions, notifications and chat membership go with it (on delete cascade); anything the person
  // did (on delete restrict) blocks the removal, which never happens for an unaccepted invitation.
  try {
    await db.query(`delete from users where id = $1`, [target.id]);
  } catch {
    fail('user', 'This account already has activity on record, so it cannot be removed. Archive it instead.');
  }
  if (target.auth_user_id) await auth.deleteUser(target.auth_user_id).catch(() => {});
  await audit(c, db, 'user.invite_cancelled', { type: USER, id: target.id },
    { email: target.email, full_name: target.full_name, account_status: target.account_status }, null);
}

/** The signed-in person behind an invitation link (its Supabase session), or a 401/404. */
export async function inviteHolder(c: Context<AppEnv>): Promise<Row> {
  const { db, auth } = c.get('deps');
  const header = c.req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const verified = token ? await auth.verify(token) : null;
  if (!verified) fail('link', 'This link has expired or was already used. Ask your Admin to resend the invite.');
  const [user] = await db.query(
    `select u.*, to_jsonb(r) as role from users u left join roles r on r.id = u.role_id where u.auth_user_id = $1::uuid`,
    [verified!.authUserId],
  );
  if (!user) fail('link', 'This invitation was cancelled. Ask your Admin to send a new one.');
  return user;
}

/** Last active Admin: true when no other active, unarchived Admin would remain. */
export async function isLastActiveAdmin(db: Db, target: Row): Promise<boolean> {
  if (target.role?.name !== 'admin') return false;
  const [row] = await db.query(
    `select count(*)::int as n from users u join roles r on r.id = u.role_id
     where r.name = 'admin' and u.account_status = 'active' and u.archived_at is null and u.id <> $1`,
    [target.id],
  );
  return row.n === 0;
}

/**
 * Archive (suspend) an account from `from` (default now) until `until` (optional). Starting now:
 * suspended at once and every session revoked. Starting later: archived now, suspended when the start
 * passes (checked on every request). Refuses yourself and the last active Admin.
 */
export async function archiveUser(c: Context<AppEnv>, target: Row, input: { from?: string | null; until?: string | null; reason?: string | null }): Promise<Row> {
  const { db, auth } = c.get('deps');
  const actor = c.get('user');
  if (Number(actor.id) === Number(target.id)) fail('user', 'You cannot archive your own account.');
  if (target.archived_at) fail('user', 'This account is already archived.');
  if (NEVER_ACCEPTED.includes(target.account_status)) fail('user', 'This invitation was not accepted yet: cancel the invite instead of archiving it.');
  if (await isLastActiveAdmin(db, target)) fail('user', 'This is the last active Admin. Make another Admin active first.');
  const now = new Date();
  const from = input.from ? new Date(input.from) : now;
  if (Number.isNaN(from.getTime())) fail('suspended_from', 'Choose a valid start date and time.');
  const until = input.until ? new Date(input.until) : null;
  if (until && Number.isNaN(until.getTime())) fail('suspended_until', 'Choose a valid end date and time.');
  if (until && until <= from) fail('suspended_until', 'The suspension must end after it starts.');
  if (until && until <= now) fail('suspended_until', 'The end must be in the future.');
  const reason = input.reason ? String(input.reason).trim().slice(0, 2000) || null : null;
  const startsNow = from <= now;
  const [saved] = await db.query(
    `update users set archived_at = now(), archived_by_user_id = $2, archive_reason = $3, suspended_from = $4, suspended_until = $5,
       account_status = $6 where id = $1 returning *`,
    [target.id, actor.id, reason, startsNow ? now : from, until, startsNow ? 'suspended' : 'active'],
  );
  if (startsNow && target.auth_user_id) await auth.revokeAll(target.auth_user_id);
  await audit(c, db, 'user.archived', { type: USER, id: target.id },
    { account_status: target.account_status },
    { account_status: saved.account_status, suspended_from: saved.suspended_from, suspended_until: saved.suspended_until, archive_reason: reason, starts_later: !startsNow });
  return saved;
}

/** Restore (unarchive) at once: active again, suspension cleared. */
export async function restoreUser(c: Context<AppEnv>, target: Row): Promise<Row> {
  const { db } = c.get('deps');
  if (!target.archived_at && target.account_status !== 'suspended') fail('user', 'This account is not archived.');
  const [saved] = await db.query(
    `update users set account_status = 'active', archived_at = null, archived_by_user_id = null, archive_reason = null,
       suspended_from = null, suspended_until = null where id = $1 returning *`,
    [target.id],
  );
  await audit(c, db, 'user.restored', { type: USER, id: target.id },
    { account_status: target.account_status, archived_at: target.archived_at, suspended_from: target.suspended_from, suspended_until: target.suspended_until, archive_reason: target.archive_reason ?? null },
    { account_status: 'active' });
  return saved;
}
