import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import { LoadingState, Notice } from '../ApiUi';

// Executive dashboard panel for applicant follow-up (rules in services/followUp.ts); the page wraps it
// in its usual PanelShell. Sales' own follow-ups are in the notification bell (Follow-ups tab).

const ROW_BUTTON = 'min-h-[32px] inline-flex items-center justify-center p-[0_12px] border border-line rounded-[9px] [background:var(--surface-subtle)] text-text-secondary text-[12.5px] font-[700] cursor-pointer whitespace-nowrap hover:text-text hover:border-line-strong hover:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]';

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
          <tr><th>Sales user</th><th className="text-right">Overdue</th><th className="text-right">Stalled</th><th className="text-right">On hold</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sales_user_id ?? 'unassigned'}>
              <td>{row.full_name}</td>
              {cell(row.overdue, 'text-[#fb923c] light:text-[#c2410c]')}
              {cell(row.stalled, 'text-[#f87171] light:text-[#b91c1c]')}
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
