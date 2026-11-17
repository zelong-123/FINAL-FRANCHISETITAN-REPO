import React, { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import { manilaDateTimeLabel } from '../../lib/format';
import { LoadingState, Notice } from '../ApiUi';

const INPUT = 'w-[120px] [box-sizing:border-box] min-h-[40px] p-[8px_12px] border border-input-line rounded-[10px] [background:var(--input-bg)] text-text text-[14px] focus:[outline:2px_solid_color-mix(in_srgb,_var(--accent)_55%,_transparent)] focus:[outline-offset:1px]';

/** Admin settings → Follow-up rules: when an applicant shows Overdue and Stalled. */
export default function FollowUpRules() {
  const remote = useRemote(async () => (await api.get('/applicants/follow-up-settings')).data, []);
  const [edited, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // The saved values until Admin types.
  const form = edited ?? (remote.data ? { overdue_days: String(remote.data.overdue_days), stalled_days: String(remote.data.stalled_days) } : null);
  if (remote.loading || !form) return remote.error ? <Notice type="error" inline>{remote.error}</Notice> : <LoadingState label="Loading…" />;
  const overdue = Number(form.overdue_days);
  const stalled = Number(form.stalled_days);
  let problem = '';
  if (!Number.isInteger(overdue) || overdue < 1 || overdue > 60) problem = 'Overdue must be a whole number of days from 1 to 60.';
  else if (!Number.isInteger(stalled) || stalled > 120) problem = 'Stalled must be a whole number of days up to 120.';
  else if (stalled <= overdue) problem = 'Stalled must be more days than Overdue.';
  const save = async (event) => {
    event.preventDefault();
    if (problem) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.put('/applicants/follow-up-settings', { overdue_days: overdue, stalled_days: stalled });
      remote.setData(res.data);
      setSuccess(res.message || 'Follow-up rules saved.');
    } catch (err) {
      setError(firstValidationMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="grid gap-[14px] max-w-[640px]" noValidate>
      <Notice type="success">{success}</Notice>
      <div>
        <h2 className="m-0 mb-[6px] text-[12px] font-[800] tracking-[.12em] uppercase text-muted">Follow-up rules</h2>
        <p className="m-0 text-[14px] text-text-secondary leading-[1.6]">
          An applicant is <strong className="text-text">Overdue</strong> after this many days in the same stage with no Sales update (stage move, follow-up,
          requirement, activity or payment submission), and <strong className="text-text">Stalled</strong> after the second number. Not counted: an upcoming
          scheduled activity, anything waiting for Admin ("Waiting on Admin"), and time on hold.
        </p>
      </div>
      <div className="flex flex-wrap gap-[18px]">
        <label className="grid gap-[6px] text-[13px] font-[650] text-text">
          Overdue after (days)
          <input type="number" min={1} max={60} className={INPUT} value={form.overdue_days} onChange={(e) => setForm({ ...form, overdue_days: e.target.value })} />
        </label>
        <label className="grid gap-[6px] text-[13px] font-[650] text-text">
          Stalled after (days)
          <input type="number" min={2} max={120} className={INPUT} value={form.stalled_days} onChange={(e) => setForm({ ...form, stalled_days: e.target.value })} />
        </label>
      </div>
      {(problem || error) && <p className="m-0 text-danger-text text-[13px] font-[600]" role="alert">{problem || error}</p>}
      <div className="flex flex-wrap items-center gap-[12px]">
        <button type="submit" disabled={busy || Boolean(problem)} className="min-h-[38px] p-[0_16px] border border-transparent rounded-[10px] text-[#fff] font-[700] cursor-pointer [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Save rules'}
        </button>
        {remote.data?.updated_at && <small className="text-muted">Last saved {manilaDateTimeLabel(remote.data.updated_at)}{remote.data.updated_by ? ` by ${remote.data.updated_by}` : ''}</small>}
      </div>
    </form>
  );
}
