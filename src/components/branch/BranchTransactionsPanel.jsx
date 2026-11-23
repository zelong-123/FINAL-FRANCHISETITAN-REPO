import { useCallback, useEffect, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, LoadingState, Notice, Pagination } from '../ApiUi';
import { formatDate, formatNumber } from '../../lib/format';

const PAGE_SIZE = 8;

/** The Manila calendar day (YYYY-MM-DD) of a timestamp, so ranges match what the table shows. */
const manilaDay = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
};

const DATE_INPUT = 'h-[36px] rounded-[9px] border border-line-strong [background:var(--input-bg)] px-[10px] text-[12px] text-text [color-scheme:dark] light:[color-scheme:light] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:1px]';

/** Every production transaction of this branch, newest first, and the physical counts below it. */
export default function BranchTransactionsPanel({ branchQuery = {} }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [rangeRows, setRangeRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rangeActive = Boolean(fromDate || toDate);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (rangeActive) {
        // The endpoint has no date filter, so the branch's whole history is read
        // (100 per request, capped) and the range is applied on this side.
        const all = [];
        for (let next = 1; next <= 30; next += 1) {
          const response = await api.get('/branch/workspace/production-transactions', { ...branchQuery, page: next, per_page: 100 });
          all.push(...(response.data || []));
          if (next >= (response.meta?.last_page || 1)) break;
        }
        setRangeRows(all);
      } else {
        const response = await api.get('/branch/workspace/production-transactions', { ...branchQuery, page, per_page: PAGE_SIZE });
        setRows(response.data || []);
        setMeta(response.meta || null);
      }
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery, page, rangeActive]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setPage(1); }, [fromDate, toDate]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!rangeActive && document.visibilityState === 'visible') void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load, rangeActive]);

  const filtered = rangeActive
    ? rangeRows.filter((row) => {
      const day = manilaDay(row.date);
      return (!fromDate || day >= fromDate) && (!toDate || day <= toDate);
    })
    : rows;
  const lastPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, lastPage);
  const visible = rangeActive ? filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : rows;
  const pageMeta = rangeActive
    ? { current_page: safePage, per_page: PAGE_SIZE, total: filtered.length, last_page: lastPage }
    : meta;

  return (
    <div>
      <Notice type="error">{error}</Notice>
      <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[8px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0">
        <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]">
          <h2>All Transactions</h2>
          <div className="flex flex-wrap items-center gap-[8px] max-[761px]:later:w-full">
            <label className="inline-flex items-center gap-[6px] text-[10px] font-[750] tracking-[.06em] uppercase text-muted">
              From
              <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} className={DATE_INPUT} />
            </label>
            <label className="inline-flex items-center gap-[6px] text-[10px] font-[750] tracking-[.06em] uppercase text-muted">
              To
              <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} className={DATE_INPUT} />
            </label>
            {rangeActive && (
              <button type="button" className="ghost-button small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => { setFromDate(''); setToDate(''); }}>Clear</button>
            )}
          </div>
        </header>
        <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px]">
          {loading && visible.length === 0 ? <LoadingState label="Loading transactions…" /> : visible.length === 0 ? (
            <EmptyState label={rangeActive ? 'No transactions in this date range.' : 'No transactions yet.'} detail={rangeActive ? 'Adjust the dates or clear the range.' : 'Record production and it appears here.'} />
          ) : (
            <>
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="branch-readable-table [&_th]:text-[12px] [&_td_small]:text-[12px]">
                  <thead><tr><th>Date and time</th><th>Product</th><th>Quantity</th><th>Submitted by</th><th>Status</th></tr></thead>
                  <tbody>
                    {visible.map((row) => (
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
              <Pagination meta={pageMeta} onPage={setPage} />
            </>
          )}
        </div>
      </section>
      <CountHistory branchQuery={branchQuery} />
    </div>
  );
}

/** Physical counts of this branch with the reason given, newest first. */
function CountHistory({ branchQuery }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/branch/workspace/count-history', { ...branchQuery, page })
      .then((response) => { if (alive) { setRows(response.data || []); setMeta(response.meta || null); setError(''); } })
      .catch((caught) => { if (alive) setError(firstValidationMessage(caught)); });
    return () => { alive = false; };
  }, [branchQuery, page]);
  const delta = (row) => (row.delta === 0 ? 'No change' : `${row.delta > 0 ? '+' : ''}${formatNumber(row.delta, 3)} ${row.unit}`);
  return (
    <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] flex flex-col p-0" aria-labelledby="count-history-title">
      <header className="min-h-[60px] flex items-center m-[0_20px] p-[12px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[18px] [&_h2]:font-[800] [&_h2]:uppercase"><h2 id="count-history-title">Physical counts</h2></header>
      <div className="p-[16px_20px_20px]">
        <Notice type="error">{error}</Notice>
        {rows.length === 0 ? <EmptyState label="No physical counts yet." detail="Use Physical count in Raw materials; each count shows here with its reason." /> : (
          <>
            <div className="table-wrap overflow-x-auto">
              <table className="branch-readable-table [&_th]:text-[12px] [&_td_small]:text-[12px]">
                <thead><tr><th>Date and time</th><th>Material</th><th>System → counted</th><th>Change</th><th>Reason</th><th>Counted by</th></tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDate(row.occurred_at, true)}</td>
                      <td><strong>{row.material}</strong></td>
                      <td>{formatNumber(row.before, 3)} → {formatNumber(row.counted, 3)} {row.unit}</td>
                      <td className={row.delta < 0 ? 'text-danger-text font-[650]' : row.delta > 0 ? 'text-success-text font-[650]' : 'text-muted'}>{delta(row)}</td>
                      <td>{row.reason || '—'}</td>
                      <td>{row.recorded_by || '—'}</td>
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
  );
}
