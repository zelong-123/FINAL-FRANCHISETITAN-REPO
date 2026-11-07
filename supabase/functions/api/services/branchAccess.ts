// App\Services\ProfitTrackBranchAccess + BranchProvisioner: resolve the one branch of an
// active franchisee, creating it at first sign-in from the applicant's own preferences.
import type { Db, Row } from '../lib/db.ts';

const LOCATION_NOT_SET = 'Location not set';
const ACTIVE_FRANCHISEE = 'active_franchisee';

function canOperate(user: Row, location: Row, franchisee: Row): boolean {
  return user.account_status === 'active'
    && user.role?.name === 'franchisee'
    && location.type === 'franchise'
    && location.is_active === true
    && franchisee.franchise_status === 'active'
    && String(franchisee.user_id) === String(user.id);
}

function validLink(user: Row, franchisee: Row | undefined, applicant: Row | undefined): boolean {
  return Boolean(franchisee && applicant)
    && franchisee!.franchise_status === 'active'
    && applicant!.archived_at === null
    && applicant!.status === ACTIVE_FRANCHISEE
    && String(applicant!.user_id) === String(user.id)
    && String(franchisee!.user_id) === String(user.id);
}

const cleanPlace = (value: unknown): string | null => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text === '' ? null : [...text].slice(0, 100).join('');
};

const randomCode = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
};

export async function provisionBranch(db: Db, franchiseeId: number): Promise<Row | null> {
  return db.tx(async (tx) => {
    const [franchisee] = await tx.query(`select * from franchisees where id = $1 for update`, [franchiseeId]);
    if (!franchisee) return null;
    const existing = await tx.query(`select * from franchise_locations where franchisee_id = $1 order by id for update`, [franchiseeId]);
    const branch = existing.find((l) => l.type === 'franchise');
    if (branch) return branch;

    const [applicant] = await tx.query(`select * from applicants where id = $1`, [franchisee.applicant_id]);
    if (!applicant?.preferred_brand_id) return null;
    const [brand] = await tx.query(`select * from brands where id = $1`, [applicant.preferred_brand_id]);
    if (!brand) return null;
    const [inquiry] = applicant.inquiry_id
      ? await tx.query(`select preferred_franchise_location from franchise_inquiries where id = $1`, [applicant.inquiry_id])
      : [];
    const place = cleanPlace(inquiry?.preferred_franchise_location);

    let code: string;
    do {
      code = `BR-${franchiseeId}-${randomCode()}`;
    } while ((await tx.query(`select 1 from franchise_locations where branch_code = $1`, [code])).length);

    const [location] = await tx.query(
      `insert into franchise_locations (franchisee_id, brand_id, preferred_branch_type, name, branch_code, type, address, city, contact_number, is_active)
       values ($1, $2, $3, $4, $5, 'franchise', $6, $7, $8, true) returning *`,
      [franchiseeId, brand.id, brand.name, `${brand.name} · ${place ?? LOCATION_NOT_SET}`, code, place ?? LOCATION_NOT_SET, place, applicant.phone],
    );
    return location;
  });
}

/** Exactly one active branch from the signed-in account; ambiguous links are denied. */
export async function resolveWorkspace(db: Db, user: Row): Promise<Row | null> {
  if (user.account_status !== 'active' || user.role?.name !== 'franchisee') return null;

  const franchisees = await db.query(`select * from franchisees where user_id = $1 limit 2`, [user.id]);
  if (franchisees.length !== 1) return null;
  const [franchisee] = franchisees;
  const [applicant] = await db.query(`select * from applicants where id = $1`, [franchisee.applicant_id]);
  if (!validLink(user, franchisee, applicant)) return null;

  const active = await db.query(
    `select * from franchise_locations where franchisee_id = $1 and type = 'franchise' and is_active = true limit 2`,
    [franchisee.id],
  );
  if (active.length > 1) return null;
  if (active.length === 1) return canOperate(user, active[0], franchisee) ? active[0] : null;

  return db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from franchisees where id = $1 for update`, [franchisee.id]);
    const [freshApplicant] = await tx.query(`select * from applicants where id = $1`, [franchisee.applicant_id]);
    if (!validLink(user, locked, freshApplicant)) return null;

    const locations = await tx.query(
      `select * from franchise_locations where franchisee_id = $1 and type = 'franchise' limit 2 for update`,
      [locked.id],
    );
    if (locations.length > 1) return null;
    // An existing inactive branch is a deliberate Admin decision; never re-open it.
    if (locations[0] && !locations[0].is_active) return null;

    const location = await provisionBranch(tx, locked.id);
    return location?.is_active && canOperate(user, location, locked) ? location : null;
  });
}
