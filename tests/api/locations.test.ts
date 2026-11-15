// Standardized PH locations (built-in PSGC list): reference data, inquiry residence + preferred
// location (validated, carried to the applicant), Proposed site prefill + "different" note, the
// LOI tab data for legacy rows, and the branch name suggestion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { requirementForm } from '../support/requirements.ts';
import { formatLocation, locationText, suggestBranchName } from '../../supabase/functions/api/services/psgc.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

const NCR = '1300000000';
const LAS_PINAS = '1380200000';
const MUNTINLUPA = '1380800000';
const QUEZON_CITY = '1381300000';
const CAVITE = '0402100000';
const BACOOR = '0402103000';

let seq = 0;
const lead = (extra: Record<string, unknown> = {}) => {
  seq += 1;
  return { lead_name: `Loc Lead ${seq}`, first_name: `Loc${seq}`, last_name: 'Lead', phone: `0917${String(2000000 + seq).slice(1)}`, source: 'facebook', preferred_brand_id: brand.id, ...extra };
};

test('the PSGC reference list: 82 provinces + Metro Manila (NCR) + BARMM SGA, 1,642 selectable cities/municipalities, read-only', async () => {
  const ref = (await call('GET', '/ph-locations', { token: marketing })).json.data;
  assert.equal(ref.release.release, '2025-2Q');
  assert.equal(ref.provinces.length, 84);
  assert.equal(ref.provinces[0].name, 'Metro Manila (NCR)', 'NCR first');
  assert.ok(ref.provinces.some((p: any) => p.name === 'BARMM Special Geographic Area'));
  assert.equal(ref.cities.length, 1642, '149 cities + 1,493 municipalities (Manila districts not selectable)');
  const ncr = ref.cities.filter((c: any) => c.province_code === NCR).map((c: any) => c.name);
  assert.equal(ncr.length, 17, '16 cities + Pateros');
  assert.ok(ncr.includes('City of Manila') && ncr.includes('Pateros') && !ncr.includes('Tondo I/II'));
  const angeles = ref.cities.find((c: any) => c.name === 'Angeles City');
  assert.equal(ref.provinces.find((p: any) => p.code === angeles.province_code).name, 'Pampanga', 'HUCs under their geographic province');
  const isabela = ref.cities.find((c: any) => c.name === 'Isabela City');
  assert.equal(ref.provinces.find((p: any) => p.code === isabela.province_code).name, 'Basilan');
  const [counts] = await q(`select provinces, cities, municipalities, sub_municipalities from psgc_release`);
  assert.deepEqual(counts, { provinces: 82, cities: 149, municipalities: 1493, sub_municipalities: 14 });
  assert.equal((await call('GET', '/ph-locations')).status, 401, 'signed-in users only');
});

test('inquiry: residence and preferred location are validated against the list and stored with PSGC names', async () => {
  const notIn = await call('POST', '/inquiries', { token: marketing, body: lead({ residence_location: { province_code: NCR, city_code: BACOOR } }) });
  assert.equal(notIn.status, 422);
  assert.match(notIn.json.errors['residence_location.city_code'][0], /Bacoor City is not in Metro Manila \(NCR\)/);
  assert.match((await call('POST', '/inquiries', { token: marketing, body: lead({ preferred_location: { province_code: NCR, city_code: '9999999999' } }) })).json.errors['preferred_location.city_code'][0], /from the list/);
  assert.match((await call('POST', '/inquiries', { token: marketing, body: lead({ preferred_location: { barangay: 'Talon Uno' } }) })).json.errors['preferred_location.city_code'][0], /Choose a City/);

  const created = await call('POST', '/inquiries', { token: marketing, body: lead({
    residence_location: { province_code: NCR, city_code: LAS_PINAS, barangay: 'Talon Uno', street: 'Blk 1 Lot 2', province: 'Fake', city: 'Fake' },
    // City picked first: the province is filled in from the city.
    preferred_location: { city_code: BACOOR, barangay: 'Molino' },
  }) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const i = created.json.data;
  assert.deepEqual(i.residence_location, { province_code: NCR, province: 'Metro Manila (NCR)', city_code: LAS_PINAS, city: 'Las Piñas City', barangay: 'Talon Uno', street: 'Blk 1 Lot 2' }, 'names come from the list, not the client');
  assert.equal(i.preferred_location.province_code, CAVITE);
  assert.equal(i.preferred_location.province, 'Cavite');
  assert.equal(i.no_preferred_location, false);
  assert.equal(formatLocation(i.residence_location), 'Blk 1 Lot 2, Talon Uno, Las Piñas City, Metro Manila (NCR)');
});

test('no preferred City/Municipality saves as "No preferred location yet"; inquiry -> applicant carries both locations; edits stay in sync', async () => {
  const created = await call('POST', '/inquiries', { token: marketing, body: lead({ residence_location: { province_code: NCR, city_code: QUEZON_CITY } }) });
  const inquiry = created.json.data;
  assert.equal(inquiry.no_preferred_location, true);
  assert.equal(inquiry.preferred_location, null);
  assert.equal(locationText(inquiry.preferred_location, inquiry.preferred_franchise_location, inquiry.no_preferred_location), 'No preferred location yet');

  assert.equal((await call('POST', `/inquiries/${inquiry.id}/endorse`, { token: marketing, body: { endorsed_to_user_id: salesUser.id } })).status, 200);
  const converted = await call('POST', `/inquiries/${inquiry.id}/convert`, { token: admin, body: { assigned_sales_user_id: salesUser.id } });
  assert.equal(converted.status, 201);
  const applicantId = converted.json.data.id;
  assert.equal(converted.json.data.residence_location.city, 'Quezon City');
  assert.equal(converted.json.data.no_preferred_location, true);
  let report = (await call('GET', `/applicants/${applicantId}/report`, { token: admin })).json.data.applicant;
  assert.equal(report.address_text, 'Quezon City, Metro Manila (NCR)', 'Overview Address = the residence');
  assert.equal(report.preferred_location_text, 'No preferred location yet');

  // Sales (or Marketing before conversion) adds it later: Admin edits the converted inquiry here.
  const edited = await call('PUT', `/inquiries/${inquiry.id}`, { token: admin, body: { ...lead(), phone: inquiry.phone, lead_name: inquiry.lead_name, preferred_location: { province_code: NCR, city_code: MUNTINLUPA } } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.data.residence_location.city, 'Quezon City', 'a location not sent is kept');
  report = (await call('GET', `/applicants/${applicantId}/report`, { token: admin })).json.data.applicant;
  assert.equal(report.preferred_location_text, 'Muntinlupa City, Metro Manila (NCR)');
  assert.equal(report.no_preferred_location, false);
  const [kept] = await q(`select current_city, preferred_franchise_location from franchise_inquiries where id = $1`, [inquiry.id]);
  assert.deepEqual(kept, { current_city: null, preferred_franchise_location: null }, 'the old free-text columns are not overwritten');
});

test('the old free text still shows when there is no structured value', async () => {
  const [i] = await q(`insert into franchise_inquiries (lead_name, phone, source, preferred_brand_id, status, inquiry_date, current_city, preferred_franchise_location)
    values ('Old Lead', '09170000123', 'facebook', $1, 'converted', '2026-01-01', 'Las Pinas', 'Muntinlupa') returning id`, [brand.id]);
  const [a] = await q(`insert into applicants (inquiry_id, full_name, status, application_date, assigned_sales_user_id) values ($1, 'Old Lead', 'converted', '2026-01-01', $2) returning id`, [i.id, salesUser.id]);
  const report = (await call('GET', `/applicants/${a.id}/report`, { token: admin })).json.data.applicant;
  assert.equal(report.address_text, 'Las Pinas', 'the inquiry city of residence fills the Address');
  assert.equal(report.preferred_location_text, 'Muntinlupa');
});

async function loiApplicant(preferred: Record<string, unknown> | null, none = false) {
  const [a] = await q(`insert into applicants (full_name, status, application_date, assigned_sales_user_id, loi_confirmed_at, preferred_location, no_preferred_location)
    values ('Site Loc', 'loi_submitted', '2026-01-01', $1, now(), $2, $3) returning id`, [salesUser.id, preferred ? JSON.stringify(preferred) : null, none]);
  return a.id as number;
}
const siteItem = async (id: number) => (await call('GET', `/applicants/${id}`, { token: admin })).json.data.requirements.items.find((i: any) => i.key === 'proposed_site');

test('Proposed site: Province + City required, Barangay/St optional; prefill from the preferred location; "different from preferred" note; Admin sees the formatted location', async () => {
  const id = await loiApplicant({ province_code: NCR, province: 'Metro Manila (NCR)', city_code: MUNTINLUPA, city: 'Muntinlupa City', barangay: 'Alabang' });
  const before = await siteItem(id);
  assert.deepEqual(before.location_prefill, { province_code: NCR, province: 'Metro Manila (NCR)', city_code: MUNTINLUPA, city: 'Muntinlupa City' }, 'prefilled Province/City (no barangay)');
  assert.equal(before.location_note, null);

  const noBarangay = requirementForm('proposed_site', 'loi', { 'location.barangay': '' });
  const sent = await call('POST', `/applicants/${id}/requirements/proposed_site`, { token: sales, form: noBarangay });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const item = await siteItem(id);
  assert.equal(item.location_text, 'Las Piñas City, Metro Manila (NCR)', 'Barangay/St is optional');
  assert.equal(item.location_note, 'Different from preferred location (Muntinlupa City, Metro Manila (NCR))');
  const config = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.requirements.config.requirements.find((r: any) => r.key === 'proposed_site');
  assert.deepEqual(config.fields.map((f: any) => [f.key, f.type, Boolean(f.required)]), [['location', 'location', true], ['ownership', 'select', true]]);
  assert.equal(config.fields[0].placeholder, 'Barangay/St (Optional)');

  const none = await loiApplicant(null, true);
  const noPref = await siteItem(none);
  assert.equal(noPref.location_prefill, null, 'no preferred location: no prefill');
  await call('POST', `/applicants/${none}/requirements/proposed_site`, { token: sales, form: requirementForm('proposed_site', 'loi') });
  assert.equal((await siteItem(none)).location_note, null, 'and no note');
});

test('LOI tab data: a legacy Proposed site row moved to stage loi (typed address only) still shows its location, status and photos', async () => {
  const id = await loiApplicant(null);
  await q(`update applicants set status = 'payment_submitted' where id = $1`, [id]);
  const [r] = await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_at, reviewed_at)
    values ($1, 'proposed_site', 'loi', 'accepted', '{"address": "San pedro Bulacan", "ownership": "owned"}', now(), now()) returning id`, [id]);
  await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, mime_type, size_bytes, uploaded_by_user_id)
    values ('App\\Models\\ApplicantRequirement', $1, 'site_photos', 'front.jpg', 'front.jpg', 'private', 'x/front.jpg', 'image/jpeg', 1, $2)`, [r.id, salesUser.id]);
  const report = (await call('GET', `/applicants/${id}/report`, { token: admin })).json.data;
  const item = report.requirements.items.find((i: any) => i.key === 'proposed_site');
  assert.equal(item.stage, 'loi');
  assert.equal(item.status, 'accepted');
  assert.equal(item.location_text, 'San pedro Bulacan');
  assert.equal(item.data.ownership, 'owned');
  assert.equal(item.files.length, 1);
  assert.equal(report.requirements.summary.loi.legacy, false, 'shown as a real requirement, not "not captured"');
});

test('branch name suggestion: "<Brand> <City/Municipality> – <Barangay/St>", or without the barangay', () => {
  assert.equal(suggestBranchName('Daily Dash', { city: 'Quezon City', barangay: 'Commonwealth' }), 'Daily Dash Quezon City – Commonwealth');
  assert.equal(suggestBranchName('Daily Dash', { city: 'Quezon City', barangay: '  ' }), 'Daily Dash Quezon City');
  assert.equal(suggestBranchName('Daily Dash', { city: null }), null);
});

test('Sales (assigned) or Admin adds the preferred location later; a city outside the province is refused; audited', async () => {
  const id = await loiApplicant(null, true);
  const path = `/applicants/${id}/preferred-location`;
  const wrong = await call('PUT', path, { token: sales, body: { preferred_location: { province_code: NCR, city_code: BACOOR } } });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.errors['preferred_location.city_code'][0], /not in Metro Manila/);
  assert.equal((await call('PUT', path, { token: marketing, body: { preferred_location: { province_code: NCR, city_code: QUEZON_CITY } } })).status, 403);
  const saved = await call('PUT', path, { token: sales, body: { preferred_location: { province_code: NCR, city_code: QUEZON_CITY, barangay: 'Commonwealth' } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.no_preferred_location, false);
  assert.equal(formatLocation(saved.json.data.preferred_location), 'Commonwealth, Quezon City, Metro Manila (NCR)');
  assert.equal((await siteItem(id)).location_prefill.city, 'Quezon City', 'the Proposed site is prefilled from it');
  const [log] = await q(`select new_values from audit_logs where action = 'applicant.preferred_location_updated' and auditable_id = $1`, [id]);
  assert.equal(log.new_values.preferred_location.city, 'Quezon City');
  const cleared = await call('PUT', path, { token: admin, body: { preferred_location: null } });
  assert.equal(cleared.json.data.no_preferred_location, true, 'no City/Municipality = No preferred location yet');
});
