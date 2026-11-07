import React, { useCallback, useEffect, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { LoadingState, Modal, Notice } from '../ApiUi';
import RecordCode from '../RecordCode';
import { formatDate, titleCase } from '../../lib/format';
import { STATUS_COLORS, activityLabel, formatSessionRange, statusLabel } from '../../lib/scheduleSessions';

/*
 * Session details: participants, history and the actions the role may take.
 * Nothing happens without a click + confirmation; the backend re-checks every
 * rule. Removing the LAST participant never cancels the session by itself —
 * the user is asked: "Wala nang participant ang session na ito. I-cancel ba?"
 */
export default function SessionDetail({ sessionId, can, onClose, onChanged, onEdit, onSetAgain }) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { kind, ... }
  const [remarks, setRemarks] = useState('');
  const [mergeTargets, setMergeTargets] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const response = await api.get(`/schedule-sessions/${sessionId}`);
      setSession(response.data);
    } catch (loadError) {
      setError(firstValidationMessage(loadError));
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const run = async (request, message, after) => {
    setBusy(true);
    setError('');
    try {
      const response = await request();
      setNotice(message);
      setConfirm(null);
      setRemarks('');
      await load();
      onChanged?.();
      after?.(response);
    } catch (actionError) {
      setError(firstValidationMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const live = ['pending', 'confirmed'].includes(session?.status);
  const participants = session?.active_participants || [];

  const openMerge = async () => {
    setBusy(true);
    setError('');
    try {
      const start = new Date(session.start_at);
      const from = new Date(start.getTime() - 14 * 864e5).toISOString();
      const to = new Date(start.getTime() + 14 * 864e5).toISOString();
      const response = await api.post(`/schedule-sessions/${session.id}/evaluate-drag`, { from, to });
      const ids = (response.data.targets || []).filter((row) => row.status === 'mergeable').map((row) => row.session_id);
      // Details (time, handler, venue) for the confirmation, from the calendar feed.
      const feed = ids.length ? await api.get('/schedule-sessions', { from, to }) : { data: [] };
      setMergeTargets((feed.data || []).filter((row) => ids.includes(row.id)));
    } catch (mergeError) {
      setError(firstValidationMessage(mergeError));
    } finally {
      setBusy(false);
    }
  };

  const removeParticipant = (participant) => run(
    () => api.delete(`/schedule-sessions/${session.id}/participants/${participant.applicant_id}`),
    `${participant.applicant?.full_name || 'Participant'} was removed from the session.`,
    (response) => {
      if (response.data?.empty_session) setConfirm({ kind: 'empty' });
    },
  );

  return (
    <Modal title={session ? `${session.activity_label} session` : 'Session'} onClose={onClose} size="wide">
      <Notice type="error">{error}</Notice>
      <Notice type="success">{notice}</Notice>
      {!session ? (error ? null : <LoadingState />) : (
        <div className="grid gap-4 [&_h4]:m-[0_0_8px] [&_h4]:text-text [&_h4]:text-[13px]">
          <header className="grid gap-2 [&_h3]:m-0 [&_h3]:text-text [&_h3]:text-[17px] [&_dl]:grid [&_dl]:grid-cols-[repeat(auto-fit,_minmax(140px,_1fr))] [&_dl]:gap-[8px_16px] [&_dl]:m-0 [&_dl_.full]:col-span-full [&_dt]:text-muted [&_dt]:text-[10.5px] [&_dt]:uppercase [&_dt]:tracking-[.04em] [&_dd]:m-[2px_0_0] [&_dd]:text-text-secondary [&_.ms-merge-badge]:relative">
            <span className="[justify-self:start] p-[2px_9px] [border:1px_solid_var(--chip)] rounded-[999px] [background:color-mix(in_srgb,_var(--chip)_16%,_transparent)] text-[color:var(--chip)] text-[11px] font-[600]" style={{ '--chip': STATUS_COLORS[session.status] }}>{statusLabel(session.status)}</span>
            {session.merge_suggested && <span className="ms-merge-badge [justify-self:start] p-[1px_6px] rounded-[999px] [background:color-mix(in_srgb,_var(--accent-2)_85%,_transparent)] text-[#fff] text-[9px] not-italic font-[650]">Merge suggested</span>}
            <h3>{formatSessionRange(session.start_at, session.end_at)}</h3>
            <dl>
              <div><dt>Activity</dt><dd>{activityLabel(session.activity_type)}</dd></div>
              <div><dt>Brand</dt><dd>{session.brand?.name || (session.activity_type === 'orientation' ? 'Any (Orientation)' : '—')}</dd></div>
              <div><dt>Handler</dt><dd>{session.handler?.full_name || '—'}</dd></div>
              <div><dt>Venue</dt><dd>{session.venue || '—'}</dd></div>
              <div><dt>Applicants</dt><dd>{session.occupancy}</dd></div>
              {session.remarks && <div className="full [.ap-grid_&]:col-span-full"><dt>Remarks</dt><dd>{session.remarks}</dd></div>}
            </dl>
          </header>

          {live && (
            <div className="flex flex-wrap gap-2">
              {can.confirm && session.status === 'pending' && (
                <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy} onClick={() => setConfirm({ kind: 'confirm' })}>Confirm</button>
              )}
              {can.schedule && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => onEdit(session)}>Edit</button>}
              {can.merge && session.activity_type !== 'training' && (
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => void openMerge()}>Merge…</button>
              )}
              {can.cancel && <button type="button" className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" disabled={busy} onClick={() => setConfirm({ kind: 'cancel' })}>Cancel session</button>}
            </div>
          )}

          {mergeTargets && (
            <section className="[&_ul]:grid [&_ul]:gap-[6px] [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:justify-between [&_li]:gap-2 [&_li]:p-[8px_10px] [&_li]:border [&_li]:border-line [&_li]:rounded-[9px] [&_li]:[background:var(--surface-subtle)]">
              <h4>Merge into…</h4>
              {mergeTargets.length === 0 ? <p className="text-muted text-[12px]">No session can take these applicants right now.</p> : (
                <ul>
                  {mergeTargets.map((target) => (
                    <li key={target.id}>
                      <span>{formatSessionRange(target.start_at, target.end_at)} · {target.brand?.name || 'Any brand'} · {target.handler?.full_name || 'No handler'} · {target.venue || 'No venue'} · {target.occupancy}</span>
                      <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy} onClick={() => setConfirm({ kind: 'merge', target })}>Merge here</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <h4>Participants ({participants.length})</h4>
            {participants.length === 0 ? <p className="text-muted text-[12px]">Wala nang participant ang session na ito.</p> : (
              <ul className="grid gap-[6px] m-0 p-0 [list-style:none] [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:justify-between [&_li]:gap-2 [&_li]:p-[8px_10px] [&_li]:border [&_li]:border-line [&_li]:rounded-[9px] [&_li]:[background:var(--surface-subtle)] [&_li>div:first-child]:grid [&_li>div:first-child]:gap-[2px] [&_small]:text-muted [&_small]:text-[11px]">
                {participants.map((participant) => (
                  <li key={participant.id}>
                    <div>
                      <strong>{participant.applicant?.full_name || `Applicant`}</strong>
                      <RecordCode code={participant.applicant?.applicant_code} label="Applicant ID" />
                      <small>{titleCase(participant.attendance_status)}{participant.admin_attended_by_name ? ` · Attended (${participant.admin_attended_by_name})` : ''}</small>
                    </div>
                    {live && (
                      <div className="flex flex-wrap gap-2">
                        {can.schedule && !participant.activity_done && participant.attendance_status !== 'attended' && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => onSetAgain(session, participant.applicant)}>Set Again</button>}
                        {can.remove && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => setConfirm({ kind: 'remove', participant })}>Remove</button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h4>History</h4>
            <ol className="grid gap-[6px] m-0 p-0 [list-style:none] [&_small]:text-muted [&_small]:text-[11px] [&_span]:text-muted [&_span]:text-[11px] later:[&_li]:grid later:[&_li]:gap-[1px] later:[&_li]:p-[6px_0] later:[&_li]:border-b later:[&_li]:border-b-line [&_strong]:text-text-secondary [&_strong]:text-[12px]">
              {(session.history || []).slice().reverse().map((row) => (
                <li key={row.id}>
                  <strong>{titleCase(row.action)}</strong>
                  <span>{formatDate(row.created_at, true)} · {row.performed_by_name || 'System'}{row.performed_by_role ? ` (${row.performed_by_role})` : ''}</span>
                  {row.remarks && <small>{row.remarks}</small>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {confirm && (
        <Modal
          title={{
            confirm: 'Confirm this session?',
            cancel: 'Cancel this session?',
            remove: 'Remove participant?',
            merge: `Merge ${participants.length} applicant(s) into this session?`,
            empty: 'Wala nang participant ang session na ito. I-cancel ba?',
          }[confirm.kind]}
          size="small"
          onClose={() => setConfirm(null)}
          footer={(
            <div className="flex flex-wrap gap-2 justify-end w-full">
              {confirm.kind === 'empty' ? (
                <>
                  <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => setConfirm(null)}>Keep</button>
                  {can.cancel && (
                    <button type="button" className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" disabled={busy}
                      onClick={() => void run(() => api.post(`/schedule-sessions/${session.id}/cancel`, { remarks: 'No participants left.' }), 'Session cancelled.')}>
                      Cancel session
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => setConfirm(null)}>Back</button>
                  <button type="button" className={confirm.kind === 'confirm' || confirm.kind === 'merge' ? 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]' : 'danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]'} disabled={busy}
                    onClick={() => {
                      if (confirm.kind === 'confirm') void run(() => api.post(`/schedule-sessions/${session.id}/confirm`, {}), 'Session confirmed.');
                      if (confirm.kind === 'cancel') void run(() => api.post(`/schedule-sessions/${session.id}/cancel`, { remarks: remarks || null }), 'Session cancelled.');
                      if (confirm.kind === 'remove') void removeParticipant(confirm.participant);
                      if (confirm.kind === 'merge') {
                        void run(
                          () => api.post(`/schedule-sessions/${session.id}/merge`, { target_session_id: confirm.target.id }),
                          'Sessions merged.',
                          () => { setMergeTargets(null); onClose(); },
                        );
                      }
                    }}>
                    {{ confirm: 'Confirm', cancel: 'Cancel session', remove: 'Remove', merge: 'Merge' }[confirm.kind]}
                  </button>
                </>
              )}
            </div>
          )}
        >
          {confirm.kind === 'merge' && (
            <p>{formatSessionRange(confirm.target.start_at, confirm.target.end_at)} · Handler: {confirm.target.handler?.full_name || '—'} · Venue: {confirm.target.venue || '—'}. The applicants take the target session&apos;s time; this session becomes &ldquo;Merged&rdquo;.</p>
          )}
          {confirm.kind === 'remove' && <p>{confirm.participant.applicant?.full_name} leaves this session. The session itself is kept.</p>}
          {confirm.kind === 'cancel' && (
            <label className="grid gap-1 mt-2 text-text-secondary text-[11.5px] [&_textarea]:w-full">
              <span>Remarks (optional)</span>
              <textarea rows={2} value={remarks} onChange={(event) => setRemarks(event.target.value)} />
            </label>
          )}
          {confirm.kind === 'empty' && <p>Removing the last participant does not cancel the session automatically.</p>}
          {confirm.kind === 'confirm' && <p>The session becomes Confirmed and its applicants move to Scheduling if they were still Qualified.</p>}
        </Modal>
      )}
    </Modal>
  );
}
