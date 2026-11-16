// Orientation/Tasting completion helpers: attendance proof (1–10), brand selection document (1–2)
// and the selected brand; Admin opens every current file before Verify.
const PDF = new TextEncoder().encode('%PDF-1.4 test file');
export const pdf = (name: string) => new File([PDF], name, { type: 'application/pdf' });

type Options = { attendance?: number; brandDocs?: number; brandId?: number | string | null; keep?: number[]; overrides?: Record<string, string> };

export function orientationForm({ attendance = 1, brandDocs = 1, brandId = null, keep, overrides = {} }: Options = {}) {
  const f = new FormData();
  f.set('attended', 'yes');
  f.set('actual_started_at', new Date(Date.now() - 3600_000).toISOString());
  f.set('handler_name', 'Sales User');
  f.set('result_notes', 'Attended the whole session and tasted every product.');
  for (let i = 1; i <= attendance; i += 1) f.append('attendance', pdf(`attendance-${i}.pdf`));
  for (let i = 1; i <= brandDocs; i += 1) f.append('brand_document', pdf(`brand-${i}.pdf`));
  if (brandId !== null && brandId !== undefined) f.set('selected_brand_id', String(brandId));
  if (keep) f.set('keep_document_ids', keep.join(','));
  for (const [k, v] of Object.entries(overrides)) f.set(k, v);
  return f;
}

type Call = (method: string, path: string, options?: any) => Promise<{ status: number; json: any }>;

/** Admin opens every current file of the activity (as the Verify gate requires). */
export async function viewAll(call: Call, token: string, activityId: number, docs: any[]) {
  for (const d of docs.filter((x) => !x.replaced_at)) {
    const res = await call('GET', `/activities/${activityId}/documents/${d.id}/download`, { token });
    if (res.status !== 200) throw new Error(`download ${d.id}: ${res.status}`);
  }
}

/** Sales completes Orientation/Tasting with the files and the brand; Admin opens the files and verifies. */
export async function completeAndVerify(call: Call, sales: string, admin: string, activityId: number, brandId: number) {
  const completed = await call('POST', `/activities/${activityId}/complete`, { token: sales, form: orientationForm({ brandId }) });
  if (completed.status !== 200) throw new Error(`complete: ${JSON.stringify(completed.json)}`);
  await viewAll(call, admin, activityId, completed.json.data.proof_documents);
  const verified = await call('POST', `/activities/${activityId}/attended`, { token: admin });
  if (verified.status !== 200) throw new Error(`verify: ${JSON.stringify(verified.json)}`);
  return verified;
}
