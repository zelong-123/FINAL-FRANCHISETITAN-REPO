import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaArrowRightArrowLeft, FaBan, FaCalendarDays, FaChevronDown, FaClock, FaCodeMerge, FaLocationDot, FaPenToSquare, FaRotate, FaTag, FaTrashCan, FaUser, FaUsers, FaClockRotateLeft } from 'react-icons/fa6';
import { api, firstValidationMessage } from '../../lib/api';
import { LoadingState, Modal, Notice } from '../ApiUi';
import RecordCode from '../RecordCode';
import { formatDate, titleCase } from '../../lib/format';
import { STATUS_COLORS, activityLabel, formatSessionRange, participantDidNotAttend, statusLabel } from '../../lib/scheduleSessions';

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [mergePick, setMergePick] = useState([]); // applicant ids chosen for the merge confirmation
  const [drag, setDrag] = useState(null); // { id, x, y, width, height, offsetY } while an applicant row is dragged
  const dragRef = React.useRef(null);

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
  // Same "did not attend" rule as the Master Schedule card, so the red status here matches the
  // red card: No Show seats, and live sessions whose start already passed with a seat never
  // completed. Set Again / Adjust resets the seat, so the red status clears on its own.
  const didNotAttend = (participant) => participantDidNotAttend(session, participant);
  const didNotAttendCount = participants.filter(didNotAttend).length;

  const toggleMerge = async () => {
    if (mergeTargets) {
      setMergeTargets(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const start = new Date(session.start_at);
      const from = new Date(start.getTime() - 14 * 864e5).toISOString();
      const to = new Date(start.getTime() + 14 * 864e5).toISOString();
      const response = await api.post(`/schedule-sessions/${session.id}/evaluate-drag`, { from, to });
      // Business day (Manila/+08:00) of a timestamp, so past and same-day sessions are dropped in the UI too.
      const dayOf = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(value));
      const today = dayOf(new Date());
      const verdicts = new Map((response.data.targets || []).map((row) => [row.session_id, row]));
      // Details (time, handler, venue) for the list, from the calendar feed. Targets the server did not return (past or same day) are not shown.
      const feed = verdicts.size ? await api.get('/schedule-sessions', { from, to }) : { data: [] };
      const visible = (feed.data || []).filter((row) => verdicts.has(row.id) && dayOf(row.start_at) > today);
      setMergeTargets(visible.map((row) => ({ ...row, locked: verdicts.get(row.id).status !== 'mergeable', lockedReason: verdicts.get(row.id).reasons?.[0] })));
    } catch (mergeError) {
      setError(firstValidationMessage(mergeError));
    } finally {
      setBusy(false);
    }
  };

  // Pick which applicants move: all of them by default, so the drag and Merge here buttons keep working.
  const openMergeConfirm = (target) => {
    setMergePick(participants.map((p) => p.applicant_id));
    setConfirm({ kind: 'merge', target });
  };

  const removeParticipant = (participant) => run(
    () => api.delete(`/schedule-sessions/${session.id}/participants/${participant.applicant_id}`),
    `${participant.applicant?.full_name || 'Participant'} was removed from the session.`,
    (response) => {
      if (response.data?.empty_session) setConfirm({ kind: 'empty' });
    },
  );

  const floatingRow = drag && typeof document !== 'undefined' ? createPortal(
    <div style={{ position: 'fixed', left: drag.x, top: drag.y, width: drag.width, zIndex: 2147483601, pointerEvents: 'none', boxShadow: '0 14px 36px rgba(0,0,0,.5)', border: '1px solid var(--accent)', borderRadius: '9px', background: 'color-mix(in srgb, var(--panel) 80%, transparent)', opacity: 0.85, padding: '8px 10px' }} className="flex items-center gap-3">
      <span aria-hidden="true" className="w-[34px] h-[34px] shrink-0 grid place-items-center rounded-full text-[#fff] text-[11px] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]">{(drag.name || 'A').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>
      <div className="grid gap-[2px] min-w-0"><strong>{drag.name}</strong><small className="text-muted text-[11px]">{drag.code}</small></div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
    {floatingRow}
    <Modal
      title={session?.status === 'cancelled' ? (
        <span className="inline-flex items-center gap-2">
          <span className="text-[18px] font-[800] tracking-[-.01em] line-through decoration-[2px] text-muted">{`${session.activity_label} session`}</span>
          <span className="p-[2px_9px] rounded-[999px] border border-[rgba(239,68,68,0.5)] bg-[rgba(239,68,68,0.14)] text-[#fca5a5] text-[11px] font-[700]">Cancelled</span>
        </span>
      ) : <span className="text-[18px] font-[800] tracking-[-.01em]">{session ? `${session.activity_label} session` : 'Session'}</span>}
      onClose={onClose}
      size="wide"
      chromeColor="#070A13"
    >
      <Notice type="error">{error}</Notice>
      <Notice type="success">{notice}</Notice>
      {!session ? (error ? null : <LoadingState />) : (
        <div className="grid gap-5 h-[560px] content-start overflow-y-auto pr-1 [&_h4]:m-0 [&_h4]:text-text [&_h4]:text-[13px] [&_h4]:font-[700] [&_h4]:flex [&_h4]:items-center [&_h4]:gap-2">
          <header className="grid gap-3 [&_h3]:m-0 [&_h3]:text-text [&_h3]:text-[17px] [&_dl]:grid [&_dl]:grid-cols-[repeat(auto-fit,_minmax(140px,_1fr))] [&_dl]:gap-0 [&_dl]:m-0 [&_dt]:text-muted [&_dt]:text-[13px] [&_dt]:font-[700] [&_dt]:uppercase [&_dt]:tracking-[.04em] [&_dd]:m-[2px_0_0] [&_dd]:text-text-secondary [&_dd]:text-[13px] [&_.ms-merge-badge]:relative">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2"><FaClock aria-hidden="true" className="text-muted text-[15px]" />{formatSessionRange(session.start_at, session.end_at)}</h3>
              <div className="flex flex-wrap items-center gap-2">
              <span className="[justify-self:start] p-[2px_9px] [border:0] rounded-[999px] [background:color-mix(in_srgb,_var(--chip)_16%,_transparent)] text-[color:var(--chip)] text-[11px] font-[600]" style={{ '--chip': STATUS_COLORS[session.status] }}>{statusLabel(session.status)}</span>
              {session.merge_suggested && <span className="ms-merge-badge [justify-self:start] p-[1px_6px] rounded-[999px] [background:color-mix(in_srgb,_var(--accent-2)_85%,_transparent)] text-[#fff] text-[9px] not-italic font-[650]">Merge suggested</span>}
              </div>
            </div>
            <dl className="p-[12px_0] border-y border-line">
              <div className="p-[0_14px] border-l border-line first:border-l-0 first:pl-0"><dt className="flex items-center gap-[6px]"><FaArrowRightArrowLeft aria-hidden="true" />Activity</dt><dd>{activityLabel(session.activity_type)}</dd></div>
              <div className="p-[0_14px] border-l border-line"><dt className="flex items-center gap-[6px]"><FaTag aria-hidden="true" />Brand</dt><dd>{session.brand?.name || (session.activity_type === 'orientation' ? 'Any (Orientation/Tasting)' : '—')}</dd></div>
              <div className="p-[0_14px] border-l border-line"><dt className="flex items-center gap-[6px]"><FaUser aria-hidden="true" />Handler</dt><dd>{session.handler?.full_name || '—'}</dd></div>
              <div className="p-[0_14px] border-l border-line"><dt className="flex items-center gap-[6px]"><FaLocationDot aria-hidden="true" />Venue</dt><dd>{session.venue || '—'}</dd></div>
              <div className="p-[0_14px] border-l border-line"><dt className="flex items-center gap-[6px]"><FaUsers aria-hidden="true" />Applicants</dt><dd>{session.occupancy}</dd></div>
              {session.remarks && <div className="full [.ap-grid_&]:col-span-full"><dt>Remarks</dt><dd>{session.remarks}</dd></div>}
            </dl>
          </header>

          {live && (
            <div className="flex flex-wrap gap-2">
              {can.confirm && session.status === 'pending' && (
                <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy} onClick={() => setConfirm({ kind: 'confirm' })}>Confirm</button>
              )}
              {can.schedule && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => onEdit(session)}><FaPenToSquare aria-hidden="true" />Edit</button>}
              {can.merge && session.activity_type !== 'training' && (
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => void toggleMerge()} aria-expanded={Boolean(mergeTargets)} style={mergeTargets ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)' } : undefined}><FaCodeMerge aria-hidden="true" />Merge…</button>
              )}
              {can.cancel && <button type="button" className="danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]" disabled={busy} onClick={() => setConfirm({ kind: 'cancel' })}><FaBan aria-hidden="true" />Cancel session</button>}
            </div>
          )}

          {mergeTargets && (
            <section className="ms-merge-section grid gap-3 [&_ul]:grid [&_ul]:gap-[6px] [&_ul]:m-0 [&_ul]:p-0 [&_ul]:[list-style:none] [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:justify-between [&_li]:gap-2 [&_li]:p-[8px_10px] [&_li]:border [&_li]:border-line [&_li]:rounded-[9px] [&_li]:[background:var(--surface-subtle)] [&_li>span]:flex [&_li>span]:items-center [&_li>span]:gap-2 [&_li>span]:text-[15px] [&_li>span]:text-text-secondary">
              <h4><FaCodeMerge aria-hidden="true" className="text-muted" />Merge into…</h4>
              {mergeTargets.length === 0 ? <p className="text-muted text-[12px]">No session can take these applicants right now.</p> : (
                <ul>
                  {mergeTargets.map((target, index) => (
                    <li key={target.id} data-merge-target={target.id} className={`ms-merge-item ${target.locked ? 'opacity-60' : ''}`} style={{ '--i': index, ...(dropTargetId === target.id ? { borderColor: 'var(--accent)' } : {}) }}>
                      <span><FaCalendarDays aria-hidden="true" className="text-muted shrink-0" />{formatSessionRange(target.start_at, target.end_at)} · {target.brand?.name || 'Any brand'} · {target.handler?.full_name || 'No handler'} · {target.venue || 'No venue'} · {target.occupancy}</span>
                      {target.locked ? <span title={target.lockedReason} className="text-muted text-[11px] font-[700] tracking-[.06em] uppercase">Locked</span> : <button type="button" className="primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]" disabled={busy} onClick={() => openMergeConfirm(target)}>Merge here</button>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="grid gap-3">
            <h4><FaUsers aria-hidden="true" className="text-muted" />Participants ({participants.length}){didNotAttendCount > 0 && (
              <em className="not-italic text-[10px] font-[700] whitespace-nowrap" style={{ color: '#ef4444' }}>{didNotAttendCount} did not attend</em>
            )}</h4>
            {participants.length === 0 ? <p className="text-muted text-[12px]">Wala nang participant ang session na ito.</p> : (
              <ul className="grid gap-[6px] m-0 p-0 [list-style:none] [&_li]:flex [&_li]:flex-wrap [&_li]:items-center [&_li]:justify-between [&_li]:gap-2 [&_li]:p-[8px_10px] [&_li]:border [&_li]:border-line [&_li]:rounded-[9px] [&_li]:[background:var(--surface-subtle)] [&_li>div:first-child]:flex [&_li>div:first-child]:items-center [&_li>div:first-child]:gap-3 [&_small]:text-muted [&_small]:text-[11px]">
                {participants.map((participant) => (
                  <li key={participant.id} onPointerDown={(event) => {
                    if (!mergeTargets || !can.merge || busy || event.button !== 0) return;
                    if (event.target.closest('button')) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    dragRef.current = { id: participant.id, startY: event.clientY, rowTop: rect.top, offsetY: event.clientY - rect.top, moved: false, target: null };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }} onPointerMove={(event) => {
                    const current = dragRef.current;
                    if (!current || current.id !== participant.id) return;
                    if (!current.moved && Math.abs(event.clientY - current.startY) < 4) return;
                    current.moved = true;
                    // Only vertical movement: the row stays on the pointer's X, centered on the cursor.
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDrag({ id: participant.id, x: rect.left, width: rect.width, y: event.clientY - current.offsetY, name: participant.applicant?.full_name || 'Applicant', code: participant.applicant?.applicant_code || '' });
                    const under = document.elementFromPoint(event.clientX, event.clientY);
                    const targetRow = under?.closest?.('[data-merge-target]');
                    const targetId = targetRow ? Number(targetRow.dataset.mergeTarget) : null;
                    const target = mergeTargets?.find((item) => item.id === targetId) || null;
                    current.target = target && !target.locked ? target : null;
                    setDropTargetId(current.target ? current.target.id : null);
                  }} onPointerUp={() => {
                    const current = dragRef.current;
                    dragRef.current = null;
                    setDrag(null);
                    setDropTargetId(null);
                    if (current?.moved && current.target && !busy) openMergeConfirm(current.target);
                  }} onPointerCancel={() => { dragRef.current = null; setDrag(null); setDropTargetId(null); }} className={`${mergeTargets && can.merge ? 'cursor-grab touch-none' : ''} ${drag?.id === participant.id ? 'opacity-40' : ''}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span aria-hidden="true" className="w-[34px] h-[34px] shrink-0 grid place-items-center rounded-full text-[#fff] text-[11px] font-[700] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))]">{(participant.applicant?.full_name || 'A').split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>
                      <div className="grid gap-[2px] min-w-0">
                      <strong>{participant.applicant?.full_name || `Applicant`}</strong>
                      <RecordCode code={participant.applicant?.applicant_code} label="Applicant ID" />
                      <small className="flex flex-wrap items-center gap-[6px]">
                        <span>{titleCase(participant.attendance_status)}{participant.admin_attended_by_name ? ` · Attended (${participant.admin_attended_by_name})` : ''}</span>
                        {didNotAttend(participant) && (
                          <em className="not-italic text-[10px] font-[700] whitespace-nowrap" style={{ color: '#ef4444' }}>Did not attend</em>
                        )}
                      </small>
                      </div>
                    </div>
                    {live && (
                      <div className="flex flex-wrap gap-2">
                        {can.schedule && !participant.activity_done && participant.attendance_status !== 'attended' && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => onSetAgain(session, participant.applicant)}><FaRotate aria-hidden="true" />Set Again</button>}
                        {can.remove && <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" disabled={busy} onClick={() => setConfirm({ kind: 'remove', participant })}><FaTrashCan aria-hidden="true" />Remove</button>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <button type="button" className="w-full inline-flex items-center justify-between gap-2 p-0 border-0 [background:none] text-text cursor-pointer" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
              <h4 className="m-0"><FaClockRotateLeft aria-hidden="true" className="text-muted" />History</h4>
              <FaChevronDown aria-hidden="true" className={`text-[10px] transition-transform duration-200 ${historyOpen ? 'rotate-180' : ''}`} />
            </button>
            {historyOpen && <ol className="grid gap-[6px] m-0 p-0 [list-style:none] [&_small]:text-muted [&_small]:text-[11px] [&_span]:text-muted [&_span]:text-[11px] later:[&_li]:grid later:[&_li]:gap-[1px] later:[&_li]:p-[6px_0] later:[&_li]:border-b later:[&_li]:border-b-line [&_strong]:text-text-secondary [&_strong]:text-[12px]">
              {(session.history || []).slice().reverse().map((row) => (
                <li key={row.id}>
                  <strong>{titleCase(row.action)}</strong>
                  <span>{formatDate(row.created_at, true)} · {row.performed_by_name || 'System'}{row.performed_by_role ? ` (${row.performed_by_role})` : ''}</span>
                  {row.remarks && <small>{row.remarks}</small>}
                </li>
              ))}
            </ol>}
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
                  <button type="button" disabled={busy || (confirm.kind === 'merge' && mergePick.length === 0)} className={confirm.kind === 'confirm' || confirm.kind === 'merge' ? 'primary-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] [background:linear-gradient(135deg,_var(--accent),_var(--accent-2))] [box-shadow:0_12px_28px_color-mix(in_srgb,_var(--accent)_20%,_transparent)] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] [&:hover:not(:disabled)]:[transform:translateY(-2px)] [&:hover:not(:disabled)]:[box-shadow:0_17px_34px_color-mix(in_srgb,_var(--accent)_27%,_transparent)] [&:hover:not(:disabled)]:[filter:saturate(1.08)] later:[&:active:not(:disabled)]:[transform:translateY(0)]' : 'danger-button [-webkit-tap-highlight-color:transparent] min-h-[42px] inline-flex items-center justify-center gap-2 p-[0_16px] border border-transparent rounded-[12px] text-[#fff] text-[12px] font-[760] tracking-[.01em] [transition:transform_.18s_ease,_box-shadow_.18s_ease,_filter_.18s_ease] later:[background:linear-gradient(135deg,_#ef596b,_#c9374a)] later:[box-shadow:0_12px_28px_color-mix(in_srgb,_var(--danger)_21%,_transparent)]'} disabled={busy}
                    onClick={() => {
                      if (confirm.kind === 'confirm') void run(() => api.post(`/schedule-sessions/${session.id}/confirm`, {}), 'Session confirmed.');
                      if (confirm.kind === 'cancel') void run(() => api.post(`/schedule-sessions/${session.id}/cancel`, { remarks: remarks || null }), 'Session cancelled.');
                      if (confirm.kind === 'remove') void removeParticipant(confirm.participant);
                      if (confirm.kind === 'merge') {
                        void run(
                          () => api.post(`/schedule-sessions/${session.id}/merge`, { target_session_id: confirm.target.id, applicant_ids: mergePick }),
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
            <>
              <p>{formatSessionRange(confirm.target.start_at, confirm.target.end_at)} · Handler: {confirm.target.handler?.full_name || '—'} · Venue: {confirm.target.venue || '—'}. The selected applicants take the target session&apos;s time.</p>
              <ul className="grid gap-[6px] m-0 mt-2 p-0 [list-style:none]">
                {participants.map((participant) => (
                  <li key={participant.id}>
                    <label className="flex items-center gap-2 p-[8px_10px] border border-line rounded-[9px] [background:var(--surface-subtle)] cursor-pointer">
                      <input type="checkbox" checked={mergePick.includes(participant.applicant_id)} onChange={(event) => setMergePick((ids) => (event.target.checked ? [...ids, participant.applicant_id] : ids.filter((id) => id !== participant.applicant_id)))} />
                      <span className="text-text">{participant.applicant?.full_name || 'Applicant'}</span>
                      <RecordCode code={participant.applicant?.applicant_code} label="Applicant ID" />
                    </label>
                  </li>
                ))}
              </ul>
              {mergePick.length === 0 && <p className="text-muted text-[12px] mt-2">Pumili ng kahit isang applicant.</p>}
            </>
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
    </>
  );
}
