// ApplicantStageService plus ApplicantController::transition: status columns + history + audit.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { updateRow } from '../lib/http.ts';
import { APPLICANT_MODEL } from './applicantModel.ts';
import { archiveInquiry, updateInquiry } from './inquiryModel.ts';
import { audit } from './users.ts';

/** The structured part of an action record (see the applicant action log in the migrations). */
export type ActionDetail = { step?: string | null; old_values?: Row | null; new_values?: Row | null; attachments?: Row[] | null };

const json = (value: Row | Row[] | null | undefined) => (value && (Array.isArray(value) ? value.length : Object.keys(value).length) ? JSON.stringify(value) : null);

/**
 * Appends one action record: who (user and role at that moment), when, stage, step, action,
 * old/new values, reason and attached files. Rows are never updated.
 */
export const logStageChange = (
  db: Db, applicantId: number, from: string | null, to: string, userId: number | null, remarks: string | null = null, event: string | null = null, context: Row = {},
  detail: ActionDetail = {},
) => db.query(
  `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, context, step, old_values, new_values, attachments, actor_role)
   values ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11, (select r.name from users u join roles r on r.id = u.role_id where u.id = $5))`,
  [
    applicantId, from, to, remarks, userId, event, json(context),
    detail.step ?? (event ?? (from === to ? null : 'stage_change')), json(detail.old_values), json(detail.new_values), json(detail.attachments),
  ],
);

export const logEvent = (db: Db, applicant: Row, event: string, userId: number | null, context: Row = {}, remarks: string | null = null, detail: ActionDetail = {}) =>
  logStageChange(db, applicant.id, applicant.status, applicant.status, userId, remarks, event, context, detail);

/** A file reference for an action record. */
export const fileRef = (d: Row | null | undefined) => (d ? { document_id: d.id, original_name: d.original_name, type: d.type } : null);

export async function transition(c: Context<AppEnv>, db: Db, applicant: Row, to: string, actor: Row, remarks: string | null, auditAction: string, extra: Row = {}): Promise<Row> {
  const from = applicant.status;
  const now = new Date();
  const saved = (await updateRow(db, 'applicants', applicant.id, {
    status: to,
    approved_at: to === 'approved' ? now : applicant.approved_at,
    approved_by_user_id: to === 'approved' ? actor.id : applicant.approved_by_user_id,
    rejected_at: to === 'rejected' ? now : applicant.rejected_at,
    ...(to === 'rejected' ? { archived_at: now, archived_by_user_id: actor.id } : {}),
    ...extra,
  }))!;

  if (['rejected', 'active_franchisee'].includes(to) && applicant.inquiry_id) {
    const [inquiry] = await db.query(`select * from franchise_inquiries where id = $1`, [applicant.inquiry_id]);
    if (inquiry && !inquiry.archived_at) {
      const current = to === 'rejected' ? await updateInquiry(db, inquiry, { status: 'rejected' }) : inquiry;
      await archiveInquiry(db, current, actor.id);
    }
  }

  await db.query(
    `insert into applicant_status_histories (applicant_id, from_status, to_status, remarks, changed_by_user_id) values ($1, $2, $3, $4, $5)`,
    [applicant.id, from, to, remarks, actor.id],
  );
  await logStageChange(db, applicant.id, from, to, actor.id, remarks, null, {}, { step: auditAction, old_values: { status: from }, new_values: { status: to } });
  await audit(c, db, auditAction, { type: APPLICANT_MODEL, id: applicant.id }, { status: from }, { status: to, ...(remarks ? { remarks } : {}) });
  return saved;
}
