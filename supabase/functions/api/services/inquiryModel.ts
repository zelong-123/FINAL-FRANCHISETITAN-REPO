// The behaviour of App\Models\FranchiseInquiry.
import type { Db, Row } from '../lib/db.ts';
import { Filter } from '../lib/http.ts';
import { assignPublicCode } from './users.ts';

export const INQUIRY_MODEL = 'App\\Models\\FranchiseInquiry';

/** Admin and Sales see endorsed, converted and rejected; Marketing its own and what it endorsed. */
export function visibleTo(filter: Filter, user: Row, table = 'franchise_inquiries') {
  if (['admin', 'sales'].includes(user.role?.name)) {
    filter.add(`${table}.status in ('endorsed', 'converted', 'rejected')`);
  } else {
    filter.add(`(${table}.encoded_by_user_id = ? or ${table}.endorsed_by_user_id = ?)`, user.id, user.id);
  }
}

/** Every status change stamps status_changed_at, whichever code path made it. */
export async function updateInquiry(db: Db, inquiry: Row, changes: Row): Promise<Row> {
  const fields = { ...changes };
  if ('status' in fields && fields.status !== inquiry.status) fields.status_changed_at = new Date();
  const keys = Object.keys(fields);
  const [row] = await db.query(
    `update franchise_inquiries set ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} where id = $${keys.length + 1} returning *`,
    [...keys.map((k) => fields[k]), inquiry.id],
  );
  return row;
}

export async function createInquiry(db: Db, fields: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const all = { ...fields, status_changed_at: new Date() };
    const keys = Object.keys(all);
    const [row] = await tx.query(
      `insert into franchise_inquiries (${keys.map((k) => `"${k}"`).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      keys.map((k) => (all as Row)[k]),
    );
    row.lead_code = await assignPublicCode(tx, 'franchise_inquiries', 'lead_code', 'LD', row.id);
    return row;
  });
}

/** Archive plus its history row. The displayed number is derived, so only its value then is kept. */
export async function archiveInquiry(db: Db, inquiry: Row, userId: number): Promise<Row | null> {
  if (inquiry.archived_at) return null;
  return db.tx(async (tx) => {
    const [{ display_no: displayNo }] = await tx.query(
      `select count(*)::int as display_no from franchise_inquiries where archived_at is null and id <= $1`, [inquiry.id],
    );
    const now = new Date();
    await tx.query(`update franchise_inquiries set archived_at = $1, archived_by_user_id = $2 where id = $3`, [now, userId, inquiry.id]);
    const [log] = await tx.query(
      `insert into inquiry_archive_logs (franchise_inquiry_id, lead_name, original_display_no, archived_by_user_id, archived_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [inquiry.id, inquiry.lead_name, displayNo, userId, now],
    );
    const [saved] = await tx.query(`update inquiry_archive_logs set archive_id = $1 where id = $2 returning *`, [10000 + log.id, log.id]);
    return saved;
  });
}

export async function restoreInquiry(db: Db, inquiryId: number, userId: number) {
  await db.tx(async (tx) => {
    await tx.query(`update franchise_inquiries set archived_at = null, archived_by_user_id = null where id = $1`, [inquiryId]);
    await tx.query(
      `update inquiry_archive_logs set restored_at = now(), restored_by_user_id = $1 where franchise_inquiry_id = $2 and restored_at is null`,
      [userId, inquiryId],
    );
  });
}

export const CURRENT_ARCHIVE_LOG = (alias: string) =>
  `(select to_jsonb(log) from inquiry_archive_logs log where log.franchise_inquiry_id = ${alias}.id and log.restored_at is null order by log.id desc limit 1)`;

export const archivedByAdmin = (alias: string) =>
  `exists (select 1 from users au join roles ar on ar.id = au.role_id where au.id = ${alias}.archived_by_user_id and ar.name = 'admin')`;
