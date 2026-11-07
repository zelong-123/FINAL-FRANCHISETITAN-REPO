// ApplicantStageService plus ApplicantController::transition: status columns + history + audit.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { updateRow } from '../lib/http.ts';
import { APPLICANT_MODEL } from './applicantModel.ts';
import { archiveInquiry, updateInquiry } from './inquiryModel.ts';
import { audit } from './users.ts';

export const logStageChange = (db: Db, applicantId: number, from: string | null, to: string, userId: number | null, remarks: string | null = null, event: string | null = null, context: Row = {}) => db.query(
  `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, context)
   values ($1, $2, $3, $4, $5, now(), $6, $7)`,
  [applicantId, from, to, remarks, userId, event, Object.keys(context).length ? JSON.stringify(context) : null],
);

export const logEvent = (db: Db, applicant: Row, event: string, userId: number | null, context: Row = {}, remarks: string | null = null) =>
  logStageChange(db, applicant.id, applicant.status, applicant.status, userId, remarks, event, context);

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
  await logStageChange(db, applicant.id, from, to, actor.id, remarks);
  await audit(c, db, auditAction, { type: APPLICANT_MODEL, id: applicant.id }, { status: from }, { status: to, ...(remarks ? { remarks } : {}) });
  return saved;
}
