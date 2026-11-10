// Requirements per stage: the ONE place the list is defined. The browser receives this config
// from the API (GET /applicants/:id → requirements.config), so nothing is duplicated there.
import type { Db, Row } from '../lib/db.ts';
import { fail, manilaToday } from '../lib/http.ts';

export type FieldDef = { key: string; label: string; type: 'text' | 'textarea' | 'date' | 'select'; required?: boolean; options?: { value: string; label: string }[]; min_length?: number; not_future?: boolean };
export type FileDef = { key: string; label: string; required: boolean; multiple?: boolean; accept: string };
export type RequirementDef = { key: string; stage: string; label: string; help: string; fields: FieldDef[]; files: FileDef[] };

const DOCS = 'pdf,jpg,jpeg,png';
const IMAGES = 'jpg,jpeg,png';

/** The stage each requirement belongs to, and the applicant status at which Sales submits it. */
export const REQUIREMENT_STAGES: Record<string, { label: string; applicant_status: string; gate: string }> = {
  qualification: { label: 'Qualification', applicant_status: 'converted', gate: 'Confirm Qualified' },
  activation: { label: 'Before Active Franchisee', applicant_status: 'approved', gate: 'Mark as Active Franchisee' },
};

export const REQUIREMENTS: RequirementDef[] = [
  {
    key: 'application_form', stage: 'qualification', label: 'Application form', help: 'The completed and signed application form.',
    fields: [], files: [{ key: 'form', label: 'Application form', required: true, accept: DOCS }],
  },
  {
    key: 'government_id', stage: 'qualification', label: 'Valid government ID', help: 'A clear copy of one valid government-issued ID.',
    fields: [{
      key: 'id_type', label: 'ID type', type: 'select', required: true,
      options: [
        { value: 'passport', label: 'Passport' }, { value: 'drivers_license', label: "Driver's license" }, { value: 'umid', label: 'UMID' },
        { value: 'national_id', label: 'National ID (PhilSys)' }, { value: 'prc', label: 'PRC ID' }, { value: 'postal', label: 'Postal ID' }, { value: 'other', label: 'Other government ID' },
      ],
    }],
    files: [{ key: 'id_copy', label: 'ID copy', required: true, accept: DOCS }],
  },
  {
    key: 'proof_of_funds', stage: 'qualification', label: 'Proof of funds', help: 'The declared investment range and a bank certificate or similar document.',
    fields: [{
      key: 'investment_range', label: 'Declared investment range', type: 'select', required: true,
      options: [
        { value: 'below_500k', label: 'Below ₱500,000' }, { value: '500k_1m', label: '₱500,000 – ₱1,000,000' },
        { value: '1m_2m', label: '₱1,000,001 – ₱2,000,000' }, { value: 'above_2m', label: 'Above ₱2,000,000' },
      ],
    }],
    files: [{ key: 'bank_certificate', label: 'Bank certificate or similar', required: true, accept: DOCS }],
  },
  {
    key: 'initial_interview', stage: 'qualification', label: 'Initial interview', help: 'When the interview happened, who interviewed, what was learned, and the signed interview sheet.',
    fields: [
      { key: 'interview_date', label: 'Interview date', type: 'date', required: true, not_future: true },
      { key: 'interviewer', label: 'Interviewer', type: 'text', required: true },
      { key: 'notes', label: 'Interview notes', type: 'textarea', required: true, min_length: 10 },
    ],
    files: [{ key: 'interview_sheet', label: 'Signed interview sheet', required: true, accept: DOCS }],
  },
  {
    key: 'proposed_site', stage: 'qualification', label: 'Proposed site', help: 'The address, whether it is owned or leased, and photos of the site.',
    fields: [
      { key: 'address', label: 'Site address', type: 'text', required: true },
      { key: 'ownership', label: 'Owned or leased', type: 'select', required: true, options: [{ value: 'owned', label: 'Owned' }, { value: 'leased', label: 'Leased' }] },
    ],
    files: [{ key: 'site_photos', label: 'Site photos', required: true, multiple: true, accept: IMAGES }],
  },
  {
    key: 'business_background', stage: 'qualification', label: 'Business background', help: 'Current occupation and any previous business experience.',
    fields: [
      { key: 'occupation', label: 'Occupation', type: 'text', required: true },
      { key: 'previous_experience', label: 'Previous business experience', type: 'textarea', required: true, min_length: 5 },
    ],
    files: [],
  },
  {
    key: 'franchise_agreement', stage: 'activation', label: 'Signed franchise agreement', help: 'The franchise agreement signed by the applicant.',
    fields: [], files: [{ key: 'agreement', label: 'Signed franchise agreement', required: true, accept: DOCS }],
  },
];

export const requirementDef = (key: string) => REQUIREMENTS.find((r) => r.key === key) ?? null;
export const requirementsOf = (stage: string) => REQUIREMENTS.filter((r) => r.stage === stage);
export const REQUIREMENT_MODEL = 'App\\Models\\ApplicantRequirement';

export const loadRequirementRows = async (db: Db, applicantId: number): Promise<Row[]> =>
  db.query(`select * from applicant_requirements where applicant_id = $1 order by id`, [applicantId]);

/** The submitted field values, checked against the config. Returns only known keys. */
export function readFields(def: RequirementDef, input: Row): Row {
  const data: Row = {};
  for (const field of def.fields) {
    const raw = input[field.key];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (field.required && !value) fail(field.key, `${field.label} is required.`);
    if (!value) continue;
    if (field.type === 'select' && !(field.options ?? []).some((o) => o.value === value)) fail(field.key, `Choose a valid ${field.label.toLowerCase()}.`);
    if (field.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) fail(field.key, `${field.label} must be a valid date.`);
      if (field.not_future && value > manilaToday()) fail(field.key, `${field.label} cannot be in the future.`);
    }
    if (field.min_length && value.length < field.min_length) fail(field.key, `${field.label} must be at least ${field.min_length} characters.`);
    if (value.length > 5000) fail(field.key, `${field.label} is too long.`);
    data[field.key] = value;
  }
  return data;
}

/** Labels of the requirements of a stage that are not Accepted yet. */
export async function missingRequirements(db: Db, applicantId: number, stage: string): Promise<string[]> {
  const rows = await loadRequirementRows(db, applicantId);
  return requirementsOf(stage).filter((def) => rows.find((r) => r.requirement_key === def.key)?.status !== 'accepted').map((def) => def.label);
}

/** Blocks the move and lists exactly what is missing. */
export async function assertStageRequirements(db: Db, applicantId: number, stage: string) {
  const missing = await missingRequirements(db, applicantId, stage);
  if (!missing.length) return;
  fail('requirements', `${REQUIREMENT_STAGES[stage].gate} needs every ${REQUIREMENT_STAGES[stage].label} requirement Accepted. Missing: ${missing.join(', ')}.`);
}

/** Older applicants already past a stage keep working; the stage shows "not captured". */
export function legacyStage(a: Row, stage: string, rows: Row[]): boolean {
  if (rows.some((r) => r.stage === stage)) return false;
  if (stage === 'qualification') return a.status !== 'converted' && a.status !== 'rejected' ? true : false;
  if (stage === 'activation') return a.status === 'active_franchisee';
  return false;
}

/**
 * The LOI requirement is read from the LOI record itself: no scan = Pending, a scan waiting =
 * Submitted, Verified = Accepted, a scan Admin returned (and not replaced since) = Returned.
 */
export async function loiRequirement(db: Db, a: Row): Promise<Row> {
  const [scan] = await db.query(
    `select id, original_name, created_at, uploaded_by_user_id from documents
     where documentable_type = 'App\\Models\\Applicant' and documentable_id = $1 and type = 'loi' and removed_at is null and replaced_at is null order by id desc limit 1`,
    [a.id],
  );
  let status = 'pending';
  if (a.loi_verification_status === 'verified' && scan) status = 'accepted';
  else if (scan && a.loi_returned_at && new Date(a.loi_returned_at) >= new Date(scan.created_at)) status = 'returned';
  else if (scan) status = 'submitted';
  return {
    key: 'loi_scan', stage: 'loi', label: 'Scanned LOI', status, scan: scan ?? null,
    return_reason: status === 'returned' ? a.loi_return_reason : null,
    legacy: !scan && ['payment_submitted', 'for_approval', 'approved', 'active_franchisee'].includes(a.status) && a.loi_status !== 'pending',
  };
}
