import { useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { downloadCsv } from '../../lib/export';
import { formatDate, formatNumber } from '../../lib/format';
import useRemote from '../../lib/useRemote';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ApiUi';
import SlidingPagination from '../SlidingPagination';
import SupplyRequestDetailModal from './SupplyRequestDetailModal';

const PAGE_SIZE = 10;
const EXPORT_PAGE_SIZE = 100; // backend maximum
const EXPORT_PAGE_CAP = 20;
const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'rejected', label: 'Rejected' },
];

/** Closed requests (completed / cancelled / rejected) with their own paging, filters and export. */
export default function SupplyHistoryPanel() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [detailId, setDetailId] = useState(null);

  const remote = useRemote(async () => {
    const response = await api.get('/supply-requests', {
      view: 'history',
      per_page: PAGE_SIZE,
      page,
      ...(status ? { status } : {}),
    });
    return { rows: response.data, meta: response.meta };
  }, [page, status]);

  const exportRows = async () => {
    setExporting(true);
    setExportError('');
    try {
      const rows = [];
      for (let exportPage = 1; exportPage <= EXPORT_PAGE_CAP; exportPage += 1) {
        const response = await api.get('/supply-requests', {
          view: 'history',
          per_page: EXPORT_PAGE_SIZE,
          page: exportPage,
          ...(status ? { status } : {}),
        });
        (response.data || []).forEach((row) => {
          rows.push([
            row.request_number,
            row.location?.name || '—',
            row.status,
            formatDate(row.created_at),
            formatDate(row.updated_at),
          ]);
        });
        if (exportPage >= (response.meta?.last_page ?? 1)) break;
      }
      downloadCsv('supply-history', ['Request', 'Branch', 'Status', 'Request date', 'Closed date'], rows);
    } catch (error) {
      setExportError(firstValidationMessage(error));
    } finally {
      setExporting(false);
    }
  };

  const rows = remote.data?.rows || [];

  return (
    <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] sr-history">
      <div className="flex items-center justify-between gap-3 p-[12px_14px] border-b border-b-line">
        <div className="flex items-center gap-2 [&_label]:text-muted [&_label]:text-[0.78rem] [&_label]:font-[700] [&_select]:min-h-[32px] [&_select]:p-[0_10px] [&_select]:rounded-[9px]">
          <label htmlFor="history-status">Status</label>
          <select
            id="history-status"
            value={status}
            onChange={(event) => { setStatus(event.target.value); setPage(1); }}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <button type="button" className="inline-flex items-center justify-center later:gap-[6px] later:min-h-[38px] p-[0_16px] later:rounded-[10px] later:[border:1px_solid_var(--sr-border-strong)] later-2:[background:transparent] later:[font-family:inherit] [font-style:inherit] [line-height:inherit] later:text-[0.92rem] later:font-[500] whitespace-nowrap cursor-pointer later:[transition:background_0.15s_ease,_border-color_0.15s_ease,_opacity_0.15s_ease] later:[&:hover:not(:disabled)]:[background:var(--sr-surface-hover)] later:[&:hover:not(:disabled)]:border-[color:var(--sr-muted)] focus-visible:[outline:2px_solid_var(--sr-accent)] focus-visible:[outline-offset:2px] disabled:opacity-[0.5] disabled:cursor-not-allowed motion-reduce:later-2:[transition:none] later-2:border-transparent later-2:text-[color:var(--sr-muted)]" onClick={exportRows} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {remote.error && <Notice type="error">{remote.error}</Notice>}
      {exportError && <Notice type="error">{exportError}</Notice>}

      {remote.loading ? <LoadingState /> : remote.error ? null : !rows.length ? (
        <EmptyState label="No completed, cancelled or rejected requests yet." />
      ) : (
        <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
          <table className="w-full [border-collapse:collapse] [&_th]:p-[10px_14px] [&_th]:text-left [&_th]:text-[0.85rem] [&_th]:font-[500] [&_th]:text-[color:var(--sr-muted)] [&_th]:whitespace-nowrap [&_th.sr-th-right]:text-right [&_td]:p-[16px_14px] [&_td]:[vertical-align:middle] [&_td]:[border-top:1px_solid_var(--sr-border)] [&_tbody_tr]:[transition:opacity_0.15s_ease] [&_tbody_tr.is-busy]:opacity-[0.65] max-[861px]:later:[&_th]:pl-[10px] max-[861px]:later:[&_th]:pr-[10px] max-[861px]:later:[&_td]:pl-[10px] max-[861px]:later:[&_td]:pr-[10px] motion-reduce:later:[&_tbody_tr]:[transition:none]">
            <thead>
              <tr>
                <th>Request</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Request date</th>
                <th>Closed date</th>
                <th className="sr-th-right">Items</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="sr-row-clickable" onClick={() => setDetailId(row.id)}>
                  <td><strong className="block text-[1rem] font-[600] text-[color:var(--sr-text)]">{row.request_number}</strong></td>
                  <td>{row.location?.name || '—'}</td>
                  <td><StatusBadge value={row.status} /></td>
                  <td>{formatDate(row.created_at)}</td>
                  <td>{formatDate(row.updated_at)}</td>
                  <td className="sr-th-right">{formatNumber((row.items || []).length)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SlidingPagination meta={remote.data?.meta} onPage={setPage} />

      {detailId && (
        <SupplyRequestDetailModal requestId={detailId} onClose={() => setDetailId(null)} />
      )}
    </section>
  );
}
