// Orientation/Tasting (stored key 'orientation'): what Sales submits when completing it, and what
// Admin must do before verifying it.
//  - Attendance proof: 1–10 files (document type 'attendance_proof').
//  - Brand selection document: 1–2 files (document type 'brand_selection').
//  - Selected brand: one of the brands.
//  - Admin opens (downloads) every current file after the latest submission before Verify works;
//    the views are kept per file and per Admin in activity_document_views.
// Legacy: an Orientation done under the old flow by an applicant already past Scheduling needs none of this.
import type { Db, Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';
import { MAX_UPLOAD_KB, sniffFileType } from '../lib/files.ts';

export const ACTIVITY_MODEL = 'App\\Models\\ActivitySchedule';
export const ATTENDANCE_TYPE = 'attendance_proof';
export const BRAND_DOC_TYPE = 'brand_selection';
export const ORIENTATION_DOC_TYPES = [ATTENDANCE_TYPE, BRAND_DOC_TYPE];
export const FILE_LIMITS: Record<string, { min: number; max: number; label: string; field: string }> = {
  [ATTENDANCE_TYPE]: { min: 1, max: 10, label: 'attendance proof', field: 'attendance' },
  [BRAND_DOC_TYPE]: { min: 1, max: 2, label: 'brand selection document', field: 'brand_document' },
};
const ACCEPT = ['pdf', 'jpg', 'jpeg', 'png'];
/** Statuses past Scheduling: an old-flow Orientation of these applicants is legacy. */
export const PAST_SCHEDULING = ['loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee', 'rejected'];

export const isLegacyOrientation = (activity: Row, applicant: Row | null) => activity.activity_type === 'orientation'
  && Boolean(applicant && PAST_SCHEDULING.includes(applicant.status));

/** Files of a request field: `name` (one or several) or `name[]`. */
export function filesOf(input: Row, name: string): File[] {
  const raw = input[name] ?? input[`${name}[]`];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  return list.filter((f) => f instanceof File && f.size > 0) as File[];
}

/** keep_document_ids: "12,13" or repeated fields. Absent means "keep none" (a fresh submission). */
export function keepIdsOf(input: Row): number[] {
  const raw = input.keep_document_ids ?? input['keep_document_ids[]'];
  if (raw === undefined || raw === null || raw === '') return [];
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(list)];
}

/** The same rules as the requirement uploads: PDF, JPG or PNG, at most 10 MB, contents must match the type. */
export async function assertUpload(file: File, field: string, label: string) {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!ACCEPT.includes(ext)) fail(field, `The ${label} must be a PDF, JPG or PNG file (${file.name}).`);
  if (file.size / 1024 > MAX_UPLOAD_KB) fail(field, `The ${label} may not be larger than ${MAX_UPLOAD_KB / 1024} MB (${file.name}).`);
  const real = await sniffFileType(file);
  const expected = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
  if (real !== expected) fail(field, `The ${label} "${file.name}" is not a real PDF, JPG or PNG (its contents do not match its type).`);
}

export function assertCount(type: string, total: number) {
  const rule = FILE_LIMITS[type];
  if (total < rule.min) fail(rule.field, `Attach the ${rule.label} (${rule.min === 1 ? 'at least 1 file' : `at least ${rule.min} files`}).`);
  if (total > rule.max) fail(rule.field, `The ${rule.label} can have at most ${rule.max} file${rule.max === 1 ? '' : 's'}. Remove one first.`);
}

/** The current (not replaced, not removed) Orientation/Tasting files of an activity. */
export const currentDocuments = (db: Db, activityId: number): Promise<Row[]> => db.query(
  `select * from documents where documentable_type = $1 and documentable_id = $2 and type = any($3::text[]) and replaced_at is null and removed_at is null order by id`,
  [ACTIVITY_MODEL, activityId, `{${ORIENTATION_DOC_TYPES.join(',')}}`],
);

/** Records that an Admin opened a file. */
export async function recordView(db: Db, documentId: number, userId: number) {
  await db.query(
    `insert into activity_document_views (document_id, user_id) values ($1, $2)
     on conflict (document_id, user_id) do update set last_viewed_at = now()`, [documentId, userId],
  );
}

/** The current files this Admin has not opened since the latest submission. */
export async function unviewedDocuments(db: Db, activity: Row, userId: number): Promise<Row[]> {
  return db.query(
    `select d.id, d.original_name, d.type from documents d
     where d.documentable_type = $1 and d.documentable_id = $2 and d.type = any($3::text[]) and d.replaced_at is null and d.removed_at is null
       and not exists (select 1 from activity_document_views v where v.document_id = d.id and v.user_id = $4 and v.last_viewed_at >= $5::timestamptz)
     order by d.id`,
    [ACTIVITY_MODEL, activity.id, `{${ORIENTATION_DOC_TYPES.join(',')}}`, userId, activity.completion_submitted_at ?? new Date(0)],
  );
}

/**
 * SQL for an activity's proof files with the document type and, for the given user, whether they
 * opened it since the latest submission (`viewed_by_me`). `s` is the activity_schedules alias.
 */
export const activityDocumentsSql = (userParam: string) => `coalesce((select jsonb_agg(jsonb_build_object(
    'id', d.id, 'original_name', d.original_name, 'mime_type', d.mime_type, 'created_at', d.created_at, 'replaced_at', d.replaced_at, 'type', d.type,
    'viewed_by_me', exists (select 1 from activity_document_views v where v.document_id = d.id and v.user_id = ${userParam}::bigint
      and v.last_viewed_at >= coalesce(s.completion_submitted_at, 'epoch'::timestamptz))) order by d.id)
  from documents d where d.documentable_type = 'App\\Models\\ActivitySchedule' and d.documentable_id = s.id and d.type in ('attendance_proof', 'brand_selection')), '[]'::jsonb)`;
