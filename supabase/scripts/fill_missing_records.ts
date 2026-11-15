// TEST DATA: fills the records an older, compressed pipeline never created, WITHOUT re-timing anything.
// Every stage time and activity time stays as it is (append-only history is not touched); each added
// record is timestamped inside the real window of its stage, taken from applicant_status_histories:
//   Converted  -> the 4 Qualification requirements (Sales submits, Admin accepts) with a sample file each
//   Scheduling -> Orientation/Tasting proofs (2 attendance + 1 brand document), selected brand = inquiry
//                 brand, verified, Admin viewed rows; Training proof (1 attendance file), verified
//   LOI        -> Proposed site (address, owned/leased, sample photo, accepted); the LOI file if missing;
//                 LOI status complete
//   Payment    -> the "Downpayment + Balance" preset; the existing verified entries are linked to Downpayment
//                 and Balance in time order, with an OR/AR number and a sample receipt image (no amounts)
//   Approved   -> Signed franchise agreement (sample file, accepted), before Active Franchisee
// A record that cannot fit inside its stage's window is refused, never guessed. Sample images are
// copied to their own storage objects. Every change is logged in audit_logs as sample/test data.
//
//   node --no-warnings supabase/scripts/fill_missing_records.ts --ids=6,9 --dry-run
//   node --no-warnings supabase/scripts/fill_missing_records.ts --ids=6,9 --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const MODELS = { applicant: 'App\\Models\\Applicant', requirement: 'App\\Models\\ApplicantRequirement', activity: 'App\\Models\\ActivitySchedule', payment: 'App\\Models\\Payment' };
const SEC = 1000;
const NOTE = 'Sample/test data: filled in without re-timing the pipeline.';
const iso = (d: unknown) => (d ? new Date(d as string | number).toISOString() : null);

export type Files = { copy(fromPath: string, toPath: string): Promise<void>; remove(paths: string[]): Promise<void> };
export type Actors = { salesId: number; salesName: string; adminId: number; adminName: string };
type Copy = { source: Row; owner: string; owner_id: number | null; type: string; path: string; stored_name: string; at: string; name: string };
export type Item = { stage: string; window: [string, string] | null; item: string; at: string[]; records: string; files: number; fits: boolean; why?: string };
export type FillPlan = { id: number; code: string; name: string; refused?: string; items: Item[]; copies: Copy[]; actions: ((tx: Db, ids: Row) => Promise<void>)[] };

const QUALIFICATION = [
  { key: 'application_form', file: 'form', data: {} },
  { key: 'government_id', file: 'id_copy', data: { id_type: 'national_id' } },
  { key: 'proof_of_funds', file: 'bank_certificate', data: { investment_range: '500k_1m' } },
  { key: 'initial_interview', file: 'interview_sheet', data: null },
];

/** n moments spread evenly strictly inside (start, end). */
function spread(start: number, end: number, n: number): number[] | null {
  const step = Math.floor((end - start) / (n + 1));
  if (step < SEC) return null;
  return Array.from({ length: n }, (_, i) => start + step * (i + 1));
}

export async function fillMissingRecords(db: Db, ids: number[], actors: Actors, apply: boolean, files?: Files): Promise<FillPlan[]> {
  const images = await db.query(
    `select distinct on (path) id, original_name, mime_type, size_bytes, path from documents
     where mime_type in ('image/jpeg', 'image/png') and removed_at is null and disk = 'private' order by path, id`,
  );
  images.sort((a: Row, b: Row) => Number(a.id) - Number(b.id));
  if (!images.length) throw new Error('No sample jpg/png documents to copy.');
  let next = 0;
  const plans: FillPlan[] = [];
  for (const id of ids) {
    const [a] = await db.query(`select * from applicants where id = $1`, [id]);
    const plan: FillPlan = { id, code: a?.applicant_code ?? '—', name: a?.full_name ?? '—', items: [], copies: [], actions: [] };
    plans.push(plan);
    if (!a) { plan.refused = 'applicant not found'; continue; }
    const copy = (owner: string, ownerId: number | null, type: string, folder: string, at: number, label: string) => {
      const src = images[next++ % images.length];
      const ext = String(src.original_name).split('.').pop()?.toLowerCase() || 'png';
      const stored = `${crypto.randomUUID()}.${ext}`;
      const c: Copy = { source: src, owner, owner_id: ownerId, type, path: `${folder}/${stored}`, stored_name: stored, at: iso(at)!, name: `sample-${label}.${ext}` };
      plan.copies.push(c);
      return c;
    };
    const hist = await db.query(`select from_status, to_status, created_at from applicant_status_histories where applicant_id = $1 order by created_at, id`, [id]);
    const entered = (s: string) => hist.find((h: Row) => h.to_status === s)?.created_at;
    const left = (s: string) => hist.find((h: Row) => h.from_status === s && h.to_status !== s)?.created_at;
    const win = (s: string): [number, number] | null => (entered(s) && left(s) ? [new Date(entered(s)).getTime(), new Date(left(s)).getTime()] : null);
    const label = (w: [number, number] | null): [string, string] | null => (w ? [iso(w[0])!, iso(w[1])!] : null);
    const add = (item: Item) => { plan.items.push(item); return item.fits; };

    // ---- Converted: the 4 Qualification requirements ----
    const reqs = await db.query(`select requirement_key from applicant_requirements where applicant_id = $1`, [id]);
    const missingQ = QUALIFICATION.filter((q) => !reqs.some((r: Row) => r.requirement_key === q.key));
    const wq = win('converted');
    if (missingQ.length) {
      const times = wq ? spread(wq[0], wq[1], missingQ.length * 2) : null;
      if (add({ stage: 'Converted', window: label(wq), item: `Qualification: ${missingQ.map((q) => q.key).join(', ')} (submitted + accepted)`, at: times ? [iso(times[0])!, iso(times.at(-1))!] : [],
        records: `${missingQ.length} requirement rows`, files: missingQ.length, fits: Boolean(times), why: times ? undefined : 'the Converted window is too short' }) && times) {
        missingQ.forEach((q, i) => {
          const submitted = times[i * 2];
          const accepted = times[i * 2 + 1];
          const data = q.data ?? { interview_date: new Date(submitted + 8 * 3600e3).toISOString().slice(0, 10), interviewer: actors.salesName, notes: 'Sample/test data: initial interview recorded for the demo.' };
          const c = copy(MODELS.requirement, null, q.file, `applicants/${id}/requirements/${q.key}`, submitted, q.key.replace(/_/g, '-'));
          plan.actions.push(async (tx, ctx) => {
            const [r] = await tx.query(
              `insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, created_at, updated_at)
               values ($1, $2, 'qualification', 'accepted', $3, $4, $5, $6, $7, $5, $7) returning id`,
              [id, q.key, JSON.stringify(data), actors.salesId, iso(submitted), actors.adminId, iso(accepted)],
            );
            c.owner_id = Number(r.id);
            ctx.audit.push(['requirement', r.id, { requirement_key: q.key, status: 'accepted', submitted_at: iso(submitted), reviewed_at: iso(accepted) }]);
          });
        });
      }
    }

    // ---- Scheduling: Orientation/Tasting and Training proofs, verified ----
    const ws = win('scheduled');
    const acts = await db.query(
      `select s.*, p.admin_attended_at as p_admin from activity_schedules s left join schedule_session_participants p on p.activity_schedule_id = s.id
       where s.applicant_id = $1 and s.activity_type in ('orientation', 'training') and s.status = 'completed' order by s.id`, [id],
    );
    let brandLockAt: number | null = null;
    for (const r of acts) {
      if (r.completion_submitted_at) continue;
      const files = r.activity_type === 'orientation' ? [['attendance_proof', 'proof', 'attendance-1'], ['attendance_proof', 'proof', 'attendance-2'], ['brand_selection', 'brand', 'brand-selection']] : [['attendance_proof', 'proof', 'attendance']];
      const submitted = new Date(r.completed_at).getTime();
      const recorded = r.p_admin ? new Date(r.p_admin).getTime() : 0;
      const verified = Math.max(recorded, submitted + 10 * SEC);
      const viewed = submitted + 5 * SEC;
      const fits = Boolean(ws) && submitted > ws![0] && verified < ws![1];
      const kind = r.activity_type === 'orientation' ? 'Orientation/Tasting' : 'Training';
      if (!add({ stage: 'Scheduling', window: label(ws), item: `${kind} #${r.id}: proof${r.activity_type === 'orientation' ? ' + brand document, selected brand' : ''}, Sales submitted + Admin verified, viewed rows`,
        at: [iso(submitted)!, iso(verified)!], records: 'activity + seat updated', files: files.length, fits,
        why: fits ? undefined : `submitted ${iso(submitted)} / verified ${iso(verified)} fall outside the Scheduling window` })) continue;
      if (r.activity_type === 'orientation') brandLockAt = verified;
      const copies = files.map(([type, folder, name]) => copy(MODELS.activity, Number(r.id), type, `activities/${r.id}/${folder}`, submitted, name));
      plan.actions.push(async (tx, ctx) => {
        await tx.query(
          `update activity_schedules set attended = true, handler_name = coalesce(handler_name, $2), result_notes = coalesce(nullif(result_notes, ''), $3),
             completion_submitted_at = completed_at, completion_submitted_by_user_id = $4, review_status = 'accepted', reviewed_at = $5, reviewed_by_user_id = $6,
             selected_brand_id = case when activity_type = 'orientation' then coalesce(selected_brand_id, $7) else selected_brand_id end where id = $1`,
          [r.id, actors.salesName, NOTE, actors.salesId, iso(verified), actors.adminId, a.inquiry_brand_id ?? a.preferred_brand_id],
        );
        await tx.query(`update schedule_session_participants set sales_completed_by = coalesce(sales_completed_by, $2), admin_attended_at = $3, admin_attended_by = $4, admin_attended_by_name = $5, attendance_status = 'attended' where activity_schedule_id = $1`,
          [r.id, actors.salesId, iso(verified), actors.adminId, actors.adminName]);
        ctx.views.push(...copies.map((c) => ({ copy: c, at: iso(viewed)! })));
        ctx.audit.push(['activity', r.id, { review_status: 'accepted', completion_submitted_at: iso(submitted), reviewed_at: iso(verified), files: copies.length }]);
        const key = r.activity_type === 'orientation' ? 'orientation_attended' : 'training_completed';
        ctx.details[key] = { on: new Date(verified + 8 * 3600e3).toISOString().slice(0, 16), by: `${actors.adminName} (Admin)`, by_user_id: actors.adminId };
      });
    }
    if (brandLockAt && !a.brand_locked_at) {
      plan.actions.push(async (tx) => {
        await tx.query(`update applicants set brand_locked_at = $2, brand_locked_by_user_id = $3, inquiry_brand_id = coalesce(inquiry_brand_id, preferred_brand_id) where id = $1`, [id, iso(brandLockAt), actors.adminId]);
      });
    }

    // ---- LOI: Proposed site, and the LOI file if there is none ----
    const wl = win('loi_submitted');
    const [loiFile] = await db.query(`select id from documents where documentable_type = $1 and documentable_id = $2 and type = 'loi' and removed_at is null limit 1`, [MODELS.applicant, id]);
    const needSite = !reqs.some((r: Row) => r.requirement_key === 'proposed_site');
    const needComplete = a.loi_status !== 'complete';
    const loiEvents = (needSite ? 2 : 0) + (loiFile ? 0 : 1) + (needComplete ? 1 : 0);
    if (loiEvents) {
      const times = wl ? spread(wl[0], wl[1], loiEvents) : null;
      const what = [loiFile ? null : 'LOI file', needSite ? 'Proposed site (address, leased, 1 photo; submitted + accepted)' : null, needComplete ? 'LOI status complete' : null].filter(Boolean).join(' + ');
      if (add({ stage: 'LOI Submission', window: label(wl), item: what, at: times ? [iso(times[0])!, iso(times.at(-1))!] : [], records: needSite ? '1 requirement row' : '—',
        files: (needSite ? 1 : 0) + (loiFile ? 0 : 1), fits: Boolean(times), why: times ? undefined : 'the LOI window is too short' }) && times) {
        let k = 0;
        if (!loiFile) {
          const at = times[k++];
          const c = copy(MODELS.applicant, id, 'loi', `applicants/${id}/loi`, at, 'loi');
          plan.actions.push(async (_tx, ctx) => { ctx.audit.push(['applicant', id, { loi_file: c.name, uploaded_at: c.at }]); });
        }
        if (needSite) {
          const submitted = times[k++];
          const accepted = times[k++];
          const c = copy(MODELS.requirement, null, 'site_photos', `applicants/${id}/requirements/proposed_site`, submitted, 'site-photo');
          plan.actions.push(async (tx, ctx) => {
            const [r] = await tx.query(
              `insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, created_at, updated_at)
               values ($1, 'proposed_site', 'loi', 'accepted', $2, $3, $4, $5, $6, $4, $6) returning id`,
              [id, JSON.stringify({ address: `Sample site for ${a.full_name}, Quezon City (test data)`, ownership: 'leased' }), actors.salesId, iso(submitted), actors.adminId, iso(accepted)],
            );
            c.owner_id = Number(r.id);
            ctx.audit.push(['requirement', r.id, { requirement_key: 'proposed_site', status: 'accepted', submitted_at: iso(submitted), reviewed_at: iso(accepted) }]);
          });
        }
        if (needComplete) {
          const completedAt = times[k++];
          plan.actions.push(async (tx, ctx) => {
            await tx.query(`update applicants set loi_status = 'complete', loi_completed_at = $2, loi_completed_by_user_id = $3 where id = $1`, [id, iso(completedAt), actors.adminId]);
            ctx.audit.push(['applicant', id, { loi_status: 'complete', loi_completed_at: iso(completedAt), previous_loi_status: a.loi_status ?? null }]);
          });
        }
      }
    }

    // ---- Payment Record: required payments for the existing verified entries, OR numbers, receipts ----
    const wp = win('payment_submitted');
    const entries = await db.query(`select * from payments where applicant_id = $1 and status = 'verified' order by created_at, id`, [id]);
    const [required] = await db.query(`select count(*)::int as n from applicant_required_payments where applicant_id = $1 and removed_at is null`, [id]);
    if (entries.length && !required.n) {
      const first = new Date(entries[0].created_at).getTime();
      const setupAt = wp ? wp[0] + Math.floor((first - wp[0]) / 2) : NaN;
      const inside = Boolean(wp) && setupAt > wp![0] && setupAt < first && entries.every((e: Row) => new Date(e.created_at).getTime() > wp![0] && new Date(e.verified_at ?? e.created_at).getTime() < wp![1]);
      // The "Downpayment + Balance" preset: the earlier entry is the Downpayment, the later one the Balance.
      const PRESET = ['Downpayment', 'Balance'];
      const names = entries.map((_e: Row, i: number) => PRESET[i] ?? `Payment ${i + 1}`);
      const [existingPlan] = await db.query(`select id, payment_plan_preset from applicant_payment_plans where applicant_id = $1 order by id limit 1`, [id]);
      if (entries.length > PRESET.length) add({ stage: 'Payment Record', window: label(wp), item: 'Downpayment + Balance preset', at: [], records: '—', files: 0, fits: false, why: `${entries.length} verified entries for a 2-item preset` });
      if (add({ stage: 'Payment Record', window: label(wp), item: `Preset "Downpayment + Balance" set up; entries ${entries.map((e: Row, i: number) => `#${e.id} (${String(e.payment_type).replace(/_/g, ' ')}, ${iso(e.created_at)!.slice(11, 19)}Z) -> ${names[i]}`).join(', ')}; each gets an OR/AR number, method Cash and a receipt image`,
        at: [iso(setupAt) ?? '—', iso(entries.at(-1).created_at)!], records: `${existingPlan ? 'payment plan updated' : 'payment plan created'}; ${entries.length} required payments; ${entries.length} entries updated (amounts unchanged)`, files: entries.length, fits: inside && entries.length <= PRESET.length,
        why: inside ? undefined : 'an entry or the setup time falls outside the Payment Record window' }) && inside) {
        entries.forEach((e: Row, i: number) => copy(MODELS.payment, Number(e.id), 'payment_receipt', `applicants/${id}/payments`, new Date(e.created_at).getTime(), `receipt-${i + 1}`));
        plan.actions.push(async (tx, ctx) => {
          const planFields = [iso(setupAt), actors.adminId];
          if (existingPlan) await tx.query(`update applicant_payment_plans set payment_plan_preset = 'downpayment_balance', required_set_at = $2, required_set_by_user_id = $3 where id = $1`, [existingPlan.id, ...planFields]);
          else await tx.query(`insert into applicant_payment_plans (applicant_id, payment_plan_preset, required_set_at, required_set_by_user_id, created_at, updated_at) values ($1, 'downpayment_balance', $2, $3, $2, $2)`, [id, ...planFields]);
          ctx.audit.push(['applicant', id, { payment_plan_preset: 'downpayment_balance', previous_preset: existingPlan?.payment_plan_preset ?? null, required_set_at: iso(setupAt) }]);
          for (const [i, e] of entries.entries()) {
            const [rp] = await tx.query(
              `insert into applicant_required_payments (applicant_id, name, position, created_by_user_id, created_at, updated_at) values ($1, $2, $3, $4, $5, $5) returning id`,
              [id, names[i], i + 1, actors.adminId, iso(setupAt)],
            );
            const or = `OR-SAMPLE-${String(id).padStart(4, '0')}-${i + 1}`;
            await tx.query(`update payments set required_payment_id = $2, or_number = coalesce(or_number, $3), payment_method = coalesce(payment_method, 'cash'), remarks = coalesce(remarks, $4) where id = $1`,
              [e.id, rp.id, or, NOTE]);
            ctx.audit.push(['payment', e.id, { required_payment_id: Number(rp.id), required_payment: names[i], or_number: or, payment_method: 'cash' }]);
          }
        });
      }
    } else if (!entries.length) {
      add({ stage: 'Payment Record', window: label(wp), item: 'Required payments + entries', at: [], records: '—', files: 0, fits: false, why: 'no existing verified payment entries to attach to' });
    }
  }
  for (const plan of plans) {
    if (plan.refused) continue;
    const id = plan.id;
    const [have] = await db.query(`select 1 from applicant_requirements where applicant_id = $1 and requirement_key = 'franchise_agreement'`, [id]);
    if (have) continue;
    const hist = await db.query(`select from_status, to_status, created_at from applicant_status_histories where applicant_id = $1 order by created_at, id`, [id]);
    const from = hist.find((h: Row) => h.to_status === 'approved')?.created_at;
    const to = hist.find((h: Row) => h.from_status === 'approved' && h.to_status === 'active_franchisee')?.created_at;
    const w: [number, number] | null = from && to ? [new Date(from).getTime(), new Date(to).getTime()] : null;
    const times = w ? spread(w[0], w[1], 2) : null;
    plan.items.push({ stage: 'Approved', window: w ? [iso(w[0])!, iso(w[1])!] : null, item: 'Signed franchise agreement (submitted + accepted)', at: times ? [iso(times[0])!, iso(times[1])!] : [],
      records: '1 requirement row', files: 1, fits: Boolean(times), why: times ? undefined : 'no Approved → Active Franchisee window' });
    if (!times) continue;
    const src = images[next++ % images.length];
    const ext = String(src.original_name).split('.').pop()?.toLowerCase() || 'png';
    const stored = `${crypto.randomUUID()}.${ext}`;
    const c: Copy = { source: src, owner: MODELS.requirement, owner_id: null, type: 'agreement', path: `applicants/${id}/requirements/franchise_agreement/${stored}`, stored_name: stored, at: iso(times[0])!, name: `sample-franchise-agreement.${ext}` };
    plan.copies.push(c);
    plan.actions.push(async (tx, ctx) => {
      const [r] = await tx.query(
        `insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, created_at, updated_at)
         values ($1, 'franchise_agreement', 'activation', 'accepted', '{}'::jsonb, $2, $3, $4, $5, $3, $5) returning id`,
        [id, actors.salesId, iso(times[0]), actors.adminId, iso(times[1])],
      );
      c.owner_id = Number(r.id);
      ctx.audit.push(['requirement', r.id, { requirement_key: 'franchise_agreement', status: 'accepted', submitted_at: iso(times[0]), reviewed_at: iso(times[1]) }]);
    });
  }
  if (!apply) return plans;
  if (plans.some((p) => p.refused || p.items.some((i) => !i.fits))) throw new Error('Refused or not-fitting items: nothing applied.');
  if (!files) throw new Error('Apply needs the storage client.');

  const copied: string[] = [];
  try {
    for (const p of plans) for (const c of p.copies) { await files.copy(c.source.path, c.path); copied.push(c.path); }
    await db.tx(async (tx) => {
      for (const p of plans) {
        const ctx: Row = { audit: [] as unknown[], views: [] as Row[], details: {} as Row };
        for (const action of p.actions) await action(tx, ctx);
        const docIds: number[] = [];
        for (const c of p.copies) {
          const [d] = await tx.query(
            `insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, mime_type, size_bytes, uploaded_by_user_id, metadata, created_at, updated_at)
             values ($1, $2, $3, $4, $5, 'private', $6, $7, $8, $9, $10, $11, $11) returning id`,
            [c.owner, c.owner_id, c.type, c.name, c.stored_name, c.path, c.source.mime_type, c.source.size_bytes, c.type === 'loi' ? actors.adminId : actors.salesId,
              JSON.stringify({ sample_test_data: true, copied_from_document_id: Number(c.source.id) }), c.at],
          );
          docIds.push(Number(d.id));
          const view = ctx.views.find((v: Row) => v.copy === c);
          if (view) await tx.query(`insert into activity_document_views (document_id, user_id, first_viewed_at, last_viewed_at) values ($1, $2, $3, $3) on conflict do nothing`, [d.id, actors.adminId, view.at]);
        }
        if (Object.keys(ctx.details).length) {
          const [a] = await tx.query(`select milestone_details from applicants where id = $1 for update`, [p.id]);
          await tx.query(`update applicants set milestone_details = $2 where id = $1`, [p.id, JSON.stringify({ ...(a.milestone_details ?? {}), ...ctx.details })]);
        }
        const model: Record<string, string> = MODELS;
        for (const [kind, rowId, values] of ctx.audit as [string, number, Row][]) {
          await tx.query(
            `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.sample_records_backfilled', $1, $2, $3, $4, now())`,
            [model[kind], rowId, JSON.stringify({ missing: true }), JSON.stringify({ ...values, applicant_id: p.id, note: 'Sample/test data; stage and activity times not changed.', script: 'fill_missing_records' })],
          );
        }
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.sample_records_backfilled', $1, $2, $3, $4, now())`,
          [MODELS.applicant, p.id, JSON.stringify({}), JSON.stringify({ document_ids: docIds, copied_from: p.copies.map((c) => Number(c.source.id)), note: 'Sample/test data files copied from existing uploads.', script: 'fill_missing_records' })],
        );
      }
    });
  } catch (error) {
    if (copied.length) await files.remove(copied).catch(() => {});
    throw error;
  }
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/fill_missing_records.ts'));
if (isMain) {
  const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1];
  const ids = String(arg('ids') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const apply = process.argv.includes('--apply');
  if (!ids.length || apply === process.argv.includes('--dry-run')) { console.error('Usage: --ids=6,9 and exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readEnv, readOnly } = await import('./lib/scriptDb.ts');
  const env = await readEnv();
  const db = await openScriptDb();
  const local = (d: string | null) => (d ? new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') : '—');
  try {
    const [sales] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where u.id = 3 and r.name = 'sales'`);
    const [admin] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where r.name = 'admin' and u.account_status = 'active' order by u.id limit 1`);
    const actors = { salesId: Number(sales.id), salesName: sales.full_name, adminId: Number(admin.id), adminName: admin.full_name };
    let files: Files | undefined;
    if (apply) {
      const { createClient } = await import('@supabase/supabase-js');
      const storage = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from('private');
      files = {
        copy: async (from, to) => { const { error } = await storage.copy(from, to); if (error) throw new Error(`storage copy ${from}: ${error.message}`); },
        remove: async (paths) => { await storage.remove(paths); },
      };
    }
    const plans = apply ? await fillMissingRecords(db, ids, actors, true, files) : await readOnly(db, (tx) => fillMissingRecords(tx, ids, actors, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)', `· submitted by ${actors.salesName} (#${actors.salesId}) · accepted/verified by ${actors.adminName} (#${actors.adminId})`);
    for (const p of plans) {
      console.log(`\n${p.code} ${p.name}${p.refused ? ` — REFUSED: ${p.refused}` : ''}`);
      console.table(p.items.map((i) => ({
        stage: i.stage, window: i.window ? `${local(i.window[0])} → ${local(i.window[1]).slice(11)}` : '—', item: i.item,
        when: i.at.length ? `${local(i.at[0]).slice(11)}${i.at[1] && i.at[1] !== i.at[0] ? ` → ${local(i.at[1]).slice(11)}` : ''}` : '—', records: i.records, files: i.files,
        fits: i.fits ? 'yes' : `NO: ${i.why}`,
      })));
      console.log(`  sample files: ${p.copies.length} copies (${[...new Set(p.copies.map((c) => `#${c.source.id}`))].join(', ')})`);
    }
  } finally {
    await db.close();
  }
}
