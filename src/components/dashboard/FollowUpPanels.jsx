import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaCircleCheck } from 'react-icons/fa6';
import { api } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import { manilaDateTimeLabel } from '../../lib/format';
import { LoadingState, Notice } from '../ApiUi';
import { FollowUpChip, FollowUpDialogs } from '../applicants/FollowUp';

// Dashboard panels for applicant follow-up (rules in services/followUp.ts). The page wraps each one in
// its usual PanelShell.

const ROW_BUTTON = 'min-h-[32px] inline-flex items-center justify-center p-[0_12px] border border-line rounded-[9px] [background:var(--surface-subtle)] text-text-secondary text-[12.5px] font-[700] cursor-pointer whitespace-nowrap hover:text-text hover:border-line-strong hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]';

/** Sales dashboard: their Overdue / Stalled applicants, most days first, with Log follow-up. */
export function NeedsAttentionList() {
  const navigate = useNavigate();
  const remote = useRemote(async () => (await api.get('/applicants/needs-attention')).data || []);
  const [action, setAction] = useState(null);
  const [success, setSuccess] = useState('');
  const rows = remote.data || [];
  if (remote.loading) return <LoadingState label="Loading…" />;
  if (remote.error) return <Notice type="error" inline>{remote.error}</Notice>;
  return (
    <>
      <Notice type="success">{success}</Notice>
      {!rows.length ? (
        <div className="flex items-center gap-[10px] p-[18px] text-[13.5px] text-text-secondary">
          <FaCircleCheck aria-hidden="true" className="text-success-text text-[16px]" />
          <span><strong className="text-text">All caught up.</strong> None of your applicants is Overdue or Stalled.</span>
        </div>
      ) : (
        <ul className="m-0 p-0 [list-style:none] grid">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[minmax(0,_1fr)_auto] items-center gap-[12px] p-[12px_18px] border-b border-b-line last:border-b-0 max-[561px]:grid-cols-1">
              <div className="grid gap-[3px] min-w-0">
                <span className="flex flex-wrap items-center gap-[8px]">
                  <button type="button" className="p-0 border-0 [background:transparent] text-text text-[14px] font-[700] cursor-pointer hover:underline focus-visible:[outline:2px_solid_var(--accent)] text-left" onClick={() => navigate('/applicants', { state: { focusApplicantId: row.id } })}>
                    {row.full_name}
                  </button>
                  {row.applicant_code && <small className="text-muted text-[12px] font-[600]">{row.applicant_code}</small>}
                  <FollowUpChip followUp={row.follow_up} />
                </span>
                <small className="text-text-secondary text-[12.5px]">
                  {row.status_label} · {row.follow_up.days} day{row.follow_up.days === 1 ? '' : 's'} without an update
                  {' · '}{row.follow_up.last_reminder ? `Reminder from ${row.follow_up.last_reminder.by || 'Admin'} ${manilaDateTimeLabel(row.follow_up.last_reminder.at)}` : 'No reminder yet'}
                </small>
              </div>
              <button type="button" className={ROW_BUTTON} onClick={() => setAction({ kind: 'log', applicant: row })}>Log follow-up</button>
            </li>
          ))}
        </ul>
      )}
      <FollowUpDialogs
        action={action}
        onClose={() => setAction(null)}
        onDone={async (message) => { setAction(null); await remote.reload({ silent: true }); setSuccess(message); }}
      />
    </>
  );
}

/** Executive dashboard: Overdue / Stalled applicants per Sales user. */
export function FollowUpBySalesTable() {
  const navigate = useNavigate();
  const remote = useRemote(async () => (await api.get('/applicants/follow-up-by-sales')).data);
  if (remote.loading) return <LoadingState label="Loading panel…" />;
  if (remote.error) return <Notice type="error" inline>{remote.error}</Notice>;
  const rows = remote.data?.rows || [];
  if (!rows.length) return <p className="m-0 p-[18px] text-muted text-[13px]">No active Sales users.</p>;
  const cell = (value, tone) => (
    <td className="text-right tabular-nums">
      {value ? <strong className={tone}>{value}</strong> : <span className="text-muted">0</span>}
    </td>
  );
  return (
    <div className="table-wrap overflow-x-auto">
      <table>
        <thead>
          <tr><th>Sales user</th><th className="text-right">Overdue</th><th className="text-right">Stalled</th><th className="text-right">Waiting on Admin</th><th className="text-right">On hold</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sales_user_id ?? 'unassigned'}>
              <td>{row.full_name}</td>
              {cell(row.overdue, 'text-[#fb923c] light:text-[#c2410c]')}
              {cell(row.stalled, 'text-[#f87171] light:text-[#b91c1c]')}
              {cell(row.waiting_admin, 'text-[#60a5fa] light:text-[#1d4ed8]')}
              {cell(row.on_hold, 'text-text-secondary')}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end p-[10px_18px]">
        <button type="button" className={ROW_BUTTON} onClick={() => navigate('/applicants')}>Open the Applicant pipeline</button>
      </div>
    </div>
  );
}
