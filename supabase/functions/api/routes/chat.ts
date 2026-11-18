// ChatController: department channels plus 1-on-1 direct messages.
import { Hono } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, intParam, ok, routeId } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';

export const chatRoutes = new Hono<AppEnv>();

const ONLINE_WINDOW = `now() - interval '3 minutes'`;
const USER_JSON = `(to_jsonb(u) - 'auth_user_id') || jsonb_build_object('role', (select to_jsonb(r) from roles r where r.id = u.role_id))`;
const CHAT_MESSAGE_MODEL = 'App\\Models\\ChatMessage';
export const DELETED_TEXT = 'This message was deleted';
// The text of a message deleted for everyone stays in the database but is never returned to anyone.
const MESSAGE_SELECT = `m.id, m.channel_id, m.user_id, m.created_at, m.updated_at, m.deleted_at,
  case when m.deleted_at is null then m.message else '${DELETED_TEXT}' end as message,
  (select ${USER_JSON} from users u where u.id = m.user_id) as "user"`;
// Messages a user hid with "delete for me" are dropped from that user's view only.
const NOT_HIDDEN = (userParam: string) => `not exists (select 1 from chat_message_hidden h where h.message_id = m.id and h.user_id = ${userParam})`;

async function loadChannel(db: Db, id: number, userId: number): Promise<Row> {
  const channel = requireFound((await db.query(`select * from chat_channels where id = $1`, [id]))[0]);
  if (channel.type === 'direct') {
    const member = await db.query(`select 1 from chat_channel_members where channel_id = $1 and user_id = $2`, [id, userId]);
    if (!member.length) abort(403, 'You do not have access to this conversation.');
  }
  return channel;
}

const markRead = (db: Db, channelId: number, userId: number, messageId: number) => db.query(
  `insert into chat_channel_members (channel_id, user_id, last_read_message_id, last_read_at) values ($1, $2, $3, now())
   on conflict (channel_id, user_id) do update set last_read_message_id = excluded.last_read_message_id, last_read_at = now()`,
  [channelId, userId, messageId],
);

chatRoutes.get('/channels', async (c) => {
  const { db } = c.get('deps');
  const me = c.get('user').id;
  const rows = await db.query(
    `with visible as (
       select ch.* from chat_channels ch where ch.type = 'department'
       union all
       select ch.* from chat_channels ch
       where ch.type = 'direct' and exists (select 1 from chat_channel_members cm where cm.channel_id = ch.id and cm.user_id = $1)
     )
     select v.*,
       (select count(*)::int from chat_messages m where m.channel_id = v.id and m.user_id <> $1
          and m.id > coalesce((select cm.last_read_message_id from chat_channel_members cm where cm.channel_id = v.id and cm.user_id = $1), 0)) as unread_count,
       (select to_jsonb(lm) from (select ${MESSAGE_SELECT} from chat_messages m where m.channel_id = v.id and ${NOT_HIDDEN('$1')} order by m.id desc limit 1) lm) as last_message,
       other.id as other_id, other.full_name as other_name, other.last_seen_at >= ${ONLINE_WINDOW} as other_online,
       (select coalesce(r.label, r.name) from roles r where r.id = other.role_id) as other_role
     from visible v
     left join lateral (
       select u.* from chat_channel_members cm join users u on u.id = cm.user_id
       where v.type = 'direct' and cm.channel_id = v.id and cm.user_id <> $1 limit 1
     ) other on true
     order by case when v.type = 'department' then 0 else 1 end,
              case when v.type = 'department' then v.id end asc,
              v.updated_at desc`,
    [me],
  );
  return ok(c, rows.map((row) => {
    const direct = row.type === 'direct';
    return {
      id: row.id,
      slug: row.slug,
      name: direct && row.other_id ? row.other_name : row.name,
      type: row.type,
      department: row.department,
      description: row.description,
      role_label: direct && row.other_id ? row.other_role : null,
      is_online: direct && row.other_id ? Boolean(row.other_online) : null,
      other_user_id: row.other_id ?? null,
      unread_count: row.unread_count,
      last_message: row.last_message,
      updated_at: row.updated_at,
    };
  }));
});

chatRoutes.get('/channels/:channel/messages', async (c) => {
  const { db } = c.get('deps');
  const me = c.get('user').id;
  const channel = await loadChannel(db, routeId(c, 'channel'), me);
  const sinceId = intParam(c.req.query('since_id'));
  const messages = sinceId > 0
    ? await db.query(`select ${MESSAGE_SELECT} from chat_messages m where m.channel_id = $1 and m.id > $2 and ${NOT_HIDDEN('$3')} order by m.id asc limit 50`, [channel.id, sinceId, me])
    : (await db.query(`select ${MESSAGE_SELECT} from chat_messages m where m.channel_id = $1 and ${NOT_HIDDEN('$2')} order by m.id desc limit 60`, [channel.id, me])).reverse();

  // Fetching must never mark as seen: the client asks only when the user is really looking.
  const latest = messages[messages.length - 1];
  if (latest && boolParam(c.req.query('mark_read'))) await markRead(db, channel.id, me, latest.id);

  // An open conversation polls with since_id only: tell it which of its older messages were deleted for
  // everyone recently, so the other person's screen updates without a reload.
  const deletedIds = sinceId > 0
    ? (await db.query(
      `select m.id from chat_messages m where m.channel_id = $1 and m.id <= $2 and m.deleted_at > now() - interval '10 minutes'`,
      [channel.id, sinceId],
    )).map((r) => Number(r.id))
    : [];

  const { id, slug, name, type, department, description } = channel;
  return ok(c, { channel: { id, slug, name, type, department, description }, messages, deleted_ids: deletedIds });
});

chatRoutes.post('/channels/:channel/messages', async (c) => {
  const { db } = c.get('deps');
  const me = c.get('user').id;
  const v = await validate(db, await readInput(c), { message: ['required', 'string', 'min:1', 'max:5000'] });
  const channel = await loadChannel(db, routeId(c, 'channel'), me);
  const message = await db.tx(async (tx) => {
    const [row] = await tx.query(`insert into chat_messages (channel_id, user_id, message) values ($1, $2, $3) returning id`, [channel.id, me, v.message]);
    await tx.query(`update chat_channels set updated_at = now() where id = $1`, [channel.id]);
    await markRead(tx, channel.id, me, row.id);
    await tx.query(`update users set last_seen_at = now() where id = $1`, [me]);
    return (await tx.query(`select ${MESSAGE_SELECT} from chat_messages m where m.id = $1`, [row.id]))[0];
  });
  return ok(c, message, 'Message sent.', 201);
});

/**
 * Delete a message: ?scope=everyone (the sender only: everyone sees "This message was deleted"; the text is
 * kept but never returned) or ?scope=me (any member: hidden for you only, the others still see it). Audited.
 */
chatRoutes.delete('/channels/:channel/messages/:message', async (c) => {
  const { db } = c.get('deps');
  const me = c.get('user').id;
  const channel = await loadChannel(db, routeId(c, 'channel'), me);
  const messageId = routeId(c, 'message');
  const scope = c.req.query('scope');
  if (scope !== 'everyone' && scope !== 'me') return c.json({ message: 'Choose delete for everyone or delete for me.', errors: { scope: ['Choose delete for everyone or delete for me.'] } }, 422);
  const message = requireFound((await db.query(
    `select id, user_id, deleted_at from chat_messages where id = $1 and channel_id = $2`,
    [messageId, channel.id],
  ))[0]);
  if (scope === 'everyone') {
    if (Number(message.user_id) !== Number(me)) abort(403, 'Only the sender can delete a message for everyone.');
    if (!message.deleted_at) {
      await db.query(`update chat_messages set deleted_at = now() where id = $1 and deleted_at is null`, [messageId]);
      await audit(c, db, 'chat.message_deleted_for_everyone', { type: CHAT_MESSAGE_MODEL, id: messageId }, null, { channel_id: channel.id, scope });
    }
  } else {
    const [hidden] = await db.query(
      `insert into chat_message_hidden (message_id, user_id) values ($1, $2) on conflict do nothing returning message_id`,
      [messageId, me],
    );
    if (hidden) await audit(c, db, 'chat.message_deleted_for_me', { type: CHAT_MESSAGE_MODEL, id: messageId }, null, { channel_id: channel.id, scope });
  }
  return ok(c, { id: messageId, scope }, scope === 'everyone' ? 'Message deleted for everyone.' : 'Message deleted for you.');
});

chatRoutes.post('/direct', async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { recipient_id: ['required', 'integer', 'exists:users,id'] });
  if (user.id === v.recipient_id) return c.json({ message: 'You cannot start a direct chat with yourself.' }, 422);

  const [recipient] = await db.query(
    `select u.id, u.full_name, coalesce(r.label, r.name) as role_label, coalesce(u.last_seen_at >= ${ONLINE_WINDOW}, false) as is_online
     from users u left join roles r on r.id = u.role_id where u.id = $1`,
    [v.recipient_id],
  );
  const slug = `dm_${Math.min(user.id, v.recipient_id)}_${Math.max(user.id, v.recipient_id)}`;
  const channel = await db.tx(async (tx) => {
    await tx.query(
      `insert into chat_channels (slug, name, type, description) values ($1, $2, 'direct', $3) on conflict (slug) do nothing`,
      [slug, `Chat with ${recipient.full_name}`, `Direct message between ${user.full_name} and ${recipient.full_name}`],
    );
    const [row] = await tx.query(`select * from chat_channels where slug = $1`, [slug]);
    await tx.query(
      `insert into chat_channel_members (channel_id, user_id) values ($1, $2), ($1, $3) on conflict (channel_id, user_id) do nothing`,
      [row.id, user.id, recipient.id],
    );
    return row;
  });
  return ok(c, {
    id: channel.id, slug: channel.slug, name: recipient.full_name, role_label: recipient.role_label,
    is_online: recipient.is_online, other_user_id: recipient.id, type: 'direct',
  });
});

chatRoutes.post('/heartbeat', async (c) => {
  const { db } = c.get('deps');
  const me = c.get('user').id;
  await db.query(`update users set last_seen_at = now() where id = $1`, [me]);
  const [summary] = await db.query(
    `select (select count(*)::int from users where last_seen_at >= ${ONLINE_WINDOW}) as online_count,
       (select count(*)::int from chat_messages m join chat_channels ch on ch.id = m.channel_id
        left join chat_channel_members cm on cm.channel_id = ch.id and cm.user_id = $1
        where m.user_id <> $1 and m.id > coalesce(cm.last_read_message_id, 0)
          and (ch.type = 'department' or (ch.type = 'direct' and cm.user_id is not null))) as total_unread`,
    [me],
  );
  return ok(c, { ...summary, timestamp: new Date().toISOString() });
});

chatRoutes.get('/directory', async (c) => {
  const rows = await c.get('deps').db.query(
    `select u.id, u.full_name, u.email, r.name as department, coalesce(r.label, r.name) as role_label,
       coalesce(u.last_seen_at >= ${ONLINE_WINDOW}, false) as is_online, u.last_seen_at
     from users u left join roles r on r.id = u.role_id
     where u.id <> $1 and u.account_status = 'active' order by u.full_name asc`,
    [c.get('user').id],
  );
  return ok(c, rows);
});
