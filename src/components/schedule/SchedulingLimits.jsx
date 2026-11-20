import React, { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import { setScheduleConfig } from '../../lib/scheduleConfig';
import { LoadingState, Notice } from '../ApiUi';

const INPUT = 'w-[120px] [box-sizing:border-box] min-h-[40px] p-[8px_12px] border border-input-line rounded-[10px] [background:var(--input-bg)] text-text text-[14px] focus:[outline:2px_solid_color-mix(in_srgb,_var(--accent)_55%,_transparent)] focus:[outline-offset:1px]';

const FIELDS = [
  { key: 'orientation_capacity', label: 'Orientation/Tasting: applicants per session' },
  { key: 'orientation_facility_limit', label: 'Orientation/Tasting: sessions at the same time' },
  { key: 'training_capacity', label: 'Training: applicants per session' },
  { key: 'training_facility_limit', label: 'Training: sessions at the same time' },
];

/** Admin settings → Scheduling: capacity per session and facility limits (sessions at the same time). */
export default function SchedulingLimits() {
  const remote = useRemote(async () => (await api.get('/schedule-sessions/config')).data, []);
  const [edited, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const saved = remote.data?.limits;
  const bounds = remote.data?.limit_bounds ?? { min: 1, max: 50 };
  const form = edited ?? (saved ? Object.fromEntries(FIELDS.map(({ key }) => [key, String(saved[key])])) : null);
  if (remote.loading || !form) return remote.error ? <Notice type="error" inline>{remote.error}</Notice> : <LoadingState label="Loading…" />;
  const values = Object.fromEntries(FIELDS.map(({ key }) => [key, Number(form[key])]));
  const bad = FIELDS.find(({ key }) => !Number.isInteger(values[key]) || values[key] < bounds.min || values[key] > bounds.max);
  const problem = bad ? `${bad.label} must be a whole number from ${bounds.min} to ${bounds.max}.` : '';
  const save = async (event) => {
    event.preventDefault();
    if (problem) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await api.put('/schedule-sessions/config', values);
      remote.setData(res.data);
      setScheduleConfig(res.data);
      setForm(null);
      setSuccess(res.message || 'Scheduling limits saved.');
    } catch (err) {
      setError(firstValidationMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="grid gap-[14px] max-w-[720px]" noValidate>
      <Notice type="success">{success}</Notice>
      <div>
        <h2 className="m-0 mb-[6px] text-[12px] font-[800] tracking-[.12em] uppercase text-muted">Scheduling limits</h2>
        <p className="m-0 text-[14px] text-text-secondary leading-[1.6]">
          <strong className="text-text">Applicants per session</strong> is how many applicants one session takes.{' '}
          <strong className="text-text">Sessions at the same time</strong> is how many sessions of that activity may run at once across all
          Sales users (rooms or kitchens). A Sales user never has two sessions at the same time and keeps a 1-hour gap between sessions.
          Sessions run Monday to Friday and end by 5:00 PM. Changes apply to new and edited schedules; existing sessions stay as they are.
        </p>
      </div>
      <div className="grid gap-[14px] [grid-template-columns:repeat(2,_minmax(0,_1fr))] max-[681px]:[grid-template-columns:1fr]">
        {FIELDS.map(({ key, label }) => (
          <label key={key} className="grid gap-[6px] text-[13px] font-[650] text-text">
            {label}
            <input type="number" min={bounds.min} max={bounds.max} className={INPUT} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            <small className="text-muted font-[500]">Default {remote.data?.limit_defaults?.[key]}</small>
          </label>
        ))}
      </div>
      {(problem || error) && <p className="m-0 text-danger-text text-[13px] font-[600]" role="alert">{problem || error}</p>}
      <div>
        <button type="submit" disabled={busy || Boolean(problem)} className="min-h-[38px] p-[0_16px] border border-transparent rounded-[10px] text-[#fff] font-[700] cursor-pointer [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50 disabled:cursor-not-allowed">
          {busy ? 'Saving…' : 'Save limits'}
        </button>
      </div>
    </form>
  );
}
