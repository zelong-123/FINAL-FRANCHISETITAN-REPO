import React, { useState } from 'react';
import { Field } from './ApiUi';
import { fromManilaInput, manilaDateTimeLabel, toManilaInput } from '../lib/format';

// Mirrors services/monitoring.ts (the API validates the same values).
const FOLLOW_UP_CHANNELS = { call: 'Call', text: 'Text', viber: 'Viber', email: 'Email', in_person: 'In person', other: 'Other' };
const FOLLOW_UP_OUTCOMES = { reached: 'Reached', no_answer: 'No answer', rescheduled: 'Rescheduled', not_interested: 'Not interested' };

/**
 * The follow-up log of an inquiry (Marketing) or an applicant (assigned Sales): every contact
 * attempt with its channel, outcome, notes and the next follow-up date. Entries are never edited.
 */
export default function FollowUpLog({ items = [], canAdd = false, busy = false, onAdd, title = 'Follow-up log', surfaceClass = '[background:#141a28]' }) {
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(false);
  const start = () => {
    setForm({ contacted_at: toManilaInput(new Date()), channel: 'call', outcome: 'reached', notes: '', next_follow_up_at: '' });
    setOpen(true);
  };
  const ready = form && form.contacted_at && form.notes.trim().length >= 5 && (form.outcome !== 'rescheduled' || form.next_follow_up_at);
  const send = () => {
    onAdd({
      contacted_at: fromManilaInput(form.contacted_at),
      channel: form.channel,
      outcome: form.outcome,
      notes: form.notes.trim(),
      ...(form.next_follow_up_at ? { next_follow_up_at: fromManilaInput(form.next_follow_up_at) } : {}),
    });
    setOpen(false);
  };
  return (
    <section className={`ap-section m-[0_0_17px] p-[17px] border border-[#2a3041] rounded-[13px] ${surfaceClass} text-[14px] leading-[1.5] text-[#c9d0e0]`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa]">{title}</h3>
        <small className="text-[#9ba5bd]">{items.length} logged</small>
      </div>
      {!items.length && <p className="m-[8px_0_0] text-muted">No follow-up logged yet.</p>}
      {items.length > 0 && (
        <ul className="m-[10px_0_0] p-0 [list-style:none] grid gap-2">
          {items.map((item) => (
            <li key={item.id} className="p-[10px_12px] border border-[#2b344c] rounded-[10px] [background:#0c111d] grid gap-[3px]">
              <span><strong className="text-[#edf0fa]">{FOLLOW_UP_OUTCOMES[item.outcome] || item.outcome}</strong> · {FOLLOW_UP_CHANNELS[item.channel] || item.channel} · {manilaDateTimeLabel(item.contacted_at)}</span>
              <span>{item.notes}</span>
              <small className="text-[#8f9bbd]">By {item.by_name || '—'}{item.next_follow_up_at ? ` · Next follow-up: ${manilaDateTimeLabel(item.next_follow_up_at)}` : ''}</small>
            </li>
          ))}
        </ul>
      )}
      {canAdd && !open && <button type="button" className="mt-3 min-h-[32px] p-[0_16px] border border-[#2b344c] rounded-[8px] bg-[#070A12] text-[#e6eaf5] text-[12px] font-[600] cursor-pointer hover:border-[#7b88ff] disabled:opacity-50" disabled={busy} onClick={start}>Log follow-up</button>}
      {canAdd && form && (
        <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`} aria-hidden={!open}>
        <div className="min-h-0 overflow-hidden">
        <div className="grid gap-[10px] mt-3">
          <Field label="Date and time" required>
            <input type="datetime-local" max={toManilaInput(new Date())} value={form.contacted_at} onChange={(e) => setForm({ ...form, contacted_at: e.target.value })} />
          </Field>
          <Field label="Channel" required>
            <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              {Object.entries(FOLLOW_UP_CHANNELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <Field label="Outcome" required>
            <select value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
              {Object.entries(FOLLOW_UP_OUTCOMES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </Field>
          <Field label="Notes (at least 5 characters)" required full>
            <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What was discussed" />
          </Field>
          <Field label={form.outcome === 'rescheduled' ? 'Next follow-up (required)' : 'Next follow-up'} required={form.outcome === 'rescheduled'} hint="You get a reminder when it is due.">
            <input type="datetime-local" value={form.next_follow_up_at} onChange={(e) => setForm({ ...form, next_follow_up_at: e.target.value })} />
          </Field>
          <span className="flex justify-end gap-2">
            <button type="button" className="min-h-[32px] p-[0_14px] border border-[rgba(248,113,113,0.5)] rounded-[8px] bg-transparent text-[#f87171] text-[12px] font-[600] cursor-pointer hover:bg-[rgba(248,113,113,0.08)] disabled:opacity-50" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="min-h-[32px] p-[0_14px] border border-[#3b5bdb] rounded-[8px] bg-[#1e3a8a] text-white text-[12px] font-[600] cursor-pointer hover:brightness-110 disabled:opacity-50" disabled={busy || !ready} onClick={send}>
              Save follow-up
            </button>
          </span>
        </div>
        </div>
        </div>
      )}
    </section>
  );
}
