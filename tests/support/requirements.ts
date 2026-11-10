// Test helpers for requirements per stage: a valid submission for every configured item.
import assert from 'node:assert/strict';
import { requirementsOf } from '../../supabase/functions/api/services/requirements.ts';

type Call = (method: string, path: string, options?: { token?: string; body?: unknown; form?: FormData }) => Promise<{ status: number; json: any }>;

const SAMPLE: Record<string, string> = {
  id_type: 'passport', investment_range: '1m_2m', interview_date: '2026-11-01', interviewer: 'Sales User',
  notes: 'Applicant explained the business plan clearly.', address: '123 Real St, Las Pinas', ownership: 'leased',
  occupation: 'Restaurant manager', previous_experience: 'Ran a milk tea kiosk for two years.',
};

/** A complete, valid form for one requirement (every field + a file for every slot). */
export function requirementForm(key: string, stage = 'qualification', overrides: Record<string, string | null> = {}): FormData {
  const def = requirementsOf(stage).find((r) => r.key === key);
  assert.ok(def, `unknown requirement ${key}`);
  const form = new FormData();
  for (const field of def!.fields) {
    // An override of null leaves the field out; otherwise a sample value is used.
    const value = field.key in overrides ? overrides[field.key] : (SAMPLE[field.key] ?? 'Sample value');
    if (value !== null) form.set(field.key, value);
  }
  for (const slot of def!.files) {
    if (overrides[slot.key] === null) continue;
    const name = slot.accept.includes('pdf') ? `${slot.key}.pdf` : `${slot.key}.jpg`;
    form.set(slot.key, new File([new Uint8Array([4, 2])], name, { type: name.endsWith('pdf') ? 'application/pdf' : 'image/jpeg' }));
  }
  return form;
}

/** The assigned Sales user submits every requirement of a stage; Admin accepts them all. */
export async function completeStage(call: Call, sales: string, admin: string, applicantId: number, stage = 'qualification') {
  for (const def of requirementsOf(stage)) {
    const submitted = await call('POST', `/applicants/${applicantId}/requirements/${def.key}`, { token: sales, form: requirementForm(def.key, stage) });
    assert.equal(submitted.status, 201, `${def.key}: ${JSON.stringify(submitted.json)}`);
    const accepted = await call('POST', `/applicants/${applicantId}/requirements/${def.key}/accept`, { token: admin, body: {} });
    assert.equal(accepted.status, 200, `${def.key}: ${JSON.stringify(accepted.json)}`);
  }
}
