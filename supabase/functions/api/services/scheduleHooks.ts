// The Master Schedule touchpoints the applicant routes need.
import type { Db, Row } from '../lib/db.ts';
import { RawError } from '../lib/http.ts';
import { BRANDED_TYPES, describe, SESSION_RELATIONS } from './schedule/conflict.ts';
import { iso8601 } from './schedule/rules.ts';
import { syncApplicantAttendance as syncAttendance } from './schedule/sync.ts';

/** ScheduleSessionController::sessionsFor (the Update Applicant modal). */
export async function sessionsFor(db: Db, applicantId: number): Promise<Row[]> {
  const rows = await db.query(
    `select s.*, ${SESSION_RELATIONS('s')}, (select p.attendance_status from schedule_session_participants p where p.session_id = s.id and p.applicant_id = $1 limit 1) as own_status
     from schedule_sessions s where exists (select 1 from schedule_session_participants p where p.session_id = s.id and p.applicant_id = $1) order by s.start_at`,
    [applicantId],
  );
  return rows.map((s) => ({
    id: s.id, activity_type: s.activity_type, status: s.status, start_at: iso8601(s.start_at), end_at: iso8601(s.end_at), brand: s.brand?.name ?? null,
    handler: s.handler?.full_name ?? null, venue: s.venue, occupancy: `${s.active_participants.length}/${s.max_capacity} applicants`,
    merge_suggested: Boolean(s.merge_suggested), attendance_status: s.own_status,
  }));
}

export const syncApplicantAttendance = (db: Db, applicant: Row, userId: number) => syncAttendance(db, applicant, userId);

export async function assertNoSessionOfOtherBrand(db: Db, applicantId: number, newBrandId: unknown): Promise<void> {
  const sessions = await db.query(
    `select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s
     where s.activity_type = any($1::text[]) and s.status in ('pending', 'confirmed')
       and ($2::bigint is null and s.brand_id is not null or $2::bigint is not null and (s.brand_id is null or s.brand_id <> $2::bigint))
       and exists (select 1 from schedule_session_participants p where p.session_id = s.id and p.applicant_id = $3 and p.attendance_status not in ('cancelled', 'removed'))
     order by s.start_at`,
    [`{${BRANDED_TYPES.join(',')}}`, newBrandId ?? null, applicantId],
  );
  if (!sessions.length) return;
  throw new RawError(422, {
    message: 'The submitted data is invalid.',
    errors: {
      preferred_brand_id: [`Cancel or reschedule these sessions before changing the brand preference: ${sessions.map((s) => `#${s.id} ${describe(s)}`).join('; ')}.`],
      blocking_sessions: sessions.map((s) => String(s.id)),
    },
  });
}
