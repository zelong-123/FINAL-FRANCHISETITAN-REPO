import React from 'react';
import { FaClock, FaTruckFast } from 'react-icons/fa6';
import { api } from '../../lib/api';
import useRemote from '../../lib/useRemote';
import { formatNumber } from '../../lib/format';
import { FORECASTING_SECTION_ROLES } from '../../lib/navigation';
import { EmptyState, LoadingState, Notice, StatusBadge } from '../ApiUi';

/*
 * Moved from the retired Analytics page onto "Analytics and Forecasting"
 * (Admin + Logistics only; never in the franchisee's embedded Branch Portal
 * tab). Only the items a role's dashboard does NOT already show are moved —
 * nothing is duplicated:
 *
 *   Admin     (dashboard already has Fulfillment %):
 *             Average fulfillment hours, Supply workflow distribution,
 *             Recent inquiry trend.
 *   Logistics (dashboard already has the supply workflow per stage):
 *             Fulfillment %, Average fulfillment hours, Recent inquiry trend.
 *
 * Counts and quantities only — no cost or financial figures. The old monthly "Forecast history" was
 * retired: the Estimated Requirement (daily, Descriptive / Predictive) above is the one forecast.
 */
const MOVED_OVERVIEW = {
  admin: ['average_fulfillment_hours', 'supply_statuses', 'inquiry_trend'],
  logistics: ['fulfillment_rate_percent', 'average_fulfillment_hours', 'inquiry_trend'],
};

function Metric({ label, value, suffix = '', Icon, tone = '', caption }) {
  return (
    <article className={`metric-card relative min-h-[136px] flex flex-col justify-between overflow-hidden p-[18px] border border-line rounded-[18px] [background:linear-gradient(145deg,_color-mix(in_srgb,_var(--panel-2)_96%,_transparent),_color-mix(in_srgb,_var(--panel)_92%,_transparent))] [box-shadow:var(--shadow-sm)] [transition:transform_.22s_ease,_border-color_.22s_ease,_box-shadow_.22s_ease] [&::after]:[content:''] [&::after]:absolute [&::after]:w-[120px] [&::after]:h-[120px] [&::after]:-right-[60px] [&::after]:-top-[65px] [&::after]:rounded-[50%] [&::after]:[background:color-mix(in_srgb,_var(--accent)_8%,_transparent)] [&::after]:[transition:transform_.35s_ease] hover:[transform:translateY(-3px)] hover:border-[color:color-mix(in_srgb,_var(--accent)_22%,_var(--border))] hover:[box-shadow:var(--shadow-md)] [&:hover::after]:[transform:scale(1.25)] [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680] [&_strong]:relative [&_strong]:z-1 [&_strong]:block [&_strong]:[overflow-wrap:anywhere] [&_strong]:text-text [&_strong]:text-[clamp(22px,_2.4vw,_31px)] [&_strong]:leading-[1.06] [&_strong]:tracking-[-.045em] max-[681px]:later:min-h-[124px] max-[451px]:later-2:min-h-[120px] ${tone ? ` metric-tone-${tone}` : ''}`}>
      <div className="metric-top relative z-1 flex items-center justify-between gap-3 [&>span]:text-muted [&>span]:text-[9px] [&>span]:font-[680]"><span>{label}</span><span className="metric-icon w-[36px] h-[36px] later:grid place-items-center rounded-[12px] text-accent-text [background:color-mix(in_srgb,_var(--accent)_10%,_transparent)] [.metric-tone-success_&]:text-success-text [.metric-tone-success_&]:[background:color-mix(in_srgb,_var(--success)_10%,_transparent)] later:[.metric-tone-warning_&]:text-[color:var(--warning-text)] later:[.metric-tone-warning_&]:[background:color-mix(in_srgb,_var(--warning)_10%,_transparent)] later-2:[.metric-tone-danger_&]:text-danger-text later-2:[.metric-tone-danger_&]:[background:color-mix(in_srgb,_var(--danger)_10%,_transparent)] later-3:[.metric-tone-purple_&]:text-[#b7a4ff] later-3:[.metric-tone-purple_&]:[background:rgba(139,109,255,.11)] [.dashboard-page_&]:w-[28px] [.dashboard-page_&]:h-[28px] [.dashboard-page_&]:rounded-[9px] later:[.dashboard-page_&]:text-[12px]"><Icon /></span></div>
      <div><strong>{value}{suffix}</strong><div className="metric-caption relative z-1 mt-[7px] text-muted text-[8px] leading-[1.45]">{caption}</div></div>
    </article>
  );
}

function OverviewSection({ role }) {
  const items = MOVED_OVERVIEW[role] || [];
  const remote = useRemote(async () => (items.length ? (await api.get('/analytics/overview')).data : null), [role]);
  if (!items.length) return null;
  const data = remote.data;
  const has = (key) => items.includes(key);
  const kpis = data?.kpis || {};

  return (
    <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65] af-overview" aria-labelledby="af-overview-title">
      <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]">
        <div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]">
          <h2 id="af-overview-title">Supply and demand overview</h2>
          <span>Counts from recorded supply requests and inquiries</span>
        </div>
      </div>
      <Notice type="error">{remote.error}</Notice>
      {remote.loading && !data ? <LoadingState label="Loading overview…" /> : data && (
        <>
          {(has('fulfillment_rate_percent') || has('average_fulfillment_hours')) && (
            <div className="metric-grid grid gap-[13px] mb-[18px] max-[1381px]:later:grid-cols-[repeat(3,_minmax(0,_1fr))] max-[681px]:later-2:grid-cols-[repeat(2,_minmax(0,_1fr))] later-4:grid-cols-[repeat(4,_minmax(0,_1fr))] max-[901px]:later-5:grid-cols-[repeat(2,_minmax(0,_1fr))] max-[451px]:later-6:grid-cols-[1fr]">
              {has('fulfillment_rate_percent') && (
                <Metric label="Fulfillment" value={formatNumber(kpis.fulfillment_rate_percent, 2)} suffix="%" Icon={FaTruckFast} tone="success" caption="Completed supply requests" />
              )}
              {has('average_fulfillment_hours') && (
                <Metric
                  label="Average fulfillment"
                  value={kpis.average_fulfillment_hours == null ? '—' : formatNumber(kpis.average_fulfillment_hours, 1)}
                  suffix={kpis.average_fulfillment_hours == null ? '' : ' hrs'}
                  Icon={FaClock}
                  tone="purple"
                  caption="Request-to-completion time"
                />
              )}
            </div>
          )}
          <div className="grid gap-[18px] m-[18px_0] grid-cols-[repeat(2,_minmax(0,_1fr))] max-[1121px]:later:grid-cols-[1fr]">
            {has('supply_statuses') && (
              <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
                <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]"><div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]"><h2>Supply workflow distribution</h2><span>Requests grouped by current stage</span></div></div>
                <div className="p-[5px_18px_15px] [&>div]:min-h-[42px] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:border-b [&>div]:border-b-line [&>div]:text-text-secondary [&>div]:text-[9px] [&>div:last-child]:border-b-0 [&_strong]:text-text">
                  {Object.entries(data.supply_statuses || {}).map(([key, value]) => <div key={key}><StatusBadge value={key} /><strong>{value}</strong></div>)}
                </div>
              </section>
            )}
            {has('inquiry_trend') && (
              <section className="data-panel overflow-hidden mb-[18px] border border-line rounded-[19px] [background:color-mix(in_srgb,_var(--panel)_96%,_transparent)] [box-shadow:var(--shadow-sm)] [transition:border-color_.2s_ease,_box-shadow_.2s_ease] hover:border-line-strong hover:[box-shadow:var(--shadow-md)] [.branch-detail-grid_&]:m-0 [.branch-portal-financial>&]:p-[18px] [.branch-portal-financial>section&]:p-[18px] [.branch-portal-financial_&>h2]:m-[0_0_8px] [.branch-portal-financial_&>h2]:text-text [.branch-portal-financial_&>h2]:text-[14px] [.branch-portal-financial_&>h2]:tracking-[-.02em] [.branch-portal-financial_&>p]:m-[0_0_14px] [.branch-portal-financial_&>p]:text-muted [.branch-portal-financial_&>p]:text-[10px] [.branch-portal-financial_&>p]:leading-[1.65]">
                <div className="panel-title min-h-[58px] flex items-center justify-between gap-3 p-[14px_18px] border-b border-b-line [&_h2]:m-0 [&_h2]:text-text [&_h2]:text-[11px] [&_h2]:font-[780] [&_h2]:tracking-[-.01em] [&_span]:text-muted later:[&_span]:text-[8px] [&_small]:text-muted [&_small]:text-[8px]"><div className="panel-heading-copy flex flex-col later:gap-1 [&_span]:text-muted later:[&_span]:text-[8px]"><h2>Recent inquiry trend</h2><span>Latest recorded lead periods</span></div></div>
                {!(data.inquiry_trend || []).length ? <EmptyState label="No trend data available." /> : (
                  <div className="p-[5px_18px_15px] [&>div]:min-h-[42px] [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:border-b [&>div]:border-b-line [&>div]:text-text-secondary [&>div]:text-[9px] [&>div:last-child]:border-b-0 [&_strong]:text-text">
                    {data.inquiry_trend.slice(-8).map((row) => <div key={row.period}><span>{row.period}</span><strong>{row.count}</strong></div>)}
                  </div>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Admin + Logistics sections of the standalone Analytics and Forecasting page. */
export default function ForecastingSections({ role }) {
  if (!FORECASTING_SECTION_ROLES.includes(role)) return null;
  return (
    <div className="grid gap-[18px] mt-[22px]">
      <OverviewSection role={role} />
    </div>
  );
}
