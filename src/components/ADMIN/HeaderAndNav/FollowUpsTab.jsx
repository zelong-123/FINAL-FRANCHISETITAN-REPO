import React from 'react';
import { FaCircleCheck } from 'react-icons/fa6';
import { formatDate, manilaDateTimeLabel } from '../../../lib/format';
import { FollowUpChip } from '../../applicants/FollowUp';

// The bell's Follow-ups tab (replaces the Sales dashboard's "Needs attention").
//   Sales: their Overdue / Stalled / On hold applicants with Log follow-up.
//   Admin: every Overdue / Stalled applicant with the assigned Sales user and Send reminder, then the
//          recent "Follow-up logged" notifications from Sales.
// Items disappear by themselves once resolved (the list is the live follow-up state, not a read flag).

const ROW_BUTTON = 'min-h-[34px] inline-flex items-center justify-center p-[0_12px] border border-line rounded-[9px] [background:var(--surface-subtle)] text-text-secondary text-[13px] font-[700] cursor-pointer whitespace-nowrap hover:text-text hover:border-line-strong hover:[background:var(--hover)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]';

export default function FollowUpsTab({ role, items, notes = [], loading, error, onOpen, onOpenNote, onAction }) {
  const isAdmin = role === 'admin';
  if (loading && !items) return <p className="m-0 p-[24px_18px] text-muted text-[14px] text-center">Loading follow-ups…</p>;
  if (error && !items) return <p className="m-0 p-[24px_18px] text-danger-text text-[14px] text-center">{error}</p>;
  const rows = items || [];
  return (
    <div className="readable-list">
      {!rows.length ? (
        <div className="flex items-center justify-center gap-[10px] p-[26px_18px] text-[14px] text-text-secondary">
          <FaCircleCheck aria-hidden="true" className="text-success-text text-[17px]" />
          <span><strong className="text-text text-[15px]">All caught up.</strong> {isAdmin ? 'No applicant is Overdue or Stalled.' : 'None of your applicants needs a follow-up.'}</span>
        </div>
      ) : (
        <ul className="m-0 p-0 [list-style:none]" aria-label="Follow-ups">
          {rows.map((row) => {
            const fu = row.follow_up || {};
            const late = fu.state === 'overdue' || fu.state === 'stalled';
            return (
              <li key={row.id} className="grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-[12px] p-[14px_18px] border-b border-b-line max-[451px]:grid-cols-1">
                <div className="grid gap-[4px] min-w-0">
                  <span className="flex flex-wrap items-center gap-[8px] min-w-0">
                    <button type="button" className="p-0 border-0 [background:transparent] text-text text-[15px] font-[750] text-left cursor-pointer hover:underline focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]" onClick={() => onOpen(row)}>
                      {row.full_name}
                    </button>
                    {row.applicant_code && <small className="text-muted text-[12px] font-[650]">{row.applicant_code}</small>}
                    <FollowUpChip followUp={fu} role={role} onOpen={() => onOpen(row)} />
                  </span>
                  <span className="text-text-secondary text-[14px] leading-[1.45]">
                    {row.status_label}
                    {late && typeof fu.days === 'number' ? ` · ${fu.days} day${fu.days === 1 ? '' : 's'} without an update` : ''}
                    {fu.state === 'on_hold' && fu.hold?.until ? ` · on hold until ${formatDate(fu.hold.until)}` : ''}
                    {isAdmin ? ` · Sales: ${row.assigned_sales?.full_name || 'unassigned'}` : ''}
                  </span>
                  <small className="text-muted text-[12px]">
                    {fu.last_reminder ? `Last reminder: ${fu.last_reminder.by || 'Admin'} · ${manilaDateTimeLabel(fu.last_reminder.at)}` : 'No reminder yet'}
                  </small>
                </div>
                {!isAdmin && late && <button type="button" className={ROW_BUTTON} onClick={() => onAction('log', row)}>Log follow-up</button>}
                {isAdmin && late && (
                  <button
                    type="button"
                    className={ROW_BUTTON}
                    disabled={Boolean(fu.next_reminder_at) || !row.assigned_sales}
                    title={fu.next_reminder_at ? `Next reminder available at ${manilaDateTimeLabel(fu.next_reminder_at)}` : !row.assigned_sales ? 'Assign a Sales user first' : undefined}
                    onClick={() => onAction('remind', row)}
                  >
                    Send reminder
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {isAdmin && notes.length > 0 && (
        <>
          <h3 className="m-0 p-[14px_18px_8px] text-muted text-[12px] font-[800] tracking-[.08em] uppercase">Recent follow-ups from Sales</h3>
          <ul className="m-0 p-0 [list-style:none]">
            {notes.map((note) => (
              <li key={note.id} className="border-b border-b-line">
                <button type="button" className="w-full grid gap-[4px] p-[12px_18px] border-0 [background:transparent] text-left cursor-pointer hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:-2px]" onClick={() => onOpenNote(note)}>
                  <strong className="text-text text-[15px] font-[750]">{note.title}</strong>
                  <span className="text-text-secondary text-[14px] leading-[1.45]">{note.message}</span>
                  <small className="text-muted text-[12px]">{formatDate(note.created_at, true)}</small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
