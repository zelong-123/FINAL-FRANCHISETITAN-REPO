// Defense demo data, end to end. See supabase/seed/defense-demo.mjs for how to run it.
import { readFileSync, statSync } from 'node:fs';
import type { Db, Row } from './common.ts';
import { Batch, Ids } from './common.ts';
import type { FileStore } from '../../functions/api/lib/env.ts';
import { cleanup } from './cleanup.ts';
import { cloneSetup, identity, loadBranches, loadLedger, simulate } from './branches.ts';
import { LEDGER_ORDER, writeLedger } from './ledger.ts';
import { writeSupply } from './supply.ts';
import { writeWarehouse } from './warehouse.ts';
import { applyApplicantUpdates, writePeople } from './applicants.ts';
import type { BrandKey } from './people.ts';

const FILES: Record<string, [string, string]> = {
  application_form: ['application-form.png', 'image/png'], valid_id: ['valid-id.png', 'image/png'], bank_certificate: ['bank-certificate.png', 'image/png'],
  interview_sheet: ['interview-sheet.png', 'image/png'], attendance: ['attendance-sheet.png', 'image/png'], brand_selection: ['brand-selection.png', 'image/png'],
  loi: ['loi.png', 'image/png'], agreement: ['franchise-agreement.png', 'image/png'], receipt: ['receipt.png', 'image/png'], pod: ['pod.png', 'image/png'],
  site_front: ['site-photo-front.jpg', 'image/jpeg'], site_street: ['site-photo-street.jpg', 'image/jpeg'], damaged: ['damaged-items.jpg', 'image/jpeg'],
};

export const WRITE_ORDER = [
  'franchise_inquiries', 'applicants', 'applicant_requirements', 'documents', 'activity_document_views', 'schedule_sessions', 'schedule_session_history', 'activity_schedules',
  'schedule_session_participants', 'applicant_payment_plans', 'applicant_required_payments', 'payments', 'applicant_status_histories', 'applicant_stage_histories', 'follow_ups',
  'applicant_follow_up_events', 'inquiry_archive_logs', 'supply_requests', 'supply_request_items', 'supply_reservations', 'supply_shortage_reports', 'supply_request_date_revisions', 'deliveries',
  'supply_request_status_histories', 'inventories', 'inventory_transactions', 'inventory_audit_logs', ...LEDGER_ORDER,
];

export async function uploadFiles(files: FileStore) {
  const docs: Record<string, { path: string; name: string; mime: string; size: number }> = {};
  for (const [key, [name, mime]] of Object.entries(FILES)) {
    const url = new URL(`./files/${name}`, import.meta.url);
    const bytes = new Uint8Array(readFileSync(url));
    const path = `demo/defense-2026-11-25/${name}`;
    await files.put('private', path, bytes, mime);
    docs[key] = { path, name, mime, size: statSync(url).size };
  }
  return docs;
}

export async function seedDefenseDemo(db: Db, files: FileStore, log: (s: string) => void = () => {}) {
  const t = Date.now();
  log('1. Clearing the old test data');
  await cleanup(db, (s) => log(`   ${s}`));
  const docs = await uploadFiles(files);
  const ids = new Ids(db);
  const batch = new Batch();
  const user = async (email: string) => (await db.query(`select u.*, r.name as role_name from users u join roles r on r.id = u.role_id where lower(u.email) = $1`, [email]))[0];
  const admin = await user('admin@franchisetitan.local');
  const logistics = await user('logistics@franchisetitan.local');
  const [warehouse] = await db.query(`select id from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);

  log('2. Branches: identity, materials, simulation');
  const branches = await loadBranches(db);
  for (const b of branches) if (b.spec.cloneFrom) await cloneSetup(db, ids, branches.find((x) => x.spec.email === b.spec.cloneFrom)!, b, admin.id);
  for (const b of branches) { await identity(db, b); await loadLedger(db, b); }
  const sims = branches.map((b) => simulate(b));

  log('3. Supply requests and the warehouse');
  const supply = await writeSupply({ db, ids, batch, admin, logistics, warehouseId: Number(warehouse.id), docs }, sims);
  await writeWarehouse(db, ids, batch, { ...supply, sims, logistics, warehouseId: Number(warehouse.id) });
  for (const sim of sims) await writeLedger(db, ids, batch, sim, admin.id);

  log('4. Inquiries, applicants and schedules');
  const brandRows = await db.query(`select id, name from brands`);
  const brandId = (name: string) => Number(brandRows.find((b) => b.name.toLowerCase() === name.toLowerCase())!.id);
  const brands: Record<BrandKey, number> = { kk: brandId('Kkopi'), gd: brandId('GoDo'), dd: brandId('Daily Dash'), lp: brandId('La Pasta') };
  const users = { admin, sales: await user('sales@franchisetitan.local'), herald: await user('heraldc3.23@gmail.com'), marketing: await user('marketing@franchisetitan.local') };
  const people = await writePeople({ db, ids, batch, docs, users, brands });

  log('5. Writing');
  await batch.write(db, WRITE_ORDER, (s) => log(`   ${s}`));
  await applyApplicantUpdates(db, people.updates);
  log(`Done in ${Math.round((Date.now() - t) / 1000)} s.`);
  return { branches, sims, docs, batch, people };
}
export type { Row };
