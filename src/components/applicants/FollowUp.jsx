import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaBell, FaCircleCheck, FaClock, FaHourglassHalf, FaPause, FaTriangleExclamation, FaXmark } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import { manilaDateTimeLabel } from '../../lib/format';
import {
  FOLLOW_UP_REASONS, followUpChip, followUpFormErrors, holdFormErrors, manilaDayOffset, manilaToday, reasonLabel,
} from '../../lib/followUpState';

// Applicant follow-up UI: the status chip (list + applicant modal), the Follow-up card in the applicant
// modal, and the Send reminder / Log follow-up / Put on hold / Close dialogs. Colors work in dark and light.

const TONES = {
  overdue: 'text-[#fb923c] border-[rgba(251,146,60,.45)] [background:rgba(251,146,60,.12)] light:text-[#c2410c] light:border-[rgba(194,65,12,.4)] light:[background:rgba(251,146,60,.14)]',
  stalled: 'text-[#f87171] border-[rgba(248,113,113,.5)] [background:rgba(248,113,113,.12)] light:text-[#b91c1c] light:border-[rgba(185,28,28,.4)] light:[background:rgba(248,113,113,.14)]',
  waiting: 'text-[#60a5fa] border-[rgba(96,165,250,.45)] [background:rgba(96,165,250,.12)] light:text-[#1d4ed8] light:border-[rgba(29,78,216,.35)] light:[background:rgba(96,165,250,.14)]',
  hold: 'text-[#a3adc2] border-[rgba(163,173,194,.45)] [background:rgba(163,173,194,.12)] light:text-[#475569] light:border-[rgba(71,85,105,.35)] light:[background:rgba(148,163,184,.16)]',
};
const ICONS = { overdue: FaClock, stalled: FaTriangleExclamation, waiting: FaHourglassHalf, hold: FaPause };
const CHIP = 'inline-flex items-center gap-[5px] p-[1px_8px] rounded-[999px] border text-[11px] font-[600] leading-[18px] whitespace-nowrap align-middle';

/**
 * The follow-up chip. For Admin, Overdue/Stalled is a button ("Remind") that opens Send reminder; otherwise a
 * static chip. The reason is the tooltip (title) and is read out by screen readers.
 */
export function FollowUpChip({ followUp, canRemind = false, onRemind, className = '' }) {
  const describedBy = useId();
  const chip = followUpChip(followUp);
  if (!chip) return null;
  const Icon = ICONS[chip.tone];
  const body = (
    <>
      <Icon aria-hidden="true" className="text-[10px]" />
      <span>{chip.text}</span>
    </>
  );
  if (canRemind && chip.remindable && onRemind) {
    return (
      <button
        type="button"
        className={`${CHIP} ${TONES[chip.tone]} cursor-pointer [transition:filter_.15s_ease,_box-shadow_.15s_ease] hover:[filter:brightness(1.18)] hover:[box-shadow:0_0_0_3px_color-mix(in_srgb,_currentColor_16%,_transparent)] focus-visible:[outline:2px_solid_currentColor] focus-visible:[outline-offset:2px] ${className}`}
        title={`${chip.tooltip} — click to send a reminder`}
        aria-describedby={describedBy}
        onClick={(event) => { event.stopPropagation(); onRemind(); }}
      >
        {body}
        <span className="inline-flex items-center gap-[3px] ml-[2px] pl-[6px] border-l border-l-[color-mix(in_srgb,_currentColor_35%,_transparent)]"><FaBell aria-hidden="true" className="text-[9px]" />Remind</span>
        <span id={describedBy} className="sr-only">{chip.tooltip}</span>
      </button>
    );
  }
  return (
    <span className={`${CHIP} ${TONES[chip.tone]} ${className}`} title={chip.tooltip} tabIndex={0} aria-describedby={describedBy}>
      {body}
      <span id={describedBy} className="sr-only">{chip.tooltip}</span>
    </span>
  );
}

const BUTTON = 'min-h-[34px] inline-flex items-center justify-center gap-[6px] p-[0_12px] border border-[#3a4256] rounded-[9px] [background:#121826] text-[#d6dcea] text-[13px] font-[650] cursor-pointer hover:border-[#5a6480] hover:[background:#1a2133] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:2px] light:[background:var(--panel)] light:border-line light:text-text light:hover:[background:var(--hover)]';
const PRIMARY = 'min-h-[34px] inline-flex items-center justify-center gap-[6px] p-[0_14px] border border-transparent rounded-[9px] text-[#fff] text-[13px] font-[700] cursor-pointer [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:2px]';

/**
 * The compact Follow-up card in the applicant modal: current state, last reminder, last follow-up and the
 * actions for the role. Hidden for stages that are not followed up (Approved, Active Franchisee, Rejected).
 */
export function FollowUpCard({ applicant, isAdmin, isAssignedSales, busy, onAction }) {
  const fu = applicant?.follow_up;
  if (!fu || applicant.archived_at || ['approved', 'active_franchisee', 'rejected'].includes(applicant.status)) return null;
  const state = fu.state;
  const remindable = state === 'overdue' || state === 'stalled';
  const lastFollowUp = fu.last_follow_up;
  const nextReminder = fu.next_reminder_at;
  return (
    <section className="m-[0_0_14px] p-[12px_14px] border border-[#2a3041] rounded-[12px] [background:#0C111D] light:[background:var(--panel)] light:border-line text-[13.5px] leading-[1.5] text-[#c9d0e0] light:text-text-secondary" aria-label="Follow-up">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <h3 className="m-0 text-[0.78rem] tracking-[0.09em] uppercase text-[#edf0fa] light:text-text">Follow-up</h3>
        {state ? <FollowUpChip followUp={fu} /> : (
          <span className={`${CHIP} text-[#4ade80] border-[rgba(74,222,128,.4)] [background:rgba(74,222,128,.1)] light:text-[#15803d] light:border-[rgba(21,128,61,.35)]`}>
            <FaCircleCheck aria-hidden="true" className="text-[10px]" />On track
          </span>
        )}
      </div>
      {fu.tooltip && <p className="m-[6px_0_0]">{fu.tooltip}</p>}
      {!state && fu.upcoming_activity_at && <p className="m-[6px_0_0] text-[#9aa6c4] light:text-muted">Next scheduled activity: {manilaDateTimeLabel(fu.upcoming_activity_at)}</p>}
      {!state && fu.next_action_at && new Date(fu.next_action_at) > new Date() && <p className="m-[6px_0_0] text-[#9aa6c4] light:text-muted">Next action date: {manilaDateTimeLabel(fu.next_action_at).replace(/,? \d+:\d+.*$/, '')}</p>}
      <dl className="grid gap-[4px] m-[8px_0_0] text-[12.5px] [&_dt]:inline [&_dt]:text-[#8f9bbd] light:[&_dt]:text-muted [&_dd]:inline [&_dd]:m-0">
        <div><dt>Last reminder: </dt><dd>{fu.last_reminder ? `Reminder sent by ${fu.last_reminder.by || 'Admin'} · ${manilaDateTimeLabel(fu.last_reminder.at)}` : 'None yet'}</dd></div>
        <div>
          <dt>Last follow-up: </dt>
          <dd>
            {lastFollowUp ? (
              <>
                {lastFollowUp.kind === 'overdue' ? reasonLabel(lastFollowUp.reason) : 'Contact logged'}
                {lastFollowUp.notes ? ` — ${lastFollowUp.notes}` : ''}
                {lastFollowUp.next_action_at ? ` · Next action ${manilaDateTimeLabel(lastFollowUp.next_action_at).replace(/,? \d+:\d+.*$/, '')}` : ''}
                {lastFollowUp.by ? ` · by ${lastFollowUp.by}` : ''}
              </>
            ) : 'None yet'}
          </dd>
        </div>
      </dl>
      {(isAdmin || (isAssignedSales && remindable)) && (
        <div className="flex flex-wrap items-center gap-[8px] mt-[10px]">
          {isAdmin && remindable && (
            <button type="button" className={PRIMARY} disabled={busy || Boolean(nextReminder)} onClick={() => onAction('remind')} title={nextReminder ? `Next reminder available at ${manilaDateTimeLabel(nextReminder)}` : undefined}>
              <FaBell aria-hidden="true" />Send reminder
            </button>
          )}
          {isAdmin && remindable && nextReminder && <small className="text-[#9aa6c4] light:text-muted">Next reminder available at {manilaDateTimeLabel(nextReminder)}</small>}
          {isAdmin && state === 'stalled' && <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('reassign')}>Reassign Sales</button>}
          {isAdmin && remindable && <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('hold')}><FaPause aria-hidden="true" />Put on hold</button>}
          {isAdmin && state === 'on_hold' && <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('release')}>Release hold</button>}
          {isAdmin && state === 'stalled' && <button type="button" className={BUTTON} disabled={busy} onClick={() => onAction('close')}>Close / Archive…</button>}
          {isAssignedSales && remindable && <button type="button" className={PRIMARY} disabled={busy} onClick={() => onAction('log')}>Log follow-up</button>}
        </div>
      )}
    </section>
  );
}

/** A small dialog on top of the applicant modal: theme colors, focus kept inside, Escape closes only this one. */
function FollowUpDialog({ title, onClose, footer, children }) {
  const titleId = useId();
  const cardRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const previousFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        // Capture phase + stop: the applicant modal underneath stays open.
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !cardRef.current) return;
      const focusable = [...cardRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    cardRef.current?.querySelector('textarea, select, input, button:not([aria-label="Close"])')?.focus();
    return () => { window.removeEventListener('keydown', onKey, true); previousFocus?.focus?.(); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 grid place-items-center p-5 max-[481px]:p-[10px] [background:rgba(2,_5,_12,_.66)] [backdrop-filter:blur(6px)]" style={{ zIndex: 2147483100 }} role="presentation" onMouseDown={() => closeRef.current?.()}>
      <div
        ref={cardRef}
        className="w-[min(520px,_100%)] max-h-[calc(100dvh_-_40px)] flex flex-col overflow-hidden border border-line-strong rounded-[16px] [background:var(--panel)] text-text [box-shadow:var(--shadow-xl)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line">
          <h2 id={titleId} className="m-0 text-[16px] font-[700] text-text">{title}</h2>
          <button type="button" aria-label="Close" className="inline-grid place-items-center w-[32px] h-[32px] border border-transparent rounded-[8px] [background:transparent] text-text-secondary cursor-pointer hover:[background:var(--hover)] hover:border-line focus-visible:[outline:2px_solid_var(--accent)]" onClick={onClose}><FaXmark aria-hidden="true" /></button>
        </header>
        <div className="flex-[1_1_auto] min-h-0 overflow-y-auto p-[16px_18px] grid gap-[12px] text-[14px] text-text-secondary">{children}</div>
        <footer className="flex flex-wrap items-center justify-end gap-[10px] p-[12px_18px] border-t border-t-line [background:var(--surface-subtle)]">{footer}</footer>
      </div>
    </div>,
    document.body,
  );
}

const INPUT = 'w-full [box-sizing:border-box] min-h-[40px] p-[8px_12px] border border-input-line rounded-[10px] [background:var(--input-bg)] text-text text-[14px] [font-family:inherit] focus:[outline:2px_solid_color-mix(in_srgb,_var(--accent)_55%,_transparent)] focus:[outline-offset:1px] aria-[invalid=true]:border-danger';
const LABEL = 'grid gap-[6px] text-[13px] font-[650] text-text';
const DIALOG_SECONDARY = 'min-h-[36px] p-[0_14px] border border-line rounded-[9px] [background:var(--panel)] text-text-secondary text-[13px] font-[650] cursor-pointer hover:[background:var(--hover)] hover:text-text disabled:opacity-50 disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--accent)]';
const FieldError = ({ id, children }) => (children ? <small id={id} className="text-danger-text text-[12.5px] font-[600]" role="alert">{children}</small> : null);
const ErrorBox = ({ children }) => (children ? <p className="m-0 p-[9px_12px] rounded-[10px] border border-[rgba(248,113,113,.4)] [background:rgba(248,113,113,.1)] text-danger-text text-[13px]" role="alert">{children}</p> : null);

function Summary({ applicant, followUp }) {
  return (
    <div className="grid gap-[4px] p-[10px_12px] border border-line rounded-[12px] [background:var(--surface-subtle)]">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <strong className="text-text text-[15px]">{applicant.full_name}{applicant.applicant_code ? <span className="ml-[6px] text-muted text-[12.5px] font-[600]">{applicant.applicant_code}</span> : null}</strong>
        <FollowUpChip followUp={followUp} />
      </div>
      <span className="text-[13px]">Stage: <strong className="text-text">{followUp?.stage_label || applicant.status_label || applicant.status}</strong></span>
      <span className="text-[13px]">Last update: {followUp?.last_update?.at ? `${manilaDateTimeLabel(followUp.last_update.at)}${followUp.last_update.by ? ` by ${followUp.last_update.by}` : ''}` : 'none recorded'}</span>
      <span className="text-[13px]">Last reminder: {followUp?.last_reminder?.at ? `${manilaDateTimeLabel(followUp.last_reminder.at)} by ${followUp.last_reminder.by || 'Admin'}` : 'None yet'}</span>
    </div>
  );
}

function SendReminderDialog({ applicantId, onClose, onDone }) {
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get(`/applicants/${applicantId}/reminder-draft`)
      .then((res) => { if (alive) { setDraft(res.data); setMessage(res.data.message); } })
      .catch((err) => alive && setError(firstValidationMessage(err)));
    return () => { alive = false; };
  }, [applicantId]);
  const nextAt = draft?.follow_up?.next_reminder_at;
  const tooShort = message.trim().length < 5;
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/applicants/${applicantId}/reminders`, { message: message.trim() });
      onDone(res.message || 'Reminder sent.');
    } catch (err) {
      setError(firstValidationMessage(err));
      setBusy(false);
    }
  };
  return (
    <FollowUpDialog
      title="Send reminder"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={DIALOG_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={busy || !draft || Boolean(nextAt) || tooShort} onClick={send} title={nextAt ? `Next reminder available at ${manilaDateTimeLabel(nextAt)}` : undefined}>
            <FaBell aria-hidden="true" />{busy ? 'Sending…' : 'Send reminder'}
          </button>
        </>
      )}
    >
      {!draft && !error && <p className="m-0 text-muted">Loading…</p>}
      {draft && <Summary applicant={draft.applicant} followUp={draft.follow_up} />}
      {draft && (
        <p className="m-0 text-[13px]">
          {draft.assigned_sales ? <>The reminder goes to <strong className="text-text">{draft.assigned_sales.full_name}</strong> as an in-app notification.</> : 'No Sales user is assigned: assign one first.'}
        </p>
      )}
      {nextAt && <p className="m-0 p-[9px_12px] rounded-[10px] border border-line [background:var(--surface-subtle)] text-[13px]">A reminder was sent in the last 24 hours. Next reminder available at <strong className="text-text">{manilaDateTimeLabel(nextAt)}</strong>.</p>}
      {draft && (
        <label className={LABEL}>
          Message
          <textarea className={`${INPUT} min-h-[120px]`} value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} aria-invalid={tooShort} />
          {tooShort && <FieldError>Write a message of at least 5 characters.</FieldError>}
        </label>
      )}
      <ErrorBox>{error}</ErrorBox>
    </FollowUpDialog>
  );
}

function LogFollowUpDialog({ applicant, onClose, onDone }) {
  const [form, setForm] = useState({ reason: '', notes: '', next_action_date: '' });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = followUpFormErrors(form);
  const show = (key) => (tried ? errors[key] : null);
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/applicants/${applicant.id}/follow-ups`, { kind: 'overdue', reason: form.reason, notes: form.notes.trim(), next_action_date: form.next_action_date });
      onDone(res.message || 'Follow-up logged.');
    } catch (err) {
      setError(firstValidationMessage(err));
      setBusy(false);
    }
  };
  return (
    <FollowUpDialog
      title="Log follow-up"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={DIALOG_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save follow-up'}</button>
        </>
      )}
    >
      <Summary applicant={applicant} followUp={applicant.follow_up} />
      <label className={LABEL}>
        Reason
        <select className={INPUT} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-invalid={Boolean(show('reason'))} aria-describedby="fu-reason-error">
          <option value="">Choose a reason…</option>
          {FOLLOW_UP_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <FieldError id="fu-reason-error">{show('reason')}</FieldError>
      </label>
      <label className={LABEL}>
        Note{form.reason === 'other' ? ' (required for Other)' : ' (optional)'}
        <textarea className={`${INPUT} min-h-[84px]`} value={form.notes} maxLength={5000} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-invalid={Boolean(show('notes'))} aria-describedby="fu-notes-error" />
        <FieldError id="fu-notes-error">{show('notes')}</FieldError>
      </label>
      <label className={LABEL}>
        Next action date
        <input type="date" className={INPUT} min={manilaToday()} value={form.next_action_date} onChange={(e) => setForm({ ...form, next_action_date: e.target.value })} aria-invalid={Boolean(show('next_action_date'))} aria-describedby="fu-next-error fu-next-hint" />
        <small id="fu-next-hint" className="text-muted text-[12px] font-[500]">The applicant is not Overdue until this date has passed. Admin is notified with your reason.</small>
        <FieldError id="fu-next-error">{show('next_action_date')}</FieldError>
      </label>
      <ErrorBox>{error}</ErrorBox>
    </FollowUpDialog>
  );
}

function HoldDialog({ applicant, onClose, onDone }) {
  const [form, setForm] = useState({ reason: '', until: manilaDayOffset(14) });
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errors = holdFormErrors(form);
  const show = (key) => (tried ? errors[key] : null);
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/applicants/${applicant.id}/hold`, { reason: form.reason.trim(), until: form.until });
      onDone(res.message || 'Applicant put on hold.');
    } catch (err) {
      setError(firstValidationMessage(err));
      setBusy(false);
    }
  };
  return (
    <FollowUpDialog
      title="Put on hold"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={DIALOG_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Put on hold'}</button>
        </>
      )}
    >
      <Summary applicant={applicant} followUp={applicant.follow_up} />
      <p className="m-0 text-[13px]">While on hold the follow-up timer is paused and the applicant shows "On hold until …". The assigned Sales user is notified.</p>
      <label className={LABEL}>
        Reason
        <textarea className={`${INPUT} min-h-[72px]`} value={form.reason} maxLength={2000} onChange={(e) => setForm({ ...form, reason: e.target.value })} aria-invalid={Boolean(show('reason'))} />
        <FieldError>{show('reason')}</FieldError>
      </label>
      <label className={LABEL}>
        On hold until
        <input type="date" className={INPUT} min={manilaDayOffset(1)} value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} aria-invalid={Boolean(show('until'))} />
        <FieldError>{show('until')}</FieldError>
      </label>
      <ErrorBox>{error}</ErrorBox>
    </FollowUpDialog>
  );
}

function CloseDialog({ applicant, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const invalid = reason.trim().length < 5;
  const save = async () => {
    setTried(true);
    if (invalid) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/applicants/${applicant.id}/close`, { reason: reason.trim() });
      onDone(res.message || 'Applicant closed and archived.', { closed: true });
    } catch (err) {
      setError(firstValidationMessage(err));
      setBusy(false);
    }
  };
  return (
    <FollowUpDialog
      title="Close / Archive applicant"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className={DIALOG_SECONDARY} onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={PRIMARY} disabled={busy} onClick={save}>{busy ? 'Closing…' : 'Close and archive'}</button>
        </>
      )}
    >
      <Summary applicant={applicant} followUp={applicant.follow_up} />
      <p className="m-0 text-[13px]">The applicant is archived (the same as Archive) with this reason. It can be restored from Admin settings → Archive → Applicants.</p>
      <label className={LABEL}>
        Reason
        <textarea className={`${INPUT} min-h-[84px]`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} aria-invalid={tried && invalid} />
        {tried && invalid && <FieldError>Give a reason of at least 5 characters.</FieldError>}
      </label>
      <ErrorBox>{error}</ErrorBox>
    </FollowUpDialog>
  );
}

/**
 * The open follow-up dialog, if any. `action` = { kind: 'remind' | 'log' | 'hold' | 'close', applicant }.
 * onDone(message, extra) runs after a successful save (the page shows the toast and reloads).
 */
export function FollowUpDialogs({ action, onClose, onDone }) {
  if (!action?.applicant) return null;
  const { kind, applicant } = action;
  if (kind === 'remind') return <SendReminderDialog applicantId={applicant.id} onClose={onClose} onDone={onDone} />;
  if (kind === 'log') return <LogFollowUpDialog applicant={applicant} onClose={onClose} onDone={onDone} />;
  if (kind === 'hold') return <HoldDialog applicant={applicant} onClose={onClose} onDone={onDone} />;
  if (kind === 'close') return <CloseDialog applicant={applicant} onClose={onClose} onDone={onDone} />;
  return null;
}
