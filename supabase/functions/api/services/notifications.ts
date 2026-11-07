// App\Services\NotificationService: an action never raises a red dot for the person who did it.
import type { Db, Row } from '../lib/db.ts';

export async function notifyUser(db: Db, userId: number, type: string, title: string, message: string, data: Row = {}, actor?: Row | null) {
  if (actor && actor.id === Number(userId)) return;
  await db.query(
    `insert into system_notifications (user_id, actor_user_id, type, title, message, data) values ($1, $2, $3, $4, $5, $6)`,
    [userId, actor?.id ?? null, type, title, message, Object.keys(data).length ? JSON.stringify(data) : null],
  );
}

export async function notifyRoles(db: Db, roles: string[], type: string, title: string, message: string, data: Row = {}, actor?: Row | null) {
  const users = await db.query<{ id: number }>(
    `select u.id from users u join roles r on r.id = u.role_id
     where r.name = any($1::text[]) and u.account_status = 'active' and ($2::bigint is null or u.id <> $2::bigint)`,
    [`{${roles.join(',')}}`, actor?.id ?? null],
  );
  for (const user of users) await notifyUser(db, user.id, type, title, message, data, actor);
}
