// Payment Record entry form: cash needs no reference number, and 1 or 2 receipts per entry
// (keep / replace / remove before verification, kept on a rejected entry, locked once verified).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { openAll } from '../support/files.ts';

const { pg, call, login, files } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode('%PDF-1.4 receipt');
let n = 0;
let seq = 9000;

async function atPayment(preset = 'full') {
  n += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, loi_status, loi_verification_status)
     values ($1, 'payment_submitted', '2026-01-01', $2, 'waiting_total', 'complete', 'verified') returning id`, [`Receipt Person ${n}`, salesUser.id],
  );
  assert.equal((await call('PUT', `/applicants/${a.id}/required-payments`, { token: admin, body: { preset } })).status, 200);
  return a.id as number;
}
const record = async (id: number, token = admin) => (await call('GET', `/applicants/${id}/payment-record`, { token })).json.data;
const itemId = async (id: number, name: string) => (await record(id)).required.find((r: any) => r.name === name).id as number;
const receiptFile = (name: string) => (name.endsWith('.pdf') ? new File([PDF], name, { type: 'application/pdf' })
  : name.endsWith('.png') ? new File([PNG], name, { type: 'image/png' }) : new File([JPEG], name, { type: 'image/jpeg' }));
/** An entry form with exactly the given receipt files. */
function entryWith(requiredId: number, receipts: File[], extra: Record<string, string | null> = {}) {
  seq += 1;
  const form = new FormData();
  const values: Record<string, string | null> = {
    required_payment_id: String(requiredId), payment_date: '2026-11-01', payment_method: 'gcash', or_number: `OR-R-${seq}`, reference_number: `GC-R-${seq}`, ...extra,
  };
  for (const [k, v] of Object.entries(values)) if (v !== null) form.set(k, v);
  for (const file of receipts) form.append('receipt', file);
  return form;
}
const submit = (id: number, form: FormData) => call('POST', `/applicants/${id}/payment-entries`, { token: sales, form });
const edit = (id: number, paymentId: number, form: FormData) => call('PUT', `/applicants/${id}/payment-entries/${paymentId}`, { token: sales, form });
const revisionOf = async (paymentId: number) => (await q(`select revision from payments where id = $1`, [paymentId]))[0].revision;
const stored = (paymentId: number) => q(`select id, disk, path from documents where documentable_type = 'App\\Models\\Payment' and documentable_id = $1 order by id`, [paymentId]);

test('cash: the reference number is not needed and is stored as null, even if one is sent', async () => {
  const id = await atPayment();
  const full = await itemId(id, 'Full Payment');
  const sent = await submit(id, entryWith(full, [receiptFile('r.jpg')], { payment_method: 'cash', reference_number: 'TYPED-ANYWAY-1' }));
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.json.data.entry.reference_number, null);
  assert.equal((await q(`select reference_number from payments where id = $1`, [sent.json.data.entry.id]))[0].reference_number, null);

  const other = await atPayment();
  const missing = await submit(other, entryWith(await itemId(other, 'Full Payment'), [receiptFile('r.jpg')], { payment_method: 'gcash', reference_number: null }));
  assert.match(missing.json.errors.reference_number[0], /required for every payment that is not cash/, 'non-cash still needs it');

  // Switching an entry to cash clears its stored reference number.
  const bank = await atPayment();
  const e = (await submit(bank, entryWith(await itemId(bank, 'Full Payment'), [receiptFile('r.jpg')], { payment_method: 'bank_transfer', reference_number: 'BT-CLEAR-1' }))).json.data.entry;
  const changed = await edit(bank, e.id, entryWith(e.required_payment_id, [], { payment_method: 'cash', reference_number: 'BT-CLEAR-1' }));
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.data.required[0].entry.reference_number, null);
});

test('receipts: 1 or 2 files accepted; 0 and 3 refused; wrong type or size refused', async () => {
  const id = await atPayment('reservation_full');
  const reservation = await itemId(id, 'Reservation Fee');
  assert.match((await submit(id, entryWith(reservation, []))).json.errors.receipt[0], /Attach the receipt/);
  assert.match((await submit(id, entryWith(reservation, [receiptFile('a.jpg'), receiptFile('b.png'), receiptFile('c.pdf')]))).json.errors.receipt[0], /at most 2 receipt files/);
  assert.match((await submit(id, entryWith(reservation, [receiptFile('a.jpg'), new File(['x'], 'b.docx')]))).json.errors.receipt[0], /PDF, JPG or PNG/);
  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' });
  assert.match((await submit(id, entryWith(reservation, [receiptFile('a.jpg'), big]))).json.errors.receipt[0], /larger than 10 MB/);
  const renamed = new File([new TextEncoder().encode('not a pdf')], 'fake.pdf', { type: 'application/pdf' });
  assert.match((await submit(id, entryWith(reservation, [receiptFile('a.jpg'), renamed]))).json.errors.receipt[0], /not a real PDF, JPG or PNG/);

  const two = await submit(id, entryWith(reservation, [receiptFile('front.jpg'), receiptFile('back.pdf')]));
  assert.equal(two.status, 201, JSON.stringify(two.json));
  assert.deepEqual(two.json.data.entry.receipts.map((r: any) => r.original_name), ['front.jpg', 'back.pdf']);
  const adminView = (await record(id)).required.find((r: any) => r.name === 'Reservation Fee').entry;
  assert.equal(adminView.receipts.length, 2, 'Admin sees both');
  for (const doc of adminView.receipts) {
    assert.equal((await call('GET', `/applicants/${id}/payments/${adminView.id}/documents/${doc.id}/download`, { token: admin })).status, 200, 'Admin opens both');
    assert.equal((await call('GET', `/applicants/${id}/payments/${adminView.id}/documents/${doc.id}/download`, { token: sales })).status, 200, 'Sales opens both');
  }
  assert.equal((await submit(id, entryWith(await itemId(id, 'Full Payment'), [receiptFile('one.png')]))).status, 201, 'one file is enough');
});

test('editing an entry still For verification: keep, replace or remove receipts; removed files leave storage', async () => {
  const id = await atPayment();
  const full = await itemId(id, 'Full Payment');
  const e = (await submit(id, entryWith(full, [receiptFile('keep.jpg'), receiptFile('drop.png')]))).json.data.entry;
  const [keep, drop] = e.receipts;
  const [, dropFile] = await stored(e.id);
  assert.ok(files.store.has(`${dropFile.disk}/${dropFile.path}`));

  const none = entryWith(full, []);
  none.set('keep_receipt_ids', '');
  assert.match((await edit(id, e.id, none)).json.errors.receipt[0], /Attach the receipt/, 'at least one receipt must remain');
  const three = entryWith(full, [receiptFile('new1.jpg'), receiptFile('new2.jpg')]);
  three.set('keep_receipt_ids', String(keep.id));
  assert.match((await edit(id, e.id, three)).json.errors.receipt[0], /at most 2/);
  const foreign = entryWith(full, [receiptFile('x.jpg')]);
  foreign.set('keep_receipt_ids', '999999');
  assert.match((await edit(id, e.id, foreign)).json.errors.keep_receipt_ids[0], /Only receipts of this entry/);

  const replace = entryWith(full, [receiptFile('replacement.pdf')]);
  replace.set('keep_receipt_ids', String(keep.id));
  const done = await edit(id, e.id, replace);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual(done.json.data.required[0].entry.receipts.map((r: any) => r.original_name), ['keep.jpg', 'replacement.pdf']);
  assert.equal((await q(`select count(*)::int c from documents where id = $1`, [drop.id]))[0].c, 0, 'the removed receipt row is deleted');
  assert.equal(files.store.has(`${dropFile.disk}/${dropFile.path}`), false, 'and its file is deleted from storage (no orphan)');

  // Without keep_receipt_ids an edit keeps every receipt.
  const detailsOnly = await edit(id, e.id, entryWith(full, [], { remarks: 'Only the remarks changed.' }));
  assert.equal(detailsOnly.json.data.required[0].entry.receipts.length, 2);
});

test('a rejected entry keeps its receipts; Sales keeps one for the resubmission; verified receipts are locked', async () => {
  const id = await atPayment();
  const full = await itemId(id, 'Full Payment');
  const first = (await submit(id, entryWith(full, [receiptFile('slip.jpg'), receiptFile('blurry.png')]))).json.data.entry;
  assert.equal((await call('POST', `/applicants/${id}/payment-entries/${first.id}/reject`, { token: admin, body: { reason: 'The second photo is blurry.', revision: await revisionOf(first.id) } })).status, 200);
  const rejected = (await record(id, sales)).required[0].entry;
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.receipts.map((r: any) => r.original_name), ['slip.jpg', 'blurry.png'], 'Sales sees the receipts attached before');

  const resubmit = entryWith(full, [receiptFile('sharp.png')]);
  resubmit.set('keep_receipt_ids', String(rejected.receipts[0].id));
  const again = await submit(id, resubmit);
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.deepEqual(again.json.data.entry.receipts.map((r: any) => r.original_name), ['slip.jpg', 'sharp.png'], 'kept one, replaced the other');
  const [copy] = await stored(again.json.data.entry.id);
  const original = await stored(first.id);
  assert.notEqual(copy.path, original[0].path, 'the kept receipt is copied: the rejected entry keeps its own file as history');
  assert.equal(original.length, 2, 'the rejected entry still has both receipts');
  assert.ok(files.store.has(`${original[0].disk}/${original[0].path}`));

  await openAll(call, admin, id);
  assert.equal((await call('POST', `/applicants/${id}/payment-entries/${again.json.data.entry.id}/verify`, { token: admin, body: { revision: await revisionOf(again.json.data.entry.id) } })).status, 200);
  const locked = entryWith(full, [receiptFile('late.jpg')]);
  locked.set('keep_receipt_ids', '');
  const refused = await edit(id, again.json.data.entry.id, locked);
  assert.match(refused.json.errors.payment[0], /Verified and locked: its receipts can no longer change/);
  assert.equal((await stored(again.json.data.entry.id)).length, 2, 'verified receipts unchanged');
  assert.equal((await record(id, sales)).required[0].entry.receipts.length, 2, 'the Sales "Verified · locked" row lists both receipts');
});

test('keep_receipt_ids on a new entry may only name receipts of that payment\'s rejected entry', async () => {
  const id = await atPayment();
  const other = await atPayment();
  const theirs = (await submit(other, entryWith(await itemId(other, 'Full Payment'), [receiptFile('theirs.jpg')]))).json.data.entry.receipts[0];
  const form = entryWith(await itemId(id, 'Full Payment'), [receiptFile('mine.jpg')]);
  form.set('keep_receipt_ids', String(theirs.id));
  assert.match((await submit(id, form)).json.errors.keep_receipt_ids[0], /Only receipts of the rejected entry/);
});
