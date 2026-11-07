import { useCallback, useEffect, useState } from 'react';
import { api, firstValidationMessage } from '../../lib/api';
import { EmptyState, LoadingState, Notice } from '../ApiUi';
import { ProductionTrendCombo } from '../dashboard/Charts';
import { formatDate, formatNumber } from '../../lib/format';
import useCosting from '../../lib/useCosting';

const money = (value) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PHP' }).format(Number(value || 0));

/**
 * Branch Dashboard: production-only dual-axis trend and recent production.
 * There is deliberately no revenue, profit, margin or finished-goods metric.
 */
export default function BranchDashboardPanel({ branchQuery = {}, onViewAll }) {
  const costing = useCosting();
  const [period, setPeriod] = useState('month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.get('/branch/workspace/production-dashboard', { ...branchQuery, period });
      setData(response.data);
      setError('');
    } catch (caught) {
      setError(firstValidationMessage(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchQuery, period]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const summary = data?.summary || {};
  const recent = data?.recent_three_days || [];

  return (
    <div className="branch-dashboard">
      <Notice type="error">{error}</Notice>

      <section className="grid grid-cols-[repeat(auto-fit,_minmax(180px,_1fr))] gap-3 mb-4 [&_.metric-card]:min-h-[105px] [&_.metric-card]:grid [&_.metric-card]:[align-content:space-between] [&_.metric-card]:p-4 [&_.metric-card]:border later:[&_.metric-card]:border-line [&_.metric-card]:rounded-[16px] [&_.metric-card]:[background:var(--panel)] [&_.metric-card_span]:text-muted [&_.metric-card_span]:text-[10px] [&_.metric-card_strong]:text-text [&_.metric-card_strong]:text-[25px] [.branch-dashboard_&]:grid-cols-[repeat(auto-fit,_minmax(210px,_1fr))] [.branch-dashboard_&_.metric-card]:min-h-[120px] [.branch-dashboard_&_.metric-card]:p-[18px_20px] [.branch-dashboard_&_.metric-card_span]:text-[13px] [.branch-dashboard_&_.metric-card_strong]:text-[48px] [.branch-dashboard_&_.metric-card_strong]:font-[800] [.branch-dashboard_&_.metric-card_strong]:leading-[1.05] max-[761px]:later:[.branch-dashboard_&_.metric-card_strong]:text-[38px]" aria-label="Production summary">
        <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]"><span>Units produced · this month</span><strong>{formatNumber(summary.month_units)}</strong></article>
        {costing && <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]"><span>Material cost · this month</span><strong>{money(summary.month_material_cost)}</strong></article>}
        <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]"><span>Production runs · this month</span><strong>{formatNumber(summary.month_batches)}</strong></article>
        <article className="metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px]"><span>Units produced · selected range</span><strong>{formatNumber(summary.total_units)}</strong></article>
      </section>

      <div className="grid grid-cols-[minmax(0,_1.55fr)_minmax(0,_1fr)] gap-4 max-[981px]:later:grid-cols-[minmax(0,_1fr)] later:items-stretch later:[&>.data-panel]:mb-0">
        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0 [&_.branch-panel-heading]:mb-2 [&_.chart-caption]:hidden later:[&_.chart-surface]:p-0">
          <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]">
            <h2>Production Trend</h2>
            <select
              className="min-h-[42px] p-[8px_12px] border border-input-line rounded-[10px] text-text [background-color:var(--input-bg)] text-[14px] [transition:border-color_.18s_ease,_box-shadow_.18s_ease] later:w-auto min-w-[160px] font-[600] [&_option]:text-text [&_option]:[background:var(--panel)] focus:[outline:0] focus:border-[color:var(--branch-accent)] focus:[box-shadow:0_0_0_3px_color-mix(in_srgb,_var(--branch-accent)_17%,_transparent)]"
              aria-label="Production trend period"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            >
              <option value="month">By month</option>
              <option value="year">By year</option>
            </select>
          </header>
          <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px]">
            {loading && !data ? <LoadingState label="Loading production trend…" /> : (
              <ProductionTrendCombo rows={data?.series || []} />
            )}
          </div>
        </section>

        <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] flex flex-col p-0 [&_.branch-panel-heading]:mb-2">
          <header className="min-h-[72px] flex flex-wrap items-center justify-between gap-3 m-[0_20px] p-[14px_8px] [border-bottom:1px_solid_color-mix(in_srgb,_var(--branch-accent)_28%,_var(--border))] [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[20px] [&_h2]:font-[800] [&_h2]:tracking-[.01em] [&_h2]:uppercase max-[761px]:later:m-[0_16px] max-[761px]:later:p-[12px_0] max-[761px]:later:min-h-0 max-[761px]:later:[&_h2]:text-[17px]">
            <h2>Recent Transaction</h2>
            <button type="button" className="ghost-button later:min-h-[38px] inline-flex items-center justify-center later:gap-[7px] later:p-[0_14px] border later:border-line-strong later:rounded-[10px] later:text-text-secondary later:[background:transparent] later:text-[13px] later:font-[650] later:[transition:color_.16s_ease,_background_.16s_ease,_border-color_.16s_ease] later:[&:hover:not(:disabled)]:text-text later:[&:hover:not(:disabled)]:border-accent later:[&:hover:not(:disabled)]:[background:var(--hover)] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] [.branch-production-line_&]:min-h-[40px] small [&.ghost-button]:min-h-[32px] [&.ghost-button]:p-[0_10px] [&.ghost-button]:text-[12px]" onClick={onViewAll}>View all</button>
          </header>
          <div className="flex-1 min-w-0 flex flex-col p-[16px_20px_20px] max-[761px]:later:p-[14px_16px_16px] branch-recent-body relative min-h-[300px] max-[981px]:later:min-h-0">
            {loading && !data ? <LoadingState label="Loading recent production…" /> : recent.length === 0 ? (
              <EmptyState label="No transactions in the past 3 days." />
            ) : (
              <div className="grid gap-2 overflow-auto pr-1 absolute inset-[16px_20px_20px] later:max-h-[none] [align-content:start] max-[981px]:later:static max-[981px]:later-2:max-h-[420px]">
                {recent.map((row) => (
                  <article key={row.id} className={`grid gap-1 p-[11px_12px] border border-line rounded-[12px] [background:var(--surface-subtle)] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-2 [&>div]:text-text [&_p]:m-0 [&_p]:text-text-secondary [&_small]:text-muted [&.is-voided]:opacity-[.62] [&_.ghost-button.small]:[justify-self:start] later:[&_.ghost-button.small]:min-h-[28px] [&_.ghost-button.small]:text-[9px] later:[&>div]:text-[14px] later:[&_p]:text-[13px] later:[&_small]:text-[12px] ${row.voided ? ' is-voided' : ''}`}>
                    <div>
                      <strong>{row.product}</strong>
                      {row.voided && <span className="p-[2px_7px] rounded-[999px] text-[#f56d7d] [background:color-mix(in_srgb,_#f56d7d_14%,_transparent)] text-[8px] font-[800] tracking-[.04em] uppercase">Voided</span>}
                    </div>
                    <p>{formatNumber(row.quantity)} pcs{costing ? ` · ${money(row.material_cost)} material cost` : ''}</p>
                    <small>{formatDate(row.date, true)} · {row.submitted_by}</small>
                    {/* View-only: Admin can no longer void a branch's production (403);
                        the branch voids its own same-day batch from the Production tab. */}
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
