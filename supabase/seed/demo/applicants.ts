// Inquiries, applicants and their schedules. Each applicant is built along the pipeline the way the
// API would have recorded it: requirements with files (opened by Admin before Accept), stage moves
// with their status and action history, Orientation/Tasting and Training in Master Schedule
// sessions, the LOI with the Proposed site, the Payment Record, the approval and the activation.
import type { Db, Row } from './common.ts';
import { addDays, at, Batch, daysBetween, Ids, isWeekday, LAST_DAY, MODELS, nextWeekday, plusMinutes, prevWeekday, rng } from './common.ts';
import { ACTIVE, BRAND_NAMES, type BrandKey, LEADS, type Person, PIPELINE } from './people.ts';

type Docs = Record<string, { path: string; name: string; mime: string; size: number }>;
export interface PeopleContext { db: Db; ids: Ids; batch: Batch; docs: Docs; users: { admin: Row; sales: Row; herald: Row; marketing: Row }; brands: Record<BrandKey, number> }

const ADMIN_NAME = 'ADMIN (Admin)';
const ID_TYPES = ['national_id', 'drivers_license', 'passport', 'umid', 'prc'];
const RANGES = ['500k_1m', '1m_2m', '1m_2m', 'above_2m'];
const PRESETS: Record<string, string[]> = { reservation_full: ['Reservation Fee', 'Full Payment'], downpayment_balance: ['Downpayment', 'Balance'], full: ['Full Payment'] };
const METHODS = ['bank_transfer', 'gcash', 'cash', 'check'];

export async function writePeople(ctx: PeopleContext) {
  const { db, ids, batch, docs, users, brands } = ctx;
  const { admin, marketing } = users;
  const r = rng('people');
  const salesOf = (p: Person) => (p.sales === 'H' ? users.herald : users.sales);
  const place = new Map<string, Row>();
  async function psgc(city: string, barangay: string) {
    const key = city;
    if (!place.has(key)) {
      const [row] = await db.query(
        `select c.code as city_code, c.name as city, p.code as province_code, p.name as province from psgc_cities c join psgc_provinces p on p.code = c.province_code
         where c.name ilike $1 order by (c.name ilike $2) desc, (c.name ilike $3) desc, length(c.name) limit 1`, [`%${city}%`, `City of ${city}`, `${city} City`],
      );
      if (!row) throw new Error(`PSGC city not found: ${city}`);
      place.set(key, row);
    }
    const c = place.get(key)!;
    return { city: c.city, street: null, barangay, province: c.province, city_code: c.city_code, province_code: c.province_code };
  }
  const office = (day: string, hhmm: string) => at(isWeekday(day) ? day : nextWeekday(day), hhmm);
  const later = (d: Date, minutes: number) => plusMinutes(d, minutes);
  const phoneOf = (i: number) => `09${String(17 + (i % 3) * 10)}${String(4100000 + i * 7307).slice(-7)}`;
  const emailOf = (p: Person) => `${p.first.split(' ')[0]}.${p.last.replace(/\s+/g, '')}@gmail.com`.toLowerCase().replace('ñ', 'n');
  let seq = 0;

  // ---------------------------------------------------------------- shared writers
  async function doc(ownerType: string, ownerId: number, type: string, file: string, name: string, uploader: number, when: Date, meta: Row | null = null) {
    const f = docs[file];
    const id = await ids.next('documents');
    batch.add('documents', { id, documentable_type: ownerType, documentable_id: ownerId, type, original_name: name, stored_name: f.path.split('/').pop(), disk: 'private', path: f.path, mime_type: f.mime, size_bytes: f.size, uploaded_by_user_id: uploader, metadata: { sample_demo_data: true, ...(meta ?? {}) }, created_at: when, updated_at: when });
    return id;
  }
  const view = (documentId: number, when: Date) => batch.add('activity_document_views', { document_id: documentId, user_id: admin.id, first_viewed_at: when, last_viewed_at: when });
  const ref = (id: number, name: string, type: string) => ({ document_id: id, original_name: name, type });
  async function stage(a: Row, from: string | null, to: string, when: Date, actor: Row, remarks: string | null, extra: { event?: string | null; step?: string | null; old?: Row | null; new?: Row | null; files?: Row[] | null; context?: Row | null } = {}) {
    batch.add('applicant_stage_histories', {
      id: await ids.next('applicant_stage_histories'), applicant_id: a.id, from_stage: from, to_stage: to, remarks, changed_by_user_id: actor.id, changed_at: when, created_at: when, updated_at: when,
      event: extra.event ?? null, context: extra.context ?? null, step: extra.step ?? (extra.event ?? (from === to ? null : 'stage_change')), old_values: extra.old ?? null, new_values: extra.new ?? null,
      attachments: extra.files?.length ? extra.files : null, actor_role: actor.role_name,
    });
  }
  const event = (a: Row, name: string, when: Date, actor: Row, remarks: string | null, extra: { step?: string; old?: Row | null; new?: Row | null; files?: Row[] | null; context?: Row | null } = {}) =>
    stage(a, a.status, a.status, when, actor, remarks, { event: name, ...extra });
  async function move(a: Row, to: string, when: Date, actor: Row, remarks: string, action: string, fields: Row = {}) {
    batch.add('applicant_status_histories', { id: await ids.next('applicant_status_histories'), applicant_id: a.id, from_status: a.status, to_status: to, remarks, changed_by_user_id: actor.id, created_at: when, updated_at: when });
    await stage(a, a.status, to, when, actor, remarks, { step: action, old: { status: a.status }, new: { status: to } });
    Object.assign(a, { status: to, updated_at: when }, fields);
  }
  const milestone = (a: Row, key: string, when: Date, by = ADMIN_NAME) => {
    a.milestones = { ...(a.milestones ?? {}), [key]: true };
    a.milestone_details = { ...(a.milestone_details ?? {}), [key]: { on: new Date(when.getTime() + 8 * 3_600_000).toISOString().slice(0, 16), by, by_user_id: admin.id } };
  };

  // ---------------------------------------------------------------- inquiry
  async function inquiry(p: Person, status: string, extra: Row = {}) {
    const id = await ids.next('franchise_inquiries');
    const created = at(p.inquiry, r.time('09:10', '16:40'));
    const residence = await psgc(p.city, p.barangay);
    const row: Row = {
      id, lead_name: `${p.first} ${p.last}`, first_name: p.first, last_name: p.last, email: emailOf(p), phone: phoneOf(++seq), source: p.source, preferred_brand_id: brands[p.brand], status,
      remarks: `Interested in a ${BRAND_NAMES[p.brand]} franchise in ${residence.city}.`, encoded_by_user_id: marketing.id, inquiry_date: p.inquiry, created_at: created, updated_at: created,
      status_changed_at: created, lead_code: `LD-${p.inquiry.slice(0, 4)}-${String(id).padStart(5, '0')}`, residence_location: residence, preferred_location: residence,
      current_city: residence.city, preferred_franchise_location: `${residence.city}, ${residence.province}`, no_preferred_location: false, viber_number: p.source === 'viber' ? phoneOf(seq) : null, ...extra,
    };
    batch.add('franchise_inquiries', row);
    return row;
  }

  // ---------------------------------------------------------------- applicant phases
  async function convert(p: Person, existing: Row | null) {
    const sales = salesOf(p);
    const inq = await inquiry(p, 'converted', {});
    const endorsed = office(addDays(p.inquiry, 1), r.time('09:30', '11:30'));
    const converted = office(p.convert!, r.time('09:30', '11:00'));
    Object.assign(inq, { endorsed_to_user_id: admin.id, endorsed_by_user_id: marketing.id, converted_from_status: 'endorsed', status_changed_at: converted, updated_at: converted });
    const id = existing?.id ?? await ids.next('applicants');
    const a: Row = {
      ...(existing ?? {}), id, inquiry_id: inq.id, preferred_brand_id: brands[p.brand], inquiry_brand_id: brands[p.brand], full_name: `${p.first} ${p.last}`, email: existing?.email ?? inq.email, phone: inq.phone,
      address: null, status: 'converted', application_date: p.convert, notes: inq.remarks, created_at: converted, updated_at: converted, milestones: {}, milestone_details: {},
      assigned_sales_user_id: sales.id, assigned_sales_at: converted, assigned_sales_by_user_id: admin.id, residence_location: inq.residence_location, preferred_location: inq.preferred_location,
      no_preferred_location: false, applicant_code: existing?.applicant_code ?? `APL-${p.convert!.slice(0, 4)}-${String(id).padStart(5, '0')}`, archived_at: null, archived_by_user_id: null,
      other_fees: 0, loi_status: null, loi_verification_status: null, payment_stage_state: null, on_hold_until: null, on_hold_reason: null, on_hold_at: null, on_hold_by_user_id: null,
      approved_at: null, approved_by_user_id: null, rejected_at: null, reviewed_at: null, reviewed_by_user_id: null, review_remarks: null, brand_locked_at: null, brand_locked_by_user_id: null,
      loi_confirmed_at: null, loi_confirmed_by_user_id: null, loi_completed_at: null, loi_completed_by_user_id: null, loi_submission_date: null, loi_received_by: null, loi_submission_type: null,
      loi_returned_at: null, loi_returned_by_user_id: null, loi_return_reason: null, payment_confirmed_at: null, payment_confirmed_by_user_id: null, qualified_at: null, qualified_by_user_id: null, archive_reason: null,
    };
    batch.add('applicant_status_histories', { id: await ids.next('applicant_status_histories'), applicant_id: id, from_status: null, to_status: 'converted', remarks: 'Created from inquiry.', changed_by_user_id: admin.id, created_at: converted, updated_at: converted });
    await stage(a, null, 'converted', converted, admin, 'Created from inquiry.', { event: 'converted', step: 'conversion', context: { inquiry_id: inq.id, lead_code: inq.lead_code }, new: { status: 'converted', inquiry_id: inq.id, lead_code: inq.lead_code } });
    await stage(a, 'converted', 'converted', later(converted, 1), admin, `Assigned to ${sales.full_name}.`, { event: 'sales_assigned', step: 'assignment', old: { assigned_sales_user_id: null }, new: { assigned_sales_user_id: sales.id, assigned_sales: sales.full_name } });
    return { a, inq, converted };
  }

  const REQ: Record<string, { file: string; slot: string; data: (p: Person, a: Row, day: string) => Row }> = {
    application_form: { file: 'application_form', slot: 'form', data: () => ({}) },
    government_id: { file: 'valid_id', slot: 'id_copy', data: (_p, a) => ({ id_type: ID_TYPES[a.id % ID_TYPES.length], id_number: `${String(1000 + (a.id * 37) % 9000)}-${String(2000 + (a.id * 91) % 7000)}-${String(3000 + (a.id * 53) % 6000)}` }) },
    proof_of_funds: { file: 'bank_certificate', slot: 'bank_certificate', data: (_p, a) => ({ investment_range: RANGES[a.id % RANGES.length] }) },
    initial_interview: { file: 'interview_sheet', slot: 'interview_sheet', data: (p, _a, day) => ({ interview_date: day, interviewer: salesOf(p).full_name, notes: `Discussed the ${BRAND_NAMES[p.brand]} packages, the preferred area and the expected investment. The applicant has food-service experience and is ready to proceed.` }) },
  };
  /** One requirement: submitted by Sales (with its file), then Accepted or Returned by Admin, or left waiting. */
  async function requirement(p: Person, a: Row, key: string, stageName: string, submitted: Date, outcome: 'accepted' | 'submitted' | 'returned', data: Row, files: [string, string, string][]) {
    const sales = salesOf(p);
    const rid = await ids.next('applicant_requirements');
    const reviewed = later(submitted, 70 + (a.id % 50));
    const refs: Row[] = [];
    const docIds: number[] = [];
    for (const [file, slot, name] of files) { const d = await doc(MODELS.requirement, rid, slot, file, name, sales.id, submitted); refs.push(ref(d, name, slot)); docIds.push(d); }
    batch.add('applicant_requirements', {
      id: rid, applicant_id: a.id, requirement_key: key, stage: stageName, status: outcome, data, submitted_by_user_id: sales.id, submitted_at: submitted,
      reviewed_by_user_id: outcome === 'submitted' ? null : admin.id, reviewed_at: outcome === 'submitted' ? null : reviewed, return_reason: outcome === 'returned' ? 'The ID copy is blurred and the ID number cannot be read. Please upload a clearer copy.' : null,
      created_at: submitted, updated_at: outcome === 'submitted' ? submitted : reviewed,
    });
    await event(a, 'requirement_submitted', submitted, sales, null, { step: key, context: { requirement_key: key, requirement_id: rid }, old: { status: 'pending' }, new: { status: 'submitted', data }, files: refs });
    if (outcome !== 'submitted') {
      for (const d of docIds) view(d, later(reviewed, -8));
      await event(a, outcome === 'accepted' ? 'requirement_accepted' : 'requirement_returned', reviewed, admin, outcome === 'returned' ? 'The ID copy is blurred and the ID number cannot be read. Please upload a clearer copy.' : null,
        { step: key, context: { requirement_key: key, requirement_id: rid }, old: { status: 'submitted' }, new: { status: outcome } });
    }
    return reviewed;
  }
  async function qualification(p: Person, a: Row, mode: 'full' | 'missing' | 'waiting' | 'returned', from: string) {
    const keys = Object.keys(REQ);
    let day = from;
    let last = office(from, '10:00');
    for (const [i, key] of keys.entries()) {
      if (mode === 'missing' && i >= 2) break;
      day = i % 2 === 0 ? addDays(day, 1) : day;
      const submitted = office(day, r.time('09:20', '15:30'));
      const outcome = mode === 'waiting' && key === 'initial_interview' ? 'submitted' : mode === 'returned' && key === 'government_id' ? 'returned' : 'accepted';
      const def = REQ[key];
      const last2 = p.last.toLowerCase().replace(/\s+/g, '-');
      last = await requirement(p, a, key, 'qualification', submitted, outcome, def.data(p, a, prevWeekday(day)), [[def.file, def.slot, `${def.slot.replace(/_/g, '-')}-${last2}.png`]]);
    }
    if (mode !== 'full') return null;
    const when = office(addDays(nextWeekday(day), 1), r.time('09:30', '11:30'));
    for (const k of ['qualification_profile_reviewed', 'qualification_financial_capability_assessed', 'qualification_initial_interview_completed', 'qualification_preferred_location_evaluated', 'qualification_investment_understood']) milestone(a, k, when, `${admin.full_name} (Admin, requirements accepted)`);
    await move(a, 'qualified', when, admin, 'All four qualification requirements accepted.', 'applicant.qualified', { qualified_at: when, qualified_by_user_id: admin.id });
    void last;
    return when;
  }
  async function setSchedule(a: Row, when: Date) {
    await move(a, 'scheduled', when, admin, 'Set Schedule by Admin — Schedule Activity unlocked.', 'applicant.set_schedule');
  }

  // Master Schedule sessions shared by applicants with the same activity, start and handler.
  const sessions = new Map<string, Row>();
  async function session(type: string, start: Date, minutes: number, handler: Row, brandId: number | null, created: Date, status: string) {
    const key = `${type}|${start.toISOString()}|${handler.id}|${status === 'cancelled' ? Math.random() : ''}`;
    if (!sessions.has(key)) {
      const id = await ids.next('schedule_sessions');
      const row = { id, activity_type: type, brand_id: type === 'training' ? brandId : null, start_at: start, end_at: later(start, minutes), handler_id: handler.id, venue: 'Main Office (In-person)', status,
        merged_into_session_id: null, merge_suggested: false, max_capacity: type === 'training' ? 1 : 5, remarks: null, legacy_session_key: `session-${id}`, created_by: handler.id, created_at: created, updated_at: created };
      sessions.set(key, row);
      batch.add('schedule_sessions', row);
      batch.add('schedule_session_history', { id: await ids.next('schedule_session_history'), session_id: id, action: 'created', from_value: null, to_value: { status }, performed_by: handler.id, performed_by_role: 'sales', remarks: 'Session created.', created_at: created });
    }
    return sessions.get(key)!;
  }
  type Outcome = 'scheduled' | 'no_show' | 'submitted' | 'verified' | 'returned' | 'cancelled';
  /** One activity in a session. Completion is always after the session start; Admin verifies on a later office hour. */
  async function activity(p: Person, a: Row, type: 'orientation' | 'training', slot: [string, string, number], outcome: Outcome, scheduledOn: Date) {
    const sales = salesOf(p);
    // Training holds one applicant: move to the next weekday when that slot is already taken.
    while (type === 'training' && outcome !== 'cancelled' && [...sessions.values()].some((x) => x.activity_type === 'training' && x.handler_id === sales.id && x.status !== 'cancelled' && x.start_at.getTime() === at(slot[0], slot[1]).getTime())) {
      slot = [nextWeekday(addDays(slot[0], 1)), slot[1], slot[2]];
    }
    const start = at(slot[0], slot[1]);
    const end = later(start, slot[2]);
    const brand = brands[p.chose ?? p.brand];
    const sess = await session(type, start, slot[2], sales, type === 'training' ? brand : null, scheduledOn, outcome === 'cancelled' ? 'cancelled' : start < at(LAST_DAY, '17:00') && ['verified', 'no_show'].includes(outcome) ? 'completed' : 'confirmed');
    const id = await ids.next('activity_schedules');
    const label = type === 'orientation' ? 'Orientation/Tasting' : 'Training';
    const submittedAt = later(end, 25 + (a.id % 40));
    const reviewedAt = office(addDays(slot[0], 1), r.time('09:20', '11:00'));
    const row: Row = {
      id, applicant_id: a.id, activity_type: type, title: `${label} — ${a.full_name} (${slot[0]})`, starts_at: start, ends_at: end, venue: 'Main Office (In-person)', status: 'confirmed',
      assigned_to_user_id: sales.id, scheduled_by_user_id: sales.id, participants: [a.full_name], duration_minutes: slot[2], approval_status: 'immediate', session_key: `session-${sess.id}`,
      live_key: `${a.id}:${type}`, created_at: scheduledOn, updated_at: scheduledOn,
    };
    const part: Row = { id: await ids.next('schedule_session_participants'), session_id: sess.id, applicant_id: a.id, attendance_status: 'scheduled', activity_schedule_id: id, created_at: scheduledOn, updated_at: scheduledOn };
    await event(a, 'schedule_created', scheduledOn, sales, `${label} scheduled for ${slot[0]} ${slot[1]}.`, { step: type, new: { activity_id: id, starts_at: start, session_id: sess.id } });
    if (outcome === 'cancelled') {
      const when = later(scheduledOn, 60 * 26);
      Object.assign(row, { status: 'cancelled', cancelled_at: when, live_key: null, updated_at: when });
      Object.assign(part, { attendance_status: 'cancelled', updated_at: when });
      await event(a, 'schedule_cancelled', when, admin, 'The applicant asked to move the session to a later date.', { step: type });
    } else if (outcome === 'no_show') {
      Object.assign(row, { status: 'no_show', attended: false, no_show_reason: 'The applicant did not arrive and could not be reached by phone.', completion_submitted_at: submittedAt, completion_submitted_by_user_id: sales.id, review_status: 'submitted', live_key: null, result_notes: null, updated_at: submittedAt });
      Object.assign(part, { attendance_status: 'no_show', sales_completed_by: sales.id, sales_completed_at: submittedAt, updated_at: submittedAt });
      await event(a, 'activity_no_show', submittedAt, sales, 'The applicant did not arrive and could not be reached by phone.', { step: type });
    } else if (outcome !== 'scheduled') {
      const files: Row[] = [];
      const last = a.full_name.split(' ').pop()!.toLowerCase();
      const att = await doc(MODELS.activity, id, 'attendance_proof', 'attendance', `attendance-sheet-${slot[0]}-${last}.png`, sales.id, submittedAt);
      files.push(ref(att, `attendance-sheet-${slot[0]}-${last}.png`, 'attendance_proof'));
      if (type === 'orientation') { const bs = await doc(MODELS.activity, id, 'brand_selection', 'brand_selection', `brand-selection-${last}.png`, sales.id, submittedAt); files.push(ref(bs, `brand-selection-${last}.png`, 'brand_selection')); }
      Object.assign(row, {
        status: 'completed', attended: true, actual_started_at: later(start, 5), handler_name: sales.full_name, completed_at: submittedAt, completion_submitted_at: submittedAt, completion_submitted_by_user_id: sales.id,
        result_notes: type === 'orientation' ? `Attended the full orientation and tasted the ${BRAND_NAMES[p.brand]} menu. Chose ${BRAND_NAMES[p.chose ?? p.brand]}.` : 'Completed the full training: recipes, equipment, hygiene and daily inventory recording.',
        review_status: 'submitted', selected_brand_id: type === 'orientation' ? brand : null, tasted_brand_id: type === 'training' ? brand : null, updated_at: submittedAt,
      });
      Object.assign(part, { attendance_status: 'completed', sales_completed_by: sales.id, sales_completed_at: submittedAt, updated_at: submittedAt });
      await event(a, 'activity_completed', submittedAt, sales, `${label} marked Complete.`, { step: type, new: { status: 'completed', attended: true }, files });
      if (outcome === 'verified') {
        for (const f of files) view(f.document_id, later(reviewedAt, -6));
        Object.assign(row, { review_status: 'accepted', reviewed_by_user_id: admin.id, reviewed_at: reviewedAt, updated_at: reviewedAt });
        Object.assign(part, { attendance_status: 'attended', admin_attended_by: admin.id, admin_attended_by_name: admin.full_name, admin_attended_at: reviewedAt, updated_at: reviewedAt });
        milestone(a, type === 'orientation' ? 'orientation_attended' : 'training_completed', reviewedAt);
        if (type === 'orientation') Object.assign(a, { brand_locked_at: reviewedAt, brand_locked_by_user_id: admin.id, preferred_brand_id: brand });
        await event(a, 'activity_attended', reviewedAt, admin, type === 'orientation' ? 'Orientation/Tasting verified: files opened, brand locked.' : 'Training marked Attended.', { step: type, old: { review_status: 'submitted' }, new: { review_status: 'accepted' } });
      } else if (outcome === 'returned') {
        const reason = 'The brand selection form is not signed by the applicant. Please upload the signed form.';
        Object.assign(row, { status: 'confirmed', completed_at: null, review_status: 'returned', reviewed_by_user_id: admin.id, reviewed_at: reviewedAt, return_reason: reason, updated_at: reviewedAt });
        Object.assign(part, { attendance_status: 'scheduled', updated_at: reviewedAt });
        await event(a, 'activity_returned', reviewedAt, admin, reason, { step: type, new: { status: 'confirmed', review_status: 'returned' } });
      }
    }
    batch.add('activity_schedules', row);
    batch.add('schedule_session_participants', part);
    return reviewedAt;
  }

  async function loi(p: Person, a: Row, from: Date, mode: 'empty' | 'site_waiting' | 'returned' | 'complete') {
    const sales = salesOf(p);
    await move(a, 'loi_submitted', from, admin, 'Signed LOI received at the office.', 'applicant.status_changed', { loi_confirmed_at: from, loi_confirmed_by_user_id: admin.id, loi_remarks: 'Signed LOI received at the office.', loi_verification_status: 'not_verified' });
    if (mode === 'empty') return from;
    const day = addDays(from.toISOString().slice(0, 10), 2);
    const uploaded = office(day, r.time('09:30', '15:00'));
    const last = a.full_name.split(' ').pop()!.toLowerCase();
    const scan = await doc(MODELS.applicant, a.id, 'loi', 'loi', `signed-loi-${last}.png`, sales.id, uploaded, { submission_date: uploaded.toISOString().slice(0, 10) });
    Object.assign(a, { loi_submission_date: prevWeekday(day), loi_received_by: sales.full_name, loi_submission_type: 'physical' });
    await event(a, 'loi_uploaded', uploaded, sales, null, { step: 'loi', new: { loi_submission_date: prevWeekday(day), loi_received_by: sales.full_name, loi_submission_type: 'physical' }, files: [ref(scan, `signed-loi-${last}.png`, 'loi')] });
    // The Proposed site, at the same stage.
    const site = await psgc(p.city, p.barangay);
    const siteData = { location: site, address: `${site.barangay}, ${site.city}, ${site.province}`, ownership: a.id % 3 === 0 ? 'owned' : 'leased' };
    const siteAt = later(uploaded, 45);
    const siteOutcome = mode === 'complete' ? 'accepted' : 'submitted';
    if (mode !== 'returned') await requirement(p, a, 'proposed_site', 'loi', siteAt, siteOutcome, siteData, [['site_front', 'site_photos', `site-front-${last}.jpg`], ['site_street', 'site_photos', `site-street-${last}.jpg`]]);
    if (mode === 'returned') {
      const back = office(addDays(day, 1), '10:15');
      view(scan, later(back, -5));
      Object.assign(a, { loi_returned_at: back, loi_returned_by_user_id: admin.id, loi_return_reason: 'The scan is cut off at the bottom: the signature and date are missing.' });
      await event(a, 'loi_returned', back, admin, 'The scan is cut off at the bottom: the signature and date are missing.', { step: 'loi', old: { loi_verification_status: 'not_verified', requirement: 'submitted' }, new: { loi_verification_status: 'not_verified', requirement: 'returned' } });
      return back;
    }
    if (mode === 'site_waiting') return siteAt;
    const verified = office(addDays(day, 1), r.time('09:30', '11:00'));
    view(scan, later(verified, -4));
    a.loi_verification_status = 'verified';
    await event(a, 'loi_verification_changed', verified, admin, null, { step: 'loi', old: { loi_verification_status: 'not_verified' }, new: { loi_verification_status: 'verified' } });
    const done = later(verified, 50);
    await move(a, 'payment_submitted', done, admin, 'LOI verified and confirmed by Admin.', 'applicant.loi_completed', { payment_stage_state: 'waiting_total', loi_status: 'complete', loi_completed_at: done, loi_completed_by_user_id: admin.id });
    await event(a, 'loi_completed', later(done, 1), admin, 'LOI Complete.', { step: 'loi', context: { submission_type: 'physical' } });
    return done;
  }

  async function payments(p: Person, a: Row, from: Date, mode: 'none_set' | 'none' | 'none_rejected' | 'one_of_two' | 'waiting' | 'all') {
    if (mode === 'none_set') return from;
    const sales = salesOf(p);
    const preset = ['reservation_full', 'downpayment_balance', 'full'][a.id % 3];
    const names = PRESETS[preset];
    const setAt = later(from, 60 * 20);
    batch.add('applicant_payment_plans', { id: await ids.next('applicant_payment_plans'), applicant_id: a.id, payment_plan_preset: preset, basis_note: `${BRAND_NAMES[p.chose ?? p.brand]} kiosk package, per signed LOI`, required_set_at: setAt, required_set_by_user_id: admin.id, other_fees: 0, created_at: setAt, updated_at: setAt });
    const items: Row[] = [];
    for (const [i, name] of names.entries()) {
      const rid = await ids.next('applicant_required_payments');
      items.push({ id: rid, name });
      batch.add('applicant_required_payments', { id: rid, applicant_id: a.id, name, position: i + 1, created_by_user_id: admin.id, created_at: setAt, updated_at: setAt });
    }
    await event(a, 'payment_required_updated', setAt, admin, null, { step: 'payment_record', new: { preset, required: names } });
    const paid = mode === 'all' ? items.length : mode === 'one_of_two' || mode === 'waiting' ? Math.min(items.length, mode === 'waiting' ? items.length : 1) : mode === 'none_rejected' ? 1 : 0;
    let last = setAt;
    for (const [i, item] of items.slice(0, paid).entries()) {
      const day = addDays(setAt.toISOString().slice(0, 10), 3 + i * 6);
      const recorded = office(day, r.time('09:30', '15:30'));
      const pid = await ids.next('payments');
      const method = METHODS[(a.id + i) % METHODS.length];
      const waiting = mode === 'waiting' && i === paid - 1;
      const rejected = mode === 'none_rejected';
      const verifiedAt = office(addDays(day, 1), r.time('09:20', '11:30'));
      const receiptName = `receipt-${item.name.toLowerCase().replace(/\s+/g, '-')}-${a.applicant_code}.png`;
      const receipt = await doc(MODELS.payment, pid, 'payment_receipt', 'receipt', receiptName, sales.id, recorded);
      batch.add('payments', {
        id: pid, applicant_id: a.id, payment_type: item.name.toLowerCase().replace(/\s+/g, '_'), amount: null, payment_date: prevWeekday(addDays(day, -1)), status: waiting ? 'pending' : rejected ? 'returned' : 'verified',
        recorded_by_user_id: sales.id, verified_by_user_id: waiting || rejected ? null : admin.id, verified_at: waiting || rejected ? null : verifiedAt, remarks: null, department: 'Sales', requested_at: recorded,
        payment_method: method, or_number: `OR-${a.id}${String(100 + i)}`, reference_number: method === 'cash' ? null : `${method === 'gcash' ? 'GC' : method === 'check' ? 'CHK' : 'BT'}-${a.id}${String(7700 + i * 13)}`,
        required_payment_id: item.id, revision: 1, created_at: recorded, updated_at: waiting ? recorded : verifiedAt,
        returned_reason: rejected ? 'The receipt does not show the OR number. Please attach the official receipt.' : null, returned_at: rejected ? verifiedAt : null, returned_by_user_id: rejected ? admin.id : null,
      });
      await event(a, 'payment_entry_submitted', recorded, sales, null, { step: 'payment_record', new: { payment_id: pid, required_payment: item.name, status: 'for_verification', payment_method: method }, files: [ref(receipt, receiptName, 'payment_receipt')] });
      if (!waiting) {
        view(receipt, later(verifiedAt, -5));
        await event(a, rejected ? 'payment_entry_rejected' : 'payment_entry_verified', verifiedAt, admin, rejected ? 'The receipt does not show the OR number. Please attach the official receipt.' : null,
          { step: 'payment_record', old: { payment_id: pid, status: 'for_verification' }, new: { payment_id: pid, status: rejected ? 'rejected' : 'verified', required_payment: item.name } });
      }
      last = waiting ? recorded : verifiedAt;
    }
    if (mode !== 'all') return last;
    const moved = later(last, 90);
    await move(a, 'for_approval', moved, admin, 'All required payments verified by Admin.', 'applicant.payment_confirmed', { payment_stage_state: 'confirmed', payment_confirmed_at: moved, payment_confirmed_by_user_id: admin.id });
    return moved;
  }

  async function approve(a: Row, from: Date) {
    const reviewed = office(addDays(from.toISOString().slice(0, 10), 1), '10:00');
    Object.assign(a, { reviewed_at: reviewed, reviewed_by_user_id: admin.id, review_remarks: 'Every stage checked: requirements, activities, LOI and payments.' });
    const approved = later(reviewed, 120);
    await move(a, 'approved', approved, admin, 'Approved by Admin.', 'applicant.approved', { approved_at: approved, approved_by_user_id: admin.id });
    return approved;
  }
  async function agreement(p: Person, a: Row, from: Date, outcome: 'accepted' | 'submitted') {
    const last = a.full_name.split(' ').pop()!.toLowerCase();
    return requirement(p, a, 'franchise_agreement', 'activation', office(addDays(from.toISOString().slice(0, 10), 2), '10:30'), outcome, {}, [['agreement', 'agreement', `franchise-agreement-${last}.png`]]);
  }

  // ---------------------------------------------------------------- the people
  const finishApplicant = (a: Row, existing: boolean) => (existing ? updates.push(a) : batch.add('applicants', a));
  const updates: Row[] = [];
  const written: Row[] = [];

  for (const p of [...PIPELINE, ...ACTIVE]) {
    let existing: Row | null = null;
    let branch: Row | null = null;
    if (p.branch) {
      [branch] = await db.query(`select l.*, f.id as franchisee_id, f.applicant_id, u.id as user_id, u.email as user_email from users u join franchisees f on f.user_id = u.id join franchise_locations l on l.franchisee_id = f.id where lower(u.email) = $1`, [p.branch]);
      [existing] = await db.query(`select * from applicants where id = $1`, [branch!.applicant_id]);
    }
    const { a, inq } = await convert(p, existing);
    const sc = p.scenario;
    // Qualification
    if (sc.startsWith('conv_')) {
      await qualification(p, a, ({ conv_missing: 'missing', conv_waiting: 'waiting', conv_returned: 'returned', conv_ready: 'full_noqual' } as Record<string, string>)[sc] === 'full_noqual' ? 'waiting' : ({ conv_missing: 'missing', conv_waiting: 'waiting', conv_returned: 'returned' } as Record<string, 'missing' | 'waiting' | 'returned'>)[sc], p.convert!);
      if (sc === 'conv_ready') {
        // All four Accepted, not yet confirmed: rewrite the waiting interview as accepted.
        const reqs = batch.tables.get('applicant_requirements')!.filter((x) => x.applicant_id === a.id);
        const waiting = reqs.find((x) => x.status === 'submitted')!;
        const reviewed = later(new Date(waiting.submitted_at), 75);
        Object.assign(waiting, { status: 'accepted', reviewed_by_user_id: admin.id, reviewed_at: reviewed, updated_at: reviewed });
        for (const d of batch.tables.get('documents')!.filter((x) => x.documentable_type === MODELS.requirement && x.documentable_id === waiting.id)) view(d.id, later(reviewed, -4));
        await event(a, 'requirement_accepted', reviewed, admin, null, { step: 'initial_interview', old: { status: 'submitted' }, new: { status: 'accepted' } });
      }
      finishApplicant(a, false); written.push(a); continue;
    }
    if (sc.startsWith('rejected:')) {
      const day = sc.split(':')[1];
      const q = await qualification(p, a, 'full', p.convert!);
      if (q && day > addDays(q.toISOString().slice(0, 10), 2)) await setSchedule(a, later(q, 60 * 24));
      const when = office(day, '15:10');
      const reason = a.status === 'scheduled' ? 'The applicant withdrew: the family decided to postpone the business.' : 'Financial capacity is below the package after the interview.';
      await move(a, 'rejected', when, admin, reason, 'applicant.status_changed', { rejected_at: when, archived_at: when, archived_by_user_id: admin.id, archive_reason: reason });
      Object.assign(inq, { status: 'rejected', archived_at: when, archived_by_user_id: admin.id, status_changed_at: when, updated_at: when });
      finishApplicant(a, false); written.push(a); continue;
    }
    // Everyone else is qualified first.
    const ot = p.ot;
    let qualifyFrom = p.convert!;
    const q = await qualification(p, a, 'full', qualifyFrom);
    if (sc === 'qualified_ready') { finishApplicant(a, false); written.push(a); continue; }
    const fixed: Record<string, string> = { overdue_noschedule: '2026-11-13', stalled: '2026-11-06', sched_none: '2026-11-20', on_hold: '2026-11-03' };
    let schedAt = fixed[sc] ? office(fixed[sc], '09:40') : later(q!, 60 * 24);
    if (schedAt < q!) schedAt = later(q!, 60);
    await setSchedule(a, schedAt);
    const scheduledOn = (slotDay: string, minDaysBefore = 3) => {
      let d = office(addDays(slotDay, -minDaysBefore), r.time('09:30', '11:30'));
      if (d <= schedAt) d = later(schedAt, 45);
      return d;
    };
    const otSlot = ot ?? ([nextWeekday(addDays(schedAt.toISOString().slice(0, 10), 4)), '09:00', 120] as [string, string, number]);
    const trSlot = p.training ?? ([nextWeekday(addDays(otSlot[0], 7)), '14:00', 180] as [string, string, number]);
    // Cancelled sessions before the real one (three in November, two in October).
    const cancelledBefore: Record<string, string> = { 'Diana Rivera': '2026-11-12', 'Gilbert Aguilar': '2026-11-18', 'Kevin Torres': '2026-11-19', 'Ursula Diaz': '2026-10-19', 'Tristan Lim': '2026-10-28' };
    const fullName = `${p.first} ${p.last}`;
    if (cancelledBefore[fullName]) await activity(p, a, 'orientation', [cancelledBefore[fullName], '09:00', 120], 'cancelled', scheduledOn(cancelledBefore[fullName], 4));

    if (['sched_none', 'overdue_noschedule', 'stalled', 'on_hold'].includes(sc)) {
      if (sc === 'on_hold') {
        const when = office('2026-11-16', '10:20');
        Object.assign(a, { on_hold_until: at('2026-12-05', '17:00'), on_hold_reason: 'The applicant is traveling abroad until December 5.', on_hold_at: when, on_hold_by_user_id: admin.id });
        batch.add('applicant_follow_up_events', { id: await ids.next('applicant_follow_up_events'), applicant_id: a.id, kind: 'hold', user_id: admin.id, to_user_id: a.assigned_sales_user_id, message: null, reason: a.on_hold_reason, until_at: a.on_hold_until, snapshot: null, created_at: when });
        await event(a, 'put_on_hold', when, admin, a.on_hold_reason, { step: 'follow_up', new: { on_hold_until: '2026-12-05' } });
      }
      finishApplicant(a, false); written.push(a); continue;
    }
    if (sc === 'overdue_past') { await activity(p, a, 'orientation', otSlot, 'scheduled', office('2026-11-12', '10:05')); finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'noshow') { await activity(p, a, 'orientation', otSlot, 'no_show', scheduledOn(otSlot[0])); finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'ot_not_submitted' || sc === 'ready_today' || sc === 'future') { await activity(p, a, 'orientation', otSlot, 'scheduled', scheduledOn(otSlot[0], sc === 'future' ? 5 : 4)); finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'ot_waiting_verify') { await activity(p, a, 'orientation', otSlot, 'submitted', scheduledOn(otSlot[0])); finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'ot_returned') { await activity(p, a, 'orientation', otSlot, 'returned', scheduledOn(otSlot[0])); finishApplicant(a, false); written.push(a); continue; }
    const otDone = await activity(p, a, 'orientation', otSlot, 'verified', scheduledOn(otSlot[0]));
    if (sc === 'ot_verified') { finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'training_future') { await activity(p, a, 'training', trSlot, 'scheduled', later(otDone, 60 * 3)); finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'training_waiting') { await activity(p, a, 'training', trSlot, 'submitted', later(otDone, 60 * 3)); finishApplicant(a, false); written.push(a); continue; }
    const trDone = await activity(p, a, 'training', trSlot, 'verified', later(otDone, 60 * 3));
    if (sc === 'both_done') { finishApplicant(a, false); written.push(a); continue; }
    // LOI and beyond
    const loiAt = office(addDays(trDone.toISOString().slice(0, 10), 1), r.time('13:30', '15:30'));
    const loiMode = ({ loi_empty: 'empty', loi_site_waiting: 'site_waiting', loi_returned: 'returned' } as Record<string, 'empty' | 'site_waiting' | 'returned'>)[sc] ?? 'complete';
    const loiDone = await loi(p, a, loiAt, loiMode);
    if (loiMode !== 'complete') { finishApplicant(a, false); written.push(a); continue; }
    const payMode = ({ pay_one_of_two: 'one_of_two', pay_none_rejected: 'none_rejected', pay_none: 'none', pay_not_set: 'none_set', pay_waiting_verify: 'waiting' } as Record<string, 'one_of_two' | 'none_rejected' | 'none' | 'none_set' | 'waiting'>)[sc] ?? 'all';
    const paid = await payments(p, a, loiDone, payMode);
    if (payMode !== 'all') { finishApplicant(a, false); written.push(a); continue; }
    if (sc === 'for_approval') { finishApplicant(a, false); written.push(a); continue; }
    const approved = await approve(a, paid);
    if (sc === 'approved_no_agreement') { finishApplicant(a, false); written.push(a); continue; }
    const agreed = await agreement(p, a, approved, sc === 'approved_agreement_waiting' ? 'submitted' : 'accepted');
    if (sc.startsWith('approved_')) { finishApplicant(a, false); written.push(a); continue; }
    // Active franchisee: the portal invitation, accepted; the franchise and branch were set up then.
    const invited = office(addDays(agreed.toISOString().slice(0, 10), 1), '09:45');
    await event(a, 'portal_user_invited', invited, admin, `Invite email sent to ${branch!.user_email}.`, { step: 'activation' });
    const activated = office(addDays(invited.toISOString().slice(0, 10), 1), '14:20');
    await move(a, 'active_franchisee', activated, admin, 'Franchisee accepted the portal invitation.', 'applicant.activated', { user_id: branch!.user_id, email: branch!.user_email });
    Object.assign(inq, { archived_at: activated, archived_by_user_id: admin.id });
    await db.query(`update franchisees set approval_date = $2, created_at = $3, updated_at = $3 where id = $1`, [branch!.franchisee_id, a.approved_at.toISOString().slice(0, 10), activated]);
    await db.query(`update users set invited_at = $2, invite_accepted_at = $3, created_at = least(created_at, $2) where id = $1`, [branch!.user_id, invited, activated]);
    finishApplicant(a, true); written.push(a);
    void qualifyFrom;
  }

  // Recent Sales follow-ups (with a next action date) so only the intended applicants show Overdue/Stalled.
  const NOTES: Record<string, [string, string, string]> = {
    conv_returned: ['2026-11-23', 'Asked the applicant for a clearer copy of the ID; it will be sent tomorrow.', '2026-11-26'],
    conv_ready: ['2026-11-23', 'All four requirements are accepted; waiting for Admin to confirm Qualified.', '2026-11-26'],
    qualified_ready: ['2026-11-20', 'Applicant is available for Orientation/Tasting next week.', '2026-11-27'],
    ot_returned: ['2026-11-23', 'The applicant will sign the brand selection form on Wednesday.', '2026-11-26'],
    ot_verified: ['2026-11-23', 'Training slot to be set once the applicant confirms the date.', '2026-11-27'],
    both_done: ['2026-11-20', 'Applicant is reviewing the LOI with the family.', '2026-11-27'],
    ready_today: ['2026-11-24', 'Session done; attendance sheet and brand selection will be submitted tomorrow.', '2026-11-25'],
    loi_empty: ['2026-11-23', 'Called: the applicant will bring the signed LOI scan this week.', '2026-11-27'],
    loi_returned: ['2026-11-24', 'Asked the applicant to re-scan the full LOI page with the signature and date.', '2026-11-26'],
    pay_one_of_two: ['2026-11-23', 'Applicant confirmed the balance transfer by end of the month.', '2026-11-30'],
    pay_none_rejected: ['2026-11-20', 'Requested the official receipt with the OR number from the applicant.', '2026-11-26'],
    pay_none: ['2026-11-24', 'Applicant will pay the reservation fee at the office.', '2026-11-27'],
    pay_not_set: ['2026-11-21', 'Waiting for the required payments to be set; applicant ready to pay.', '2026-11-26'],
  };
  const people = [...PIPELINE, ...ACTIVE];
  for (const a of written) {
    const p = people.find((x) => `${x.first} ${x.last}` === a.full_name)!;
    const note = NOTES[p.scenario];
    if (!note) continue;
    const sales = salesOf(p);
    const when = office(note[0], note[0] === '2026-11-24' ? '13:40' : r.time('10:00', '15:30'));
    const next = office(note[2], '10:00');
    batch.add('follow_ups', { id: await ids.next('follow_ups'), followable_type: 'applicant', followable_id: a.id, user_id: sales.id, actor_role: 'sales', contacted_at: when, channel: ['call', 'viber', 'text'][a.id % 3], outcome: 'reached', notes: note[1], next_follow_up_at: next, kind: 'contact', created_at: when });
    await event(a, 'follow_up_logged', when, sales, note[1], { step: 'follow_up', new: { channel: ['call', 'viber', 'text'][a.id % 3], outcome: 'reached', next_action_at: next } });
  }

  // Leads still with Marketing.
  const byName = new Map(written.map((a) => [a.full_name, a]));
  for (const lead of LEADS) {
    const row = await inquiry(lead, lead.status === 'contacted' ? 'contacted' : lead.status === 'endorsed' ? 'endorsed' : lead.status === 'rejected' ? 'rejected' : 'new');
    const created = new Date(row.created_at);
    if (lead.followUps) {
      for (let i = 0; i < lead.followUps; i += 1) {
        const when = office(addDays(lead.inquiry, 1 + i * 3), r.time('10:00', '16:00'));
        batch.add('follow_ups', { id: await ids.next('follow_ups'), followable_type: 'inquiry', followable_id: row.id, user_id: marketing.id, actor_role: 'marketing', contacted_at: when, channel: ['call', 'viber', 'text'][i % 3], outcome: i === lead.followUps - 1 ? 'reached' : 'no_answer',
          notes: i === lead.followUps - 1 ? 'Sent the franchise brochure and the package list; will visit the office next week.' : 'No answer; left a message.', next_follow_up_at: office(addDays(lead.inquiry, 6 + i * 3), '10:00'), kind: 'contact', created_at: when });
        if (i === 0) Object.assign(row, { status_changed_at: when, updated_at: when });
      }
    }
    if (lead.status === 'endorsed') {
      const when = office(addDays(lead.inquiry, 1), r.time('09:30', '11:30'));
      Object.assign(row, { endorsed_to_user_id: admin.id, endorsed_by_user_id: marketing.id, status_changed_at: when, updated_at: when });
    }
    if (lead.status === 'rejected') {
      const when = office(addDays(lead.inquiry, 3), '14:10');
      Object.assign(row, { endorsed_to_user_id: admin.id, endorsed_by_user_id: marketing.id, rejected_reason: lead.reason, rejected_at: when, rejected_by_user_id: admin.id, archived_at: when, archived_by_user_id: admin.id, status_changed_at: when, updated_at: when });
      const logId = await ids.next('inquiry_archive_logs');
      batch.add('inquiry_archive_logs', { id: logId, franchise_inquiry_id: row.id, lead_name: row.lead_name, original_display_no: row.id, archived_by_user_id: admin.id, archived_at: when, archive_id: 10000 + logId });
    }
    if (lead.duplicateOf) {
      const match = byName.get(lead.duplicateOf);
      if (match) {
        row.phone = match.phone;
        Object.assign(row, { duplicate_reason: 'Same number as an applicant: a relative inquiring for a second branch in another city.', duplicate_matches: [{ type: 'applicant', id: match.id, code: match.applicant_code, name: match.full_name, matched_on: ['phone'] }] });
      }
    }
    void created;
  }

  // A few unread bell notifications for what is waiting right now (cleanup emptied the bells).
  const bell = async (user: Row, type: string, title: string, message: string, data: Row, when: Date, actor: Row | null) =>
    batch.add('system_notifications', { id: await ids.next('system_notifications'), user_id: user.id, actor_user_id: actor?.id ?? null, type, title, message, data, read_at: null, created_at: when, updated_at: when });
  const find = (name: string) => written.find((a) => a.full_name === name)!;
  const acts = batch.tables.get('activity_schedules') ?? [];
  for (const name of ['Pamela Cruz', 'Tristan Lim', 'Victor Hernandez', 'Grace Ocampo']) {
    const a = find(name);
    const act = acts.filter((x) => x.applicant_id === a.id && x.review_status === 'submitted').pop();
    if (!act) continue;
    const p = people.find((x) => `${x.first} ${x.last}` === name)!;
    const label = act.activity_type === 'orientation' ? 'Orientation/Tasting' : 'Training';
    const attended = act.status === 'completed';
    await bell(admin, 'applicant_activity_completed', attended ? 'Activity marked Complete' : 'Activity marked No Show',
      `${label} for ${a.applicant_code} was ${attended ? 'marked Complete' : 'marked No Show'}. ${act.activity_type === 'orientation' ? 'Open every file, then Verify or Return it.' : 'Review the proof and mark it Attended or Return it.'}`,
      { applicant_id: a.id, activity_id: act.id }, new Date(act.completion_submitted_at), salesOf(p));
  }
  {
    const a = find('Patricia Gonzales');
    const req = (batch.tables.get('applicant_requirements') ?? []).find((x) => x.applicant_id === a.id && x.status === 'submitted');
    if (req) await bell(admin, 'requirement_submitted', 'Requirement submitted', `Herald Sales submitted "Initial interview" for ${a.full_name}. Review it: Accept or Return.`, { applicant_id: a.id, requirement_key: req.requirement_key }, new Date(req.submitted_at), users.herald);
    const f = find('Francis Leonardo');
    const pay = (batch.tables.get('payments') ?? []).find((x) => x.applicant_id === f.id && x.status === 'pending');
    if (pay) await bell(admin, 'payment_entry_submitted', 'Payment entry to verify', `Herald Sales recorded the Balance (OR/AR ${pay.or_number}) for ${f.full_name}. Verify or reject it.`, { applicant_id: f.id, payment_id: pay.id }, new Date(pay.created_at), users.herald);
    const c = find('Camille Ilagan');
    const back = (batch.tables.get('payments') ?? []).find((x) => x.applicant_id === c.id && x.status === 'returned');
    if (back) await bell(users.herald, 'payment_entry_rejected', 'Payment entry rejected', `The payment entry for ${c.full_name} was rejected: ${back.returned_reason}`, { applicant_id: c.id, payment_id: back.id }, new Date(back.returned_at), admin);
  }
  for (const inq of (batch.tables.get('franchise_inquiries') ?? []).filter((x) => x.status === 'endorsed')) {
    await bell(admin, 'inquiry_endorsed', 'New inquiry endorsed', `Inquiry from ${inq.lead_name} has been endorsed to you.`, { inquiry_id: inq.id }, new Date(inq.status_changed_at), marketing);
  }

  return { written, updates, sessions: [...sessions.values()] };
}

/** Reused applicant rows are updated in place (their franchisee and branch point at them), after the batch wrote their new inquiries. */
export async function applyApplicantUpdates(db: Db, updates: Row[]) {
  for (const a of updates) {
    const cols = Object.keys(a).filter((k) => k !== 'id');
    await db.query(`update applicants set ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} where id = $1`, [a.id, ...cols.map((c) => (a[c] instanceof Date ? a[c].toISOString() : a[c] !== null && typeof a[c] === 'object' ? JSON.stringify(a[c]) : a[c]))]);
  }
}
