import React, { useState } from 'react';
import { api, ApiError, firstValidationMessage } from '../../lib/api';
import { Modal } from '../ApiUi';
import { activityLabel, formatSessionRange } from '../../lib/scheduleSessions';

/*
 * What happens after a drag is dropped (Phase 3). The backend has already
 * evaluated the drop; this dialog only asks the user to confirm — and the
 * backend checks everything AGAIN on the save (move / merge).
 *
 *  kind 'blocked' → reasons + up to 3 suggested times (the event is already back)
 *  kind 'merge'   → Admin dropped onto a session: "Merge N applicants into this session?"
 *  kind 'move'    → dropped on a time: confirm; mergeable / warning choices per role
 *
 * Cancel/Back always puts the event back where it was (drop.revert).
 */
export default function DropDialog({ drop, isAdmin, onClose, onDone, onPickSuggestion }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState([]);
  const [remarks, setRemarks] = useState('');

  const cancel = () => {
    drop.revert?.();
    onClose();
  };

  const run = async (request, message) => {
    setBusy(true);
    setError('');
    setReasons([]);
    try {
      await request();
      onDone(message);
    } catch (requestError) {
      setError(firstValidationMessage(requestError));
      if (requestError instanceof ApiError) {
        const evaluation = requestError.payload?.evaluation;
        setReasons([...(evaluation?.reasons || []), ...(evaluation?.warnings || [])]);
      }
    } finally {
      setBusy(false);
    }
  };

  const session = drop.session;
  const applicants = session?.participant_count ?? 0;
  const merge = (target) => run(
    () => api.post(`/schedule-sessions/${session.id}/merge`, { target_session_id: target.id ?? target.session_id }),
    `Merged into the ${activityLabel(session.activity_type)} session at ${formatSessionRange(target.start_at, target.end_at)}.`,
  );
  const move = (decision = {}) => run(
    () => api.post(`/schedule-sessions/${session.id}/move`, {
      start_at: drop.start.toISOString(),
      end_at: drop.end.toISOString(),
      override_remarks: remarks.trim() || undefined,
      from_suggestion: drop.fromSuggestion || undefined,
      ...decision,
    }),
    isAdmin ? 'Session rescheduled.' : 'Session rescheduled — it is Pending until Admin confirms it.',
  );

  let title;
  let body;
  let actions;

  if (drop.kind === 'blocked') {
    title = 'Hindi puwedeng ilipat dito';
    body = (
      <>
        <ul className="m-[0_0_8px] pl-[18px] text-danger-text text-[12px]">{(drop.reasons || []).map((reason) => <li key={reason}>{reason}</li>)}</ul>
        {(drop.suggestions || []).length > 0 && (
          <div className="grid gap-[6px] text-muted text-[11.5px] [&_div]:flex [&_div]:flex-wrap [&_div]:gap-[6px]">
            <span>Available times (pick one, then confirm):</span>
            <div>{drop.suggestions.map((slot) => (
              <button key={slot.start_at} type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => onPickSuggestion(drop.session, slot)}>{slot.label}</button>
            ))}</div>
          </div>
        )}
      </>
    );
    actions = <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" onClick={onClose}>OK</button>;
  } else if (drop.kind === 'merge') {
    const target = drop.target;
    title = `Merge ${applicants} applicant${applicants === 1 ? '' : 's'} into this session?`;
    body = (
      <p>
        {formatSessionRange(target.start_at, target.end_at)} · Handler: {target.handler?.full_name || '—'} · Venue: {target.venue || '—'} · {target.occupancy}.
        {' '}The applicants take this session&apos;s time; the dragged session becomes &ldquo;Merged&rdquo;.
      </p>
    );
    actions = (
      <>
        <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={cancel}>Cancel</button>
        <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy} onClick={() => void merge(target)}>Merge</button>
      </>
    );
  } else {
    const evaluation = drop.evaluation || {};
    const targets = evaluation.merge_targets || [];
    const warnings = evaluation.warnings || [];
    const needsRemarks = isAdmin && warnings.length > 0;
    const remarksMissing = needsRemarks && !remarks.trim();
    title = 'Move this session?';
    body = (
      <>
        <p>{activityLabel(session.activity_type)} → <strong>{formatSessionRange(drop.start.toISOString(), drop.end.toISOString())}</strong>{!isAdmin && ' — it goes back to Pending for Admin review.'}</p>
        {targets.length > 0 && (
          <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-merge">
            <strong>May overlapping session na puwedeng pagsamahin:</strong>
            <ul>{targets.map((target) => <li key={target.session_id}>{formatSessionRange(target.start_at, target.end_at)} · {target.brand || 'Any brand'} · {target.handler || 'No handler'} · {target.occupancy} — {target.why}</li>)}</ul>
            {!isAdmin && <p className="text-muted text-[12px]">Admin lang ang puwedeng mag-merge.</p>}
            {!evaluation.separate_allowed && (evaluation.separate_blockers || []).map((reason) => <p key={reason} className="text-muted text-[12px]">Separate session: {reason}</p>)}
          </div>
        )}
        {needsRemarks && (
          <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-warning">
            <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            <label className="grid gap-1 mt-2 text-text-secondary text-[11.5px] [&_textarea]:w-full">
              <span>Override remarks (required)</span>
              <textarea rows={2} value={remarks} onChange={(event) => setRemarks(event.target.value)} />
            </label>
          </div>
        )}
      </>
    );
    actions = (
      <>
        <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={cancel}>Cancel</button>
        {targets.length > 0 ? (
          <>
            {isAdmin && targets.map((target) => (
              <button key={target.session_id} type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy}
                onClick={() => void merge({ ...target, id: target.session_id })}>
                Merge into {target.time}
              </button>
            ))}
            <button type="button" className={isAdmin ? 'ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]' : 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]'} disabled={busy || !evaluation.separate_allowed || remarksMissing}
              onClick={() => void move({ create_separate: true })}>
              {isAdmin ? 'Keep separate' : 'Keep separate (Pending — Admin will review)'}
            </button>
          </>
        ) : (
          <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy || remarksMissing} onClick={() => void move()}>Move</button>
        )}
      </>
    );
  }

  return (
    <Modal
      title={title}
      size="small"
      onClose={drop.kind === 'blocked' ? onClose : cancel}
      footer={<div className="flex flex-wrap gap-2 justify-end w-full">{actions}</div>}
    >
      {body}
      {error && (
        <div className="m-0 p-[9px_12px] border border-line rounded-[9px] text-[12px] [&_ul]:m-[4px_0_0] [&_ul]:pl-[18px] later:[&_p]:m-[4px_0_0] [&_a]:text-accent-text [&.is-ok]:border-[color:color-mix(in_srgb,_var(--success)_45%,_transparent)] [&.is-ok]:text-success-text later:[&.is-blocked]:border-[color:color-mix(in_srgb,_var(--danger)_45%,_transparent)] later:[&.is-blocked]:text-danger-text later-2:[&.is-merge]:border-[color:color-mix(in_srgb,_var(--accent-2)_50%,_transparent)] later-2:[&.is-merge]:text-text-secondary later-3:[&.is-warning]:border-[color:color-mix(in_srgb,_var(--warning)_50%,_transparent)] later-3:[&.is-warning]:text-[color:var(--warning-text)] is-blocked" role="alert">
          <p>{error}</p>
          {reasons.length > 0 && <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        </div>
      )}
    </Modal>
  );
}
