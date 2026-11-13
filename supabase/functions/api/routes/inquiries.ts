// InquiryController + InquiryIntakeService.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, fail, Filter, intParam, manilaToday, ok, paginate, perPage, routeId } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { notifyRoles, notifyUser } from '../services/notifications.ts';
import { applyRecordSearch } from '../services/recordSearch.ts';
import { APPLICANT_MODEL, applicantJson, loadApplicant } from '../services/applicantModel.ts';
import {
  archivedByAdmin, archiveInquiry, createInquiry, CURRENT_ARCHIVE_LOG, INQUIRY_MODEL, restoreInquiry, updateInquiry, visibleTo,
} from '../services/inquiryModel.ts';
import { assignPublicCode } from '../services/users.ts';
import { renameParticipantName } from '../services/scheduleNames.ts';
import { activeSalesUser, requireReason } from '../services/accountability.ts';
import { logStageChange } from '../services/applicantStage.ts';
import { assertBrandUnlocked } from '../services/brandConfirmation.ts';
import { applyDateRange, createFollowUp, deliverDueReminders, followUpsOf, INQUIRY_DAYS_SQL, inquiryMonitor } from '../services/monitoring.ts';

export const inquiryRoutes = new Hono<AppEnv>();

const SOURCES = ['facebook', 'viber', 'gmail', 'walk_in', 'referral'];
const marketingAdminSales = role('marketing', 'admin', 'sales');
const marketingAdmin = role('marketing', 'admin');
const adminOnly = role('admin');

const PERSON = (alias: string, column: string, extra = '') =>
  `(select jsonb_build_object('id', u.id, 'full_name', u.full_name${extra}) from users u where u.id = ${alias}.${column})`;
const BRAND = (alias: string) => `(select to_jsonb(b) from brands b where b.id = ${alias}.preferred_brand_id)`;
const ENCODED = (alias: string) => PERSON(alias, 'encoded_by_user_id', `, 'user_code', u.user_code`);
const relations = (a: string) => `${BRAND(a)} as preferred_brand, ${ENCODED(a)} as encoded_by, ${PERSON(a, 'endorsed_to_user_id')} as endorsed_to`;

const loadInquiry = async (db: Db, id: number): Promise<Row> =>
  requireFound((await db.query(`select * from franchise_inquiries where id = $1`, [id]))[0], 'Inquiry not found.');
const withRelations = async (db: Db, id: number): Promise<Row> =>
  (await db.query(`select f.*, ${relations('f')} from franchise_inquiries f where f.id = $1`, [id]))[0];
const fresh = async (db: Db, id: number) => (await db.query(`select * from franchise_inquiries where id = $1`, [id]))[0];

async function ensureVisible(c: Context<AppEnv>, db: Db, inquiry: Row) {
  const user = c.get('user');
  const f = new Filter();
  f.add('franchise_inquiries.id = ?', inquiry.id);
  visibleTo(f, user);
  if (!(await db.query(`select 1 from franchise_inquiries ${f.where}`, f.params)).length) abort(404, 'Inquiry not found.');
  if (!inquiry.archived_at) return;
  const name = user.role?.name;
  if (name === 'marketing' && inquiry.archived_by_user_id !== user.id) abort(404, 'Inquiry not found.');
  if (name === 'sales') abort(404, 'Inquiry not found.');
  if (name === 'admin') {
    const [archiver] = await db.query(`select r.name from users u join roles r on r.id = u.role_id where u.id = $1`, [inquiry.archived_by_user_id]);
    if (archiver?.name !== 'admin') abort(404, 'Inquiry not found.');
  }
}

function ensureNotLockedForMarketing(c: Context<AppEnv>, inquiry: Row) {
  if (roleName(c) === 'marketing' && inquiry.status === 'converted') abort(403, 'Converted inquiries are locked for Marketing.');
}

inquiryRoutes.get('/inquiries', marketingAdminSales, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const user = c.get('user');
  const name = roleName(c);
  const archived = boolParam(q.archived);
  if (archived && !['admin', 'marketing'].includes(name)) abort(403, 'Your role is not allowed to perform this action.');
  await deliverDueReminders(db, user);

  const f = new Filter();
  visibleTo(f, user);
  let columns = `franchise_inquiries.*, ${relations('franchise_inquiries')},
    (select jsonb_build_object('id', ap.id, 'inquiry_id', ap.inquiry_id, 'status', ap.status, 'applicant_code', ap.applicant_code)
     from applicants ap where ap.inquiry_id = franchise_inquiries.id limit 1) as applicant,
    ${INQUIRY_DAYS_SQL('franchise_inquiries')} as days_in_status,
    (select count(*)::int from follow_ups fu where fu.followable_type = 'inquiry' and fu.followable_id = franchise_inquiries.id) as follow_up_count,
    (select exists(select 1 from system_notifications sn where sn.user_id = ${Number(user.id)} and sn.read_at is null and sn.type like 'inquiry%' and (sn.data ->> 'inquiry_id')::bigint = franchise_inquiries.id)) as has_unread,
    (select max(fu.next_follow_up_at) from follow_ups fu where fu.followable_type = 'inquiry' and fu.followable_id = franchise_inquiries.id
       and fu.id = (select max(x.id) from follow_ups x where x.followable_type = 'inquiry' and x.followable_id = franchise_inquiries.id)) as next_follow_up_at`;
  const columnParams: unknown[] = [];

  if (archived) {
    f.add('franchise_inquiries.archived_at is not null');
    columns += `, ${CURRENT_ARCHIVE_LOG('franchise_inquiries')} as current_archive_log`;
    if (name === 'marketing') {
      f.add(`franchise_inquiries.encoded_by_user_id = ? and franchise_inquiries.archived_by_user_id = ? and franchise_inquiries.status = 'new'`, user.id, user.id);
    } else {
      f.add(archivedByAdmin('franchise_inquiries'));
    }
  } else if (!boolParam(q.encoded_by_me)) {
    f.add('franchise_inquiries.archived_at is null');
    // Displayed number: position among active visible inquiries, derived on every request.
    const seq = new Filter();
    visibleTo(seq, user, 'seq');
    const visible = seq.clauses.map((clause) => clause.replace(/\$\d+/g, '?'));
    columns += `, (select count(*)::int from franchise_inquiries seq where seq.archived_at is null and ${visible.join(' and ')} and seq.id <= franchise_inquiries.id) as display_no`;
    columnParams.push(...seq.params);
  }

  if (q.status) f.add('franchise_inquiries.status = ?', q.status);
  if (boolParam(q.encoded_by_me)) f.add('franchise_inquiries.encoded_by_user_id = ?', user.id);
  if (q.source) f.add('franchise_inquiries.source = ?', q.source);
  if (q.brand_id) f.add('franchise_inquiries.preferred_brand_id = ?', intParam(q.brand_id));
  applyDateRange(f, q, { inquiry: 'franchise_inquiries.inquiry_date' }, 'inquiry');
  if (q.year) f.add('extract(year from franchise_inquiries.inquiry_date) = ?::int', intParam(q.year));
  if (q.month) f.add('extract(month from franchise_inquiries.inquiry_date) = ?::int', intParam(q.month));

  const order: string[] = [];
  const orderParams: unknown[] = [];
  const ranked = applyRecordSearch(
    f, q.search,
    ['franchise_inquiries.lead_code'],
    [
      'franchise_inquiries.lead_name', 'franchise_inquiries.email',
      '(select enc.full_name from users enc where enc.id = franchise_inquiries.encoded_by_user_id)',
      '(select enc.user_code from users enc where enc.id = franchise_inquiries.encoded_by_user_id)',
    ],
    ['franchise_inquiries.phone'],
  );
  if (ranked) { order.push(ranked.orderBy); orderParams.push(...ranked.orderParams); }
  if (name === 'marketing') order.push(`case franchise_inquiries.status when 'new' then 0 when 'endorsed' then 1 when 'converted' then 2 else 3 end`);
  if (q.sort === 'date') order.push('franchise_inquiries.inquiry_date desc', 'franchise_inquiries.id desc');
  else if (archived) order.push('franchise_inquiries.archived_at desc', 'franchise_inquiries.id desc');
  else order.push('franchise_inquiries.id asc');

  return paginate(c, db, {
    columns, columnParams, from: 'franchise_inquiries', where: f.clauses, params: f.params,
    orderBy: order.join(', '), orderParams, perPage: perPage(c, 20),
    map: (row) => ({ ...row, ...inquiryMonitor(row) }),
  });
});

inquiryRoutes.post('/inquiries', role('marketing'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    lead_name: ['required', 'string', 'max:255'],
    first_name: ['required', 'string', 'max:100'],
    last_name: ['required', 'string', 'max:100'],
    email: ['nullable', 'email', 'max:255'],
    viber_number: ['nullable', 'required_if:source,viber', 'string', 'max:30'],
    address: ['nullable', 'string'],
    current_city: ['nullable', 'string', 'max:255'],
    preferred_franchise_location: ['nullable', 'string', 'max:255'],
    source: ['required', `in:${SOURCES.join(',')}`],
    phone: ['required', 'string', 'max:50'],
    preferred_brand_id: ['required', 'integer', 'exists:brands,id'],
    remarks: ['nullable', 'string'],
    inquiry_date: ['nullable', 'date'],
    duplicate_reason: ['nullable', 'string', 'max:2000'],
  });
  // Same normalized phone or email as an active inquiry or applicant: 409 with the matches,
  // saved only once the user gives a reason, which is kept with the record.
  const { duplicate_reason: duplicateInput, ...fields } = v;
  const matches = await findDuplicates(db, fields.phone, fields.email);
  let duplicate: Row = {};
  if (matches.length) {
    if (!String(duplicateInput ?? '').trim()) {
      return c.json({
        message: 'Possible duplicate: this phone number or email already belongs to an active inquiry or applicant. Give a reason to save it anyway.',
        matches,
        errors: { duplicate_reason: ['Give a reason to save this possible duplicate.'] },
      }, 409);
    }
    duplicate = { duplicate_reason: requireReason(duplicateInput, 'duplicate_reason', 'a duplicate reason'), duplicate_matches: JSON.stringify(matches) };
  }
  const inquiry = await createInquiry(db, { ...fields, ...duplicate, status: 'new', encoded_by_user_id: user.id, inquiry_date: fields.inquiry_date ?? manilaToday() });
  await audit(c, db, 'inquiry.created', { type: INQUIRY_MODEL, id: inquiry.id }, null, inquiry);
  if (matches.length) {
    await audit(c, db, 'inquiry.duplicate_confirmed', { type: INQUIRY_MODEL, id: inquiry.id }, null, { duplicate_reason: inquiry.duplicate_reason, matches });
  }
  await notifyRoles(db, ['admin'], 'inquiry_created', 'New inquiry recorded', `${inquiry.lead_name} was added to the Leads & inquiries pipeline.`, { inquiry_id: inquiry.id }, user);
  return ok(c, await withRelations(db, inquiry.id), 'Inquiry recorded.', 201);
});

/** Digits only, compared on the last 10 (09171234567, +639171234567 and 9171234567 match). */
export const phoneKey = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10);
const PHONE_SQL = (column: string) => `right(regexp_replace(coalesce(${column}, ''), '\\D', '', 'g'), 10)`;

/** Active inquiries and applicants that share the normalized phone or email. */
export async function findDuplicates(db: Db, phone: unknown, email: unknown, ignoreInquiryId: number | null = null): Promise<Row[]> {
  const key = phoneKey(phone);
  const mail = String(email ?? '').trim().toLowerCase();
  if (key.length < 7 && !mail) return [];
  const phoneParam = key.length >= 7 ? key : null;
  const mailParam = mail || null;
  const inquiries = await db.query(
    `select id, lead_code as code, lead_name as name, status, inquiry_date as date,
       (${PHONE_SQL('phone')} = $1) as phone_match, (lower(trim(coalesce(email, ''))) = $2) as email_match
     from franchise_inquiries
     where archived_at is null and status <> 'rejected' and ($3::bigint is null or id <> $3::bigint)
       and ((${PHONE_SQL('phone')} = $1) or (lower(trim(coalesce(email, ''))) = $2))
     order by id limit 10`,
    [phoneParam, mailParam, ignoreInquiryId],
  );
  const applicants = await db.query(
    `select id, applicant_code as code, full_name as name, status, application_date as date,
       (${PHONE_SQL('phone')} = $1) as phone_match, (lower(trim(coalesce(email, ''))) = $2) as email_match
     from applicants
     where archived_at is null and status <> 'rejected' and ($3::bigint is null or inquiry_id is distinct from $3::bigint)
       and ((${PHONE_SQL('phone')} = $1) or (lower(trim(coalesce(email, ''))) = $2))
     order by id limit 10`,
    [phoneParam, mailParam, ignoreInquiryId],
  );
  const shape = (type: string) => (r: Row) => ({
    type, id: r.id, code: r.code, name: r.name, status: r.status, date: r.date,
    matched_on: [r.phone_match ? 'phone' : null, r.email_match ? 'email' : null].filter(Boolean),
  });
  return [...inquiries.map(shape('inquiry')), ...applicants.map(shape('applicant'))];
}

inquiryRoutes.get('/inquiries/endorsement-history', marketingAdminSales, async (c) => {
  const { db } = c.get('deps');
  if (roleName(c) !== 'marketing') abort(403, 'Your role is not allowed to perform this action.');
  const f = new Filter();
  f.add(`al.action = 'inquiry.endorsed' and al.auditable_type = ?`, INQUIRY_MODEL);
  f.add(`actor_role.name = 'marketing'`);
  f.add('al.user_id = ?', c.get('user').id);
  const raw = String(c.req.query('search') ?? '').trim();
  const order = ['al.created_at desc', 'al.id desc'];
  const orderParams: unknown[] = [];
  if (raw) {
    const term = `%${raw.replace(/[\\%_]/g, '\\$&')}%`;
    f.add('(fi.lead_name ilike ? or fi.lead_code ilike ? or b.name ilike ?)', term, term, term);
    order.unshift('case when lower(fi.lead_code) = ? then 0 else 1 end');
    orderParams.push(raw.toLowerCase());
  }
  return paginate(c, db, {
    columns: `al.id, fi.lead_name, fi.id as lead_id, fi.lead_code, b.name as concept, al.created_at as endorsed_at`,
    from: `audit_logs al join users actor on actor.id = al.user_id join roles actor_role on actor_role.id = actor.role_id
           left join franchise_inquiries fi on fi.id = al.auditable_id left join brands b on b.id = fi.preferred_brand_id`,
    where: f.clauses, params: f.params, orderBy: order.join(', '), orderParams, perPage: perPage(c, 15),
  });
});

inquiryRoutes.get('/inquiries/by-code/:code', marketingAdminSales, async (c) => {
  const { db } = c.get('deps');
  const [inquiry] = await db.query(`select * from franchise_inquiries where lower(lead_code) = $1`, [c.req.param('code')!.trim().toLowerCase()]);
  requireFound(inquiry, 'Inquiry not found.');
  await ensureVisible(c, db, inquiry);
  const [applicant] = await db.query(`select id, applicant_code from applicants where inquiry_id = $1 limit 1`, [inquiry.id]);
  return ok(c, {
    id: inquiry.id, lead_code: inquiry.lead_code, lead_name: inquiry.lead_name, status: inquiry.status,
    archived: inquiry.archived_at !== null, applicant: applicant ?? null,
  });
});

inquiryRoutes.get('/inquiries/:inquiry', marketingAdminSales, async (c) => {
  const { db } = c.get('deps');
  const inquiry = await loadInquiry(db, routeId(c, 'inquiry'));
  await ensureVisible(c, db, inquiry);
  const row = await withRelations(db, inquiry.id);
  const [applicant] = await db.query(`select * from applicants where inquiry_id = $1 limit 1`, [inquiry.id]);
  let applicantJsonOut = null;
  if (applicant) {
    const history = await db.query(
      `select h.*, ${PERSON('h', 'changed_by_user_id')} as changed_by from applicant_status_histories h where h.applicant_id = $1 order by h.id`,
      [applicant.id],
    );
    applicantJsonOut = { ...applicantJson(applicant), status_history: history };
  }
  return ok(c, { ...row, applicant: applicantJsonOut, follow_ups: await followUpsOf(db, 'inquiry', inquiry.id) });
});

inquiryRoutes.post('/inquiries/:inquiry/follow-ups', marketingAdminSales, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  if (roleName(c) !== 'marketing') abort(403, 'Marketing logs the follow-ups of an inquiry.');
  const inquiry = await loadInquiry(db, routeId(c, 'inquiry'));
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);
  if (inquiry.archived_at || ['rejected', 'closed'].includes(inquiry.status)) fail('inquiry', 'An archived, rejected or closed inquiry takes no follow-ups.');
  const previous = (await db.query(`select count(*)::int as n from follow_ups where followable_type = 'inquiry' and followable_id = $1`, [inquiry.id]))[0].n;
  const followUp = await db.tx(async (tx) => {
    const row = await createFollowUp(tx, 'inquiry', inquiry.id, user, await readInput(c));
    await audit(c, tx, 'inquiry.follow_up_logged', { type: INQUIRY_MODEL, id: inquiry.id }, null, row);
    // The first follow-up marks a new inquiry as contacted.
    if (previous === 0 && inquiry.status === 'new') {
      const saved = await updateInquiry(tx, inquiry, { status: 'contacted' });
      await audit(c, tx, 'inquiry.contacted', { type: INQUIRY_MODEL, id: inquiry.id }, { status: 'new' }, { status: saved.status, follow_up_id: row.id });
    }
    return row;
  });
  return ok(c, { follow_up: followUp, inquiry: await withRelations(db, inquiry.id), follow_ups: await followUpsOf(db, 'inquiry', inquiry.id) }, 'Follow-up logged.', 201);
});

inquiryRoutes.put('/inquiries/:inquiry', marketingAdmin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);

  const input = await readInput(c);
  // An older record may keep its retired source when edited.
  const keepsSource = input.source === inquiry.source;
  const v = await validate(db, input, {
    lead_name: ['required', 'string', 'max:255'],
    first_name: ['required', 'string', 'max:100'],
    last_name: ['required', 'string', 'max:100'],
    email: ['nullable', 'email', 'max:255'],
    phone: ['required', 'string', 'max:50'],
    viber_number: ['nullable', 'string', 'max:30'],
    address: ['nullable', 'string'],
    current_city: ['nullable', 'string', 'max:255'],
    preferred_franchise_location: ['nullable', 'string', 'max:255'],
    source: keepsSource ? ['required', 'string'] : ['required', `in:${SOURCES.join(',')}`],
    preferred_brand_id: ['required', 'integer', 'exists:brands,id'],
    remarks: ['nullable', 'string'],
    inquiry_date: ['sometimes', 'date'],
  });

  // A linked applicant's confirmed (or legacy) brand is locked: the edit cannot overwrite it.
  const [linked] = await db.query(`select * from applicants where inquiry_id = $1 limit 1`, [id]);
  if (linked && Number(v.preferred_brand_id) !== Number(linked.preferred_brand_id ?? 0)) {
    await assertBrandUnlocked(db, linked, 'preferred_brand_id');
  }
  const saved = await updateInquiry(db, inquiry, v);
  await syncLinkedApplicant(db, saved, v);
  await audit(c, db, 'inquiry.updated', { type: INQUIRY_MODEL, id }, inquiry, saved);
  return ok(c, await withRelations(db, id), 'Inquiry updated.');
});

/** The inquiry owns the person's identity: mirror edited fields onto the linked applicant. */
async function syncLinkedApplicant(db: Db, inquiry: Row, sent: Row) {
  const [applicant] = await db.query(`select * from applicants where inquiry_id = $1 limit 1`, [inquiry.id]);
  if (!applicant) return;
  const changes: Row = {};
  if ('lead_name' in sent) changes.full_name = inquiry.lead_name;
  for (const field of ['email', 'phone', 'address', 'preferred_brand_id']) {
    if (field in sent) changes[field] = inquiry[field];
  }
  const different = Object.entries(changes).filter(([k, value]) => String(applicant[k] ?? '') !== String(value ?? ''));
  if (!different.length) return;
  await db.query(
    `update applicants set ${different.map(([k], i) => `"${k}" = $${i + 1}`).join(', ')} where id = $${different.length + 1}`,
    [...different.map(([, value]) => value), applicant.id],
  );
  if (different.some(([k]) => k === 'full_name')) await renameParticipantName(db, applicant.id, applicant.full_name, inquiry.lead_name);
}

inquiryRoutes.post('/inquiries/:inquiry/endorse', marketingAdmin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  const me = c.get('user');
  if (!['marketing', 'sales'].includes(roleName(c))) abort(403, 'Only Marketing and Sales can endorse inquiries.');
  ensureNotLockedForMarketing(c, inquiry);
  if (inquiry.status === 'converted') fail('inquiry', 'A converted inquiry cannot be endorsed.');
  if (inquiry.endorsed_to_user_id && inquiry.endorsed_to_user_id !== me.id) fail('inquiry', 'This inquiry was already endorsed.');

  const v = await validate(db, await readInput(c), {
    endorsed_to_user_id: ['nullable', 'exists:users,id'],
    remarks: ['nullable', 'string'],
  });
  const firstActive = async (name: string) => (await db.query(
    `select u.*, r.name as role_name from users u join roles r on r.id = u.role_id where u.account_status = 'active' and r.name = $1 order by u.id limit 1`, [name],
  ))[0];
  let target = v.endorsed_to_user_id
    ? (await db.query(`select u.*, r.name as role_name from users u join roles r on r.id = u.role_id where u.id = $1`, [v.endorsed_to_user_id]))[0]
    : await firstActive('admin');
  target ??= await firstActive('sales');
  if (!target || target.account_status !== 'active' || !['admin', 'sales'].includes(target.role_name)) {
    fail('endorsed_to_user_id', 'Choose an active admin or sales account to receive this inquiry.');
  }
  if (target.id === me.id) fail('endorsed_to_user_id', 'You cannot endorse an inquiry to yourself.');

  const saved = await updateInquiry(db, inquiry, {
    status: 'endorsed', endorsed_to_user_id: target.id, endorsed_by_user_id: me.id, remarks: v.remarks ?? inquiry.remarks,
  });
  await notifyUser(db, target.id, 'inquiry_endorsed', 'New inquiry endorsed', `Inquiry from ${inquiry.lead_name} has been endorsed to you.`, { inquiry_id: id });
  await audit(c, db, 'inquiry.endorsed', { type: INQUIRY_MODEL, id }, inquiry, saved);
  const row = (await db.query(`select f.*, ${PERSON('f', 'endorsed_to_user_id')} as endorsed_to from franchise_inquiries f where f.id = $1`, [id]))[0];
  return ok(c, row, 'Inquiry endorsed.');
});

inquiryRoutes.post('/inquiries/:inquiry/convert', adminOnly, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const user = c.get('user');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);

  const [existing] = await db.query(`select * from applicants where inquiry_id = $1 limit 1`, [id]);
  if (existing) return ok(c, applicantJson(existing), 'Inquiry was already converted.');

  const v = await validate(db, await readInput(c), {
    notes: ['nullable', 'string'], application_date: ['nullable', 'date'], assigned_sales_user_id: ['nullable', 'integer'],
  });
  // Admin must choose the active Sales user who will handle the applicant.
  const salesUser = await activeSalesUser(db, v.assigned_sales_user_id, 'assigned_sales_user_id');
  const applicant = await db.tx(async (tx) => {
    const [row] = await tx.query(
      `insert into applicants (inquiry_id, preferred_brand_id, full_name, email, phone, address, status, application_date, notes, assigned_sales_user_id, assigned_sales_at, assigned_sales_by_user_id)
       values ($1, $2, $3, $4, $5, $6, 'converted', $7, $8, $9, now(), $10) returning *`,
      [id, inquiry.preferred_brand_id, inquiry.lead_name, inquiry.email, inquiry.phone, inquiry.address, v.application_date ?? manilaToday(), v.notes ?? inquiry.remarks, salesUser.id, user.id],
    );
    row.applicant_code = await assignPublicCode(tx, 'applicants', 'applicant_code', 'APL', row.id);
    await tx.query(
      `insert into applicant_status_histories (applicant_id, from_status, to_status, remarks, changed_by_user_id) values ($1, null, 'converted', 'Created from inquiry.', $2)`,
      [row.id, user.id],
    );
    await logStageChange(tx, row.id, null, 'converted', user.id, 'Created from inquiry.', 'converted', { inquiry_id: id, lead_code: inquiry.lead_code }, {
      step: 'conversion', new_values: { status: 'converted', inquiry_id: id, lead_code: inquiry.lead_code },
    });
    await logStageChange(tx, row.id, 'converted', 'converted', user.id, `Assigned to ${salesUser.full_name}.`, 'sales_assigned', {}, {
      step: 'assignment', old_values: { assigned_sales_user_id: null }, new_values: { assigned_sales_user_id: salesUser.id, assigned_sales: salesUser.full_name },
    });
    await updateInquiry(tx, inquiry, { status: 'converted', converted_from_status: inquiry.status });
    return row;
  });

  await audit(c, db, 'inquiry.converted', { type: INQUIRY_MODEL, id }, null, { applicant_id: applicant.id, assigned_sales_user_id: salesUser.id });
  // The assigned Sales user gets the alert (and the red dot on [Update] until the record is opened).
  const message = `${applicant.applicant_code} (${applicant.full_name}) is ready for the qualification assessment. You are the assigned Sales user.`;
  await notifyUser(db, salesUser.id, 'assessment_pending', 'Applicant ready for assessment', message, { applicant_id: applicant.id }, user);
  const [brand] = await db.query(`select * from brands where id = $1`, [applicant.preferred_brand_id]);
  return ok(c, { ...applicantJson(applicant), preferred_brand: brand ?? null, inquiry: await fresh(db, id) }, 'Inquiry converted to applicant.', 201);
});

inquiryRoutes.post('/inquiries/:inquiry/reject', adminOnly, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const user = c.get('user');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  if ((await db.query(`select 1 from applicants where inquiry_id = $1 limit 1`, [id])).length) fail('inquiry', 'Reject the linked applicant from the applicant pipeline instead.');
  if (inquiry.status === 'rejected') return ok(c, inquiry, 'Inquiry is already rejected.');
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const reason = requireReason(v.reason, 'reason', 'a rejection reason');

  const updated = await updateInquiry(db, inquiry, { status: 'rejected', rejected_reason: reason, rejected_at: new Date(), rejected_by_user_id: user.id });
  const log = await archiveInquiry(db, updated, user.id);
  const saved = await fresh(db, id);
  await audit(c, db, 'inquiry.rejected', { type: INQUIRY_MODEL, id }, inquiry, saved);
  await notifyRoles(db, ['admin'], 'inquiry_rejected', 'Inquiry rejected', `${inquiry.lead_code} (${inquiry.lead_name}) was rejected and moved to the archive. Reason: ${reason}`, { inquiry_id: id, archive_id: log?.archive_id ?? null }, user);
  return ok(c, { ...saved, current_archive_log: log }, 'Inquiry rejected and archived.');
});

inquiryRoutes.post('/inquiries/:inquiry/archive', marketingAdmin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const user = c.get('user');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);
  if (roleName(c) === 'marketing') {
    const endorsed = await db.query(
      `select 1 from audit_logs where action = 'inquiry.endorsed' and auditable_type = $1 and auditable_id = $2 limit 1`, [INQUIRY_MODEL, id],
    );
    if (inquiry.status !== 'new' || inquiry.encoded_by_user_id !== user.id || endorsed.length) abort(403, 'Marketing may only archive its own new leads.');
  }
  if (inquiry.archived_at) return ok(c, inquiry, 'Inquiry is already archived.');

  const log = await archiveInquiry(db, inquiry, user.id);
  const saved = await fresh(db, id);
  await audit(c, db, 'inquiry.archived', { type: INQUIRY_MODEL, id }, inquiry, { ...saved, archive_id: log?.archive_id, original_display_no: log?.original_display_no });
  return ok(c, { ...saved, current_archive_log: log }, 'Inquiry archived.');
});

inquiryRoutes.post('/inquiries/:inquiry/restore', marketingAdmin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const user = c.get('user');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);
  if (roleName(c) === 'marketing' && inquiry.archived_by_user_id !== user.id) abort(403, 'This action is unauthorized.');
  await restoreInquiry(db, id, user.id);
  const saved = await fresh(db, id);
  await audit(c, db, 'inquiry.restored', { type: INQUIRY_MODEL, id }, inquiry, saved);
  return ok(c, saved, 'Inquiry restored.');
});

inquiryRoutes.delete('/inquiries/:inquiry', marketingAdmin, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'inquiry');
  const inquiry = await loadInquiry(db, id);
  await ensureVisible(c, db, inquiry);
  ensureNotLockedForMarketing(c, inquiry);
  if ((await db.query(`select 1 from applicants where inquiry_id = $1 limit 1`, [id])).length) fail('inquiry', 'Undo the conversion before deleting this inquiry.');
  await db.query(`delete from franchise_inquiries where id = $1`, [id]);
  await audit(c, db, 'inquiry.deleted', { type: INQUIRY_MODEL, id }, inquiry);
  return ok(c, null, 'Inquiry deleted.');
});

// ArchiveController
const archiveRoutes = new Hono<AppEnv>();
export { archiveRoutes };

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

archiveRoutes.get('/archive', adminOnly, async (c) => {
  const { db } = c.get('deps');
  const type = c.req.query('type') || 'all';
  const limit = perPage(c, 25);
  if (!['all', 'users', 'inquiries', 'applicants'].includes(type)) return c.json({ message: 'Unknown archive type.' }, 422);

  const counts = (await db.query<Row>(`select
    (select count(*)::int from users where archived_at is not null) as users,
    (select count(*)::int from franchise_inquiries f where f.archived_at is not null and ${archivedByAdmin('f')}) as inquiries,
    (select count(*)::int from applicants where archived_at is not null) as applicants`))[0];
  const payload: Row = {};

  if (['all', 'users'].includes(type)) {
    const rows = await db.query(
      `select u.id, u.full_name, u.email, u.archived_at, r.label as role_label, (select a.full_name from users a where a.id = u.archived_by_user_id) as archived_by
       from users u left join roles r on r.id = u.role_id where u.archived_at is not null order by u.archived_at desc limit ${limit}`,
    );
    payload.users = {
      count: counts.users,
      items: rows.map((u) => ({ id: u.id, label: u.full_name, detail: u.email, badge: u.role_label, archived_at: iso(u.archived_at), archived_by: u.archived_by })),
    };
  }
  if (['all', 'inquiries'].includes(type)) {
    const rows = await db.query(
      `select f.*, (select b.name from brands b where b.id = f.preferred_brand_id) as brand_name,
         (select a.full_name from users a where a.id = f.archived_by_user_id) as archived_by,
         ${CURRENT_ARCHIVE_LOG('f')} as log, exists (select 1 from applicants ap where ap.inquiry_id = f.id) as has_applicant
       from franchise_inquiries f where f.archived_at is not null and ${archivedByAdmin('f')} order by f.archived_at desc limit ${limit}`,
    );
    payload.inquiries = {
      count: counts.inquiries,
      items: rows.map((f) => ({
        id: f.id,
        label: f.lead_name,
        archive_id: f.log?.archive_id ?? null,
        has_applicant: f.has_applicant,
        original_display_no: f.log?.original_display_no ?? null,
        detail: [
          f.log ? `Archive ID ${f.log.archive_id}` : null,
          f.log?.original_display_no ? `Original #${f.log.original_display_no}` : null,
          f.email, f.brand_name, f.status,
        ].filter(Boolean).join(' · '),
        badge: f.source,
        archived_at: iso(f.archived_at),
        archived_by: f.archived_by,
      })),
    };
  }
  if (['all', 'applicants'].includes(type)) {
    const rows = await db.query(
      `select ap.*, (select b.name from brands b where b.id = ap.preferred_brand_id) as brand_name,
         (select a.full_name from users a where a.id = ap.archived_by_user_id) as archived_by
       from applicants ap where ap.archived_at is not null order by ap.archived_at desc limit ${limit}`,
    );
    payload.applicants = {
      count: counts.applicants,
      items: rows.map((a) => ({
        id: a.id, label: a.full_name, detail: [a.email, a.brand_name, a.status].filter(Boolean).join(' · '),
        badge: 'Applicant', archived_at: iso(a.archived_at), archived_by: a.archived_by,
      })),
    };
  }
  payload.totals = { ...counts, all: counts.users + counts.inquiries + counts.applicants };
  return ok(c, payload);
});

const RESTORE_MODELS: Record<string, { table: string; model: string }> = {
  users: { table: 'users', model: 'App\\Models\\User' },
  inquiries: { table: 'franchise_inquiries', model: INQUIRY_MODEL },
  applicants: { table: 'applicants', model: APPLICANT_MODEL },
};
const APPLICANT_STATUSES = ['converted', 'qualified', 'scheduled', 'loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'rejected', 'active_franchisee'];

archiveRoutes.post('/archive/inquiries/:id/purge', adminOnly, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'id');
  const v = await validate(db, await readInput(c), { reason: ['required', 'string', 'min:5', 'max:500'] });
  const [inquiry] = await db.query(
    `select f.*, ${CURRENT_ARCHIVE_LOG('f')} as log from franchise_inquiries f where f.id = $1 and f.archived_at is not null and ${archivedByAdmin('f')}`, [id],
  );
  requireFound(inquiry);
  if ((await db.query(`select 1 from applicants where inquiry_id = $1 limit 1`, [id])).length) {
    fail('inquiry', 'This inquiry was converted to an applicant, so it cannot be permanently deleted.');
  }
  await db.tx(async (tx) => {
    await tx.query(`delete from inquiry_archive_logs where franchise_inquiry_id = $1`, [id]);
    await tx.query(`delete from franchise_inquiries where id = $1`, [id]);
  });
  await audit(c, db, 'inquiry.purged', { type: INQUIRY_MODEL, id }, { id, lead_name: inquiry.lead_name, archive_id: inquiry.log?.archive_id ?? null }, { reason: v.reason });
  return ok(c, { deleted: 1 }, 'Inquiry permanently deleted.');
});

archiveRoutes.post('/archive/:type/:id/restore', adminOnly, async (c) => {
  const { db } = c.get('deps');
  const type = c.req.param('type');
  const meta = RESTORE_MODELS[type!];
  if (!meta) return c.json({ message: 'Unknown archive type.' }, 422);
  const id = routeId(c, 'id');
  const [record] = await db.query(`select * from ${meta.table} where id = $1 and archived_at is not null`, [id]);
  requireFound(record);
  const old = { archived_at: record.archived_at, archived_by_user_id: record.archived_by_user_id };

  if (type === 'inquiries') {
    const [archiver] = await db.query(`select r.name from users u join roles r on r.id = u.role_id where u.id = $1`, [record.archived_by_user_id]);
    if (archiver?.name !== 'admin') abort(404, 'Record not found.');
    await restoreInquiry(db, id, c.get('user').id);
  } else {
    let extra = '';
    const params: unknown[] = [id];
    if (type === 'applicants' && record.status === 'rejected') {
      const [previous] = await db.query(
        `select from_status from applicant_status_histories where applicant_id = $1 and to_status = 'rejected' order by id desc limit 1`, [id],
      );
      params.push(APPLICANT_STATUSES.includes(previous?.from_status) ? previous.from_status : 'converted');
      extra = `, status = $2, rejected_at = null`;
    }
    await db.query(`update ${meta.table} set archived_at = null, archived_by_user_id = null${extra} where id = $1`, params);
  }
  await audit(c, db, `${type}.restored`, { type: meta.model, id }, old);
  const [saved] = await db.query(`select * from ${meta.table} where id = $1`, [id]);
  const { auth_user_id: _hidden, ...visible } = saved;
  return ok(c, type === 'applicants' ? applicantJson(visible) : visible, 'Record restored.');
});
