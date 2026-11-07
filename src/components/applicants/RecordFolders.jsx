import React from 'react';
import { FaFolderOpen } from 'react-icons/fa6';
import { StatusBadge } from '../ApiUi';
import RecordCode, { ApplicantIdCell } from '../RecordCode';
import { formatDate, formatNumber } from '../../lib/format';
import {
  PAYMENT_STAGES, branchLabel, folderDate, paidLabel, planTitle as planSummary,
} from '../../lib/recordFolders';

/*
 * Application Detail record folders — one card design (the original approved
 * "folder" card) shared by the Active Applicants, Approved / Active Franchise
 * and Rejected folders, plus a table view with the same data.
 *
 * Every card has the same slots (icon row, 2-line name, two meta lines, footer)
 * so cards in a row are always the same height.
 */

const planTitle = (row) => planSummary(row, (value) => formatNumber(value, 2));

function statusLine(folder, row) {
  if (folder === 'approved') {
    const label = row.status === 'active_franchisee' ? 'Active franchisee' : 'Approved';
    return row.approved_at ? `${label} · ${formatDate(row.approved_at)}` : label;
  }
  if (folder === 'rejected') {
    const when = row.rejected_at ? formatDate(row.rejected_at) : 'Date not recorded';
    return row.rejected_by ? `${when} · by ${row.rejected_by}` : when;
  }
  return row.updated_at ? `Updated ${formatDate(row.updated_at)}` : 'Not updated yet';
}

function footLeft(folder, row) {
  if (folder === 'rejected') {
    const remarks = row.rejection_remarks || 'No remarks recorded';
    return <span className="ap-folder-remarks block overflow-hidden text-ellipsis whitespace-nowrap" title={remarks}>{remarks}</span>;
  }
  if (folder === 'active' && !PAYMENT_STAGES.has(row.status)) {
    return <span>{row.step ? `Step ${row.step} of ${row.step_total}` : '—'}</span>;
  }
  return <span title={planTitle(row)}>{paidLabel(row)}</span>;
}

export function RecordFolderCard({ folder, row, onOpen }) {
  return (
    <button
      type="button"
      role="listitem"
      className={`flex flex-col items-stretch gap-[5px] min-w-0 h-full p-[14px] border border-[#2a3041] rounded-[12px] [background:#141a28] text-[color:inherit] later:[font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] [line-height:inherit] text-left cursor-pointer [transition:border-color_.15s_ease,_transform_.15s_ease,_background_.15s_ease] hover:border-[#4a5580] hover:[background:#171e2f] hover:[transform:translateY(-1px)] focus-visible:[outline:2px_solid_#8175ff] focus-visible:[outline-offset:2px] ap-folder--${folder}`}
      onClick={() => onOpen(row.id)}
      title={row.full_name}
    >
      <span className="flex items-start justify-between gap-2 min-h-[40px] [&_.status-pill]:max-w-[60%] [&_.status-pill]:overflow-hidden [&_.status-pill]:text-ellipsis [&_.status-pill]:whitespace-nowrap">
        <span className="grid flex-none w-[36px] h-[36px] place-items-center rounded-[9px] [background:rgba(129,_117,_255,_.14)] text-[#a89dff] text-[17px] [.ap-folder--rejected_&]:[background:rgba(245,_109,_125,_.14)] [.ap-folder--rejected_&]:text-[#f58a97]" aria-hidden="true"><FaFolderOpen /></span>
        {folder !== 'approved' && <StatusBadge value={row.status} label={row.status_label} />}
      </span>
      <strong className="[display:-webkit-box] min-h-[calc(2_*_1.35em)] overflow-hidden text-[#fff] text-[13px] leading-[1.35] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] [line-clamp:2]">{row.full_name}</strong>
      <span className="min-h-[18px] overflow-hidden text-ellipsis whitespace-nowrap">
        <RecordCode code={row.applicant_code} label="Applicant ID" copyable={false} />
        {row.lead?.lead_code && <span className="overflow-hidden text-[#9ba5bd] text-[10.5px] text-ellipsis whitespace-nowrap"> · from {row.lead.lead_code}</span>}
      </span>
      <span className="overflow-hidden text-[#9ba5bd] text-[10.5px] text-ellipsis whitespace-nowrap">{branchLabel(row)}</span>
      <span className="overflow-hidden text-[#9ba5bd] text-[10.5px] text-ellipsis whitespace-nowrap">{statusLine(folder, row)}</span>
      <span className="flex justify-between gap-2 w-full mt-auto pt-2 border-t border-t-[#272f44] text-[#9aa6c4] text-[10px] [&>span:first-child]:min-w-0">
        {footLeft(folder, row)}
        <span className="flex-none">Open record</span>
      </span>
    </button>
  );
}

export function RecordFolderGrid({ folder, rows, onOpen }) {
  return (
    <div className="grid grid-cols-[repeat(5,_minmax(0,_1fr))] [grid-auto-rows:1fr] gap-3 p-[4px_0_14px] max-[1281px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[861px]:later-2:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[521px]:later-3:grid-cols-[minmax(0,_1fr)]" role="list">
      {rows.map((row) => <RecordFolderCard key={row.id} folder={folder} row={row} onOpen={onOpen} />)}
    </div>
  );
}

export function RecordFolderTable({ folder, rows, onOpen }) {
  const dateHeading = folder === 'approved' ? 'Approved' : folder === 'rejected' ? 'Rejected' : 'Last updated';
  return (
    <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
      <table className="[&_td_small]:block [&_td_small]:mt-[2px] [&_td_small]:text-[#8f9ab2] [&_td_small]:text-[10.5px] [&_td_.ap-folder-remarks]:max-w-[260px]">
        <thead>
          <tr>
            <th className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden">Applicant ID</th><th>Name</th><th>Brand / Branch</th><th>Stage / Status</th><th>{dateHeading}</th>
            <th>{folder === 'rejected' ? 'Remarks' : '% paid'}</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="max-[761px]:[th&]:hidden max-[761px]:[td&]:hidden"><ApplicantIdCell code={row.applicant_code} leadCode={row.lead?.lead_code} /></td>
              <td>
                <span className="hidden max-[761px]:later:block max-[761px]:mb-[2px]"><RecordCode code={row.applicant_code} label="Applicant ID" /></span>
                <strong>{row.full_name}</strong><small>{row.email || '—'}</small>
              </td>
              <td>{branchLabel(row)}</td>
              <td>
                <StatusBadge value={row.status} label={row.status_label} />
                {folder === 'active' && row.step && <small>Step {row.step} of {row.step_total}</small>}
              </td>
              <td>
                {formatDate(folderDate(folder, row))}
                {folder === 'rejected' && row.rejected_by && <small>by {row.rejected_by}</small>}
              </td>
              <td>
                {folder === 'rejected'
                  ? <span className="ap-folder-remarks block overflow-hidden text-ellipsis whitespace-nowrap" title={row.rejection_remarks || ''}>{row.rejection_remarks || '—'}</span>
                  : <>{paidLabel(row)}<small>{planTitle(row)}</small></>}
              </td>
              <td>
                <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]" onClick={() => onOpen(row.id)}>Open record</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
