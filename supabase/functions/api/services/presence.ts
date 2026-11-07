// App\Services\UserPresence: a tab heartbeats into user_sessions; the account is Active
// while one session is fresh. Admin accounts never show a Time Out.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { manilaToday } from '../lib/http.ts';
import { clientIp } from './users.ts';

const ONLINE_WINDOW_MS = 90_000;
const key = (userId: number, sessionKey?: string | null) => `${userId}|${sessionKey || 'default'}`.slice(0, 80);

export async function touch(c: Context<AppEnv>, db: Db, user: Row, sessionKey?: string | null) {
  await db.query(`update users set last_seen_at = now() where id = $1`, [user.id]);
  await db.query(
    `insert into user_sessions (user_id, session_key, ip_address, user_agent, last_seen_at, ended_at)
     values ($1, $2, $3, $4, now(), null)
     on conflict (session_key) do update set user_id = excluded.user_id, ip_address = excluded.ip_address,
       user_agent = excluded.user_agent, last_seen_at = now(), ended_at = null`,
    [user.id, key(user.id, sessionKey), clientIp(c), (c.req.header('user-agent') ?? '').slice(0, 250)],
  );
}

export async function endSession(db: Db, user: Row, sessionKey?: string | null) {
  if (!sessionKey) return;
  await db.query(`update user_sessions set ended_at = now() where session_key = $1 and ended_at is null`, [key(user.id, sessionKey)]);
}

export async function endAll(db: Db, user: Row) {
  await db.query(`update user_sessions set ended_at = now() where user_id = $1 and ended_at is null`, [user.id]);
}

export interface Presence { is_online: boolean; time_in: string | null; time_out: string | null; last_active: string | null }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const dates = (rows: Row[], col: string) => rows.map((r) => r[col]).filter(Boolean).map((d) => new Date(d).getTime());

export async function forUsers(db: Db, users: Row[]): Promise<Record<number, Presence>> {
  if (!users.length) return {};
  const startOfToday = `${manilaToday()}T00:00:00+08:00`;
  const sessions = await db.query(
    `select * from user_sessions where user_id = any($1::bigint[]) and (created_at >= $2::timestamptz or last_seen_at >= $2::timestamptz)`,
    [`{${users.map((u) => u.id).join(',')}}`, startOfToday],
  );
  const today = new Date(startOfToday).getTime();
  const out: Record<number, Presence> = {};
  for (const user of users) {
    const own = sessions.filter((s) => s.user_id === user.id);
    const online = own.some((s) => !s.ended_at && s.last_seen_at && Date.now() - new Date(s.last_seen_at).getTime() <= ONLINE_WINDOW_MS);
    const isAdmin = user.role?.name === 'admin';
    const openedToday = dates(own, 'created_at').filter((t) => t >= today);
    const seen = dates(own, 'last_seen_at');
    const timeIn = openedToday.length ? Math.min(...openedToday) : seen.length ? Math.min(...seen) : null;
    const ended = dates(own, 'ended_at');
    const timeOut = !isAdmin && !online && ended.length ? Math.max(...ended) : null;
    out[user.id] = {
      is_online: isAdmin ? true : online,
      time_in: timeIn ? new Date(timeIn).toISOString() : null,
      time_out: timeOut ? new Date(timeOut).toISOString() : null,
      last_active: iso(user.last_seen_at),
    };
  }
  return out;
}

export async function forUser(db: Db, user: Row): Promise<Presence> {
  return (await forUsers(db, [user]))[user.id];
}
