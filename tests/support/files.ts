// Test files with real contents (the API reads the first bytes, so a renamed file is refused) and the
// "open before you verify" steps: Admin opens each current file through the same routes the page uses.
type Call = (method: string, path: string, options?: any) => Promise<{ status: number; json: any }>;

const PDF = new TextEncoder().encode('%PDF-1.4 test file');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

/** A file whose contents match its extension (PDF, PNG or JPG/JPEG). */
export function realFile(name: string): File {
  const ext = name.split('.').pop()!.toLowerCase();
  if (ext === 'png') return new File([PNG], name, { type: 'image/png' });
  if (ext === 'jpg' || ext === 'jpeg') return new File([JPG], name, { type: 'image/jpeg' });
  return new File([PDF], name, { type: 'application/pdf' });
}

async function get(call: Call, token: string, path: string) {
  const res = await call('GET', path, { token });
  if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(res.json)}`);
}

/** Admin opens the current files of one requirement. */
export async function openRequirement(call: Call, token: string, applicantId: number, key: string, files: any[]) {
  for (const d of files.filter((x) => !x.replaced_at)) await get(call, token, `/applicants/${applicantId}/requirements/${key}/documents/${d.id}/download`);
}

/** Admin opens every current file of an applicant: requirement files, the LOI scan and payment receipts. */
export async function openAll(call: Call, token: string, applicantId: number) {
  const detail = await call('GET', `/applicants/${applicantId}`, { token });
  if (detail.status !== 200) throw new Error(`applicant ${applicantId}: ${detail.status}`);
  const data = detail.json.data;
  for (const item of data.requirements?.items ?? []) await openRequirement(call, token, applicantId, item.key, item.files ?? []);
  for (const d of (data.documents ?? []).filter((x: any) => x.file_state === 'current')) await get(call, token, `/applicants/${applicantId}/documents/${d.id}/download`);
  const record = data.payment_record;
  const entries = [...(record?.required ?? []).flatMap((r: any) => [r.entry, ...(r.history ?? [])]), ...(record?.earlier_entries ?? [])].filter(Boolean);
  for (const entry of entries) {
    for (const d of entry.receipts ?? []) await get(call, token, `/applicants/${applicantId}/payments/${entry.id}/documents/${d.id}/download`);
  }
}

/** Admin opens the current proof files of an activity. */
export async function openActivity(call: Call, token: string, activityId: number) {
  const res = await call('GET', `/activities/${activityId}`, { token });
  if (res.status !== 200) throw new Error(`activity ${activityId}: ${res.status}`);
  for (const d of (res.json.data.proof_documents ?? []).filter((x: any) => !x.replaced_at)) await get(call, token, `/activities/${activityId}/documents/${d.id}/download`);
}
