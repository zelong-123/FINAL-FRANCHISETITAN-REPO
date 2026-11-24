// Step 2: the branches. Each branch is simulated day by day from its opening: production of the
// brand's products (which consumes raw materials through the recipes), physical counts, and the
// restock cycle (supply requests delivered by the warehouse). Every row is written the way the API
// writes it, so the stock balances, the forecast, the Branches panel and the dashboards agree.
import type { Db, Row } from './common.ts';
import { addDays, addWorkingDays, at, Batch, daysBetween, dow, Ids, isWeekday, LAST_DAY, nextWeekday, plusMinutes, rng, round } from './common.ts';
import { BRANCHES, type BranchSpec } from './branchSpecs.ts';

/** Before this day only the core products are recorded, one batch each (keeps the history light). */
const DETAIL_FROM = '2026-07-27';
const BRAND_BASE: Record<string, number> = { kkopi: 14, godo: 10, 'daily dash': 12, 'la pasta': 8 };
const PERISHABLE = /milk|cream|ice\b|^ice|fruit|mango|avocado|lemon|calamansi|cheese|beef|bacon|hotdog|strawberry|puree|pulp/i;
const COUNT_REASONS: [string, string][] = [['spoiled', 'Spoiled or expired'], ['spilled', 'Spilled or wasted'], ['unrecorded_use', 'Used but not recorded'], ['damaged', 'Damaged']];

export interface Mat { id: number; name: string; unit: string; wp: number | null; productUnit: string | null; pack: number | null; low: number | null; critical: number | null; balanceId: number }
export interface Recipe { id: number; name: string; versionId: number; ingredients: { materialId: number; perPiece: number }[]; finishedId: number | null }
export interface Branch {
  spec: BranchSpec; location: Row; user: Row; franchiseeId: number; applicantId: number; brand: string; brandId: number; mats: Mat[]; recipes: Recipe[];
}
/** A restock request produced by the simulation (quantities in product units). */
export interface SimRequest {
  branch: Branch; created: Date; createdDay: string; delivery: string; lines: { mat: Mat; qty: number }[];
  /** null = delivered and received; otherwise the open scenario. */
  state: string | null; damaged?: { matId: number; qty: number }; partial?: { matId: number; shipped: number; backorder: number }; opening?: boolean;
  /** A closed request with its own story (discrepancy_review, completed_with_discrepancy, partial_backorder). */
  special?: string; number?: string; id?: number;
}

const unitStep = (m: Mat) => (m.pack && m.pack > 0 ? m.pack : /^(pcs|pc|piece|pieces|pack|packs|box|boxes|bottle|bottles|can|cans|sachet|sachets|bag|bags|tray|trays)$/i.test(m.unit) ? 1 : 0.5);
const roundUp = (qty: number, step: number) => round(Math.ceil(qty / step - 1e-9) * step, 2);

export async function loadBranches(db: Db): Promise<Branch[]> {
  const out: Branch[] = [];
  for (const spec of BRANCHES) {
    const [row] = await db.query(
      `select u.id as user_id, f.id as franchisee_id, f.applicant_id, l.id as location_id, l.brand_id, b.name as brand from users u join franchisees f on f.user_id = u.id
       join franchise_locations l on l.franchisee_id = f.id and l.type = 'franchise' join brands b on b.id = l.brand_id where lower(u.email) = lower($1)`, [spec.email],
    );
    if (!row) throw new Error(`No franchise branch for ${spec.email}.`);
    const [location] = await db.query(`select * from franchise_locations where id = $1`, [row.location_id]);
    const [user] = await db.query(`select u.*, r.name as role_name from users u join roles r on r.id = u.role_id where u.id = $1`, [row.user_id]);
    out.push({ spec, location, user, franchiseeId: Number(row.franchisee_id), applicantId: Number(row.applicant_id), brand: String(row.brand), brandId: Number(row.brand_id), mats: [], recipes: [] });
  }
  return out;
}

/** Copies another branch's materials and recipes (for a branch that has none yet). */
async function cloneSetup(db: Db, ids: Ids, from: Branch, to: Branch, actorId: number) {
  const have = await db.query(`select count(*)::int as n from profittrack_materials where location_id = $1`, [to.location.id]);
  if (have[0].n > 0) return;
  const mats = await db.query(`select * from profittrack_materials where location_id = $1 and is_active = true order by id`, [from.location.id]);
  const map = new Map<number, number>();
  for (const m of mats) {
    const id = await ids.next('profittrack_materials');
    map.set(Number(m.id), id);
    await db.query(`insert into profittrack_materials (id, location_id, name, variant, unit, is_active, warehouse_product_id, source, low_level, critical_level, max_cover_days)
      values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10)`, [id, to.location.id, m.name, m.variant, m.unit, m.warehouse_product_id, m.source, m.low_level, m.critical_level, m.max_cover_days]);
    await db.query(`insert into profittrack_material_balances (location_id, material_id, quantity_milli) values ($1, $2, 0)`, [to.location.id, id]);
  }
  const recipes = await db.query(`select * from profittrack_recipes where location_id = $1 and is_active = true order by id`, [from.location.id]);
  for (const r of recipes) {
    const rid = await ids.next('profittrack_recipes');
    await db.query(`insert into profittrack_recipes (id, location_id, name, sku, image_path, standard_price_cents, is_active, current_version, created_by_user_id, updated_by_user_id, brand_product_id, source_signature)
      values ($1, $2, $3, $4, $5, $6, true, 1, $7, $7, $8, $9)`, [rid, to.location.id, r.name, r.sku, r.image_path, r.standard_price_cents, actorId, r.brand_product_id, r.source_signature]);
    const vid = await ids.next('profittrack_recipe_versions');
    await db.query(`insert into profittrack_recipe_versions (id, location_id, recipe_id, version, yield_pieces, created_by_user_id) values ($1, $2, $3, 1, 1, $4)`, [vid, to.location.id, rid, actorId]);
    const [version] = await db.query(`select id from profittrack_recipe_versions where recipe_id = $1 and version = $2`, [r.id, r.current_version]);
    for (const ing of await db.query(`select * from profittrack_recipe_ingredients where recipe_version_id = $1`, [version.id])) {
      if (!map.has(Number(ing.material_id))) continue;
      await db.query(`insert into profittrack_recipe_ingredients (location_id, recipe_version_id, material_id, quantity_milli_per_piece, unit) values ($1, $2, $3, $4, $5)`,
        [to.location.id, vid, map.get(Number(ing.material_id)), ing.quantity_milli_per_piece, ing.unit]);
    }
    await db.query(`insert into profittrack_finished_balances (location_id, recipe_id) values ($1, $2)`, [to.location.id, rid]);
  }
}

async function loadLedger(db: Db, b: Branch) {
  const mats = await db.query(
    `select m.*, bal.id as balance_id, p.unit as product_unit, p.pack_size from profittrack_materials m join profittrack_material_balances bal on bal.material_id = m.id
     left join products p on p.id = m.warehouse_product_id where m.location_id = $1 and m.is_active = true order by m.id`, [b.location.id],
  );
  b.mats = mats.map((m) => ({
    id: Number(m.id), name: String(m.name), unit: String(m.unit), wp: m.warehouse_product_id === null ? null : Number(m.warehouse_product_id),
    productUnit: m.product_unit ?? null, pack: m.pack_size === null ? null : Number(m.pack_size), low: m.low_level === null ? null : Number(m.low_level),
    critical: m.critical_level === null ? null : Number(m.critical_level), balanceId: Number(m.balance_id),
  }));
  const recipes = await db.query(
    `select r.id, r.name, v.id as version_id, (select fb.id from profittrack_finished_balances fb where fb.recipe_id = r.id limit 1) as finished_id
     from profittrack_recipes r join profittrack_recipe_versions v on v.recipe_id = r.id and v.version = r.current_version where r.location_id = $1 and r.is_active = true order by r.id`, [b.location.id],
  );
  b.recipes = [];
  for (const r of recipes) {
    const ings = await db.query(`select material_id, quantity_milli_per_piece from profittrack_recipe_ingredients where recipe_version_id = $1`, [r.version_id]);
    const ingredients = ings.map((i) => ({ materialId: Number(i.material_id), perPiece: Number(i.quantity_milli_per_piece) })).filter((i) => b.mats.some((m) => m.id === i.materialId) && i.perPiece > 0);
    if (ingredients.length) b.recipes.push({ id: Number(r.id), name: String(r.name), versionId: Number(r.version_id), ingredients, finishedId: r.finished_id === null ? null : Number(r.finished_id) });
  }
  if (!b.recipes.length) throw new Error(`${b.spec.name} has no recipe with ingredients.`);
}

/** Renames the branch, its franchisee and (for the reused accounts) the owner. */
async function identity(db: Db, b: Branch) {
  const s = b.spec;
  const [city] = await db.query(
    `select c.code as city_code, c.name as city, p.code as province_code, p.name as province from psgc_cities c join psgc_provinces p on p.code = c.province_code
     where c.name ilike $1 order by (c.name ilike $2) desc, length(c.name) limit 1`, [`%${s.city}%`, `${s.city} City`],
  );
  if (!city) throw new Error(`PSGC city not found: ${s.city}`);
  const address = `${s.barangay}, ${city.city}, ${city.province}`;
  await db.query(`update franchise_locations set is_demo = false, name = $2, branch_code = $3, address = $4, city = $5, province = $6, opening_date = $7, is_active = true, archived_at = null,
    archived_by_user_id = null, archive_reason = null, contact_number = coalesce(contact_number, $8) where id = $1`,
  [b.location.id, s.name, s.code, address, city.city, city.province, s.open, `0917${String(1000000 + Number(b.location.id) * 7919).slice(-7)}`]);
  b.location = { ...b.location, name: s.name, branch_code: s.code, address, city: city.city, province: city.province, opening_date: s.open, psgc: city };
  await db.query(`update franchisees set business_name = $2, franchise_status = 'active' where id = $1`, [b.franchiseeId, s.name]);
  if (s.owner) await db.query(`update users set full_name = $2, account_status = 'active', archived_at = null, suspended_from = null, suspended_until = null where id = $1`, [b.user.id, s.owner]);
  b.user = { ...b.user, full_name: s.owner ?? b.user.full_name };
}

// ---------------------------------------------------------------- simulation
interface DayPlan { day: string; batches: { recipe: Recipe; pieces: number; time: string }[] }

function profileOf(index: number, total: number) {
  if (total <= 2) return index === 0 ? 'core' : 'erratic';
  if (total === 3) return ['core', 'erratic', 'intermittent'][index];
  return ['core', 'core', 'erratic', 'intermittent', 'lumpy', 'core'][index % 6];
}

function plan(b: Branch): DayPlan[] {
  const r = rng(`plan:${b.spec.code}`);
  const base = (BRAND_BASE[b.brand.toLowerCase()] ?? 10) * b.spec.scale;
  const profiles = b.recipes.map((_, i) => profileOf(i, b.recipes.length));
  const cores = profiles.filter((p) => p === 'core').length || 1;
  const perCore = (base * 2.2) / cores;
  const closed = new Set<string>();
  for (const [from, to] of b.spec.forecast.closures ?? []) for (let d = from; d <= to; d = addDays(d, 1)) closed.add(d);
  const excludedWeek = b.spec.forecast.excludedWeek?.[0];
  const days: DayPlan[] = [];
  const nextLumpy = new Map<number, string>();
  for (let day = b.spec.open; day <= LAST_DAY; day = addDays(day, 1)) {
    if (closed.has(day)) continue;
    const age = daysBetween(b.spec.open, day);
    const ramp = Math.min(1, 0.6 + 0.4 * (age / 75));
    const weekend = dow(day) === 6 ? 1.25 : dow(day) === 0 ? 1.15 : 1;
    let factor = ramp * weekend * (1 + 0.08 * Math.sin(age / 9));
    if (b.spec.forecast.trend && daysBetween(day, LAST_DAY) < 7) factor *= 1 + b.spec.forecast.trend;
    if (excludedWeek && day >= excludedWeek && day <= addDays(excludedWeek, 6)) factor *= 0.45;
    const spike = b.spec.forecast.spikeDay === day ? 4 : 1;
    const detailed = day >= DETAIL_FROM;
    const batches: DayPlan['batches'] = [];
    b.recipes.forEach((recipe, i) => {
      const profile = profiles[i];
      let pieces = 0;
      if (profile === 'core') pieces = Math.round(perCore * factor * spike * (0.85 + 0.3 * r.next()));
      else if (!detailed) return;
      else if (profile === 'erratic') pieces = r.chance(0.45) ? r.int(0, 2) : Math.round(perCore * factor * (0.9 + 1.6 * r.next()));
      else if (profile === 'intermittent') pieces = (age + i) % 3 === 0 ? Math.round(perCore * 0.9 * factor * (0.92 + 0.16 * r.next())) : 0;
      else if (profile === 'lumpy') {
        const next = nextLumpy.get(recipe.id) ?? day;
        if (day >= next) { pieces = r.int(1, Math.max(2, Math.round(perCore * 3 * factor))); nextLumpy.set(recipe.id, addDays(day, r.int(3, 5))); }
      }
      if (pieces <= 0) return;
      if (detailed && profile === 'core' && pieces >= 6) {
        const morning = Math.ceil(pieces * (0.4 + 0.2 * r.next()));
        batches.push({ recipe, pieces: morning, time: r.time('09:10', '12:30') }, { recipe, pieces: pieces - morning, time: r.time('14:00', '19:30') });
      } else batches.push({ recipe, pieces, time: r.time('09:15', '19:30') });
    });
    batches.sort((a, c) => a.time.localeCompare(c.time));
    days.push({ day, batches });
  }
  return days;
}

export interface SimResult {
  branch: Branch; days: { day: string; batches: { recipe: Recipe; pieces: number; at: Date }[]; counts: { at: Date; items: { mat: Mat; before: number; counted: number; code: string | null }[] } | null }[];
  receipts: { req: SimRequest; at: Date; lines: { mat: Mat; milli: number }[] }[];
  requests: SimRequest[]; stock: Map<number, number>; finished: Map<number, number>;
}

/** Runs the branch: deliveries in the morning, production through the day, counts after closing. */
export function simulate(b: Branch): SimResult {
  const r = rng(`sim:${b.spec.code}`);
  const days = plan(b);
  const usage = new Map<string, Map<number, number>>();
  for (const d of days) {
    const u = new Map<number, number>();
    for (const batch of d.batches) for (const ing of batch.recipe.ingredients) u.set(ing.materialId, (u.get(ing.materialId) ?? 0) + ing.perPiece * batch.pieces);
    usage.set(d.day, u);
  }
  const avgAhead = (day: string, matId: number, n = 7) => {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += usage.get(addDays(day, i))?.get(matId) ?? 0;
    return total / n;
  };
  const lowCover = (m: Mat) => (b.spec.forecast.lowCover ?? []).some((re) => re.test(m.name));
  const overstock = b.spec.forecast.overstock ? b.mats.find((m) => b.spec.forecast.overstock!.test(m.name) && m.wp !== null) : undefined;
  const orderable = b.mats.filter((m) => m.wp !== null && (m.productUnit ?? '').toLowerCase() === m.unit.toLowerCase());
  const stock = new Map<number, number>(b.mats.map((m) => [m.id, 0]));
  const finished = new Map<number, number>();
  const pending: SimRequest[] = [];
  const requests: SimRequest[] = [];
  const result: SimResult = { branch: b, days: [], receipts: [], requests, stock, finished };

  const order = (day: string, opening: boolean) => {
    const lines: SimRequest['lines'] = [];
    const late = day >= addDays(b.spec.freezeFrom, -7);
    for (const m of orderable) {
      const u = Math.max(avgAhead(day, m.id, 10), avgAhead(addDays(day, -14), m.id, 14));
      if (u <= 0) continue;
      const inTransit = [...pending, ...requests.filter((q) => q.state)].reduce((s, p) => s + p.lines.filter((l) => l.mat.id === m.id).reduce((t, l) => t + l.qty * 1000, 0), 0);
      const position = (stock.get(m.id) ?? 0) + inTransit;
      // Reorder at about 5 days of cover, up to about 10; the last delivery before the freeze carries the branch to the end.
      const lastBeforeFreeze = !opening && day < b.spec.freezeFrom && daysBetween(day, b.spec.freezeFrom) <= 7;
      let want = opening ? u * 10 : position < u * 5 ? u * (lastBeforeFreeze ? 11 : 9.5) - position : lastBeforeFreeze && position < u * 8 ? u * 11 - position : 0;
      // Low cover at the end: smaller orders in the last weeks, never in an open request.
      if (!opening && late && lowCover(m)) want = day >= b.spec.freezeFrom ? 0 : position < u * 4 ? u * 6.5 - position : 0;
      if (!opening && late && overstock?.id === m.id && !requests.some((q) => q.lines.some((l) => l.mat.id === m.id && l.qty * 1000 > u * 30))) want = Math.max(want, u * 45);
      if (want <= 0) continue;
      lines.push({ mat: m, qty: roundUp(want / 1000, unitStep(m)) });
    }
    if (!lines.length) return;
    const created = at(day, opening ? '10:00' : r.time('09:20', '11:40'));
    const dispatch = addWorkingDays(day, 1);
    let delivery = addDays(dispatch, 2);
    if (delivery < addWorkingDays(day, 2)) delivery = addWorkingDays(day, 2);
    const req: SimRequest = { branch: b, created, createdDay: day, delivery, lines, state: day >= b.spec.freezeFrom ? 'open' : null, opening };
    if (opening) { req.delivery = b.spec.open; req.created = at(addDays(b.spec.open, -6), '10:00'); req.createdDay = addDays(b.spec.open, -6); }
    const story = (name: string, from: string) => !opening && !req.state && b.spec.extras.includes(name) && day >= from && !requests.some((q) => q.special === name);
    if (story('discrepancy_review', '2026-11-12') || story('completed_with_discrepancy', '2026-10-12')) {
      req.special = story('discrepancy_review', '2026-11-12') ? 'discrepancy_review' : 'completed_with_discrepancy';
      const line = req.lines.find((l) => l.qty >= 2) ?? req.lines[0];
      req.damaged = { matId: line.mat.id, qty: Math.max(unitStep(line.mat), roundUp(line.qty * 0.15, unitStep(line.mat))) };
    } else if (story('partial_backorder', '2026-11-09')) {
      req.special = 'partial_backorder';
      const line = req.lines.find((l) => l.qty >= 4) ?? req.lines[0];
      const shipped = roundUp(line.qty * 0.6, unitStep(line.mat));
      req.partial = { matId: line.mat.id, shipped, backorder: round(line.qty - shipped, 2) };
    }
    requests.push(req);
    if (!req.state) pending.push(req);
  };

  order(b.spec.open, true);
  for (const d of days) {
    // Deliveries arrive before opening.
    for (const req of pending.filter((p) => p.delivery <= d.day)) {
      pending.splice(pending.indexOf(req), 1);
      const arrived = at(d.day, r.time('08:20', '08:55'));
      const lines: SimResult['receipts'][number]['lines'] = [];
      for (const l of req.lines) {
        let milli = Math.round(l.qty * 1000);
        if (req.damaged && req.damaged.matId === l.mat.id) milli -= Math.round(req.damaged.qty * 1000);
        if (req.partial && req.partial.matId === l.mat.id) milli = Math.round(req.partial.shipped * 1000);
        stock.set(l.mat.id, (stock.get(l.mat.id) ?? 0) + milli);
        lines.push({ mat: l.mat, milli });
      }
      result.receipts.push({ req, at: arrived, lines });
    }
    // Production, capped by what is on hand.
    const batches: SimResult['days'][number]['batches'] = [];
    for (const batch of d.batches) {
      let pieces = batch.pieces;
      for (const ing of batch.recipe.ingredients) pieces = Math.min(pieces, Math.floor((stock.get(ing.materialId) ?? 0) / ing.perPiece));
      if (pieces <= 0) continue;
      for (const ing of batch.recipe.ingredients) stock.set(ing.materialId, stock.get(ing.materialId)! - ing.perPiece * pieces);
      finished.set(batch.recipe.id, (finished.get(batch.recipe.id) ?? 0) + pieces);
      batches.push({ recipe: batch.recipe, pieces, at: at(d.day, batch.time) });
    }
    // Counts: Monday, Wednesday, Friday and the last day; perishables lose a little.
    let counts: SimResult['days'][number]['counts'] = null;
    const stale = b.spec.forecast.staleAfter && d.day > b.spec.forecast.staleAfter;
    if (!stale && d.day >= addDays(b.spec.open, 2) && ([1, 3, 5].includes(dow(d.day)) || d.day === LAST_DAY)) {
      const items: NonNullable<typeof counts>['items'] = [];
      const pool = b.mats.filter((m) => (stock.get(m.id) ?? 0) > 0);
      // Monday (and the last day): every material; Wednesday and Friday: the perishables and a few others.
      const full = dow(d.day) === 1 || d.day === LAST_DAY;
      const chosen = full ? pool : pool.filter((m) => PERISHABLE.test(m.name)).slice(0, 5).concat(pool.filter((m) => !PERISHABLE.test(m.name)).sort(() => r.next() - 0.5).slice(0, 2));
      for (const m of chosen) {
        const before = stock.get(m.id)!;
        let counted = before;
        let code: string | null = null;
        if (PERISHABLE.test(m.name) && r.chance(0.55)) { counted = Math.max(0, before - Math.round(avgAhead(d.day, m.id, 3) * (0.04 + 0.1 * r.next()))); code = r.pick(COUNT_REASONS)[0]; }
        else if (r.chance(0.08)) { counted = before + Math.round(avgAhead(d.day, m.id, 3) * 0.05); code = 'encoding_error'; }
        if (counted !== before && code === null) code = 'unrecorded_use';
        stock.set(m.id, counted);
        items.push({ mat: m, before, counted, code: counted === before ? null : code });
      }
      if (d.day === LAST_DAY && b.spec.forecast.outOf) {
        const m = b.mats.find((x) => b.spec.forecast.outOf!.test(x.name));
        if (m && (stock.get(m.id) ?? 0) > 0) { items.push({ mat: m, before: stock.get(m.id)!, counted: 0, code: 'spoiled' }); stock.set(m.id, 0); }
      }
      if (items.length) counts = { at: at(d.day, r.time('20:10', '20:50')), items };
    }
    result.days.push({ day: d.day, batches, counts });
    // Restock check: Monday and Thursday (Mondays only in the older history).
    if (d.day < LAST_DAY && ((dow(d.day) === 1) || (dow(d.day) === 4 && d.day >= DETAIL_FROM))) order(d.day, false);
  }
  // Requests still on their way at the end are open too (their scenario decides the status).
  for (const req of pending) req.state = 'open';
  return result;
}

export { identity, loadLedger, cloneSetup };
