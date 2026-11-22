import React, { useEffect, useState } from 'react';
import { FaChevronLeft, FaChevronRight } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import {
  PICKER_WEEKDAYS, calendarWeeks, dayTitle, formWindow, joinConfirmText, liveActions, monthTitle, shiftMonth, slotLabel,
} from '../../lib/smartSchedule';
import { endTimeLabel, timeLabel } from '../../lib/scheduleRules';

/*
 * The Schedule activity modal's smart parts (both entry points: Activities & Schedules and the
 * applicant's "Set schedule" / "Set again"). Every rule comes from the API:
 *   - useAvailability   (lib/useAvailability.js) GET /schedule-sessions/availability (the applicant's Sales user only, this activity only)
 *   - SmartStartPicker  Mon–Fri calendar with dots and dimmed days, hour slots 9–5 with reasons, Next available
 *   - LiveScheduleCheck POST /schedule-sessions/evaluate while the user picks; Join / Next available / Reassign
 *   - SessionsPanel     GET /schedule-sessions/joinable; Join this session / Open in Master Schedule
 * Nothing here schedules the applicant until a Join is confirmed or the form is saved.
 */

const sectionLabel = 'block text-muted text-[13px] font-[600] mb-[6px]';
/** Short inline reason for an unavailable hour slot (visible text, not hover-only). */
const shortReason = (reason = '') => {
  if (/limit|full|capacity/i.test(reason)) return 'Full';
  if (/5:00|5 PM|cutoff|after|end/i.test(reason)) return 'Ends after 5 PM';
  return 'Busy';
};
/** "2026-11-23" → "Nov 23, 2026" (calendar text only, no timezone shift). */
const formatPickedDay = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
const chip = 'inline-flex items-center gap-1 h-[24px] px-[9px] rounded-[7px] border text-[11.5px] font-[650]';
const smallButton = 'inline-flex items-center gap-[6px] h-[30px] px-[11px] rounded-[8px] border border-line text-[12px] font-[650] text-text [background:transparent] cursor-pointer hover:enabled:border-accent disabled:opacity-[0.45] disabled:cursor-not-allowed';

/** Starts: Mon–Fri calendar (dots = this Sales user's sessions of this activity) and hour slots 9:00–5:00 PM. */
export function SmartStartPicker({ availability, month, setMonth, form, onPick, activityLabel, keepSlot = null, durationField = null, locked = false }) {
  const { data, loading, error } = availability;
  const weeks = calendarWeeks(month, data?.days ?? []);
  const selectedDay = (data?.days ?? []).find((day) => day.date === form.start_date) ?? null;
  const next = data?.next_available ?? null;
  // Adjust (Edit): the activity's own day and start hour stay selectable, so the current time can be kept.
  const keepDate = keepSlot?.date ?? null;
  const keepHour = Number.isFinite(keepSlot?.hour) ? keepSlot.hour : null;

  return (
    <div className="col-span-full grid gap-[10px]" data-testid="smart-start-picker">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className={sectionLabel}>Date</span>
      </div>
      {error && <p className="m-0 text-danger text-[12.5px]" role="alert">{error}</p>}
      {data && !data.handler && <p className="m-0 text-danger text-[12.5px]" role="alert">This applicant has no assigned Sales user. Assign one before scheduling.</p>}

      <div className="grid grid-cols-[minmax(0,_1fr)_1px_minmax(0,_1fr)] max-[639px]:grid-cols-[minmax(0,_1fr)] gap-x-[20px] max-[639px]:gap-y-[20px] items-start [&>*]:min-w-0">
        <div className="grid gap-[8px]" aria-busy={loading}>
          <div className="flex items-center justify-between mb-[6px]">
            <button type="button" aria-label="Previous month" className="w-[28px] h-[28px] inline-grid place-items-center border border-line rounded-[7px] [background:transparent] text-text cursor-pointer" onClick={() => setMonth(shiftMonth(month, -1))}><FaChevronLeft aria-hidden="true" /></button>
            <strong className="text-[13px]">{monthTitle(month)}</strong>
            <button type="button" aria-label="Next month" className="w-[28px] h-[28px] inline-grid place-items-center border border-line rounded-[7px] [background:transparent] text-text cursor-pointer" onClick={() => setMonth(shiftMonth(month, 1))}><FaChevronRight aria-hidden="true" /></button>
          </div>
          <table className="w-full table-fixed border-collapse" aria-label={`${monthTitle(month)}, Monday to Friday`}>
            <thead><tr>{PICKER_WEEKDAYS.map((d) => <th key={d} className="text-muted text-[11px] font-[750] pb-[4px]">{d}</th>)}</tr></thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week.find(Boolean)?.date}>
                  {week.map((cell, index) => (
                    <td key={cell?.date ?? `blank-${index}`} className="p-[2px] text-center">
                      {cell && (
                        <button
                          type="button"
                          title={dayTitle(cell, activityLabel) || undefined}
                          aria-label={`${cell.date}${cell.sessions.length ? `, ${cell.sessions.length} session${cell.sessions.length === 1 ? '' : 's'}` : ''}${cell.available ? '' : `, unavailable: ${cell.reason ?? ''}`}`}
                          aria-pressed={cell.date === form.start_date}
                          aria-disabled={!cell.available && cell.date !== keepDate}
                          disabled={locked}
                          onClick={() => { if (!locked && (cell.available || cell.date === keepDate)) onPick({ date: cell.date }); }}
                          className={`w-[44px] h-[44px] mx-auto grid place-items-center content-center gap-[2px] rounded-[50%] border-0 text-[15px] ${cell.date === form.start_date ? 'bg-accent text-white font-[700]' : 'bg-transparent text-text font-[550]'} ${cell.available || cell.date === keepDate ? 'cursor-pointer hover:bg-[#222a40] focus-visible:outline-2 focus-visible:outline-accent' : 'text-[#5d6684] font-[400] opacity-100 cursor-default'}`}
                        >
                          <span>{cell.day}</span>
                          <span className="flex items-center gap-[2px] h-[6px]" aria-hidden="true">
                            {Array.from({ length: cell.dots }, (_, i) => <i key={i} className={`w-[4px] h-[4px] rounded-[50%] ${cell.date === form.start_date ? 'bg-white' : 'bg-[#7c88ff]'}`} />)}
                            {cell.more > 0 && <em className="not-italic text-[8px] text-muted">+{cell.more}</em>}
                          </span>
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div aria-hidden="true" className="hidden min-[640px]:block w-px self-stretch bg-[#1f2639]" />
        <div className="grid content-start gap-[12px]">
          {durationField}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted text-[13px] font-[600]">{form.start_date ? `Start time · ${form.start_date}` : 'Pick a day to see the start times.'}</span>
          </div>
          {selectedDay && (
            <div className="grid grid-cols-[repeat(3,_minmax(0,_1fr))] gap-[6px]" role="group" aria-label="Hour slots">
              {selectedDay.slots.map((slot) => {
                const hour = Number(slot.time.slice(0, 2));
                const chosen = Number(form.start_hour) === hour && Number(form.start_minute) === 0;
                const selectable = slot.available || (selectedDay.date === keepDate && hour === keepHour);
                return (
                  <button
                    key={slot.time}
                    type="button"
                    title={slot.reason || 'Free'}
                    aria-pressed={chosen}
                    aria-disabled={!selectable}
                    disabled={locked}
                    onClick={() => { if (!locked && selectable) onPick({ date: selectedDay.date, hour }); }}
                    className={`h-[40px] rounded-[8px] border-0 flex flex-col items-center justify-center text-[13px] leading-[1.2] ${chosen ? 'bg-accent text-white font-[700]' : selectable ? 'bg-[#161c2e] text-text font-[600] cursor-pointer hover:bg-[#222a40]' : 'bg-transparent text-[#5d6684] font-[500] cursor-not-allowed'}`}
                  >
                    {slotLabel(slot.time)}
                    {!selectable && <span className="text-[11px] font-normal text-[#8a94ad] leading-[1.2]">{shortReason(slot.reason)}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <button type="button" className="justify-self-start inline-flex items-center h-[36px] px-[8px] rounded-[8px] border-0 [background:transparent] text-[#aab4ff] text-[13px] font-[600] whitespace-nowrap cursor-pointer hover:bg-[#222a40] disabled:text-muted disabled:cursor-not-allowed" disabled={!next || locked} title={next ? next.label : 'No free time in the next 60 days.'} onClick={() => next && onPick({ date: next.date, hour: Number(next.time.slice(0, 2)), month: next.date.slice(0, 7) })}>
            {next ? `Next available: ${next.label}` : 'No available slots'}
          </button>
          <div className="inline-flex items-center justify-self-start h-[36px] px-[10px] rounded-[8px] border border-[#2f3752] [background:#0a0e1a] text-[14px] text-text whitespace-nowrap" role="status" aria-live="polite">
            {form.start_date ? (
              <>
                <strong>{formatPickedDay(form.start_date)}</strong>
                <span className="text-muted mx-[6px]">·</span>
                {timeLabel(form.start_hour, form.start_minute)} to {endTimeLabel(form)}
              </>
            ) : (
              <span className="text-muted">No date picked yet</span>
            )}
          </div>
          
        </div>
      </div>
    </div>
  );
}

/** Confirmation, then the existing participant API; `onJoined` closes the modal with a toast. */
function JoinConfirm({ row, applicantId, applicantName, onJoined, onCancel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const join = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await api.post(`/schedule-sessions/${row.id}/participants`, { applicant_id: Number(applicantId) });
      onJoined(response.message || 'Applicant added to the session.');
    } catch (failure) {
      setError(firstValidationMessage(failure));
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-[8px] p-[10px] border border-accent rounded-[10px] [background:color-mix(in_srgb,_var(--accent)_8%,_transparent)]" role="alertdialog" aria-label="Join this session">
      <p className="m-0 text-[13px] text-text">{joinConfirmText(row, applicantName)}</p>
      {error && <p className="m-0 text-danger text-[12.5px]" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className={smallButton} disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={`${smallButton} border-accent`} disabled={busy} onClick={join}>{busy ? 'Joining…' : 'Join'}</button>
      </div>
    </div>
  );
}

/** Live inline validation of the picked time, with the ways out. */
export function LiveScheduleCheck({ form, hours, applicantId, applicantName, activityType, activityLabel, availability, isAdmin, onUseNext, onJoined, onReassign }) {
  const window_ = formWindow(form, hours);
  const brandId = activityType === 'training' ? availability.data?.applicant_brand?.id ?? null : null;
  const request = window_ && applicantId && activityType ? {
    activity_type: activityType, brand_id: brandId, start_at: window_.start_at, end_at: window_.end_at,
    applicant_ids: [Number(applicantId)], venue: form.venue || null,
  } : null;
  const key = request ? JSON.stringify(request) : '';
  // Checked 300 ms after the last change (a timer callback, never a render-time setState).
  const [settledKey, setSettledKey] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledKey(key), 300);
    return () => window.clearTimeout(timer);
  }, [key]);
  const check = useRemote(async () => (settledKey ? (await api.post('/schedule-sessions/evaluate', JSON.parse(settledKey))).data : null), [settledKey]);
  // A Join confirmation belongs to the time it was opened for.
  const [joiningFor, setJoiningFor] = useState(null);
  const joining = joiningFor?.key === key ? joiningFor.row : null;
  const setJoining = (row) => setJoiningFor(row ? { key, row } : null);

  if (!key) return null;
  const evaluation = settledKey === key ? check.data : null;
  if (!evaluation) return check.error && settledKey === key ? null : <p className="col-span-full m-0 text-muted text-[12.5px]" role="status">Checking this time…</p>;
  if (evaluation.status === 'ok') {
    return <p className="col-span-full m-0 text-[12.5px] text-[#22c55e]" role="status">This time is free for the Sales user and the facility.</p>;
  }
  const actions = liveActions(evaluation, { isAdmin, nextAvailable: availability.data?.next_available ?? null });
  return (
    <div className="col-span-full grid gap-[8px] p-[10px_12px] border border-[color:color-mix(in_srgb,_var(--danger,_#ef4444)_45%,_transparent)] rounded-[10px] [background:color-mix(in_srgb,_var(--danger,_#ef4444)_7%,_transparent)]" role="alert" aria-live="polite">
      <ul className="m-0 pl-[18px] grid gap-[3px] text-[12.5px] text-text">
        {(evaluation.reasons || []).map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
      <div className="flex gap-2 flex-wrap">
        {actions.join && (
          <button type="button" className={smallButton} onClick={() => setJoining({
            id: actions.join.session_id, activity_label: activityLabel, date_label: '', time: actions.join.time, brand: actions.join.brand ? { name: actions.join.brand } : null, occupancy: actions.join.occupancy,
          })}>Join existing session</button>
        )}
        {actions.next && <button type="button" className={smallButton} onClick={() => onUseNext(actions.next)}>Use next available time</button>}
        {actions.reassign && <button type="button" className={smallButton} onClick={onReassign}>Reassign Sales</button>}
      </div>
      {joining && <JoinConfirm row={joining} applicantId={applicantId} applicantName={applicantName} onJoined={onJoined} onCancel={() => setJoining(null)} />}
    </div>
  );
}

const STATUS_CHIP = {
  pending: 'border-[rgba(245,158,11,0.45)] text-[#f59e0b]',
  confirmed: 'border-[rgba(34,197,94,0.45)] text-[#22c55e]',
  cancelled: 'border-[rgba(239,68,68,0.45)] text-[#ef4444]',
  completed: 'border-line text-muted',
};

/** [Sessions]: upcoming sessions of the activity by the applicant's Sales user. */
export function SessionsPanel({ applicantId, applicantName, activityType, activityLabel, onJoined, onOpenMaster }) {
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState(null);
  const remote = useRemote(async () => (open && applicantId && activityType
    ? (await api.get('/schedule-sessions/joinable', { applicant_id: applicantId, activity_type: activityType })).data
    : null), [open, applicantId, activityType]);
  const state = {
    rows: remote.data?.sessions ?? null,
    handler: remote.data?.handler ?? null,
    error: remote.error || remote.data?.reason || '',
    loading: open && remote.loading,
  };

  if (!applicantId || !activityType) return null;
  return (
    <div className="col-span-full grid gap-[8px]">
      <div>
        <button type="button" className={smallButton} aria-expanded={open} onClick={() => { setOpen((value) => !value); setJoining(null); }}>
          Sessions
        </button>
        <small className="ml-2 text-muted text-[11.5px]">Upcoming {activityLabel} sessions of the applicant&apos;s Sales user — join one instead of creating a new session.</small>
      </div>
      {open && (
        <div className="grid gap-[6px] p-[10px] border border-line rounded-[12px]" aria-busy={state.loading} aria-label="Upcoming sessions">
          {state.loading && <p className="m-0 text-muted text-[12.5px]">Loading sessions…</p>}
          {state.error && <p className="m-0 text-danger text-[12.5px]" role="alert">{state.error}</p>}
          {state.rows && !state.loading && !state.rows.length && !state.error && (
            <p className="m-0 text-muted text-[12.5px]">No upcoming {activityLabel} sessions for {state.handler?.full_name ?? 'this Sales user'}.</p>
          )}
          {(state.rows ?? []).map((row) => (
            <div key={row.id} className="grid gap-[6px] p-[8px_10px] border border-line rounded-[10px]">
              <div className="flex items-center gap-2 flex-wrap text-[12.5px] text-text">
                <strong>{row.date_label}</strong>
                <span>{row.time}</span>
                <span className="text-muted">{row.venue || 'No venue'}</span>
                {row.activity_type === 'training' && <span className={`${chip} border-line text-text`}>{row.brand?.name ?? 'No brand'}</span>}
                <span className={`${chip} border-line text-text`}>{row.occupancy}</span>
                <span className={`${chip} ${STATUS_CHIP[row.status] ?? 'border-line text-muted'} ${row.status === 'cancelled' ? 'line-through' : ''}`}>{row.status_label}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className={smallButton} disabled={!row.joinable} title={row.reason || undefined} onClick={() => setJoining(row)}>Join this session</button>
                <button type="button" className={smallButton} onClick={() => onOpenMaster(row)}>Open in Master Schedule</button>
                {!row.joinable && row.reason && <small className="text-muted text-[11.5px]">{row.reason}</small>}
              </div>
              {joining?.id === row.id && <JoinConfirm row={row} applicantId={applicantId} applicantName={applicantName} onJoined={onJoined} onCancel={() => setJoining(null)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
