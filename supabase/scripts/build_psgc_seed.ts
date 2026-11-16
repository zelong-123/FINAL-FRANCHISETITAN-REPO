// Builds supabase/migrations/20261118000002_psgc_data.sql from the vendored PSGC files in
// supabase/data/psgc/2025-2Q (from @jobuntux/psgc 0.2.1, PSA PSGC 2025 Q2 release; MIT licence).
// Fixes applied to the package data:
//   - the 33 highly urbanized cities carry a truncated code (Manila "80600"): rebuilt as the 10-digit
//     PSGC code from region + province code (1380600000);
//   - HUCs are independent in PSGC: each is listed under its GEOGRAPHIC province (Angeles -> Pampanga),
//     the official parent is kept in official_parent_code; Isabela City (09901) -> Basilan;
//   - NCR has no province: the 16 cities + Pateros go under the pseudo-province "Metro Manila (NCR)";
//   - BARMM's Special Geographic Area towns (19999) go under the pseudo-province "BARMM Special Geographic Area";
//   - Manila's 14 sub-municipalities are kept but not selectable (the district is typed as the barangay).
//
//   node --no-warnings supabase/scripts/build_psgc_seed.ts
import { readFileSync, writeFileSync } from 'node:fs';

export const RELEASE = '2025-2Q';
export const NCR = '1300000000';
export const SGA = '1999900000';

type P = { psgcCode: string; regCode: string; provCode: string; provName: string; cityClass: string | null };
type M = { psgcCode: string; regCode: string; provCode: string; munCityCode: string; munCityName: string };
export type PsgcProvince = { code: string; name: string; region: string; region_name: string; kind: string };
export type PsgcCity = { code: string; name: string; official: string; kind: string; province: string; parent: string | null; selectable: boolean };

// Geographic province of each independent city (key: region + province code).
const GEOGRAPHIC: Record<string, string> = {
  '03301': 'Pampanga', '18302': 'Negros Occidental', '14303': 'Benguet', '16304': 'Agusan del Norte', '10305': 'Misamis Oriental',
  '07306': 'Cebu', '11307': 'Davao del Sur', '12308': 'South Cotabato', '10309': 'Lanao del Norte', '06310': 'Iloilo',
  '07311': 'Cebu', '04312': 'Quezon', '07313': 'Cebu', '03314': 'Zambales', '17315': 'Palawan', '08316': 'Leyte',
  '09317': 'Zamboanga del Sur', '09901': 'Basilan',
};

/** "City of Las Piñas" -> "Las Piñas City"; Manila keeps "City of Manila". */
export const displayCity = (name: string) => {
  const n = name.trim().replace(/\s+/g, ' ');
  if (n === 'City of Manila') return n;
  const m = /^City of (.+)$/.exec(n);
  return m ? `${m[1]} City` : n;
};

/** The picker data built from the vendored files (also used by the location backfill before the tables exist). */
export function buildPsgc(): { provinces: PsgcProvince[]; cities: PsgcCity[]; counts: Record<string, number> } {
  const dir = new URL(`../data/psgc/${RELEASE}/`, import.meta.url);
  const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const provinces: P[] = read('provinces.json');
  const muncities: M[] = read('muncities.json');
  const regions: { regCode: string; regionName: string }[] = read('regions.json');
  const regionName = (code: string) => regions.find((r) => r.regCode === code)?.regionName ?? code;

  const real = provinces.filter((p) => !p.cityClass).map((p) => ({ code: p.psgcCode, name: p.provName.trim(), region: p.regCode, kind: 'province' }));
  const all = [
    ...real,
    { code: NCR, name: 'Metro Manila (NCR)', region: '13', kind: 'ncr' },
    { code: SGA, name: 'BARMM Special Geographic Area', region: '19', kind: 'sga' },
  ].map((p) => ({ ...p, region_name: regionName(p.region) }));
  const byName = new Map(real.map((p) => [p.name, p.code]));
  const provinceOf = new Map(real.map((p) => [p.code.slice(0, 5), p.code]));

  const cities: PsgcCity[] = muncities.map((m) => {
    const key = m.regCode + m.provCode;
    const code = m.psgcCode.length === 10 ? m.psgcCode : `${key}00000`;
    const official = m.munCityName.trim().replace(/\s+/g, ' ');
    const sub = key === '13806' && official !== 'City of Manila';
    let province = provinceOf.get(key);
    let parent: string | null = null;
    if (m.regCode === '13') { province = NCR; parent = key === '13817' ? null : `${key}00000`; }
    else if (key === '19999') province = SGA;
    else if (GEOGRAPHIC[key]) { province = byName.get(GEOGRAPHIC[key]); parent = `${key}00000`; }
    if (!province) throw new Error(`No province for ${official} (${key})`);
    if (parent === code) parent = null;
    return { code, name: displayCity(official), official, kind: sub ? 'sub_municipality' : /City/.test(official) ? 'city' : 'municipality', province, parent, selectable: !sub };
  });

  const counts = {
    provinces: real.length, pseudo: all.length - real.length,
    cities: cities.filter((c) => c.kind === 'city').length, municipalities: cities.filter((c) => c.kind === 'municipality').length,
    sub_municipalities: cities.filter((c) => c.kind === 'sub_municipality').length,
  };
  if (counts.provinces !== 82 || counts.cities !== 149 || counts.municipalities !== 1493 || counts.sub_municipalities !== 14) {
    throw new Error(`Unexpected counts ${JSON.stringify(counts)}`);
  }
  if (new Set(cities.map((c) => c.code)).size !== cities.length) throw new Error('Duplicate city codes');
  return { provinces: all, cities, counts };
}

const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/build_psgc_seed.ts'));
if (isMain) {
  const { provinces, cities, counts } = buildPsgc();
  const q = (v: string | null) => (v === null ? 'null' : `'${v.replace(/'/g, "''")}'`);
  const lines = [
    `-- GENERATED by supabase/scripts/build_psgc_seed.ts — do not edit by hand.`,
    `-- PSA PSGC ${RELEASE} (via @jobuntux/psgc 0.2.1): ${counts.provinces} provinces + ${counts.pseudo} pseudo-provinces, ${counts.cities} cities, ${counts.municipalities} municipalities, ${counts.sub_municipalities} Manila sub-municipalities (not selectable).`,
    `insert into public."psgc_release" ("release", "source", "provinces", "cities", "municipalities", "sub_municipalities") values`,
    `  ('${RELEASE}', 'PSA PSGC ${RELEASE} via @jobuntux/psgc 0.2.1 (fixes: HUC codes rebuilt, HUCs under their geographic province, NCR and BARMM SGA pseudo-provinces)', ${counts.provinces}, ${counts.cities}, ${counts.municipalities}, ${counts.sub_municipalities});`,
    `insert into public."psgc_provinces" ("code", "name", "region_code", "region_name", "kind") values`,
    provinces.map((p) => `  (${q(p.code)}, ${q(p.name)}, ${q(p.region)}, ${q(p.region_name)}, ${q(p.kind)})`).join(',\n') + ';',
    `insert into public."psgc_cities" ("code", "name", "official_name", "kind", "province_code", "official_parent_code", "selectable") values`,
    cities.map((c) => `  (${q(c.code)}, ${q(c.name)}, ${q(c.official)}, ${q(c.kind)}, ${q(c.province)}, ${q(c.parent)}, ${c.selectable})`).join(',\n') + ';',
    '',
  ];
  writeFileSync(new URL('../migrations/20261118000002_psgc_data.sql', import.meta.url), lines.join('\n'));
  console.log(`PSGC ${RELEASE}:`, JSON.stringify(counts), `· ${provinces.length} provinces in the picker · ${cities.filter((c) => c.selectable).length} selectable cities/municipalities`);
}
