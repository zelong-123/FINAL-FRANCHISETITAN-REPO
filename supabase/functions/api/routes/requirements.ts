// Requirements per stage: the assigned Sales user submits each item (data + files), Admin
// Accepts it or Returns it with a reason. Only Admin and the assigned Sales user see the files.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, ok, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { downloadDocument, MAX_UPLOAD_KB, storeDocument } from '../lib/files.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { notifyRoles } from '../services/notifications.ts';
import { APPLICANT_MODEL } from '../services/applicantModel.ts';
import { fileRef, logEvent } from '../services/applicantStage.ts';
import { assertAssignedSales, notifyAssignedSales, requireReason } from '../services/accountability.ts';
import {
  legacyStage, loadRequirementRows, loiRequirement, readFields, REQUIREMENT_MODEL, REQUIREMENT_STAGES, requirementDef, REQUIREMENTS,
} from '../services/requirements.ts';

export const requirementRoutes = new Hono<AppEnv>();
const staff = role('admin', 'sales');
const admin = role('admin');

const NAME = (expr: string) => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${expr})`;

const loadApplicant = async (c: Context<AppEnv>): Promise<Row> => {
  const [a] = await c.get('deps').db.query(`select * from applicants where id = $1`, [routeId(c, 'applicant')]);
  requireFound(a);
  if (roleName(c) === 'sales' && a.archived_at) abort(404, 'Record not found.');
  return a;
};
const loadDef = (c: Context<AppEnv>) => {
  const def = requirementDef(c.req.param('key') ?? '');
  if (!def) abort(404, 'Unknown requirement.');
  return def!;
};

/** Files are visible to Admin and the assigned Sales user only. */
export const canSeeRequirementFiles = (user: Row, a: Row) => user.role?.name === 'admin'
  || (user.role?.name === 'sales' && Number(a.assigned_sales_user_id) === Number(user.id));

/** The requirements block of the applicant payload: config, every item, legacy flags, LOI. */
export async function requirementsPayload(db: Db, a: Row, user: Row): Promise<Row> {
  const rows = await db.query(
    `select r.*, ${NAME('r.submitted_by_user_id')} as submitted_by, ${NAME('r.reviewed_by_user_id')} as reviewed_by
     from applicant_requirements r where r.applicant_id = $1 order by r.id`, [a.id],
  );
  const showFiles = canSeeRequirementFiles(user, a);
  const files = showFiles && rows.length ? await db.query(
    `select id, documentable_id, type, original_name, mime_type, size_bytes, created_at, replaced_at, ${NAME('uploaded_by_user_id')} as uploaded_by
     from documents where documentable_type = $1 and documentable_id = any($2::bigint[]) and removed_at is null order by id`,
    [REQUIREMENT_MODEL, `{${rows.map((r) => r.id).join(',')}}`],
  ) : [];
  const items = REQUIREMENTS.map((def) => {
    const row = rows.find((r) => r.requirement_key === def.key);
    return {
      key: def.key, stage: def.stage, label: def.label, status: row?.status ?? 'pending', data: row?.data ?? {},
      submitted_by: row?.submitted_by ?? null, submitted_at: row?.submitted_at ?? null,
      reviewed_by: row?.reviewed_by ?? null, reviewed_at: row?.reviewed_at ?? null, return_reason: row?.return_reason ?? null,
      files: showFiles ? files.filter((d) => row && Number(d.documentable_id) === Number(row.id)) : null,
    };
  });
  const summary: Row = {};
  for (const stage of Object.keys(REQUIREMENT_STAGES)) {
    const own = items.filter((i) => i.stage === stage);
    summary[stage] = {
      complete: own.every((i) => i.status === 'accepted'),
      missing: own.filter((i) => i.status !== 'accepted').map((i) => i.label),
      legacy: legacyStage(a, stage, rows),
      open: a.status === REQUIREMENT_STAGES[stage].applicant_status && !a.archived_at,
    };
  }
  return { config: { stages: REQUIREMENT_STAGES, requirements: REQUIREMENTS }, items, summary, loi: await loiRequirement(db, a), files_visible: showFiles };
}

/** Uploaded files for one file slot: one or several (`key` or `key[]`), type and size checked. */
function filesFor(input: Row, slot: { key: string; label: string; accept: string; multiple?: boolean }): File[] {
  const raw = input[slot.key] ?? input[`${slot.key}[]`];
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]).filter((f) => f instanceof File) as File[];
  if (!slot.multiple && list.length > 1) fail(slot.key, `Attach only one file for ${slot.label}.`);
  const allowed = slot.accept.split(',');
  for (const file of list) {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!allowed.includes(ext)) fail(slot.key, `${slot.label} must be a ${allowed.join(', ').toUpperCase()} file.`);
    if (file.size / 1024 > MAX_UPLOAD_KB) fail(slot.key, `${slot.label} may not be larger than ${MAX_UPLOAD_KB / 1024} MB.`);
  }
  return list;
}

/** Sales submits (or corrects and resubmits) one requirement. */
requirementRoutes.post('/applicants/:applicant/requirements/:key', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  const def = loadDef(c);
  const user = c.get('user');
  if (roleName(c) !== 'sales') abort(403, 'Only the assigned Sales user submits requirements. Admin reviews them.');
  await assertAssignedSales(c, a);
  const stage = REQUIREMENT_STAGES[def.stage];
  if (a.archived_at || a.status !== stage.applicant_status) fail('requirement', `${def.label} is submitted at the ${stage.label} stage.`);
  const [current] = await db.query(`select * from applicant_requirements where applicant_id = $1 and requirement_key = $2`, [a.id, def.key]);
  if (current?.status === 'accepted') fail('requirement', `${def.label} is already Accepted.`);
  if (current?.status === 'submitted') fail('requirement', `${def.label} is waiting for Admin review.`);

  const input = await readInput(c);
  const data = readFields(def, input);
  const uploads = Object.fromEntries(def.files.map((slot) => [slot.key, filesFor(input, slot)]));
  const existing = current ? await db.query(
    `select id, type, original_name from documents where documentable_type = $1 and documentable_id = $2 and replaced_at is null and removed_at is null`, [REQUIREMENT_MODEL, current.id],
  ) : [];
  // A resubmission may keep the files Admin did not object to; a slot with new files replaces them.
  for (const slot of def.files) {
    if (slot.required && !uploads[slot.key].length && !existing.some((d) => d.type === slot.key)) fail(slot.key, `Attach the ${slot.label.toLowerCase()}.`);
  }

  const { row, stored } = await db.tx(async (tx) => {
    const now = new Date();
    const saved = current
      ? (await updateRow(tx, 'applicant_requirements', current.id, { status: 'submitted', data, submitted_by_user_id: user.id, submitted_at: now, reviewed_by_user_id: null, reviewed_at: null, return_reason: null }))!
      : await insertRow(tx, 'applicant_requirements', { applicant_id: a.id, requirement_key: def.key, stage: def.stage, status: 'submitted', data, submitted_by_user_id: user.id, submitted_at: now });
    const added: Row[] = [];
    const swapped: Row[] = [];
    for (const slot of def.files) {
      const files = uploads[slot.key];
      if (!files.length) continue;
      const old = existing.filter((d) => d.type === slot.key);
      for (const file of files) added.push(await storeDocument(c, tx, file, `applicants/${a.id}/requirements/${def.key}`, { type: REQUIREMENT_MODEL, id: saved.id }, slot.key));
      if (old.length) {
        await tx.query(`update documents set replaced_at = now(), replaced_by_document_id = $1 where id = any($2::bigint[])`, [added[added.length - 1].id, `{${old.map((d) => d.id).join(',')}}`]);
        swapped.push(...old);
      }
    }
    await logEvent(tx, a, current ? 'requirement_resubmitted' : 'requirement_submitted', user.id, { requirement_key: def.key, requirement_id: saved.id }, null, {
      step: def.key,
      old_values: current ? { status: current.status, data: current.data } : { status: 'pending' },
      new_values: { status: 'submitted', data },
      attachments: [...added.map(fileRef), ...swapped.map((d) => ({ ...fileRef(d), state: 'replaced' }))] as Row[],
    });
    await audit(c, tx, 'applicant.requirement_submitted', { type: APPLICANT_MODEL, id: a.id }, current ?? null, { requirement_key: def.key, data, document_ids: added.map((d) => d.id) });
    return { row: saved, stored: added };
  });
  await notifyRoles(db, ['admin'], 'requirement_submitted', 'Requirement submitted',
    `${user.full_name} submitted "${def.label}" for ${a.full_name}. Review it: Accept or Return.`, { applicant_id: a.id, requirement_key: def.key }, user);
  return ok(c, { ...row, files: stored }, `${def.label} sent to Admin for review.`, 201);
});

/** Admin accepts a submitted requirement. */
requirementRoutes.post('/applicants/:applicant/requirements/:key/accept', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  const def = loadDef(c);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can accept a requirement. Sales cannot verify its own submission.');
  const user = c.get('user');
  const [current] = await db.query(`select * from applicant_requirements where applicant_id = $1 and requirement_key = $2`, [a.id, def.key]);
  if (!current || current.status !== 'submitted') fail('requirement', `${def.label} has no submission waiting for review.`);
  await db.tx(async (tx) => {
    await updateRow(tx, 'applicant_requirements', current.id, { status: 'accepted', reviewed_by_user_id: user.id, reviewed_at: new Date(), return_reason: null });
    await logEvent(tx, a, 'requirement_accepted', user.id, { requirement_key: def.key, requirement_id: current.id }, null, {
      step: def.key, old_values: { status: 'submitted' }, new_values: { status: 'accepted' },
    });
    await audit(c, tx, 'applicant.requirement_accepted', { type: APPLICANT_MODEL, id: a.id }, { status: 'submitted' }, { requirement_key: def.key, status: 'accepted' });
  });
  await notifyAssignedSales(db, a, 'requirement_accepted', 'Requirement accepted', `Admin accepted "${def.label}" for ${a.full_name}.`, { requirement_key: def.key }, user);
  return ok(c, await requirementsPayload(db, a, user), `${def.label} accepted.`);
});

/** Admin returns a submitted requirement with a reason; Sales corrects and resubmits. */
requirementRoutes.post('/applicants/:applicant/requirements/:key/return', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  const def = loadDef(c);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can return a requirement.');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const [current] = await db.query(`select * from applicant_requirements where applicant_id = $1 and requirement_key = $2`, [a.id, def.key]);
  if (!current || current.status !== 'submitted') fail('requirement', `${def.label} has no submission waiting for review.`);
  const reason = requireReason(v.reason, 'reason', 'a return reason');
  await db.tx(async (tx) => {
    await updateRow(tx, 'applicant_requirements', current.id, { status: 'returned', reviewed_by_user_id: user.id, reviewed_at: new Date(), return_reason: reason });
    await logEvent(tx, a, 'requirement_returned', user.id, { requirement_key: def.key, requirement_id: current.id }, reason, {
      step: def.key, old_values: { status: 'submitted' }, new_values: { status: 'returned' },
    });
    await audit(c, tx, 'applicant.requirement_returned', { type: APPLICANT_MODEL, id: a.id }, { status: 'submitted' }, { requirement_key: def.key, status: 'returned', reason });
  });
  await notifyAssignedSales(db, a, 'requirement_returned', 'Requirement returned', `Admin returned "${def.label}" for ${a.full_name}: ${reason}`, { requirement_key: def.key }, user);
  return ok(c, await requirementsPayload(db, a, user), `${def.label} returned to Sales.`);
});

/** A requirement file: Admin and the assigned Sales user only (never Marketing or the branch). */
requirementRoutes.get('/applicants/:applicant/requirements/:key/documents/:document/download', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  const def = loadDef(c);
  if (!canSeeRequirementFiles(c.get('user'), a)) abort(403, 'Only Admin and the assigned Sales user can open requirement files.');
  const [d] = await db.query(
    `select d.* from documents d join applicant_requirements r on r.id = d.documentable_id
     where d.id = $1 and d.documentable_type = $2 and r.applicant_id = $3 and r.requirement_key = $4`,
    [routeId(c, 'document'), REQUIREMENT_MODEL, a.id, def.key],
  );
  return downloadDocument(c, requireFound(d));
});
