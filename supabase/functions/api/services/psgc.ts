// Standardized Philippine locations from the built-in PSGC reference tables (no external API).
// A location is stored as {province_code, province, city_code, city, barangay, street}; the names are
// always taken from the reference tables, never from the client.
import type { Db, Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

export type Location = { province_code: string; province: string; city_code: string | null; city: string | null; barangay: string | null; street: string | null };
export const NO_PREFERRED_LOCATION = 'No preferred location yet';

const text = (v: unknown, max = 255) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, max).join('') : null;
};

/** The whole picker list: provinces and selectable cities/municipalities (about 80 KB, cached by the browser). */
export async function locationReference(db: Db): Promise<Row> {
  const [release] = await db.query(`select "release", "source" from psgc_release order by loaded_at desc limit 1`);
  const provinces = await db.query(`select code, name, kind from psgc_provinces order by case kind when 'ncr' then 0 else 1 end, name`);
  const cities = await db.query(`select code, name, kind, province_code from psgc_cities where selectable order by name, code`);
  return { release: release ?? null, provinces, cities };
}

/**
 * Reads one location from the request: province (and city) must exist, the city must belong to the
 * province, and a city picked without a province fills it in. Returns null when nothing was given.
 */
export async function readLocation(
  db: Db, input: unknown, field: string, { required = false, street = false }: { required?: boolean; street?: boolean } = {},
): Promise<Location | null> {
  const raw = (input && typeof input === 'object' ? input : {}) as Row;
  let provinceCode = text(raw.province_code, 20);
  const cityCode = text(raw.city_code, 20);
  const barangay = text(raw.barangay);
  const streetText = street ? text(raw.street) : null;
  if (!provinceCode && !cityCode) {
    if (required) fail(`${field}.province_code`, 'Choose a Province.');
    if (barangay || streetText) fail(`${field}.city_code`, 'Choose a City/Municipality for this barangay or street.');
    return null;
  }
  let city: Row | null = null;
  if (cityCode) {
    [city] = await db.query(`select code, name, province_code from psgc_cities where code = $1 and selectable`, [cityCode]);
    if (!city) fail(`${field}.city_code`, 'Choose a City/Municipality from the list.');
    if (!provinceCode) provinceCode = city!.province_code;
  }
  const [province] = await db.query(`select code, name from psgc_provinces where code = $1`, [provinceCode]);
  if (!province) fail(`${field}.province_code`, 'Choose a Province from the list.');
  if (city && city.province_code !== province.code) fail(`${field}.city_code`, `${city.name} is not in ${province.name}.`);
  if (required && !city) fail(`${field}.city_code`, 'Choose a City/Municipality.');
  return { province_code: province.code, province: province.name, city_code: city?.code ?? null, city: city?.name ?? null, barangay, street: streetText };
}

/** "Barangay/St, City/Municipality, Province" (empty parts skipped). */
export function formatLocation(loc: Row | null | undefined): string | null {
  if (!loc || typeof loc !== 'object') return null;
  const parts = [loc.street, loc.barangay, loc.city, loc.province].map((p) => text(p)).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Display text: the structured value, else the old free text, else "No preferred location yet" when marked. */
export function locationText(loc: Row | null | undefined, legacy: unknown, noneMarked = false): string | null {
  if (noneMarked && !loc?.city_code) return loc?.province ? `${NO_PREFERRED_LOCATION} (${loc.province})` : NO_PREFERRED_LOCATION;
  return formatLocation(loc) ?? text(legacy);
}

export const sameCity = (a: Row | null | undefined, b: Row | null | undefined) => Boolean(a?.city_code && b?.city_code && a.city_code === b.city_code);

/** "<Brand> <City/Municipality> – <Barangay/St>", or "<Brand> <City/Municipality>" without a barangay. */
export function suggestBranchName(brand: string | null | undefined, loc: Row | null | undefined): string | null {
  const city = text(loc?.city);
  if (!city) return null;
  const head = [text(brand), city].filter(Boolean).join(' ');
  const barangay = text(loc?.barangay);
  return barangay ? `${head} – ${barangay}` : head;
}
