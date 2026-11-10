// NotificationController: the red dot is per (user, record), stored on the notification.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import { abort, boolParam, ok, paginate, perPage, routeId } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound } from '../lib/middleware.ts';
import { deliverDueReminders } from '../services/monitoring.ts';

export const notificationRoutes = new Hono<AppEnv>();

const RECORD_KEYS: Record<string, string> = {
  applicant: 'applicant_id',
  inquiry: 'inquiry_id',
  activity: 'activity_id',
  supply_request: 'supply_request_id',
};

notificationRoutes.get('/', async (c) => {
  const { db } = c.get('deps');
  await deliverDueReminders(db, c.get('user'));
  const where = ['user_id = $1'];
  if (boolParam(c.req.query('unread_only'))) where.push('read_at is null');
  return paginate(c, db, {
    columns: '*', from: 'system_notifications', where, params: [c.get('user').id],
    orderBy: 'created_at desc, id desc', perPage: perPage(c, 30),
  });
});

notificationRoutes.post('/mark-seen', async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    record_type: ['required', `in:${Object.keys(RECORD_KEYS).join(',')}`],
    record_id: ['required', 'integer', 'min:1'],
  });
  // The key comes from the fixed map above, never from the request.
  const marked = await db.query(
    `update system_notifications set read_at = now()
     where user_id = $1 and read_at is null and (data ->> '${RECORD_KEYS[v.record_type]}')::bigint = $2 returning id`,
    [c.get('user').id, v.record_id],
  );
  return ok(c, { marked: marked.length }, 'Record marked as seen.');
});

notificationRoutes.patch('/read-all', async (c) => {
  await c.get('deps').db.query(`update system_notifications set read_at = now() where user_id = $1 and read_at is null`, [c.get('user').id]);
  return ok(c, null, 'All notifications marked as read.');
});

notificationRoutes.patch('/:notification/read', async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'notification');
  const [row] = await db.query(`select user_id from system_notifications where id = $1`, [id]);
  requireFound(row);
  if (row.user_id !== c.get('user').id) abort(404, 'Record not found.');
  const [saved] = await db.query(`update system_notifications set read_at = now() where id = $1 returning *`, [id]);
  return ok(c, saved, 'Notification marked as read.');
});
