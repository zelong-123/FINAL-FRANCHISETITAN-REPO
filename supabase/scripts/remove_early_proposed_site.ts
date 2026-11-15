// One-off: the Proposed site requirement moved from Qualification to LOI Submission.
// Applicants BEFORE LOI Submission (Converted, Qualified, Scheduling) lose ONLY their Proposed site
// data: the requirement row (address, owned/leased, review status), its site photo records, the
// photo files in storage and the applicant_stage_histories rows of that requirement. Nothing else is
// touched. Every removal is written to audit_logs. Applicants at or past LOI Submission are refused.
//
// Usage (from the project root, reads .env):
//   node --no-warnings supabase/scripts/remove_early_proposed_site.ts --ids=22,24,25 --dry-run
//   node --no-warnings supabase/scripts/remove_early_proposed_site.ts --ids=22,24,25 --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

export const EARLY_STAGES = ['converted', 'qualified', 'scheduled'];
const REQUIREMENT_MODEL = 'App\\Models\\ApplicantRequirement';
const APPLICANT_MODEL = 'App\\Models\\Applicant';
type Files = { remove(disk: string, paths: string[]): Promise<void> };

export type RemovalPlan = {
  id: number; code: string | null; name: string; stage: string; action: 'delete' | 'refused' | 'nothing to delete'; reason?: string;
  requirement_id?: number; address?: string | null; ownership?: string | null; review_status?: string;
  documents?: { id: number; disk: string; path: string; original_name: string }[]; history_ids?: number[];
  /** Stored files still used by a document row that is NOT being deleted: never removed from storage. */
  shared_files?: string[];
};

/** Paths of the planned documents that another, kept document row also points to. */
async function sharedPaths(db: Db, plans: RemovalPlan[]): Promise<Set<string>> {
  const deleting = plans.flatMap((p) => p.documents ?? []);
  const ids = `{${deleting.map((d) => d.id).join(',') || '0'}}`;
  const shared = new Set<string>();
  for (const d of deleting) {
    const [other] = await db.query(`select 1 from documents where disk = $1 and path = $2 and not (id = any($3::bigint[])) limit 1`, [d.disk, d.path, ids]);
    if (other) shared.add(`${d.disk}/${d.path}`);
  }
  return shared;
}

/** Builds the plan for the given applicant ids; with apply = true, carries it out. */
export async function removeEarlyProposedSite(db: Db, files: Files, ids: number[], apply: boolean): Promise<RemovalPlan[]> {
  const plans: RemovalPlan[] = [];
  for (const id of ids) {
    const [a] = await db.query(`select id, applicant_code, full_name, status from applicants where id = $1`, [id]);
    if (!a) { plans.push({ id, code: null, name: '—', stage: '—', action: 'refused', reason: 'applicant not found' }); continue; }
    const base = { id: Number(a.id), code: a.applicant_code ?? null, name: a.full_name, stage: a.status };
    if (!EARLY_STAGES.includes(a.status)) { plans.push({ ...base, action: 'refused', reason: 'at or past LOI Submission: data is kept' }); continue; }
    const [req] = await db.query(`select * from applicant_requirements where applicant_id = $1 and requirement_key = 'proposed_site'`, [id]);
    if (!req) { plans.push({ ...base, action: 'nothing to delete' }); continue; }
    const documents = await db.query(
      `select id, disk, path, original_name from documents where documentable_type = $1 and documentable_id = $2 order by id`, [REQUIREMENT_MODEL, req.id],
    );
    const history = await db.query(`select id from applicant_stage_histories where applicant_id = $1 and step = 'proposed_site' order by id`, [id]);
    plans.push({
      ...base, action: 'delete', requirement_id: Number(req.id), address: req.data?.address ?? null, ownership: req.data?.ownership ?? null,
      review_status: req.status, documents: documents.map((d: Row) => ({ id: Number(d.id), disk: d.disk, path: d.path, original_name: d.original_name })),
      history_ids: history.map((h: Row) => Number(h.id)),
    });
  }
  const shared = await sharedPaths(db, plans);
  for (const plan of plans) if (plan.documents) plan.shared_files = plan.documents.map((d) => `${d.disk}/${d.path}`).filter((k) => shared.has(k));
  if (!apply) return plans;
  const removedFiles = new Set<string>();

  for (const plan of plans.filter((p) => p.action === 'delete')) {
    await db.tx(async (tx) => {
      // Re-check inside the transaction: the applicant must still be before LOI Submission.
      const [a] = await tx.query(`select status from applicants where id = $1 for update`, [plan.id]);
      if (!a || !EARLY_STAGES.includes(a.status)) throw new Error(`Applicant ${plan.id} moved to ${a?.status}; nothing was deleted for it.`);
      const docIds = `{${plan.documents!.map((d) => d.id).join(',')}}`;
      const historyIds = `{${plan.history_ids!.join(',')}}`;
      await tx.query(`delete from documents where documentable_type = $1 and id = any($2::bigint[])`, [REQUIREMENT_MODEL, docIds]);
      await tx.query(`delete from applicant_stage_histories where applicant_id = $1 and step = 'proposed_site' and id = any($2::bigint[])`, [plan.id, historyIds]);
      await tx.query(`delete from applicant_requirements where id = $1 and applicant_id = $2 and requirement_key = 'proposed_site'`, [plan.requirement_id, plan.id]);
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, $1, $2, $3, $4, $5, now())`,
        ['applicant.proposed_site_removed', APPLICANT_MODEL, plan.id,
          JSON.stringify({ requirement_key: 'proposed_site', address: plan.address, ownership: plan.ownership, review_status: plan.review_status,
            documents: plan.documents!.map((d) => ({ id: d.id, original_name: d.original_name, path: d.path })), history_ids: plan.history_ids }),
          JSON.stringify({ reason: 'Proposed site moved from Qualification to LOI Submission; the applicant enters it again at LOI Submission.', script: 'remove_early_proposed_site' })],
      );
    });
    // Files go after the commit, so a failed transaction never loses a file. A file another kept
    // document still points to is left in storage; a file already removed is not removed twice.
    for (const disk of new Set(plan.documents!.map((d) => d.disk))) {
      const paths = plan.documents!.filter((d) => d.disk === disk && !shared.has(`${disk}/${d.path}`) && !removedFiles.has(`${disk}/${d.path}`)).map((d) => d.path);
      await files.remove(disk, paths);
      paths.forEach((path) => removedFiles.add(`${disk}/${path}`));
    }
  }
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/remove_early_proposed_site.ts'));
if (isMain) {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const ids = String(arg('ids') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const apply = process.argv.includes('--apply');
  const dry = process.argv.includes('--dry-run');
  if (!ids.length || apply === dry) {
    console.error('Usage: --ids=22,24,25 and exactly one of --dry-run or --apply');
    process.exit(2);
  }
  const { openScriptDb, readEnv } = await import('./lib/scriptDb.ts');
  const env = await readEnv();
  const { createClient } = await import('@supabase/supabase-js');
  const db = await openScriptDb();
  const storage = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }).storage;
  const files: Files = {
    async remove(disk, paths) {
      if (!paths.length) return;
      const { error } = await storage.from(disk).remove(paths);
      if (error) throw new Error(`Storage remove failed (${disk}): ${error.message}`);
    },
  };
  try {
    const plans = await removeEarlyProposedSite(db, files, ids, apply);
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({
      id: p.id, code: p.code, name: p.name, stage: p.stage, action: p.action, reason: p.reason ?? '',
      address: p.address ?? '', ownership: p.ownership ?? '', review: p.review_status ?? '',
      files: p.documents?.length ?? 0, kept_shared_files: p.shared_files?.length ?? 0, history_rows: p.history_ids?.length ?? 0,
    })));
    for (const p of plans.filter((x) => x.documents?.length)) console.log(`  ${p.code} files:`, p.documents!.map((d) => `${d.disk}/${d.path} (${d.original_name})`).join(', '));
  } finally {
    await db.close();
  }
}
