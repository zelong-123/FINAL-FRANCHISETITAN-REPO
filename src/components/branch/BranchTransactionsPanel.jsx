import { useCallback, useEffect, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, LoadingState, Notice, Pagination } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';

/** Every production transaction of this branch, newest first. */
export default function BranchTransactionsPanel({ branchQuery = {} }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.get('/branch/workspace/production-transactions', { ...branchQuery, page });
      setRows(response.data || []);
      setMeta(response.meta || null);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <div>
      <Notice type="error">{error}</Notice>
      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0">
        <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]"><h2>All Transactions</h2></header>
        <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px]">
          {loading && rows.length === 0 ? <LoadingState label="Loading transactions…" /> : rows.length === 0 ? (
            <EmptyState label="No transactions yet." detail="Record production and it appears here." />
          ) : (
            <>
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="branch-readable-table [&_th]:text-[12px] [&_td_small]:text-[12px]">
                  <thead><tr><th>Date and time</th><th>Product</th><th>Quantity</th><th>Submitted by</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{formatDate(row.date, true)}</td>
                        <td><strong>{row.product}</strong></td>
                        <td>{formatNumber(row.quantity)} pcs</td>
                        <td>{row.submitted_by}</td>
                        <td>{row.voided ? <span className="p-[2px_7px] rounded-[999px] text-[#f56d7d] [background:color-mix(in_srgb,_#f56d7d_14%,_transparent)] text-[8px] font-[800] tracking-[.04em] uppercase" title={row.void_reason || undefined}>Voided</span> : 'Recorded'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination meta={meta} onPage={setPage} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
