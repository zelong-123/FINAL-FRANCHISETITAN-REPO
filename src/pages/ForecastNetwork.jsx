import React, { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaCircleInfo, FaTriangleExclamation } from 'react-icons/fa6';
import { api } from '../lib/api';
import useRemote from '../lib/useRemote';
import useForecastLiveRefresh from '../lib/useForecastLiveRefresh';
import { formatNumber } from '../lib/format';
import { EmptyState, Field, LoadingState, Notice, PageHeader } from '../components/ApiUi';

const NOTE = 'Estimates are based on past usage to support decisions. They are not guarantees.';

const RISK_LABEL = {
  runs_out_soon: 'Run out soon',
  watch: 'Watch',
  ok: 'Covered',
  unknown: 'Unknown',
};

const RISK_ORDER = { runs_out_soon: 0, watch: 1, unknown: 2, ok: 3 };

function qty(value, unit) {
  if (value === null || value === undefined) return '—';
  return `${formatNumber(value, 2)} ${unit || ''}`.trim();
}

function days(value) {
  if (value === null || value === undefined) return '—';
  return `${formatNumber(value, 1)} d`;
}

export default function ForecastNetwork() {
  const [brandId, setBrandId] = useState('');
  const [horizon, setHorizon] = useState(1);
  const [dips, setDips] = useState('cap');
  const [open, setOpen] = useState([]);

  const remote = useRemote(
    () => api.get('/estimated-requirement/network', {
      brand_id: brandId || undefined,
      horizon,
      dips,
    }),
    [brandId, horizon, dips],
  );

  useForecastLiveRefresh(() => { void remote.reload({ silent: true }); });

  const payload = remote.data?.data;
  const products = useMemo(() => payload?.products || [], [payload]);
  const unmapped = payload?.unmapped || [];

  const totals = useMemo(() => ({
    atRisk: products.filter((row) => row.risk === 'runs_out_soon').length,
    watch: products.filter((row) => row.risk === 'watch').length,
    need: products.reduce((sum, row) => sum + Number(row.estimated_need || 0), 0),
  }), [products]);

  const toggle = (id) => setOpen((current) => (current.includes(id)
    ? current.filter((row) => row !== id)
    : [...current, id]));

  return (
    <div className="page-container w-[min(100%,_1640px)] m-[0_auto] p-[clamp(22px,_3vw,_38px)] max-[861px]:later:p-[22px_17px_30px] [--sr-accent:var(--accent,_#2f7de1)] [--sr-accent-soft:rgba(47,_125,_225,_0.18)] [--sr-text:var(--text,_#f4f4f5)] [--sr-muted:var(--text-muted,_#a1a1aa)] [--sr-border:var(--border,_#2e2e33)] [--sr-border-strong:var(--border-strong,_#3f3f46)] [--sr-surface-hover:var(--surface-hover,_rgba(255,_255,_255,_0.04))] [--sr-danger:var(--danger-text,_#f87171)] [--sr-success:var(--success-text,_#4ade80)] [--sr-todo:#3a3a40]">
      <PageHeader
        title="Network requirement"
        subtitle="Every branch's estimated need next to the warehouse stock that has to cover it."
      />

      <p className="flex items-center gap-2 m-[0_0_14px] text-muted text-[12.5px] [&_svg]:text-accent-text [&_svg]:flex-none"><FaCircleInfo aria-hidden="true" /> {payload?.note || NOTE}</p>
      <p className="m-[-4px_0_14px]"><Link to="/estimated-requirement" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px]">← One branch at a time</Link></p>

      {remote.error && <Notice type="error">{remote.error}</Notice>}

      <div className="fn-filters grid grid-cols-[repeat(auto-fit,_minmax(190px,_1fr))] gap-3 p-[14px] mb-4 [background:var(--panel)] border border-line rounded-[14px]">
        <Field label="Brand">
          <select value={brandId} onChange={(event) => setBrandId(event.target.value)}>
            <option value="">All brands</option>
            {(payload?.brands || []).map((brand) => (
              <option key={brand.id} value={brand.id}>{brand.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Horizon">
          <select value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
            <option value={1}>1 week</option>
            <option value={2}>2 weeks</option>
            <option value={4}>4 weeks</option>
          </select>
        </Field>
        <Field label="Dips and spikes in calculations" hint="Recorded usage is never changed.">
          <select value={dips} onChange={(event) => setDips(event.target.value)}>
            <option value="cap">Cap them (default)</option>
            <option value="raw">Use raw values</option>
          </select>
        </Field>
      </div>

      {remote.loading ? <LoadingState label="Adding up the network…" /> : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] gap-3 mb-4">
            <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_span]:text-muted [&_span]:text-[11.5px] [&_span]:tracking-[.03em] [&_span]:uppercase [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11px]"><span>Branches counted</span><strong>{formatNumber(payload?.branch_count ?? 0)}</strong></article>
            <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_span]:text-muted [&_span]:text-[11.5px] [&_span]:tracking-[.03em] [&_span]:uppercase [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11px]"><span>Warehouse items covered</span><strong>{formatNumber(products.length)}</strong></article>
            <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_span]:text-muted [&_span]:text-[11.5px] [&_span]:tracking-[.03em] [&_span]:uppercase [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_small]:text-muted [&_small]:text-[11px] later:[&_strong]:text-danger-text"><span>Run out within {formatNumber(payload?.settings?.runs_out_days ?? 5)} days</span><strong>{formatNumber(totals.atRisk)}</strong></article>
            <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_span]:text-muted [&_span]:text-[11.5px] [&_span]:tracking-[.03em] [&_span]:uppercase [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_small]:text-muted [&_small]:text-[11px] later-2:[&_strong]:text-[color:var(--warning-text)]"><span>Watch</span><strong>{formatNumber(totals.watch)}</strong></article>
            <article className="flex flex-col gap-[6px] p-4 [background:var(--panel)] border border-line rounded-[14px] [&_span]:text-muted [&_span]:text-[11.5px] [&_span]:tracking-[.03em] [&_span]:uppercase [&_strong]:text-[26px] [&_strong]:leading-[1.1] [&_strong]:text-text [&_small]:text-muted [&_small]:text-[11px]"><span>Total estimated need</span><strong>{formatNumber(totals.need, 2)}</strong><small>Across every unit shown below — read per row, not as one sum</small></article>
          </div>

          <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_h2_svg]:text-[color:var(--warning-text)] [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px] [&_.table-wrap]:overflow-x-auto">
            <header>
              <h2>Need against warehouse stock</h2>
              <p>Warehouse stock is a snapshot of the warehouse location. A row with no stock figure has nothing recorded for that item.</p>
            </header>

            {products.length === 0 ? (
              <EmptyState label="No warehouse item has a linked raw material yet." detail="Link raw materials to warehouse products, or pick another brand." />
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_small]:block [&_td_small]:text-muted [&_td_small]:text-[11px] [&_tr.is-open>td]:[background:var(--hover)] [&_thead_th.fn-right]:text-right">
                  <thead>
                    <tr>
                      <th>Warehouse item</th>
                      <th>Weekly usage</th>
                      <th className="fn-right text-right">Warehouse stock</th>
                      <th className="fn-right text-right">Estimated need ({horizon}w)</th>
                      <th className="fn-right text-right">Suggested transfer</th>
                      <th className="fn-right text-right">Days of cover</th>
                      <th>Risk</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((row) => (
                      <Fragment key={row.product_id}>
                        <tr className={open.includes(row.product_id) ? 'is-open' : undefined}>
                          <td>
                            <strong>{row.name}</strong>
                            <small>{row.sku || '—'} · {formatNumber(row.materials)} material{row.materials === 1 ? '' : 's'}</small>
                          </td>
                          <td>{qty(row.weekly_usage, row.unit)}</td>
                          <td className="fn-right text-right">{qty(row.warehouse_stock, row.unit)}</td>
                          <td className="fn-right text-right">{qty(row.estimated_need, row.unit)}</td>
                          <td className="fn-right text-right">{row.suggested_reorder ? <strong>{qty(row.suggested_reorder, row.unit)}</strong> : '—'}</td>
                          <td className="fn-right text-right">{days(row.days_of_cover)}</td>
                          <td><span className={`inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap fn-${row.risk}`}>{RISK_LABEL[row.risk] || row.risk}</span></td>
                          <td className="fn-right text-right">
                            <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={() => toggle(row.product_id)} aria-expanded={open.includes(row.product_id)}>
                              {open.includes(row.product_id) ? 'Hide branches' : 'Branches'}
                            </button>
                          </td>
                        </tr>
                        {open.includes(row.product_id) && (
                          <tr className="[&>td]:p-[0_0_8px_18px]! [&>td]:[background:var(--surface-subtle)]">
                            <td colSpan={8}>
                              <table className="w-full [border-collapse:collapse] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_thead_th.fn-right]:text-right later:text-[11.5px] later:[&_tbody_td]:p-[7px_10px]">
                                <thead>
                                  <tr><th>Branch</th><th>Raw material</th><th className="fn-right text-right">On hand</th><th className="fn-right text-right">On order</th><th className="fn-right text-right">Estimated need</th><th className="fn-right text-right">Suggested transfer</th><th className="fn-right text-right">Days left</th><th>Branch status</th></tr>
                                </thead>
                                <tbody>
                                  {row.branches.map((branch) => (
                                    <tr key={`${branch.location_id}-${branch.material}`}>
                                      <td>{branch.branch}</td>
                                      <td>{branch.material}</td>
                                      <td className="fn-right text-right">{qty(branch.on_hand, row.unit)}</td>
                                      <td className="fn-right text-right">{qty(branch.on_order, row.unit)}</td>
                                      <td className="fn-right text-right">{branch.ready ? qty(branch.estimated_need, row.unit) : 'Not ready'}</td>
                                      <td className="fn-right text-right">{qty(branch.suggested_reorder, row.unit)}</td>
                                      <td className="fn-right text-right">{days(branch.days_left)}</td>
                                      <td><span className={`inline-flex items-center p-[2px_8px] rounded-[999px] text-[11px] font-[600] border border-line-strong text-text-secondary [background:var(--surface-subtle)] whitespace-nowrap fn-${branch.status}`}>{RISK_LABEL[branch.status] || branch.status}</span></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="p-4 mb-4 [background:var(--panel)] border border-line rounded-[14px] [&>header]:mb-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:m-0 [&_h2]:text-[15px] [&_h2]:text-text [&_h2_svg]:text-[color:var(--warning-text)] [&_header_p]:m-[4px_0_0] [&_header_p]:text-muted [&_header_p]:text-[12px] [&_.table-wrap]:overflow-x-auto">
            <header>
              <h2><FaTriangleExclamation aria-hidden="true" /> Unmapped materials</h2>
              <p>These raw materials have no usable warehouse product, so they are left out of the totals above rather than guessed.</p>
            </header>
            {unmapped.length === 0 ? (
              <p className="text-muted text-[12px] m-[10px_0_0]">Every raw material used here is linked to a warehouse item.</p>
            ) : (
              <div className="table-wrap overflow-x-auto [.data-panel_&_table_tbody_tr[data-applicant-id]_td]:[vertical-align:middle]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pt-[14px]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td]:pb-[14px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:font-[400]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:leading-[1.35]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:font-[500]! later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)_small]:mt-[3px]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.875rem]! later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:font-[400]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:text-[0.8125rem]! later-3:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(5)]:font-[450]! max-[721px]:later:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_strong]:text-[1rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(3)]:text-[0.9375rem]! max-[721px]:later-4:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(4)]:text-[0.9375rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(1)_small]:text-[0.8125rem]! max-[721px]:later-2:[.data-panel_&_table_tbody_tr[data-applicant-id]_td:nth-child(2)_small]:text-[0.8125rem]! [.data-panel_&_table_tbody_tr.ap-row-readable]:cursor-pointer [.data-panel_&_table_tbody_tr.ap-row-readable]:[transition:background_.15s_ease] [.data-panel_&_table_tbody_tr.ap-row-readable:hover]:[background:rgba(123,_136,_255,_.06)] [.data-panel_&_table_tbody_tr.ap-row-readable.is-selected]:[background:rgba(123,_136,_255,_.12)] [.data-panel_&_table_tbody_tr.ap-row-readable_button]:cursor-pointer">
                <table className="w-full [border-collapse:collapse] text-[12.5px] [&_thead_th]:text-left [&_thead_th]:p-[8px_10px] [&_thead_th]:text-muted [&_thead_th]:font-[500] [&_thead_th]:text-[11.5px] [&_thead_th]:border-b [&_thead_th]:border-b-line [&_thead_th]:whitespace-nowrap [&_tbody_td]:p-[10px] [&_tbody_td]:border-b [&_tbody_td]:border-b-line [&_tbody_td]:text-text-secondary [&_tbody_td]:[vertical-align:middle] [&_td_strong]:text-text [&_td_strong]:font-[600] [&_td_small]:block [&_td_small]:text-muted [&_td_small]:text-[11px] [&_tr.is-open>td]:[background:var(--hover)] [&_thead_th.fn-right]:text-right">
                  <thead>
                    <tr><th>Branch</th><th>Raw material</th><th>Unit</th><th>Why it is left out</th></tr>
                  </thead>
                  <tbody>
                    {unmapped.map((row) => (
                      <tr key={`${row.location_id}-${row.material_id}`}>
                        <td>{row.branch}</td>
                        <td><strong>{row.material}</strong></td>
                        <td>{row.unit}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-muted text-[12px] m-[10px_0_0]">{NOTE} Rows are ordered by risk, then name. Nothing here creates, changes or approves a supply request.</p>
        </>
      )}
    </div>
  );
}
