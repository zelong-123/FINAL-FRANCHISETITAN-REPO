// Standardized PH locations (built-in PSGC list from GET /ph-locations). Pure helpers used by the
// LocationPicker and every place that shows a location. A location value is
// { province_code, province, city_code, city, barangay, street }.

export const NO_PREFERRED_LOCATION = 'No preferred location yet';

/** Lowercase, accents removed ("Parañaque" -> "paranaque"), spaces collapsed. */
export const normalize = (value) => String(value ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const clean = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
};

/** "Barangay/St, City/Municipality, Province" (empty parts skipped); null when empty. */
export function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const parts = [loc.street, loc.barangay, loc.city, loc.province].map(clean).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** What to show: the structured value, else the old free text, else "No preferred location yet" when marked. */
export function locationText(loc, legacy, noneMarked = false) {
  if (noneMarked && !loc?.city_code) {
    return loc?.province ? `${NO_PREFERRED_LOCATION} (${loc.province})` : NO_PREFERRED_LOCATION;
  }
  return formatLocation(loc) ?? clean(legacy);
}

/** Rank: 0 name starts with the query, 1 a word starts with it, 2 contains it; null = no match. */
function rank(name, query) {
  const n = normalize(name);
  if (!query) return 0;
  if (n.startsWith(query)) return 0;
  if (n.split(' ').some((word) => word.startsWith(query))) return 1;
  return n.includes(query) ? 2 : null;
}

const byRank = (items, query, nameOf) => items
  .map((item) => ({ item, r: rank(nameOf(item), query) }))
  .filter((x) => x.r !== null)
  .sort((a, b) => a.r - b.r || nameOf(a.item).localeCompare(nameOf(b.item)))
  .map((x) => x.item);

/** Provinces matching the typed text ("que" -> Quezon). Metro Manila (NCR) is listed first when nothing is typed. */
export function provinceOptions(reference, query = '') {
  const provinces = reference?.provinces ?? [];
  const q = normalize(query);
  return q ? byRank(provinces, q, (p) => p.name) : provinces;
}

/**
 * Cities/municipalities: only those of the selected province; with no province, every city is
 * searched and labelled "City, Province" (e.g. typing "que" shows Quezon City, Metro Manila (NCR)).
 */
export function cityOptions(reference, provinceCode, query = '', limit = 60) {
  const provinces = new Map((reference?.provinces ?? []).map((p) => [p.code, p.name]));
  const pool = (reference?.cities ?? []).filter((c) => !provinceCode || c.province_code === provinceCode);
  const q = normalize(query);
  const list = q ? byRank(pool, q, (c) => c.name) : pool;
  return list.slice(0, provinceCode ? undefined : limit).map((c) => ({
    ...c, province: provinces.get(c.province_code) ?? '', label: provinceCode ? c.name : `${c.name}, ${provinces.get(c.province_code) ?? ''}`,
  }));
}

/** Choosing a province keeps the city only when it belongs to it. */
export function chooseProvince(reference, value, provinceCode) {
  const province = (reference?.provinces ?? []).find((p) => p.code === provinceCode) ?? null;
  const city = (reference?.cities ?? []).find((c) => c.code === value?.city_code);
  const keep = Boolean(province && city && city.province_code === province.code);
  return {
    ...value,
    province_code: province?.code ?? null, province: province?.name ?? null,
    city_code: keep ? city.code : null, city: keep ? city.name : null,
  };
}

/** Choosing a city fills in its province (city-first search). */
export function chooseCity(reference, value, cityCode) {
  const city = (reference?.cities ?? []).find((c) => c.code === cityCode) ?? null;
  if (!city) return { ...value, city_code: null, city: null };
  const province = (reference?.provinces ?? []).find((p) => p.code === city.province_code);
  return { ...value, province_code: province?.code ?? null, province: province?.name ?? null, city_code: city.code, city: city.name };
}

/** True when the city belongs to the province (or nothing is chosen). */
export function cityInProvince(reference, value) {
  if (!value?.city_code) return true;
  const city = (reference?.cities ?? []).find((c) => c.code === value.city_code);
  return Boolean(city && (!value.province_code || city.province_code === value.province_code));
}

/** The request body of a location (codes + free text only; the API fills the names). */
export function locationInput(value) {
  if (!value?.province_code && !value?.city_code) return null;
  const out = { province_code: value.province_code || null, city_code: value.city_code || null, barangay: clean(value.barangay) };
  if ('street' in (value || {})) out.street = clean(value.street);
  return out;
}

/** The non-blocking note when the Proposed site is in another city than the preferred location. */
export function differentFromPreferred(site, preferred) {
  if (!site?.city_code || !preferred?.city_code || site.city_code === preferred.city_code) return null;
  return `Different from preferred location (${[preferred.city, preferred.province].filter(Boolean).join(', ')})`;
}

/** "<Brand> <City/Municipality> – <Barangay/St>", or "<Brand> <City/Municipality>" without a barangay. */
export function suggestBranchName(brand, loc) {
  const city = clean(loc?.city);
  if (!city) return '';
  const head = [clean(brand), city].filter(Boolean).join(' ');
  const barangay = clean(loc?.barangay);
  return barangay ? `${head} – ${barangay}` : head;
}
