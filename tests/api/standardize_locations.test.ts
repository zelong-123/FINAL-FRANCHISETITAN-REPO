// The location backfill's matching rules (matched / matched (province) / sample (city inferred) / sample)
// and a dry-run + apply on the test database: refused rows, --skip-sites, audit rows, free text kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../support/harness.ts';
import { parse, pickLocation, standardizeLocations } from '../../supabase/scripts/standardize_locations.ts';

const fallback = () => ({ loc: { province_code: 'x', province: 'Sample', city_code: 'y', city: 'Sample City', barangay: null, street: null }, how: 'sample', from: null });

test('matching: exact/normalized city names, leftover text as barangay, province only, Las Piñas barangays, nonsense', () => {
  const m = (text: string) => pickLocation(text, 1, fallback);
  assert.deepEqual([m('Manila tondo').loc.city, m('Manila tondo').loc.barangay, m('Manila tondo').how], ['City of Manila', 'Tondo', 'matched']);
  assert.equal(m('Las pinas City').loc.city, 'Las Piñas City');
  assert.equal(m('paranaque').loc.city, 'Parañaque City');
  assert.equal(m('Cavite City').loc.city, 'Cavite City', '"<Name> City" is the city');
  assert.equal(parse('Cavite').kind, 'province', 'the name alone is the province');
  assert.deepEqual([m('Bacoor, Cavite').loc.city, m('Bacoor, Cavite').loc.province], ['Bacoor City', 'Cavite']);
  assert.deepEqual([m('San Pedro, Laguna').loc.city, m('San Pedro, Laguna').loc.province], ['San Pedro City', 'Laguna']);
  assert.equal(m('Quezon City, Philippines (demo)').loc.city, 'Quezon City');
  assert.equal(m('Las Piñas City').how, 'matched; barangay sample');
  const bulacan = m('Bulacan');
  assert.deepEqual([bulacan.loc.province, bulacan.loc.city, bulacan.how], ['Bulacan', 'Malolos City', 'matched (province); city sample']);
  const kyle = m('San pedro Bulacan');
  assert.deepEqual([kyle.loc.province, kyle.loc.barangay], ['Bulacan', 'San Pedro'], 'a city outside the typed province: the province wins');
  for (const [text, barangay] of [['talon 2', 'Talon Dos'], ['Talon uno', 'Talon Uno'], ['talon dos lpc', 'Talon Dos'], ['talon 3', 'Talon Tres']]) {
    const p = m(text);
    assert.deepEqual([p.loc.city, p.loc.barangay, p.how], ['Las Piñas City', barangay, 'sample (city inferred)'], text);
  }
  for (const text of ['admiral', 'kahit san', 'dasidjabshfa', '323232', '', 'Sample site for X, Quezon City (test data)']) {
    assert.equal(m(text).how, 'sample', `"${text}" is not matched`);
  }
});

test('dry-run then apply on the test database: refused without a time, --skip-sites, audit, free text kept', async () => {
  const { pg, db } = await setup();
  const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
  const [brand] = await q(`select id from brands order by id limit 1`);
  const [sales] = await q(`select id, full_name from users where email = 'sales@franchisetitan.local'`);
  const [admin] = await q(`select id, full_name from users where email = 'admin@franchisetitan.local'`);
  const actors = { salesId: sales.id, salesName: sales.full_name, adminId: admin.id, adminName: admin.full_name };
  const [i] = await q(`insert into franchise_inquiries (lead_name, phone, source, preferred_brand_id, status, inquiry_date, current_city, preferred_franchise_location)
    values ('Backfill Lead', '09175550001', 'facebook', $1, 'converted', '2026-01-01', 'Manila tondo', 'talon 2') returning id`, [brand.id]);
  // Rejected at Qualification: never reached LOI, never approved -> no time fits for a Proposed site.
  const [a] = await q(`insert into applicants (inquiry_id, full_name, status, application_date) values ($1, 'Backfill Lead', 'rejected', '2026-01-01') returning id`, [i.id]);

  // A sample image to copy for any new Proposed site rows (seeded franchisees), and a stub storage.
  await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, mime_type, size_bytes, uploaded_by_user_id)
    values ('App\\Models\\Applicant', $1, 'loi', 's.png', 's.png', 'private', 'x/s.png', 'image/png', 1, $2)`, [a.id, sales.id]);
  const copies: string[] = [];
  const files = { copy: async (_from: string, to: string) => { copies.push(to); }, remove: async () => {} };
  const dry = await standardizeLocations(db, actors, false);
  assert.ok(dry.refused.some((r) => r.record.includes('Backfill Lead')));
  await assert.rejects(standardizeLocations(db, actors, true, files), /nothing applied/);

  const applied = await standardizeLocations(db, actors, true, files, [a.id]);
  assert.equal(copies.length, applied.newSites.length, 'one photo copy per new Proposed site row');
  const [inq] = await q(`select current_city, preferred_franchise_location, residence_location, preferred_location, no_preferred_location from franchise_inquiries where id = $1`, [i.id]);
  assert.equal(inq.current_city, 'Manila tondo', 'the original free text is kept');
  assert.deepEqual([inq.residence_location.city, inq.residence_location.barangay], ['City of Manila', 'Tondo']);
  assert.deepEqual([inq.preferred_location.city, inq.preferred_location.barangay], ['Las Piñas City', 'Talon Dos']);
  const [app] = await q(`select residence_location, preferred_location from applicants where id = $1`, [a.id]);
  assert.equal(app.preferred_location.city, 'Las Piñas City', 'the applicant gets the inquiry values');
  assert.equal((await q(`select count(*)::int n from applicant_requirements where applicant_id = $1`, [a.id]))[0].n, 0, 'skipped: no Proposed site row');
  const [log] = await q(`select new_values from audit_logs where action = 'data.location_standardized' and auditable_type = 'App\\Models\\FranchiseInquiry' and auditable_id = $1`, [i.id]);
  assert.deepEqual([log.new_values.residence, log.new_values.preferred], ['matched', 'sample (city inferred)']);
  assert.equal((await standardizeLocations(db, actors, false, undefined, [a.id])).changes.length, 0, 'a second run changes nothing');
});
