// The location picker's logic, run against the real built-in PSGC list (the generated data migration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chooseCity, chooseProvince, cityInProvince, cityOptions, differentFromPreferred, formatLocation, locationInput,
  locationText, normalize, provinceOptions, suggestBranchName,
} from './locations.js';

// Parse the generated SQL into the same shape GET /ph-locations returns.
const sql = readFileSync(new URL('../../supabase/migrations/20261118000002_psgc_data.sql', import.meta.url), 'utf8');
const tuples = (table) => {
  const block = sql.slice(sql.indexOf(`insert into public."${table}"`));
  const body = block.slice(block.indexOf('values') + 6, block.indexOf(';\n'));
  return [...body.matchAll(/\(([^\n]*)\)/g)].map((m) => [...m[1].matchAll(/'((?:[^']|'')*)'|(true|false|null)/g)].map((x) => (x[1] !== undefined ? x[1].replace(/''/g, "'") : x[2] === 'null' ? null : x[2] === 'true')));
};
const provinces = tuples('psgc_provinces').map(([code, name, , , kind]) => ({ code, name, kind }))
  .sort((a, b) => (a.kind === 'ncr' ? -1 : b.kind === 'ncr' ? 1 : a.name.localeCompare(b.name)));
const cities = tuples('psgc_cities').filter((c) => c[6]).map(([code, name, , kind, province_code]) => ({ code, name, kind, province_code }));
const ref = { provinces, cities };
const NCR = '1300000000';

test('searchable: typing "que" finds Quezon province and Quezon City; accents are ignored', () => {
  assert.deepEqual(provinceOptions(ref, 'que').map((p) => p.name).slice(0, 1), ['Quezon']);
  const all = cityOptions(ref, null, 'que');
  assert.ok(all.some((c) => c.label === 'Quezon City, Metro Manila (NCR)'), 'city-first search shows "City, Province"');
  assert.ok(cityOptions(ref, null, 'las pinas').some((c) => c.name === 'Las Piñas City'));
  assert.equal(normalize('Parañaque'), 'paranaque');
});

test('the City/Municipality list is filtered by the selected province (Metro Manila: 16 cities + Pateros)', () => {
  const ncr = cityOptions(ref, NCR);
  assert.equal(ncr.length, 17);
  assert.ok(ncr.every((c) => c.province_code === NCR));
  assert.ok(ncr.some((c) => c.name === 'Pateros'));
  assert.equal(cityOptions(ref, NCR, 'bacoor').length, 0, 'Bacoor is not in Metro Manila');
});

test('city first fills the province; changing the province clears a city that is not in it', () => {
  const bacoor = cities.find((c) => c.name === 'Bacoor City');
  const picked = chooseCity(ref, { barangay: 'Molino' }, bacoor.code);
  assert.equal(picked.province, 'Cavite');
  assert.equal(picked.barangay, 'Molino', 'the barangay text is kept');
  assert.equal(cityInProvince(ref, picked), true);
  const sameProvince = chooseProvince(ref, picked, picked.province_code);
  assert.equal(sameProvince.city, 'Bacoor City', 'a city that belongs stays');
  const moved = chooseProvince(ref, picked, NCR);
  assert.equal(moved.province, 'Metro Manila (NCR)');
  assert.equal(moved.city_code, null, 'cleared');
  assert.equal(cityInProvince(ref, { province_code: NCR, city_code: bacoor.code }), false);
});

test('standard display format, "No preferred location yet", request body and the "different" note', () => {
  assert.equal(formatLocation({ street: 'Blk 1', barangay: 'Talon Uno', city: 'Las Piñas City', province: 'Metro Manila (NCR)' }), 'Blk 1, Talon Uno, Las Piñas City, Metro Manila (NCR)');
  assert.equal(formatLocation({ barangay: ' ', city: 'Las Piñas City', province: 'Metro Manila (NCR)' }), 'Las Piñas City, Metro Manila (NCR)', 'empty parts skipped');
  assert.equal(locationText(null, null, true), 'No preferred location yet');
  assert.equal(locationText({ province: 'Cavite' }, null, true), 'No preferred location yet (Cavite)');
  assert.equal(locationText(null, 'talon uno'), 'talon uno', 'older free text as fallback');
  assert.deepEqual(locationInput({ province_code: NCR, province: 'x', city_code: '1380200000', city: 'y', barangay: '  Talon  Uno ' }), { province_code: NCR, city_code: '1380200000', barangay: 'Talon Uno' });
  assert.equal(locationInput({}), null);
  const pref = { city_code: '1380800000', city: 'Muntinlupa City', province: 'Metro Manila (NCR)' };
  assert.equal(differentFromPreferred({ city_code: '1380200000' }, pref), 'Different from preferred location (Muntinlupa City, Metro Manila (NCR))');
  assert.equal(differentFromPreferred({ city_code: '1380800000' }, pref), null);
  assert.equal(differentFromPreferred({ city_code: '1380200000' }, null), null, 'no preferred location: no note');
});

test('branch name suggestion', () => {
  assert.equal(suggestBranchName('Daily Dash', { city: 'Quezon City', barangay: 'Commonwealth' }), 'Daily Dash Quezon City – Commonwealth');
  assert.equal(suggestBranchName('Daily Dash', { city: 'Quezon City' }), 'Daily Dash Quezon City');
  assert.equal(suggestBranchName('Daily Dash', null), '');
});

test('only structured values are shown; the old typed text only when none exists, flagged legacy', async () => {
  const { locationShown, locationPlain } = await import('./locations.js');
  const loc = { barangay: 'Talon Uno', city_code: '1380200000', city: 'Las Piñas City', province: 'Metro Manila (NCR)' };
  assert.deepEqual(locationShown(loc, 'talon uno'), { text: 'Talon Uno, Las Piñas City, Metro Manila (NCR)', legacy: false }, 'the typed text is not shown next to it');
  assert.deepEqual(locationShown(null, 'talon uno', true), { text: 'No preferred location yet', legacy: false });
  assert.deepEqual(locationShown(null, '  talon uno '), { text: 'talon uno', legacy: true });
  assert.deepEqual(locationShown(null, ''), { text: null, legacy: false });
  assert.equal(locationPlain(null, 'talon uno'), 'talon uno (legacy)');
  assert.equal(locationPlain(loc, 'talon uno'), 'Talon Uno, Las Piñas City, Metro Manila (NCR)');
  assert.equal(locationPlain(null, null), '');
});
