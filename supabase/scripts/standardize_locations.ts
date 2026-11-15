// TEST DATA: gives every existing inquiry and applicant structured PSGC locations, keeping the old
// free text where it is (franchise_inquiries.current_city / preferred_franchise_location,
// applicants.address, the Proposed site's data.address).
//   1. Current residence  (Province, City/Municipality, Barangay)
//   2. Preferred franchise location (Province, City/Municipality)
//   3. Proposed site (Province, City/Municipality, Barangay/St) for applicants at/after LOI Submission;
//      applicants without a Proposed site row get one (owned/leased, 1 sample photo copied to its own
//      storage object, accepted by Admin), timed inside their LOI window, else just before approval;
//      when no time fits it is refused, never guessed.
// Matching (exact/normalized names only):
//   matched                  a city name matches; leftover text -> Barangay ("Manila tondo" -> City of Manila, Tondo)
//   matched (province)       only a province matches ("Bulacan"); the city is a sample in that province
//   sample (city inferred)   a Las Piñas barangay name without a city ("talon 2" -> Las Piñas City, Talon Dos)
//   sample                   anything else (empty, nonsense, our own "(test data)" text): a realistic Metro Manila sample
// History rows, stage and activity times are not changed. Every change is logged in audit_logs as
// "data.location_standardized" with matched vs sample.
//
//   node --no-warnings supabase/scripts/standardize_locations.ts --dry-run
//   node --no-warnings supabase/scripts/standardize_locations.ts --apply
import type { Db, Row } from '../functions/api/lib/db.ts';
import { buildPsgc, NCR, type PsgcCity } from './build_psgc_seed.ts';

const MODELS = { inquiry: 'App\\Models\\FranchiseInquiry', applicant: 'App\\Models\\Applicant', requirement: 'App\\Models\\ApplicantRequirement' };
const LOI_PLUS = ['loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee', 'rejected'];
const NOTE = 'Sample/test data where marked sample; the original free text is kept.';
const SEC = 1000;
const iso = (d: unknown) => (d ? new Date(d as string | number).toISOString() : null);

export type Loc = { province_code: string; province: string; city_code: string | null; city: string | null; barangay: string | null; street: string | null };
export type Pick = { loc: Loc; how: string; from: string | null };
export type Files = { copy(fromPath: string, toPath: string): Promise<void>; remove(paths: string[]): Promise<void> };
export type Actors = { salesId: number; salesName: string; adminId: number; adminName: string };

// ---------- reference + matching ----------
const ref = buildPsgc();
const provinceByCode = new Map(ref.provinces.map((p) => [p.code, p]));
const selectable = ref.cities.filter((c) => c.selectable);
const cityByName = (name: string) => selectable.find((c) => c.name === name)!;

export const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['city', 'of', 'philippines', 'ph', 'demo', 'branch', 'metro', 'ncr']);
const keyOf = (name: string) => norm(name).split(' ').filter((t) => t && !STOP.has(t)).join(' ');
const cityIndex = new Map<string, PsgcCity[]>();
for (const c of selectable) { const k = keyOf(c.name); cityIndex.set(k, [...(cityIndex.get(k) ?? []), c]); }
const provinceIndex = new Map(ref.provinces.filter((p) => p.kind === 'province').map((p) => [keyOf(p.name), p]));
const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
const NEAR = (c: PsgcCity) => (c.province === NCR ? 0 : ['03', '04'].includes(provinceByCode.get(c.province)!.region) ? 1 : 2);

const loc = (city: PsgcCity | null, provinceCode: string, barangay: string | null = null): Loc => ({
  province_code: provinceCode, province: provinceByCode.get(provinceCode)!.name, city_code: city?.code ?? null, city: city?.name ?? null, barangay, street: null,
});

/** Las Piñas barangay names typed without a city ("talon 2", "Talon dos lpc"). */
const TALON = /\btalon\s+(uno|dos|tres|kuatro|singko|[1-5])\b/;
const TALON_NAME: Record<string, string> = { 1: 'Uno', 2: 'Dos', 3: 'Tres', 4: 'Kuatro', 5: 'Singko', uno: 'Uno', dos: 'Dos', tres: 'Tres', kuatro: 'Kuatro', singko: 'Singko' };

/** Parses free text: a city (with leftover text as barangay), a province only, or nothing. */
export function parse(text: unknown): { kind: 'city' | 'province' | 'talon' | 'none'; city?: PsgcCity; province?: string; leftover: string | null } {
  const raw = norm(text);
  if (!raw || /\b(test data|sample site)\b/.test(raw)) return { kind: 'none', leftover: null };
  const tokens = raw.split(' ');
  const hasCity = tokens.includes('city');
  const core = tokens.filter((t) => !STOP.has(t));
  const used = new Set<number>();
  let cities: PsgcCity[] | null = null;
  let province: string | null = null;
  let citySpan: number[] = [];
  for (let len = Math.min(4, core.length); len >= 1; len -= 1) {
    for (let i = 0; i + len <= core.length; i += 1) {
      const idx = Array.from({ length: len }, (_, k) => i + k);
      if (idx.some((j) => used.has(j))) continue;
      const span = idx.map((j) => core[j]).join(' ');
      const asCity = cityIndex.get(span);
      const asProvince = provinceIndex.get(span);
      // "Cavite City" / "Quezon City" are cities; "Cavite" / "Quezon" alone are provinces.
      if (asCity && !cities && (!asProvince || hasCity)) { cities = asCity; citySpan = idx; idx.forEach((j) => used.add(j)); }
      else if (asProvince && !province) { province = asProvince.code; idx.forEach((j) => used.add(j)); }
    }
  }
  const leftoverOf = (extra: number[] = []) => {
    const words = core.filter((_, j) => !used.has(j) || extra.includes(j));
    return words.length ? titleCase(words.join(' ')) : null;
  };
  if (cities) {
    let pool = province ? cities.filter((c) => c.province === province) : cities;
    if (province && !pool.length) {
      // The city is not in the typed province ("San pedro Bulacan"): the province wins, the city words become the barangay.
      return { kind: 'province', province, leftover: leftoverOf(citySpan) };
    }
    if (pool.length > 1) {
      const best = Math.min(...pool.map(NEAR));
      pool = pool.filter((c) => NEAR(c) === best);
    }
    if (pool.length === 1) return { kind: 'city', city: pool[0], leftover: leftoverOf() };
  }
  if (province) return { kind: 'province', province, leftover: leftoverOf() };
  const talon = TALON.exec(raw);
  if (talon) return { kind: 'talon', leftover: `Talon ${TALON_NAME[talon[1]]}` };
  return { kind: 'none', leftover: null };
}

// Realistic sample barangays (Metro Manila first), and a barangay for a matched city with none typed.
const POOL: [string, string][] = [
  ['Quezon City', 'Commonwealth'], ['Makati City', 'Poblacion'], ['Pasig City', 'Kapitolyo'], ['Taguig City', 'Western Bicutan'],
  ['Las Piñas City', 'Pamplona Uno'], ['Muntinlupa City', 'Putatan'], ['Parañaque City', 'San Dionisio'], ['Marikina City', 'Concepcion Uno'],
];
const BARANGAYS: Record<string, string[]> = {
  'Quezon City': ['Commonwealth', 'Batasan Hills', 'Bagong Pag-asa'], 'Makati City': ['Poblacion', 'Bel-Air'], 'Pasig City': ['Kapitolyo', 'San Antonio'],
  'Taguig City': ['Western Bicutan', 'Fort Bonifacio'], 'Las Piñas City': ['Pamplona Uno', 'Almanza Uno', 'Talon Uno'], 'Muntinlupa City': ['Putatan', 'Alabang'],
  'Parañaque City': ['San Dionisio', 'San Antonio'], 'Marikina City': ['Concepcion Uno'], 'Mandaluyong City': ['Plainview'], 'City of Manila': ['Sampaloc'],
  'Caloocan City': ['Bagong Silang'], 'Valenzuela City': ['Malinta'], 'Pasay City': ['Malibay'], 'Antipolo City': ['San Roque'], 'Bacoor City': ['Molino III'],
  'Cavite City': ['San Roque'], 'San Pedro City': ['Landayan'], 'Davao City': ['Buhangin'], 'Malolos City': ['Longos'],
};
const sampleBarangay = (city: string, seed: number) => { const list = BARANGAYS[city] ?? ['Poblacion']; return list[seed % list.length]; };
const samplePlace = (seed: number): Loc => { const [city, brgy] = POOL[seed % POOL.length]; const c = cityByName(city); return loc(c, c.province, brgy); };
/** The first city (else municipality) of a province, by name: the sample city for a province-only match. */
const CAPITAL: Record<string, string> = { Bulacan: 'Malolos City' };
const cityOfProvince = (code: string) => {
  const capital = CAPITAL[provinceByCode.get(code)!.name];
  if (capital) return cityByName(capital);
  const own = selectable.filter((c) => c.province === code).sort((a, b) => a.name.localeCompare(b.name));
  return own.find((c) => c.kind === 'city') ?? own[0];
};

/** A location from free text; `fallback` decides the city when nothing usable was typed. */
export function pickLocation(text: unknown, seed: number, fallback: () => Pick, withBarangay = true): Pick {
  const from = String(text ?? '').trim() || null;
  const p = parse(text);
  if (p.kind === 'city') {
    const barangay = p.leftover ?? (withBarangay ? sampleBarangay(p.city!.name, seed) : null);
    return { loc: loc(p.city!, p.city!.province, barangay), how: p.leftover || !withBarangay ? 'matched' : 'matched; barangay sample', from };
  }
  if (p.kind === 'province') {
    const c = cityOfProvince(p.province!);
    return { loc: loc(c, p.province!, p.leftover ?? (withBarangay ? sampleBarangay(c.name, seed) : null)), how: `matched (province); city sample${p.leftover ? '; barangay from text' : ''}`, from };
  }
  if (p.kind === 'talon') return { loc: loc(cityByName('Las Piñas City'), NCR, p.leftover), how: 'sample (city inferred)', from };
  const f = fallback();
  return { ...f, from };
}
const strip = (l: Loc): Loc => ({ ...l, barangay: null, street: null });

// ---------- plan ----------
export type Change = { table: 'franchise_inquiries' | 'applicants' | 'applicant_requirements'; id: number; set: Row; old: Row; labels: Row };
export type SiteRow = { applicantId: number; loc: Loc; how: string; ownership: string; submitted: string; accepted: string; source: Row; path: string; stored: string; name: string };
export type Plan = { rows: Row[]; changes: Change[]; newSites: SiteRow[]; refused: Row[] };

export async function standardizeLocations(db: Db, actors: Actors, apply: boolean, files?: Files, skipSites: number[] = []): Promise<Plan> {
  const plan: Plan = { rows: [], changes: [], newSites: [], refused: [] };
  const show = (l: Loc | null) => (l ? [l.street, l.barangay, l.city, l.province].filter(Boolean).join(', ') : '—');
  const inquiries = await db.query(`select * from franchise_inquiries order by id`);
  const applicants = await db.query(`select * from applicants order by id`);
  const byInquiry = new Map<number, Row>();

  // 1-2. Inquiries: residence + preferred.
  for (const i of inquiries) {
    const id = Number(i.id);
    if (i.residence_location?.city_code && i.preferred_location?.city_code) continue;
    const residence = i.residence_location?.city_code ? { loc: i.residence_location, how: 'kept', from: null }
      : pickLocation(i.current_city ?? i.address, id, () => ({ loc: samplePlace(id), how: 'sample', from: null }));
    const preferred = i.preferred_location?.city_code ? { loc: i.preferred_location, how: 'kept', from: null }
      : pickLocation(i.preferred_franchise_location, id, () => ({ loc: strip(residence.loc), how: 'sample (same city as residence)', from: null }), false);
    preferred.loc = { ...preferred.loc, street: null };
    byInquiry.set(id, { residence, preferred });
    plan.changes.push({ table: 'franchise_inquiries', id, set: { residence_location: residence.loc, preferred_location: preferred.loc, no_preferred_location: false },
      old: { current_city: i.current_city, preferred_franchise_location: i.preferred_franchise_location, residence_location: i.residence_location, preferred_location: i.preferred_location },
      labels: { residence: residence.how, preferred: preferred.how } });
    const a = applicants.find((x: Row) => Number(x.inquiry_id) === id);
    plan.rows.push({ record: `${i.lead_code} ${i.lead_name}${a ? ` → ${a.applicant_code}` : ''}`, field: 'Residence', old: residence.from ?? '—', new: show(residence.loc), result: residence.how });
    plan.rows.push({ record: '', field: 'Preferred', old: preferred.from ?? '—', new: show(preferred.loc), result: preferred.how });
  }

  // 1-2. Applicants: the linked inquiry's values; otherwise from the address and the branch city.
  for (const a of applicants) {
    const id = Number(a.id);
    const [branch] = await db.query(`select l.city, l.address from franchise_locations l join franchisees f on f.id = l.franchisee_id where f.applicant_id = $1 and l.type = 'franchise' order by l.id limit 1`, [id]);
    let residence: Pick; let preferred: Pick;
    const fromInquiry = a.inquiry_id ? byInquiry.get(Number(a.inquiry_id)) : null;
    if (fromInquiry) {
      residence = { ...fromInquiry.residence, how: `from inquiry (${fromInquiry.residence.how})` };
      preferred = { ...fromInquiry.preferred, how: `from inquiry (${fromInquiry.preferred.how})` };
    } else if (a.inquiry_id) {
      const [i] = await db.query(`select residence_location, preferred_location from franchise_inquiries where id = $1`, [a.inquiry_id]);
      residence = { loc: i.residence_location, how: 'from inquiry (kept)', from: null };
      preferred = { loc: i.preferred_location, how: 'from inquiry (kept)', from: null };
    } else {
      residence = pickLocation(a.address, id, () => ({ loc: samplePlace(id), how: 'sample', from: null }));
      const branchPick = pickLocation(branch?.address ?? branch?.city, id, () => ({ loc: strip(residence.loc), how: 'sample (same city as residence)', from: null }), false);
      preferred = { loc: strip(branchPick.loc), how: branchPick.how.startsWith('matched') ? 'sample (city of the branch)' : branchPick.how, from: null };
    }
    if (!a.residence_location?.city_code || !a.preferred_location?.city_code) {
      plan.changes.push({ table: 'applicants', id, set: { residence_location: residence.loc, preferred_location: preferred.loc, no_preferred_location: false },
        old: { address: a.address, residence_location: a.residence_location, preferred_location: a.preferred_location, no_preferred_location: a.no_preferred_location },
        labels: { residence: residence.how, preferred: preferred.how } });
      if (!fromInquiry) {
        plan.rows.push({ record: `${a.applicant_code} ${a.full_name} (no inquiry)`, field: 'Residence', old: residence.from ?? '—', new: show(residence.loc), result: residence.how });
        plan.rows.push({ record: '', field: 'Preferred', old: branch ? `branch: ${branch.address ?? branch.city}` : '—', new: show(preferred.loc), result: preferred.how });
      }
    }

    // 3. Proposed site for applicants at/after LOI Submission.
    if (!LOI_PLUS.includes(a.status)) continue;
    const [site] = await db.query(`select * from applicant_requirements where applicant_id = $1 and requirement_key = 'proposed_site'`, [id]);
    const label = `${a.applicant_code} ${a.full_name}`;
    if (site) {
      if (site.data?.location?.city_code) continue;
      const pick = pickLocation(site.data?.address, id + 7, () => ({
        loc: { ...strip(preferred.loc), barangay: sampleBarangay(preferred.loc.city!, id + 7) }, how: 'sample (same city as preferred)', from: null,
      }));
      plan.changes.push({ table: 'applicant_requirements', id: Number(site.id), set: { data: { ...(site.data ?? {}), location: pick.loc } }, old: { data: site.data }, labels: { proposed_site: pick.how, applicant_id: id } });
      plan.rows.push({ record: label, field: 'Proposed site', old: pick.from ?? '—', new: show(pick.loc), result: pick.how });
      continue;
    }
    // No row: create one, timed inside the LOI window, else just before approval.
    if (skipSites.includes(id)) { plan.rows.push({ record: label, field: 'Proposed site (new row)', old: '—', new: '—', result: 'skipped (--skip-sites)' }); continue; }
    const hist = await db.query(`select from_status, to_status, created_at from applicant_status_histories where applicant_id = $1 order by created_at, id`, [id]);
    const entered = hist.find((h: Row) => h.to_status === 'loi_submitted')?.created_at;
    const left = hist.find((h: Row) => h.from_status === 'loi_submitted' && h.to_status !== 'loi_submitted')?.created_at;
    let times: number[] | null = null; let when = '';
    if (entered && left) {
      const [s, e] = [new Date(entered).getTime(), new Date(left).getTime()];
      const step = Math.floor((e - s) / 3);
      if (step >= SEC) { times = [s + step, s + 2 * step]; when = 'inside the LOI window'; }
      else when = `the LOI window is ${Math.round((e - s) / 1000)}s`;
    } else if (a.approved_at) {
      const at = new Date(a.approved_at).getTime();
      times = [at - 2 * 3600e3, at - 3600e3]; when = 'just before approval (no LOI history)';
    } else when = hist.some((h: Row) => h.to_status === 'loi_submitted') ? 'no end to the LOI window' : `never reached LOI Submission (status history: ${hist.map((h: Row) => h.to_status).join(' → ') || 'none'}) and was never approved`;
    const branchPick = branch ? pickLocation(branch.address ?? branch.city, id, () => ({ loc: strip(preferred.loc), how: '', from: null }), false) : null;
    const base = branchPick && branchPick.how.startsWith('matched') ? { l: strip(branchPick.loc), how: 'sample (city of the branch)' } : { l: strip(preferred.loc), how: 'sample (same city as preferred)' };
    const siteLoc = { ...base.l, barangay: sampleBarangay(base.l.city!, id + 7) };
    const ownership = id % 2 ? 'leased' : 'owned';
    if (!times) {
      plan.refused.push({ record: label, reason: `no time fits: ${when}` });
      plan.rows.push({ record: label, field: 'Proposed site (new row)', old: '—', new: show(siteLoc), result: `NOT CREATED — no time fits: ${when}` });
      continue;
    }
    plan.newSites.push({ applicantId: id, loc: siteLoc, how: base.how, ownership, submitted: iso(times[0])!, accepted: iso(times[1])!, source: {}, path: '', stored: '', name: '' });
    plan.rows.push({ record: label, field: 'Proposed site (new row)', old: '—', new: `${show(siteLoc)} · ${ownership} · 1 photo · ${when}`, result: base.how, at: `${iso(times[0])} → ${iso(times[1])}` });
  }

  // Sample photos to copy for the new rows (existing site photos first, then any image).
  if (plan.newSites.length) {
    const images = await db.query(
      `select distinct on (path) id, original_name, mime_type, size_bytes, path, type from documents
       where mime_type in ('image/jpeg', 'image/png') and removed_at is null and disk = 'private' order by path, id`,
    );
    images.sort((x: Row, y: Row) => Number(y.type === 'site_photos') - Number(x.type === 'site_photos') || Number(x.id) - Number(y.id));
    if (!images.length) throw new Error('No sample jpg/png documents to copy.');
    plan.newSites.forEach((s, k) => {
      const src = images[k % images.length];
      const ext = String(src.original_name).split('.').pop()?.toLowerCase() || 'jpg';
      s.source = src; s.stored = `${crypto.randomUUID()}.${ext}`; s.path = `applicants/${s.applicantId}/requirements/proposed_site/${s.stored}`; s.name = `sample-site-photo.${ext}`;
    });
  }
  if (!apply) return plan;

  // ---------- apply ----------
  if (plan.refused.length) throw new Error(`Refused rows (${plan.refused.map((r) => r.record).join(', ')}): nothing applied. Exclude them with --skip-sites=ID,…`);
  const codes = [...new Set([...plan.changes.flatMap((c) => [c.set.residence_location?.city_code, c.set.preferred_location?.city_code, c.set.data?.location?.city_code]), ...plan.newSites.map((s) => s.loc.city_code)].filter(Boolean))];
  const [found] = await db.query(`select count(*)::int as n from psgc_cities where code = any($1::text[])`, [`{${codes.join(',')}}`]);
  if (found.n !== codes.length) throw new Error('The PSGC tables are missing or incomplete on this database: push the migrations first.');
  if (plan.newSites.length && !files) throw new Error('Apply needs the storage client.');
  const copied: string[] = [];
  try {
    for (const s of plan.newSites) { await files!.copy(s.source.path, s.path); copied.push(s.path); }
    await db.tx(async (tx) => {
      for (const c of plan.changes) {
        const keys = Object.keys(c.set);
        await tx.query(`update ${c.table} set ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} where id = $1`,
          [c.id, ...keys.map((k) => (typeof c.set[k] === 'object' && c.set[k] !== null ? JSON.stringify(c.set[k]) : c.set[k]))]);
        const model = c.table === 'franchise_inquiries' ? MODELS.inquiry : c.table === 'applicants' ? MODELS.applicant : MODELS.requirement;
        await tx.query(`insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.location_standardized', $1, $2, $3, $4, now())`,
          [model, c.id, JSON.stringify(c.old), JSON.stringify({ ...c.set, ...c.labels, note: NOTE, script: 'standardize_locations' })]);
      }
      for (const s of plan.newSites) {
        const address = [s.loc.barangay, s.loc.city, s.loc.province].filter(Boolean).join(', ');
        const [r] = await tx.query(
          `insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, created_at, updated_at)
           values ($1, 'proposed_site', 'loi', 'accepted', $2, $3, $4, $5, $6, $4, $6) returning id`,
          [s.applicantId, JSON.stringify({ location: s.loc, address, ownership: s.ownership }), actors.salesId, s.submitted, actors.adminId, s.accepted],
        );
        const [d] = await tx.query(
          `insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, mime_type, size_bytes, uploaded_by_user_id, metadata, created_at, updated_at)
           values ($1, $2, 'site_photos', $3, $4, 'private', $5, $6, $7, $8, $9, $10, $10) returning id`,
          [MODELS.requirement, r.id, s.name, s.stored, s.path, s.source.mime_type, s.source.size_bytes, actors.salesId,
            JSON.stringify({ sample_test_data: true, copied_from_document_id: Number(s.source.id) }), s.submitted],
        );
        await tx.query(`insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.location_standardized', $1, $2, $3, $4, now())`,
          [MODELS.requirement, r.id, JSON.stringify({ missing: true }), JSON.stringify({ applicant_id: s.applicantId, requirement_key: 'proposed_site', status: 'accepted', location: s.loc, ownership: s.ownership,
            proposed_site: s.how, submitted_at: s.submitted, reviewed_at: s.accepted, document_id: Number(d.id), copied_from_document_id: Number(s.source.id), note: 'Sample/test data: Proposed site row added.', script: 'standardize_locations' })]);
      }
    });
  } catch (error) {
    if (copied.length) await files!.remove(copied).catch(() => {});
    throw error;
  }
  return plan;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/standardize_locations.ts'));
if (isMain) {
  const apply = process.argv.includes('--apply');
  const skipSites = String(process.argv.find((x) => x.startsWith('--skip-sites='))?.split('=')[1] ?? '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (apply === process.argv.includes('--dry-run')) { console.error('Usage: exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readEnv, readOnly } = await import('./lib/scriptDb.ts');
  const env = await readEnv();
  const db = await openScriptDb();
  const local = (d: string) => new Date(new Date(d).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
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
    const plan = apply ? await standardizeLocations(db, actors, true, files, skipSites) : await readOnly(db, (tx) => standardizeLocations(tx, actors, false, undefined, skipSites));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)', `· new Proposed sites submitted by ${actors.salesName} (#${actors.salesId}), accepted by ${actors.adminName} (#${actors.adminId})`);
    console.table(plan.rows.map((r) => ({ ...r, at: r.at ? r.at.split(' → ').map(local).join(' → ') : '' })));
    const count = (t: string) => plan.changes.filter((c) => c.table === t).length;
    console.log(`changes: ${count('franchise_inquiries')} inquiries, ${count('applicants')} applicants, ${count('applicant_requirements')} existing Proposed sites; ${plan.newSites.length} new Proposed site rows (${plan.newSites.length} photo copies); refused: ${plan.refused.length}`);
    for (const r of plan.refused) console.log(`  REFUSED ${r.record}: ${r.reason}`);
  } finally {
    await db.close();
  }
}
